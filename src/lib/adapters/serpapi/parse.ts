/**
 * Defensive readers for SERP JSON.
 *
 * Every function here takes `unknown` and returns either a value or a null,
 * and none of them throws. That is not defensive-programming habit — it is the
 * only correct posture for this input. SerpApi documents around 130 distinct
 * result-block shapes and `answer_box` alone has a dozen mutually exclusive
 * variants, so "the key I expected is missing" is the normal case, not the
 * error case. A parser that throws on a sparse response converts a fact about
 * the query into an exception about our code.
 *
 * The one thing the readers must preserve is the difference between *absent*
 * and *empty*. `organic_results: []` is a search that ran and found nothing;
 * no `organic_results` key at all is a response we cannot interpret. The first
 * is evidence, the second is not, and `hasKey` exists to keep them apart.
 */

import type { DiligenceFinding } from "../../core/types";
import type { EngineName, SerpApiJson } from "./types";

export type Citation = DiligenceFinding["citations"][number];

export function isRecord(value: unknown): value is SerpApiJson {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): SerpApiJson | null {
  return isRecord(value) ? value : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function hasKey(json: unknown, key: string): boolean {
  return isRecord(json) && Object.prototype.hasOwnProperty.call(json, key);
}

export function readString(json: unknown, key: string): string | null {
  if (!isRecord(json)) return null;
  const value = json[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function readNumber(json: unknown, key: string): number | null {
  if (!isRecord(json)) return null;
  const value = json[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // SerpApi returns some numerics as strings (review ratings, trend values).
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function readBoolean(json: unknown, key: string): boolean | null {
  if (!isRecord(json)) return null;
  const value = json[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/** Walks a dotted path, stopping at the first non-record rather than throwing. */
export function readPath(json: unknown, path: string): unknown {
  let cursor: unknown = json;
  for (const segment of path.split(".")) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/** First present, non-empty string among `keys`, including dotted paths. */
export function firstString(json: unknown, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = key.includes(".") ? readPath(json, key) : isRecord(json) ? json[key] : undefined;
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * Records under `key`, skipping anything that is not an object. Returns `[]`
 * for a missing key; use `hasKey` when the distinction matters.
 */
export function recordsAt(json: unknown, key: string): SerpApiJson[] {
  if (!isRecord(json)) return [];
  return asArray(json[key]).filter(isRecord);
}

/** The first of `keys` that is present as an array, so callers can try aliases. */
export function firstRecordsAt(json: unknown, keys: readonly string[]): SerpApiJson[] {
  for (const key of keys) {
    if (hasKey(json, key)) {
      const records = recordsAt(json, key);
      if (records.length > 0) return records;
    }
  }
  return [];
}

/**
 * Whether the response carries positive evidence that a search actually ran.
 *
 * This is the hinge of the fail-closed rule. A body containing one of the
 * given result arrays — even empty — is an answer. A body containing a
 * `search_information` block that reports an empty state is also an answer.
 * Anything else is a response we cannot read, and absence of evidence in an
 * unreadable response is not evidence of absence.
 */
export function isUsableResponse(json: unknown, resultKeys: readonly string[]): boolean {
  if (!isRecord(json)) return false;
  // The key has to carry a block, not merely exist: a result key holding a
  // string or a null is a response we do not understand, and guessing at it
  // is how a malformed body turns into a confident verdict.
  if (resultKeys.some((key) => Array.isArray(json[key]) || isRecord(json[key]))) return true;
  const info = asRecord(json.search_information);
  if (info === null) return false;
  return (
    readString(info, "organic_results_state") !== null ||
    typeof info.total_results === "number"
  );
}

/** The API's own error channel: a 200 body that reports a failure. */
export function readApiError(json: unknown): string | null {
  const direct = readString(json, "error");
  if (direct !== null) return direct;
  const status = readPath(json, "search_metadata.status");
  if (status === "Error") {
    const detail = readPath(json, "search_metadata.error");
    return typeof detail === "string" && detail.length > 0
      ? detail
      : "search_metadata.status = Error";
  }
  return null;
}

/* --------------------------------------------------------------- citations */

const TITLE_KEYS = [
  "title",
  "name",
  "question",
  "advertiser",
  "brand",
  "snippet",
  "displayed_link",
] as const;

const LINK_KEYS = [
  "link",
  "url",
  "patent_link",
  "product_link",
  "advertiser_link",
  "source.link",
] as const;

/**
 * Tried only after the human-facing links and after a reconstructed patent
 * page, because a citation is something a person clicks: a storage-bucket PDF
 * or a serpapi.com re-query is technically the same evidence and useless as a
 * place to send a reviewer.
 */
const FALLBACK_LINK_KEYS = ["user.link", "pdf", "serpapi_link"] as const;

/**
 * A citation only counts if it points somewhere a human can go and check. A
 * result with no resolvable http(s) link is dropped rather than cited with a
 * placeholder, because the product's claim is that every verdict is traceable
 * to a real source, and a fabricated link would break exactly that claim.
 */
export function toCitation(engine: EngineName, record: unknown): Citation | null {
  const title = firstString(record, TITLE_KEYS);
  const url =
    firstString(record, LINK_KEYS) ??
    patentLink(record) ??
    firstString(record, FALLBACK_LINK_KEYS);
  if (title === null || url === null) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return { title: title.slice(0, 300), url, engine };
}

/** `google_patents` results carry `patent_id` more reliably than a link. */
function patentLink(record: unknown): string | null {
  const patentId = readString(record, "patent_id");
  if (patentId === null) return null;
  return `https://patents.google.com/${patentId.replace(/^\/+/, "")}`;
}

export function toCitations(
  engine: EngineName,
  records: readonly unknown[],
  limit = 3,
): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const record of records) {
    const citation = toCitation(engine, record);
    if (citation === null || seen.has(citation.url)) continue;
    seen.add(citation.url);
    out.push(citation);
    if (out.length >= limit) break;
  }
  return out;
}

export function dedupeCitations(citations: readonly Citation[], limit = 6): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const citation of citations) {
    if (seen.has(citation.url)) continue;
    seen.add(citation.url);
    out.push(citation);
    if (out.length >= limit) break;
  }
  return out;
}

/* ----------------------------------------------------------- text matching */

/** Written as an escaped source string so the marks stay legible in the file. */
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

/**
 * Case, accent and punctuation folded, so "Ácme, Inc." matches "acme inc".
 * The combining marks NFKD produces have to be deleted rather than left to the
 * alphanumeric filter, which would replace them with a space and split the
 * word it was meant to normalise. Non-Latin scripts fold to empty here, which
 * is why `mentions` never treats an empty needle as a match.
 */
export function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The same folding with spaces removed, which is how brands become domains. */
export function slugify(value: string): string {
  return normalizeText(value).replace(/ /g, "");
}

/**
 * Matches the name as a phrase, or as the run-together form a domain or handle
 * would use. Deliberately not token-wise: "north" and "logistics" appearing in
 * unrelated sentences is not a mention of "Northwind Logistics", and a check
 * that flags on that would be noise a human learns to ignore.
 */
export function mentions(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack) return false;
  const hay = normalizeText(haystack);
  const phrase = normalizeText(needle);
  if (phrase.length === 0) return false;
  if (hay.includes(phrase)) return true;
  const slug = slugify(needle);
  return slug.length >= 4 && hay.replace(/ /g, "").includes(slug);
}

/** Concatenated text of a result, for matching across whichever keys exist. */
export function resultText(record: unknown): string {
  if (!isRecord(record)) return "";
  const parts: string[] = [];
  for (const key of [
    "title",
    "snippet",
    "description",
    "summary",
    "advertiser",
    "brand",
    "assignee",
    "displayed_link",
    "link",
    "source",
    "type",
  ]) {
    const value = record[key];
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) parts.push(value.filter((v) => typeof v === "string").join(" "));
    else if (isRecord(value) && typeof value.name === "string") parts.push(value.name);
  }
  const publication = readPath(record, "publication_info.summary");
  if (typeof publication === "string") parts.push(publication);
  return parts.join(" · ");
}

/** Registrable-looking host of a URL, lowercased, `www.` stripped. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

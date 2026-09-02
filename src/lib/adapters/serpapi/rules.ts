/**
 * Verdict semantics, and the pure functions that produce them.
 *
 * A `DiligenceFinding` answers one question: does this check's condition hold
 * against the live world right now?
 *
 *   clear    The condition holds. For a negatively-phrased check
 *            (`no_adverse_media`) that means we looked and the bad thing was
 *            not there. For a positively-phrased one (`counterparty_exists`)
 *            it means the thing we needed to be true was corroborated.
 *   flagged  The condition demonstrably fails, and the citations say why. It
 *            is a statement about the world, not about our plumbing.
 *   unknown  We could not establish either. The gate treats this exactly like
 *            a denial, which is the only safe reading before an irreversible
 *            act: an agent that registers a domain because a trademark search
 *            timed out has done something no one authorised.
 *
 * The rule that makes `unknown` meaningful is that it is never reachable from
 * a successful lookup. Errors, timeouts, and bodies we cannot read produce
 * `unknown`; a lookup that ran and returned nothing produces `clear` (or, for
 * `counterparty_exists`, `flagged` — nothing found *is* the adverse answer
 * there). Absence of evidence and absence of a search are different facts, and
 * collapsing them is how a diligence engine starts lying.
 *
 * Every function in this file is pure: outcomes in, finding out. No clock, no
 * network, no randomness. A stored bundle of raw SerpApi JSON therefore
 * re-derives the same verdict months later, which is what makes a decision
 * auditable rather than merely logged.
 */

import type { DiligenceCheck, DiligenceFinding } from "../../core/types";
import {
  dedupeCitations,
  firstRecordsAt,
  hostOf,
  isUsableResponse,
  mentions,
  normalizeText,
  readBoolean,
  readNumber,
  readString,
  recordsAt,
  resultText,
  slugify,
  toCitation,
  toCitations,
  type Citation,
} from "./parse";
import type { DiligenceSubject, EngineName, SerpApiJson, SerpApiOutcome } from "./types";

export interface CheckEvidence {
  subject: DiligenceSubject;
  probes: readonly SerpApiOutcome[];
}

/**
 * The blocks that prove a given engine actually answered. Listed per engine
 * because the block name is engine-specific and getting it wrong is silent:
 * a reader that looks for `organic_results` in a `google_scholar_case_law`
 * response sees an empty result set forever, and reports `clear` forever.
 */
export const RESULT_KEYS: Record<EngineName, readonly string[]> = {
  google: ["organic_results", "local_results", "knowledge_graph", "answer_box"],
  google_light: ["organic_results"],
  google_news: ["news_results"],
  google_patents: ["organic_results", "summary"],
  google_scholar_case_law: ["case_results", "organic_results"],
  google_maps: ["place_results", "local_results"],
  google_maps_reviews: ["reviews", "place_info"],
  google_trends: ["interest_over_time", "related_queries"],
  google_ads_transparency_center: ["ad_creatives", "advertisers"],
  amazon: ["organic_results", "product_results"],
  google_finance: ["summary", "markets"],
  google_shopping: ["shopping_results"],
};

/* ----------------------------------------------------------------- helpers */

export function probeFor(
  probes: readonly SerpApiOutcome[],
  engine: EngineName,
): SerpApiOutcome | undefined {
  return probes.find((probe) => probe.engine === engine);
}

/** The body of a probe that both succeeded and returned something readable. */
export function usableJson(
  probes: readonly SerpApiOutcome[],
  engine: EngineName,
): SerpApiJson | null {
  const probe = probeFor(probes, engine);
  if (probe === undefined || !probe.ok) return null;
  return isUsableResponse(probe.json, RESULT_KEYS[engine]) ? probe.json : null;
}

/** Why we could not see, in the words a human would want on a denial screen. */
export function describeFailures(probes: readonly SerpApiOutcome[]): string {
  const notes = probes.map((probe) => {
    if (!probe.ok) return `${probe.engine} ${probe.kind} (${probe.error})`;
    if (!isUsableResponse(probe.json, RESULT_KEYS[probe.engine])) {
      return `${probe.engine} returned no readable result block`;
    }
    return null;
  });
  return notes.filter((note): note is string => note !== null).join("; ");
}

function finding(
  check: DiligenceCheck,
  verdict: DiligenceFinding["verdict"],
  summary: string,
  citations: readonly Citation[] = [],
): DiligenceFinding {
  return { check, verdict, summary, citations: dedupeCitations(citations) };
}

/**
 * The one place `unknown` is minted, so the fail-closed rule has a single
 * definition. Citations are deliberately empty: there is no source to point
 * at, and inventing one to make the UI look complete is the exact failure
 * this product exists to prevent.
 */
function unknownFinding(check: DiligenceCheck, reason: string): DiligenceFinding {
  return finding(check, "unknown", `Could not establish this check: ${reason}.`, []);
}

function subjectLabel(subject: DiligenceSubject): string {
  return subject.legalName && subject.legalName !== subject.name
    ? `${subject.name} (${subject.legalName})`
    : subject.name;
}

function subjectNames(subject: DiligenceSubject): string[] {
  const names = [subject.name];
  if (subject.legalName) names.push(subject.legalName);
  return names;
}

function mentionsSubject(text: string, subject: DiligenceSubject): boolean {
  return subjectNames(subject).some((name) => mentions(text, name));
}

/* ------------------------------------------------------- trademark_clear */

const TRADEMARK_REGISTRY_HOSTS = [
  "uspto.gov",
  "tmsearch.uspto.gov",
  "tsdr.uspto.gov",
  "trademarks.justia.com",
  "trademarkia.com",
  "euipo.europa.eu",
  "tmdn.org",
  "ipo.gov.uk",
  "wipo.int",
  "branddb.wipo.int",
  "ipaustralia.gov.au",
  "cipo.gc.ca",
] as const;

const LIVE_MARK = /\b(live|registered|registration|renewed|published for opposition)\b/i;
const DEAD_MARK = /\b(dead|abandoned|cancell?ed|expired|withdrawn|refused)\b/i;

/**
 * USPTO prints status as the field name "Live/Dead Indicator", which contains
 * both words whatever the answer is. Read the field when it is there; keyword
 * heuristics on that string say "dead" about every live mark in the registry.
 */
const LIVE_DEAD_INDICATOR = /live\s*\/\s*dead\s*indicator\s*[:-]?\s*(live|dead)/i;

export function isLiveMark(text: string): boolean {
  const indicator = LIVE_DEAD_INDICATOR.exec(text);
  if (indicator !== null) return indicator[1].toLowerCase() === "live";
  return LIVE_MARK.test(text) && !DEAD_MARK.test(text);
}

export function isRegistryHost(host: string | null): boolean {
  if (host === null) return false;
  return TRADEMARK_REGISTRY_HOSTS.some((registry) => host === registry || host.endsWith(`.${registry}`));
}

export interface TrademarkHit {
  record: SerpApiJson;
  /** A dead mark is a hit but not a collision, so status travels with it. */
  live: boolean;
}

export function findTrademarkHits(json: SerpApiJson, subject: DiligenceSubject): TrademarkHit[] {
  const hits: TrademarkHit[] = [];
  for (const record of recordsAt(json, "organic_results")) {
    if (!isRegistryHost(hostOf(readString(record, "link")))) continue;
    const text = resultText(record);
    if (!mentionsSubject(text, subject)) continue;
    // A dead mark is not a collision — it is the opposite, evidence the name
    // was released — so status is read rather than assumed from the hit.
    hits.push({ record, live: isLiveMark(text) });
  }
  return hits;
}

/** TTAB oppositions and infringement suits naming the mark. */
export function findTrademarkCases(json: SerpApiJson, subject: DiligenceSubject): SerpApiJson[] {
  return firstRecordsAt(json, ["case_results", "organic_results"]).filter((record) => {
    const text = resultText(record);
    return mentionsSubject(text, subject) && /trademark|trade mark|opposition|infring|ttab|lanham/i.test(text);
  });
}

export function decideTrademarkClear(evidence: CheckEvidence): DiligenceFinding {
  const { subject, probes } = evidence;
  const registry = usableJson(probes, "google");
  const caseLaw = usableJson(probes, "google_scholar_case_law");

  const hits = registry === null ? [] : findTrademarkHits(registry, subject);
  const liveHits = hits.filter((hit) => hit.live);
  const cases = caseLaw === null ? [] : findTrademarkCases(caseLaw, subject);

  if (liveHits.length > 0 || cases.length > 0) {
    const citations = [
      ...toCitations("google", liveHits.map((hit) => hit.record), 3),
      ...toCitations("google_scholar_case_law", cases, 2),
    ];
    const parts: string[] = [];
    if (liveHits.length > 0) {
      const owner = readString(liveHits[0].record, "title") ?? "a registry record";
      parts.push(
        `${liveHits.length} live trademark registry record${liveHits.length === 1 ? "" : "s"} ` +
          `match "${subject.name}" (${owner})`,
      );
    }
    if (cases.length > 0) {
      parts.push(
        `${cases.length} trademark proceeding${cases.length === 1 ? "" : "s"} name${cases.length === 1 ? "s" : ""} it`,
      );
    }
    return finding("trademark_clear", "flagged", `${parts.join("; ")}.`, citations);
  }

  if (registry === null) {
    return unknownFinding(
      "trademark_clear",
      describeFailures(probes) || "the trademark registry sweep returned nothing readable",
    );
  }

  const deadHits = hits.length - liveHits.length;
  const context =
    deadHits > 0
      ? ` ${deadHits} dead or abandoned record${deadHits === 1 ? "" : "s"} matched, which does not block use.`
      : "";
  return finding(
    "trademark_clear",
    "clear",
    `No live trademark registry record matches "${subject.name}" across USPTO, EUIPO and WIPO indexes.${context}`,
    toCitations("google", hits.map((hit) => hit.record), 2),
  );
}

/* ---------------------------------------------------- no_brand_collision */

const DIRECTORY_HOSTS = [
  "linkedin.com",
  "crunchbase.com",
  "bloomberg.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "wikipedia.org",
  "glassdoor.com",
  "indeed.com",
  "yelp.com",
  "opencorporates.com",
  "dnb.com",
  "zoominfo.com",
  "trustpilot.com",
] as const;

function isDirectoryHost(host: string): boolean {
  return DIRECTORY_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

export interface BrandCollisionHits {
  advertisers: SerpApiJson[];
  marketplace: SerpApiJson[];
  /** Sites operating under the exact name, keyed by host so two count as two. */
  operators: Map<string, SerpApiJson>;
  /** Search interest, which corroborates but never decides on its own. */
  trendAverage: number | null;
}

export function findBrandCollisions(
  evidence: CheckEvidence,
): BrandCollisionHits {
  const { subject, probes } = evidence;
  const brandSlug = slugify(subject.name);
  const hits: BrandCollisionHits = {
    advertisers: [],
    marketplace: [],
    operators: new Map(),
    trendAverage: null,
  };

  const ads = usableJson(probes, "google_ads_transparency_center");
  if (ads !== null) {
    for (const record of firstRecordsAt(ads, ["ad_creatives", "advertisers"])) {
      const text = `${readString(record, "advertiser") ?? ""} ${readString(record, "name") ?? ""} ${readString(record, "target_domain") ?? ""}`;
      if (mentions(text, subject.name)) hits.advertisers.push(record);
    }
  }

  const amazon = usableJson(probes, "amazon");
  if (amazon !== null) {
    for (const record of firstRecordsAt(amazon, ["organic_results", "product_results"])) {
      const text = `${readString(record, "title") ?? ""} ${readString(record, "brand") ?? ""}`;
      if (mentions(text, subject.name)) hits.marketplace.push(record);
    }
  }

  const web = usableJson(probes, "google_light");
  if (web !== null) {
    for (const record of recordsAt(web, "organic_results")) {
      const host = hostOf(readString(record, "link"));
      if (host === null) continue;
      const labels = host.split(".");
      const hostForms = new Set([slugify(labels.slice(0, -1).join("")), slugify(labels[0])]);
      const titleLeads = normalizeText(readString(record, "title") ?? "").startsWith(
        normalizeText(subject.name),
      );
      // Either the name is somebody's domain, or it is how somebody titles
      // their own front page. A passing mention in a body snippet is not a
      // collision and is left out on purpose, and neither is a directory
      // entry: a LinkedIn or Crunchbase page is a profile of an operator, not
      // a second operator, so counting it would double the apparent evidence.
      const isOperator =
        hostForms.has(brandSlug) ||
        (titleLeads && brandSlug.length >= 5 && !isDirectoryHost(host));
      if (isOperator && !hits.operators.has(host)) hits.operators.set(host, record);
    }
  }

  const trends = usableJson(probes, "google_trends");
  if (trends !== null) hits.trendAverage = averageTrendValue(trends);

  return hits;
}

function averageTrendValue(json: SerpApiJson): number | null {
  const points = recordsAt(json.interest_over_time, "timeline_data");
  const values: number[] = [];
  for (const point of points) {
    for (const value of recordsAt(point, "values")) {
      const extracted = readNumber(value, "extracted_value") ?? readNumber(value, "value");
      if (extracted !== null) values.push(extracted);
    }
  }
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function decideNoBrandCollision(evidence: CheckEvidence): DiligenceFinding {
  const { subject, probes } = evidence;
  const hits = findBrandCollisions(evidence);
  const operators = [...hits.operators.values()];

  const decisive =
    hits.advertisers.length > 0 || hits.marketplace.length > 0 || operators.length > 0;

  if (decisive) {
    const parts: string[] = [];
    if (operators.length > 0) {
      parts.push(
        `${operators.length} ${operators.length === 1 ? "site already operates" : "sites already operate"} ` +
          `under "${subject.name}" (${[...hits.operators.keys()].slice(0, 3).join(", ")})`,
      );
    }
    if (hits.advertisers.length > 0) {
      const advertiser = readString(hits.advertisers[0], "advertiser") ?? "an advertiser";
      parts.push(`${advertiser} is running live ads on the name`);
    }
    if (hits.marketplace.length > 0) {
      parts.push(`${hits.marketplace.length} marketplace listings sell under it`);
    }
    if (hits.trendAverage !== null && hits.trendAverage > 0) {
      parts.push(`search interest averages ${Math.round(hits.trendAverage)}/100`);
    }
    return finding(
      "no_brand_collision",
      "flagged",
      `${parts.join("; ")}.`,
      [
        ...toCitations("google_light", operators, 2),
        ...toCitations("google_ads_transparency_center", hits.advertisers, 2),
        ...toCitations("amazon", hits.marketplace, 2),
      ],
    );
  }

  // Any one of the three commercial sweeps is enough to answer the question;
  // requiring all three would turn a partial outage into a denial.
  const anySweepRan =
    usableJson(probes, "google_light") !== null ||
    usableJson(probes, "google_ads_transparency_center") !== null ||
    usableJson(probes, "amazon") !== null;
  if (!anySweepRan) {
    return unknownFinding(
      "no_brand_collision",
      describeFailures(probes) || "no commercial-use sweep returned a readable result",
    );
  }

  const trendNote =
    hits.trendAverage !== null && hits.trendAverage > 0
      ? ` Search interest in the term averages ${Math.round(hits.trendAverage)}/100, which is generic-term traffic rather than an identified operator.`
      : "";
  return finding(
    "no_brand_collision",
    "clear",
    `No operator, advertiser or marketplace seller was found trading as "${subject.name}".${trendNote}`,
  );
}

/* -------------------------------------------------- counterparty_exists */

const CORROBORATING_HOSTS = [
  "linkedin.com",
  "opencorporates.com",
  "crunchbase.com",
  "bloomberg.com",
  "sec.gov",
  "companieshouse.gov.uk",
  "dnb.com",
  "sam.gov",
] as const;

export interface CounterpartySignals {
  corroborations: SerpApiJson[];
  place: SerpApiJson | null;
  /** An unclaimed listing means nobody at the business has ever answered for it. */
  unclaimedListing: boolean;
  reviewSpike: SerpApiJson[];
  finance: SerpApiJson | null;
}

export function readCounterpartySignals(evidence: CheckEvidence): CounterpartySignals {
  const { subject, probes } = evidence;
  const signals: CounterpartySignals = {
    corroborations: [],
    place: null,
    unclaimedListing: false,
    reviewSpike: [],
    finance: null,
  };

  const web = usableJson(probes, "google");
  if (web !== null) {
    for (const record of recordsAt(web, "organic_results")) {
      const host = hostOf(readString(record, "link"));
      if (host === null) continue;
      const known = CORROBORATING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
      if (known && mentionsSubject(resultText(record), subject)) signals.corroborations.push(record);
    }
  }

  const maps = usableJson(probes, "google_maps");
  if (maps !== null) {
    const place =
      (maps.place_results && typeof maps.place_results === "object" && !Array.isArray(maps.place_results)
        ? (maps.place_results as SerpApiJson)
        : null) ??
      recordsAt(maps, "local_results").find((record) =>
        mentionsSubject(resultText(record), subject),
      ) ??
      null;
    if (place !== null) {
      signals.place = place;
      signals.unclaimedListing = readBoolean(place, "unclaimed_listing") === true;
    }
  }

  const reviews = usableJson(probes, "google_maps_reviews");
  if (reviews !== null) signals.reviewSpike = findReviewSpike(reviews);

  const finance = usableJson(probes, "google_finance");
  if (finance !== null) {
    const summary = finance.summary;
    if (summary && typeof summary === "object" && !Array.isArray(summary)) {
      const record = summary as SerpApiJson;
      if (mentionsSubject(resultText(record), subject)) signals.finance = record;
    }
  }

  return signals;
}

const REVIEW_SPIKE_WINDOW = 5;
const REVIEW_SPIKE_THRESHOLD = 3;

/**
 * Reviews are requested with `sort_by=newestFirst`, so the head of the array
 * is the present rather than the all-time average. A four-star lifetime score
 * hides a business that collapsed last month; three one-star reviews at the
 * top of the newest page do not.
 */
export function findReviewSpike(json: SerpApiJson): SerpApiJson[] {
  const reviews = recordsAt(json, "reviews").slice(0, REVIEW_SPIKE_WINDOW);
  if (reviews.length < REVIEW_SPIKE_THRESHOLD) return [];
  const negative = reviews.filter((review) => {
    const rating = readNumber(review, "rating");
    return rating !== null && rating <= 2;
  });
  return negative.length >= REVIEW_SPIKE_THRESHOLD ? negative : [];
}

export function decideCounterpartyExists(evidence: CheckEvidence): DiligenceFinding {
  const { subject, probes } = evidence;
  const signals = readCounterpartySignals(evidence);
  const label = subjectLabel(subject);

  if (signals.unclaimedListing || signals.reviewSpike.length > 0) {
    const parts: string[] = [];
    const citations: Citation[] = [];
    if (signals.unclaimedListing && signals.place !== null) {
      const title = readString(signals.place, "title") ?? label;
      parts.push(
        `the Google Maps listing for ${title} is unclaimed, so no one at the business has ever verified it`,
      );
      const citation = toCitation("google_maps", signals.place);
      if (citation !== null) citations.push(citation);
    }
    if (signals.reviewSpike.length > 0) {
      parts.push(
        `${signals.reviewSpike.length} of the ${REVIEW_SPIKE_WINDOW} most recent reviews are one or two stars`,
      );
      citations.push(...toCitations("google_maps_reviews", signals.reviewSpike, 2));
    }
    return finding(
      "counterparty_exists",
      "flagged",
      `${label} is present but not in good standing: ${parts.join("; ")}.`,
      citations,
    );
  }

  const corroborated =
    signals.corroborations.length > 0 || signals.place !== null || signals.finance !== null;
  if (corroborated) {
    const parts: string[] = [];
    if (signals.place !== null) {
      const rating = readNumber(signals.place, "rating");
      const reviews = readNumber(signals.place, "reviews");
      parts.push(
        `a claimed Google Maps listing${rating !== null ? ` rated ${rating}` : ""}` +
          `${reviews !== null ? ` across ${reviews} reviews` : ""}`,
      );
    }
    if (signals.corroborations.length > 0) {
      const hosts = signals.corroborations
        .map((record) => hostOf(readString(record, "link")))
        .filter((host): host is string => host !== null);
      parts.push(`records on ${[...new Set(hosts)].slice(0, 3).join(", ")}`);
    }
    if (signals.finance !== null) {
      const exchange = readString(signals.finance, "exchange");
      parts.push(`a listed security${exchange !== null ? ` on ${exchange}` : ""}`);
    }
    return finding(
      "counterparty_exists",
      "clear",
      `${label} is corroborated by ${parts.join(", ")}.`,
      [
        ...toCitations("google", signals.corroborations, 2),
        ...(signals.place !== null ? toCitations("google_maps", [signals.place], 1) : []),
        ...(signals.finance !== null ? toCitations("google_finance", [signals.finance], 1) : []),
      ],
    );
  }

  // Nothing found is only an answer if the looking actually happened.
  const anySweepRan =
    usableJson(probes, "google") !== null || usableJson(probes, "google_maps") !== null;
  if (!anySweepRan) {
    return unknownFinding(
      "counterparty_exists",
      describeFailures(probes) || "no entity sweep returned a readable result",
    );
  }

  return finding(
    "counterparty_exists",
    "flagged",
    `No corporate register, professional profile, business listing or securities record was found for ${label}.`,
  );
}

/* ----------------------------------------------------- no_adverse_media */

export const ADVERSE_TERMS = [
  "fraud",
  "fraudulent",
  "lawsuit",
  "sued",
  "indicted",
  "indictment",
  "criminal charges",
  "investigation",
  "probe",
  "bankruptcy",
  "insolvency",
  "liquidation",
  "receivership",
  "sanctions",
  "money laundering",
  "embezzlement",
  "scam",
  "data breach",
  "recall",
  "misconduct",
  "class action",
  "sec charges",
  "ftc complaint",
  "injunction",
  "cease and desist",
  "convicted",
  "guilty plea",
  "wire fraud",
  "ponzi",
  "winding up",
] as const;

/**
 * Whole words only, with an optional plural. Substring matching would read
 * "issued" as "sued" and "misconduct" out of "misconducted" — a diligence
 * engine that cries fraud at a registration notice gets switched off, and a
 * check nobody trusts protects nothing.
 */
const ADVERSE_PATTERN = new RegExp(`\\b(?:${ADVERSE_TERMS.join("|")})s?\\b`, "i");

export function findAdverseCoverage(
  json: SerpApiJson,
  subject: DiligenceSubject,
  resultKeys: readonly string[],
): SerpApiJson[] {
  return firstRecordsAt(json, resultKeys).filter((record) => {
    const text = resultText(record);
    if (!mentionsSubject(text, subject)) return false;
    return ADVERSE_PATTERN.test(normalizeText(text));
  });
}

export function decideNoAdverseMedia(evidence: CheckEvidence): DiligenceFinding {
  const { subject, probes } = evidence;
  const news = usableJson(probes, "google_news");
  const web = usableJson(probes, "google");

  const newsHits = news === null ? [] : findAdverseCoverage(news, subject, ["news_results"]);
  const webHits = web === null ? [] : findAdverseCoverage(web, subject, ["organic_results"]);

  if (newsHits.length > 0 || webHits.length > 0) {
    const headline =
      readString(newsHits[0] ?? webHits[0], "title") ?? "an adverse report";
    return finding(
      "no_adverse_media",
      "flagged",
      `${newsHits.length + webHits.length} adverse report${newsHits.length + webHits.length === 1 ? "" : "s"} ` +
        `mention ${subjectLabel(subject)}, including "${headline}".`,
      [...toCitations("google_news", newsHits, 3), ...toCitations("google", webHits, 2)],
    );
  }

  if (news === null && web === null) {
    return unknownFinding(
      "no_adverse_media",
      describeFailures(probes) || "the news sweep returned nothing readable",
    );
  }

  // google_news has no pagination of any kind, so this sentence is scoped to
  // what one response can honestly claim. Saying "no adverse coverage exists"
  // would be a claim about the whole corpus that a single page cannot support.
  return finding(
    "no_adverse_media",
    "clear",
    `No adverse coverage of ${subjectLabel(subject)} appears in the current Google News front page or top web results.`,
    news === null ? [] : toCitations("google_news", recordsAt(news, "news_results"), 2),
  );
}

/* ------------------------------------------------ no_patent_litigation */

const LITIGATION_TERMS = /infring|litigat|patent dispute|inter partes|ptab|invalidat|injunction/i;

export function findLitigatedPatents(json: SerpApiJson, subject: DiligenceSubject): SerpApiJson[] {
  return recordsAt(json, "organic_results").filter((record) => {
    // The query is already scoped by `litigation`, so a result naming the
    // subject as assignee is itself the finding; the text test only catches
    // the case where the parameter was ignored upstream.
    const text = resultText(record);
    if (!mentionsSubject(text, subject)) return false;
    return (
      readBoolean(record, "litigation") === true ||
      recordsAt(record, "litigations").length > 0 ||
      LITIGATION_TERMS.test(text) ||
      readString(record, "assignee") !== null
    );
  });
}

export function findPatentCases(json: SerpApiJson, subject: DiligenceSubject): SerpApiJson[] {
  return firstRecordsAt(json, ["case_results", "organic_results"]).filter((record) => {
    const text = resultText(record);
    return mentionsSubject(text, subject) && /patent|infring|inter partes|ptab/i.test(text);
  });
}

export function decideNoPatentLitigation(evidence: CheckEvidence): DiligenceFinding {
  const { subject, probes } = evidence;
  const patents = usableJson(probes, "google_patents");
  const caseLaw = usableJson(probes, "google_scholar_case_law");

  const patentHits = patents === null ? [] : findLitigatedPatents(patents, subject);
  const caseHits = caseLaw === null ? [] : findPatentCases(caseLaw, subject);

  if (patentHits.length > 0 || caseHits.length > 0) {
    const parts: string[] = [];
    if (patentHits.length > 0) {
      const assignee = readString(patentHits[0], "assignee") ?? subject.name;
      parts.push(
        `${patentHits.length} patent${patentHits.length === 1 ? "" : "s"} in litigation are assigned to ${assignee}`,
      );
    }
    if (caseHits.length > 0) {
      const title = readString(caseHits[0], "title") ?? "a reported case";
      parts.push(`case law names it in a patent dispute ("${title}")`);
    }
    return finding(
      "no_patent_litigation",
      "flagged",
      `${parts.join("; ")}.`,
      [
        ...toCitations("google_patents", patentHits, 3),
        ...toCitations("google_scholar_case_law", caseHits, 2),
      ],
    );
  }

  if (patents === null && caseLaw === null) {
    return unknownFinding(
      "no_patent_litigation",
      describeFailures(probes) || "the patent litigation sweep returned nothing readable",
    );
  }

  return finding(
    "no_patent_litigation",
    "clear",
    `Google Patents' litigation filter and Google Scholar case law return no patent dispute involving ${subjectLabel(subject)}.`,
  );
}

/* ---------------------------------------------------------------- dispatch */

export const DECIDERS: Record<DiligenceCheck, (evidence: CheckEvidence) => DiligenceFinding> = {
  trademark_clear: decideTrademarkClear,
  no_brand_collision: decideNoBrandCollision,
  counterparty_exists: decideCounterpartyExists,
  no_adverse_media: decideNoAdverseMedia,
  no_patent_litigation: decideNoPatentLitigation,
};

export function decide(check: DiligenceCheck, evidence: CheckEvidence): DiligenceFinding {
  return DECIDERS[check](evidence);
}

/** Exported so a caller that only has findings can still fail closed on them. */
export function isBlocking(finding: DiligenceFinding): boolean {
  return finding.verdict !== "clear";
}

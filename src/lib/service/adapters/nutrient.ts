/**
 * `TermsExtractor`, backed by Nutrient DWS.
 *
 * Three vendor calls' worth of work happen here in one port method: extract
 * against the writ schema, ground the result against the citations that came
 * back with it, and project the two into an `EnforceablePolicy`.
 *
 * The projection is the part that has to be right, and it is not a rename.
 * `WRIT_EXTRACTION_SCHEMA` hoists limits and conditions to the root and links
 * them back by the printed clause reference, because nesting them inside each
 * grant would put their scalar fields past Nutrient's five-level cap. So the
 * extraction speaks in `/limits/2/max` and the gatekeeper speaks in
 * `/grants/0/limits/1/max`, and `EnforceablePolicy.ungrounded` is read by the
 * gatekeeper with a literal `pointer.startsWith("/grants/0/")`.
 *
 * That makes the pointer rewrite load-bearing rather than cosmetic: an
 * ungrounded `/limits/2/max` left in the extractor's own pointer space matches
 * no grant, is silently ignored, and a cap nobody could read becomes a clause
 * with no cap at all. Every rewrite below therefore either lands a term on the
 * clause it constrains or, when the row could not be attributed to one clause,
 * lands it on every clause — because a cap that might have belonged to any of
 * them must not be dropped from all of them.
 */

import { digest } from "../../core/canonical";
import {
  ACT_KINDS,
  type ActKind,
  type Condition,
  type DiligenceCheck,
  type EnforceablePolicy,
  type Grant,
  type Limit,
  type MatchKind,
  type Provenance,
  type Writ,
} from "../../core/types";
import {
  DEFAULT_GROUNDED_MATCHES,
  groundExtraction,
  splitDelimitedList,
  WRIT_EXTRACTION_INSTRUCTIONS,
  WRIT_EXTRACTION_SCHEMA,
  writRequiredPointers,
  type ExtractionClient,
  type ExtractionMode,
  type GroundingReport,
  type WritExtraction,
  type WritExtractionCondition,
  type WritExtractionLimit,
} from "../../adapters/nutrient";
import type {
  ExtractionOutcome,
  SignedDocument,
  TermsExtractor,
} from "../ports";

export interface NutrientTermsExtractorOptions {
  /**
   * `structure` is documented as unreliable for key-value work, and `agentic`
   * costs twice as much per page. `understand` is the mode the grounding gate
   * was calibrated against.
   */
  mode?: ExtractionMode;
  /** Which `match` kinds count as grounded. Defaults to the three `id_match` variants. */
  acceptedMatches?: readonly MatchKind[];
  /**
   * Secondary filter on the citation's confidence, applied only where a score is
   * present. No default, because Nutrient documents the number as uncalibrated
   * and any constant chosen here would be a fiction.
   */
  confidenceThreshold?: number | null;
  /** Reject a field whose citation carries no score at all. Off by default. */
  rejectMissingConfidence?: boolean;
}

export class NutrientTermsExtractor implements TermsExtractor {
  constructor(
    private readonly client: ExtractionClient,
    private readonly options: NutrientTermsExtractorOptions = {},
  ) {}

  async extractTerms(
    signed: SignedDocument,
    expected: { writId: string },
  ): Promise<ExtractionOutcome> {
    const mode = this.options.mode ?? "understand";
    const accepted = this.options.acceptedMatches ?? DEFAULT_GROUNDED_MATCHES;
    const confidenceThreshold = this.options.confidenceThreshold ?? null;

    const response = await this.client.extract<WritExtraction>({
      file: {
        bytes: signed.bytes,
        filename: `${expected.writId}.pdf`,
        contentType: "application/pdf",
      },
      schema: WRIT_EXTRACTION_SCHEMA,
      instructions: WRIT_EXTRACTION_INSTRUCTIONS,
      parseConfig: { mode },
      // Without citations there is nothing for the grounding gate to read, and
      // an ungrounded clause would be indistinguishable from a grounded one.
      options: { includeCitations: true },
    });

    const output = response.data.output;
    const report = groundExtraction(output, {
      requiredPointers: writRequiredPointers(output.data),
      acceptedMatches: accepted,
      confidenceThreshold,
      onMissingConfidence: this.options.rejectMissingConfidence === true ? "reject" : "accept",
    });

    const projection = projectWrit(output.data, expected.writId);
    const policy: EnforceablePolicy = {
      writ: projection.writ,
      provenance: rewriteProvenance(report, projection.rewrite),
      ungrounded: [
        ...rewritePointers(report.ungrounded, projection.rewrite),
        ...projection.unreadable,
      ],
      // Bound to the bytes we were handed, never to a field in a vendor
      // response. `Chancery.collectSignature` refuses to store terms whose hash
      // does not match the document they claim to come from.
      documentHash: signed.sha256,
    };

    const { requestCost, remainingCredits } = response.meta;
    return {
      policy,
      responseDigest: digest(response.data),
      method: `nutrient/${mode}`,
      groundingPolicy: {
        acceptedMatches: [...accepted],
        confidenceThreshold,
      },
      ...(typeof requestCost === "number" && typeof remainingCredits === "number"
        ? { cost: { charged: requestCost, remaining: remainingCredits } }
        : {}),
    };
  }
}

/* ------------------------------------------------------------ the projection */

/** One extraction pointer maps to zero, one, or several policy pointers. */
type Rewrite = (pointer: string) => string[];

interface Projection {
  writ: Writ;
  rewrite: Rewrite;
  /**
   * Terms that named a clause but could not be read as a term of any kind. They
   * are not in `report.ungrounded` — grounding says the characters were on the
   * page — but a cap whose type we cannot interpret is a cap we cannot enforce,
   * and leaving it out would widen the clause it belongs to.
   */
  unreadable: string[];
}

export function projectWrit(data: WritExtraction, writId: string): Projection {
  const grants: Grant[] = [];
  /** extraction grant index -> policy grant pointer. */
  const grantPointers = new Map<number, string>();
  /** `/limits/3` or `/conditions/1` -> the policy pointers it became. */
  const rowPointers = new Map<string, string[]>();
  const unreadable: string[] = [];

  (data.grants ?? []).forEach((row, index) => {
    const actKind = asActKind(row?.actKind);
    // A clause whose act we could not read permits nothing, so leaving it out
    // narrows the policy rather than widening it. Its own ungrounded pointers
    // then rewrite to nothing, which is correct: there is no clause to deny.
    if (actKind === null) return;
    const position = grants.length;
    grantPointers.set(index, `/grants/${position}`);
    grants.push({
      ref: typeof row?.ref === "string" ? row.ref.trim() : "",
      actKind,
      limits: [],
      conditions: [],
    });
  });

  // A clause with no readable reference cannot have a hoisted cap attached to
  // it, and `expandPointer` reports nothing for a key the document never
  // produced — so the missing ref is recorded here rather than relied upon.
  grants.forEach((grant, position) => {
    if (grant.ref.length === 0) unreadable.push(`/grants/${position}/ref`);
  });

  attach(
    data.limits,
    "limits",
    grants,
    rowPointers,
    unreadable,
    toLimit,
    (grant, limit) => grant.limits.push(limit),
    (grant) => grant.limits.length,
  );

  attach(
    data.conditions,
    "conditions",
    grants,
    rowPointers,
    unreadable,
    toCondition,
    (grant, condition) => grant.conditions.push(condition),
    (grant) => grant.conditions.length,
  );

  const writ: Writ = {
    id: writId,
    // The instrument carries no version field, and the schema does not ask for
    // one. Reporting 1 states what we know: this is the terms of one document.
    version: 1,
    principal: {
      id: derivedId("prn", data.principal?.legalName ?? writId),
      legalName: text(data.principal?.legalName),
      email: text(data.principal?.email),
      // Nothing in a signed PDF corroborates a legal entity, so this is false
      // until something that actually checked says otherwise.
      entityVerified: false,
    },
    agent: {
      id: derivedId("agent", data.agent?.domain ?? writId),
      label: text(data.agent?.label) || text(data.agent?.domain),
      domain: text(data.agent?.domain),
      publicKey: text(data.agent?.publicKey),
    },
    grants,
    effectiveFrom: isoInstant(data.effectiveFrom),
    expiresAt: isoInstant(data.expiresAt),
    jurisdiction: text(data.jurisdiction),
  };

  return { writ, unreadable, rewrite: rewriter(grantPointers, rowPointers) };
}

/**
 * Re-attaches a hoisted row to the clause it names.
 *
 * Three outcomes, and the middle one is the one that matters: a row whose
 * `grantRef` did not read is attributed to *every* clause as an unreadable
 * term, because a cap that might have constrained any of them must not end up
 * constraining none of them.
 */
function attach<Row extends { grantRef?: string }, Built>(
  rows: Row[] | undefined,
  section: "limits" | "conditions",
  grants: Grant[],
  rowPointers: Map<string, string[]>,
  unreadable: string[],
  build: (row: Row) => Built | null,
  push: (grant: Grant, built: Built) => void,
  countOf: (grant: Grant) => number,
): void {
  if (!Array.isArray(rows)) return;

  rows.forEach((row, index) => {
    const from = `/${section}/${index}`;
    const ref = typeof row?.grantRef === "string" ? row.grantRef.trim() : "";

    if (ref.length === 0) {
      // Unattributable. Every clause carries it as unreadable, which denies
      // every clause rather than quietly widening all of them.
      for (let position = 0; position < grants.length; position += 1) {
        unreadable.push(`/grants/${position}/${section}/unattributed-${index}`);
      }
      return;
    }

    const targets = grants
      .map((grant, position) => (grant.ref === ref ? position : -1))
      .filter((position) => position >= 0);
    // A `grantRef` naming no clause binds to nothing, which cannot widen
    // anything: there is no clause in the policy for it to have constrained.
    if (targets.length === 0) return;

    const built = build(row);
    const landed: string[] = [];
    for (const position of targets) {
      const grant = grants[position];
      if (built === null) {
        unreadable.push(`/grants/${position}/${section}/unreadable-${index}`);
        continue;
      }
      landed.push(`/grants/${position}/${section}/${countOf(grant)}`);
      push(grant, built);
    }
    if (landed.length > 0) rowPointers.set(from, landed);
  });
}

function rewriter(
  grantPointers: Map<number, string>,
  rowPointers: Map<string, string[]>,
): Rewrite {
  const ROW = /^\/(limits|conditions)\/(\d+)(\/.*)?$/;
  const GRANT = /^\/grants\/(\d+)(\/.*)?$/;

  return (pointer: string): string[] => {
    const row = ROW.exec(pointer);
    if (row !== null) {
      const landed = rowPointers.get(`/${row[1]}/${row[2]}`);
      if (landed !== undefined) return landed.map((base) => `${base}${row[3] ?? ""}`);
      // The row never landed on a clause. If it named none, every clause has
      // already been marked unreadable; if it named one that does not exist,
      // there is no clause to deny. Either way there is nothing to carry over.
      return [];
    }

    const grant = GRANT.exec(pointer);
    if (grant !== null) {
      const base = grantPointers.get(Number(grant[1]));
      return base === undefined ? [] : [`${base}${grant[2] ?? ""}`];
    }

    // `/principal/legalName`, `/effectiveFrom` and friends sit in the same place
    // in both shapes.
    return [pointer];
  };
}

function rewritePointers(pointers: readonly string[], rewrite: Rewrite): string[] {
  const out = new Set<string>();
  for (const pointer of pointers) {
    for (const mapped of rewrite(pointer)) out.add(mapped);
  }
  return [...out];
}

function rewriteProvenance(
  report: GroundingReport,
  rewrite: Rewrite,
): Record<string, Provenance> {
  const out: Record<string, Provenance> = {};
  for (const [pointer, provenance] of Object.entries(report.provenance)) {
    for (const mapped of rewrite(pointer)) {
      out[mapped] = { ...provenance, pointer: mapped };
    }
  }
  return out;
}

/* --------------------------------------------------------------- the rows */

const WINDOWS = new Set(["total", "day", "month"]);
const CHECKS = new Set<string>([
  "trademark_clear",
  "no_brand_collision",
  "counterparty_exists",
  "no_adverse_media",
  "no_patent_litigation",
]);

/**
 * Strict on purpose. A partially-read cap is not a cap, and filling in the
 * missing half with a default would be inventing a term the human never signed.
 */
export function toLimit(row: WritExtractionLimit): Limit | null {
  switch (row?.type) {
    case "count":
      return Number.isFinite(row.max) && isWindow(row.window)
        ? { type: "count", max: Number(row.max), window: row.window }
        : null;

    case "amount":
      return Number.isFinite(row.maxMinorUnits) && isWindow(row.window) && text(row.currency) !== ""
        ? {
            type: "amount",
            maxMinorUnits: Number(row.maxMinorUnits),
            currency: text(row.currency),
            window: row.window,
          }
        : null;

    case "allowlist": {
      const values = splitDelimitedList(row.values);
      return text(row.field) !== "" && values.length > 0
        ? { type: "allowlist", field: text(row.field), values }
        : null;
    }

    case "pattern":
      return text(row.field) !== "" && text(row.pattern) !== ""
        ? { type: "pattern", field: text(row.field), pattern: text(row.pattern) }
        : null;

    default:
      return null;
  }
}

export function toCondition(row: WritExtractionCondition): Condition | null {
  switch (row?.type) {
    case "diligence":
      return isCheck(row.check) ? { type: "diligence", check: row.check } : null;

    case "jurisdiction": {
      const allowed = splitDelimitedList(row.jurisdictions);
      return allowed.length > 0 ? { type: "jurisdiction", allowed } : null;
    }

    case "escalation":
      return Number.isFinite(row.aboveMinorUnits) && text(row.currency) !== ""
        ? {
            type: "escalation",
            aboveMinorUnits: Number(row.aboveMinorUnits),
            currency: text(row.currency),
          }
        : null;

    default:
      return null;
  }
}

function isWindow(value: unknown): value is "total" | "day" | "month" {
  return typeof value === "string" && WINDOWS.has(value);
}

function isCheck(value: unknown): value is DiligenceCheck {
  return typeof value === "string" && CHECKS.has(value);
}

function asActKind(value: unknown): ActKind | null {
  return typeof value === "string" && (ACT_KINDS as readonly string[]).includes(value)
    ? (value as ActKind)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The schema has no `format: "date-time"`, so a date grounds as `2026-09-01`.
 * Widening it to the instant `Date.parse` already reads it as loses nothing; a
 * value that is not a bare date is passed through untouched, and an unreadable
 * one denies in the gate rather than being repaired here.
 */
function isoInstant(value: unknown): string {
  const raw = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
}

/** The signed document carries no ids, so they are derived from what it does carry. */
function derivedId(prefix: string, source: string): string {
  const slug = source.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return `${prefix}_${slug.length > 0 ? slug.slice(0, 48) : "unnamed"}`;
}

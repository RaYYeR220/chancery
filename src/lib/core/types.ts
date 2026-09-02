/**
 * Core domain types.
 *
 * A `Writ` is an instrument of delegated authority: a human signs it, and it
 * says exactly which irreversible acts an agent may commit to on their behalf.
 *
 * The important property of this file is that nothing in it does I/O. The
 * decision engine is a pure function of (policy, act, history, diligence), so
 * every verdict is reproducible from the evidence bundle alone.
 */

/** An act that cannot be undone once executed. These are the only gated acts. */
export type ActKind =
  | "domain.register"
  | "domain.renew"
  | "domain.transfer"
  | "dns.write"
  | "document.send_for_signature"
  | "document.publish";

export const ACT_KINDS: readonly ActKind[] = [
  "domain.register",
  "domain.renew",
  "domain.transfer",
  "dns.write",
  "document.send_for_signature",
  "document.publish",
] as const;

/** Reversible work the agent does freely; listed so the UI can show the contrast. */
export type ReversibleKind =
  | "document.generate"
  | "document.convert"
  | "document.ocr"
  | "domain.search"
  | "diligence.run";

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Grounding strength of an extracted field, mirroring Nutrient's `match` enum.
 * We gate primarily on this rather than on the numeric confidence, because
 * Nutrient documents `confidence` as "a relative, uncalibrated signal" that is
 * explicitly not a probability.
 */
export type MatchKind =
  | "id_match"
  | "id_match_multiblock"
  | "id_match_partial"
  | "fuzzy_match"
  | "not_found";

/** Where a single policy field came from in the signed document. */
export interface Provenance {
  /** JSON pointer into the policy object, e.g. `/grants/0/limits/1/maxUsd`. */
  pointer: string;
  match: MatchKind;
  /** Null when the extractor returned no score. Absence is NOT low confidence. */
  confidence: number | null;
  pageNumber: number | null;
  bbox: BBox | null;
  blockIds: string[];
}

export interface PrincipalRef {
  id: string;
  legalName: string;
  email: string;
  /** Set once the principal's legal entity has been corroborated against live web data. */
  entityVerified: boolean;
}

export interface AgentRef {
  id: string;
  label: string;
  /** The DNS name the writ is anchored under, e.g. `ops.example.com`. */
  domain: string;
  /** base64url ed25519 public key. */
  publicKey: string;
}

/* ------------------------------------------------------------------ limits */

/** A cap on how many times an act may be performed. */
export interface CountLimit {
  type: "count";
  max: number;
  window: "total" | "day" | "month";
}

/** A cap on cumulative spend. */
export interface AmountLimit {
  type: "amount";
  maxMinorUnits: number;
  currency: string;
  window: "total" | "day" | "month";
}

/** The value at `field` must be one of `values`. */
export interface AllowlistLimit {
  type: "allowlist";
  field: string;
  values: string[];
}

/** The value at `field` must match `pattern`. */
export interface PatternLimit {
  type: "pattern";
  field: string;
  pattern: string;
}

export type Limit = CountLimit | AmountLimit | AllowlistLimit | PatternLimit;

/* -------------------------------------------------------------- conditions */

/**
 * A check against the live world rather than against the writ. Scope answers
 * "was this permitted?"; a condition answers "is it still a sane thing to do?".
 */
export type DiligenceCheck =
  | "trademark_clear"
  | "no_brand_collision"
  | "counterparty_exists"
  | "no_adverse_media"
  | "no_patent_litigation";

export interface DiligenceCondition {
  type: "diligence";
  check: DiligenceCheck;
}

export interface JurisdictionCondition {
  type: "jurisdiction";
  allowed: string[];
}

/** Above this value the act needs a fresh human decision, not just the writ. */
export interface EscalationCondition {
  type: "escalation";
  aboveMinorUnits: number;
  currency: string;
}

export type Condition =
  | DiligenceCondition
  | JurisdictionCondition
  | EscalationCondition;

/* ------------------------------------------------------------------- grant */

export interface Grant {
  /** Clause reference as printed in the signed document, e.g. "3(b)". */
  ref: string;
  actKind: ActKind;
  limits: Limit[];
  conditions: Condition[];
}

export interface Writ {
  id: string;
  version: number;
  principal: PrincipalRef;
  agent: AgentRef;
  grants: Grant[];
  /** ISO-8601. */
  effectiveFrom: string;
  /** ISO-8601. */
  expiresAt: string;
  jurisdiction: string;
}

/**
 * A writ plus the grounding evidence for every field, plus the set of pointers
 * that failed the grounding gate. Anything listed in `ungrounded` is treated as
 * absent, which means the act it would have permitted is denied.
 */
export interface EnforceablePolicy {
  writ: Writ;
  provenance: Record<string, Provenance>;
  ungrounded: string[];
  /** sha256 of the signed PDF these terms were extracted from, base64url. */
  documentHash: string;
}

/* ---------------------------------------------------------------- requests */

export interface ActRequest {
  kind: ActKind;
  /** Flat field bag the limits address, e.g. `{ tld: "com", domainName: "..." }`. */
  fields: Record<string, string | number | boolean>;
  /** Cost of this act, when it spends money. */
  amountMinorUnits?: number;
  currency?: string;
  requestedAt: string;
}

/** One previously executed act, used to evaluate cumulative limits. */
export interface ActHistoryEntry {
  kind: ActKind;
  grantRef: string;
  amountMinorUnits: number;
  currency: string;
  executedAt: string;
}

export interface DiligenceFinding {
  check: DiligenceCheck;
  /** `clear` passes the condition; `flagged` fails it; `unknown` fails closed. */
  verdict: "clear" | "flagged" | "unknown";
  summary: string;
  /** Live sources the verdict was derived from. */
  citations: { title: string; url: string; engine: string }[];
}

/* --------------------------------------------------------------- decisions */

export type DenyCode =
  | "NO_WRIT"
  | "WRIT_NOT_YET_EFFECTIVE"
  | "WRIT_EXPIRED"
  | "WRIT_REVOKED"
  | "DOCUMENT_HASH_MISMATCH"
  | "SIGNATURE_INVALID"
  | "CLAUSE_UNGROUNDED"
  | "ACT_NOT_GRANTED"
  | "COUNT_LIMIT_EXCEEDED"
  | "AMOUNT_LIMIT_EXCEEDED"
  | "VALUE_NOT_ALLOWLISTED"
  | "VALUE_PATTERN_MISMATCH"
  | "DILIGENCE_FLAGGED"
  | "DILIGENCE_UNKNOWN"
  | "OUT_OF_JURISDICTION"
  | "ESCALATION_REQUIRED"
  | "INTERNAL_FAIL_CLOSED";

export interface DecisionReason {
  code: DenyCode | "GRANTED";
  /** One sentence a non-engineer can read. */
  message: string;
  /** Clause reference in the signed document, when one applies. */
  clauseRef?: string;
  /** Where to look in the PDF, so the UI can point at it. */
  pageNumber?: number;
  bbox?: BBox;
}

export interface Decision {
  outcome: "allow" | "deny";
  reasons: DecisionReason[];
  writId: string | null;
  documentHash: string | null;
  evaluatedAt: string;
  /** Everything the verdict was derived from, so it can be re-derived offline. */
  evidence: {
    actRequest: ActRequest;
    historyCount: number;
    diligence: DiligenceFinding[];
  };
}

/**
 * The seams between the decision engine and the outside world.
 *
 * Each port is the narrowest thing the orchestrator needs, not a mirror of the
 * vendor API behind it. That keeps the vendors swappable, keeps the
 * orchestrator testable with fakes, and — more usefully here — makes it
 * obvious at a glance which vendor is load-bearing for which step, because each
 * one owns exactly one port.
 *
 *   DocumentGenerator  -> Doctavian   the writ is generated with branching terms
 *   SignatureService   -> Foxit eSign a human, and only a human, signs it
 *   TermsExtractor     -> Nutrient    the signed PDF is read back into policy
 *   DomainRegistry     -> name.com    registration, and the DNS anchor
 *   WritResolver       -> public DNS  authority is resolved from DNS, never from us
 *   DiligenceService   -> SerpApi     the act is checked against the live world
 *   WritStore          -> Xano        registry, ledger and act history of record
 */

import type {
  ActHistoryEntry,
  ActKind,
  ActRequest,
  DiligenceCheck,
  DiligenceFinding,
  EnforceablePolicy,
  Grant,
  Writ,
} from "../core/types";
import type { EvidenceBundle } from "../core/evidence";
import type { LedgerEntry, LedgerEntryInput } from "../core/ledger";
import type { WritLookup } from "../core/writ-record";

/* ------------------------------------------------------------- generation */

export interface WritSpec {
  principal: Writ["principal"];
  agent: Writ["agent"];
  grants: Grant[];
  effectiveFrom: string;
  expiresAt: string;
  jurisdiction: string;
}

export interface GeneratedDocument {
  /** Vendor handle for the generated file. */
  reference: string;
  bytes: Uint8Array;
  contentType: string;
  /** Conformance level if the generator produced an archival PDF. */
  pdfaConformance?: string;
}

export interface DocumentGenerator {
  /**
   * Render a writ. The terms branch, loop and compute inside the template
   * rather than being flattened here, so the document a human reads is derived
   * from the same structure the engine later enforces.
   */
  generateWrit(spec: WritSpec): Promise<GeneratedDocument>;
}

/* -------------------------------------------------------------- signature */

export interface SigningRequest {
  document: GeneratedDocument;
  signerEmail: string;
  signerName: string;
  subject: string;
}

export interface SigningSession {
  envelopeId: string;
  /** URL a human opens to sign. There is no programmatic path past this point. */
  signingUrl: string;
  expiresAt: string;
}

export interface SignedDocument {
  envelopeId: string;
  bytes: Uint8Array;
  /** base64url sha256 of `bytes`. */
  sha256: string;
  signedAt: string;
  /** The completion certificate the signing service issues, when it issues one. */
  certificate?: Uint8Array;
}

/**
 * Deliberately has no method that signs. It can ask a human to sign and it can
 * collect what they signed; it cannot produce a signature. The credential that
 * would let it is never held by any agent-facing code path.
 */
export interface SignatureService {
  requestSignature(request: SigningRequest): Promise<SigningSession>;
  fetchCompleted(envelopeId: string): Promise<SignedDocument | null>;
  verifySignature(bytes: Uint8Array): Promise<{
    verified: boolean;
    method: string;
    profile?: string;
  }>;
}

/* ------------------------------------------------------------- extraction */

export interface ExtractionOutcome {
  policy: EnforceablePolicy;
  /** Digest of the raw vendor response, recorded in the evidence bundle. */
  responseDigest: string;
  method: string;
  groundingPolicy: {
    acceptedMatches: string[];
    confidenceThreshold: number | null;
  };
  /** Vendor credit accounting, kept because the audit story quotes it. */
  cost?: { charged: number; remaining: number };
}

export interface TermsExtractor {
  /**
   * Read enforceable terms back out of the signed document. This is what makes
   * the enforced policy provably the one the human read: nothing is taken from
   * the draft, and nothing is taken from a database row.
   */
  extractTerms(signed: SignedDocument, expected: { writId: string }): Promise<ExtractionOutcome>;
}

/* ----------------------------------------------------------------- domains */

export interface DomainCandidate {
  domainName: string;
  tld: string;
  purchasable: boolean;
  premium: boolean;
  priceMinorUnits: number | null;
  currency: string;
}

export interface RegisteredDomain {
  domainName: string;
  orderId: string;
  totalPaidMinorUnits: number;
  currency: string;
}

export interface DnsRecordRef {
  id: number;
  fqdn: string;
}

export interface DomainRegistry {
  search(keyword: string, tlds: string[]): Promise<DomainCandidate[]>;
  checkAvailability(domainNames: string[]): Promise<DomainCandidate[]>;
  /** Irreversible and priced. The idempotency key makes a retry safe. */
  register(
    domainName: string,
    priceMinorUnits: number,
    idempotencyKey: string,
  ): Promise<RegisteredDomain>;
  putWritRecord(domain: string, value: string): Promise<DnsRecordRef>;
  /** Publishes a tombstone; it does not merely delete. */
  revokeWritRecord(domain: string, tombstoneValue: string): Promise<DnsRecordRef>;
  listWritRecords(domain: string): Promise<{ id: number; value: string }[]>;
}

/* ---------------------------------------------------------------- resolver */

/**
 * Structurally identical to `ResolutionEvidence` in the evidence bundle, and
 * deliberately so — what the resolver returns is exactly what gets published
 * for a disputer to re-query, with no lossy step in between.
 */
export interface ResolvedTxt {
  name: string;
  /** Raw TXT strings as the resolver returned them, before any parsing. */
  txtRecords: string[];
  resolver: string;
  /** DNSSEC Authenticated Data flag. */
  authenticatedData: boolean;
  resolvedAt: string;
}

export interface WritResolver {
  resolveTxt(name: string): Promise<ResolvedTxt>;
  lookupWrit(agentDomain: string): Promise<{ lookup: WritLookup; resolution: ResolvedTxt }>;
}

/* --------------------------------------------------------------- diligence */

export interface DiligenceSubject {
  kind: ActKind;
  fields: Record<string, string | number | boolean>;
  principalLegalName: string;
}

export interface DiligenceService {
  /** Never returns `clear` for a check it could not complete. */
  run(subject: DiligenceSubject, checks: DiligenceCheck[]): Promise<DiligenceFinding[]>;
}

/* ------------------------------------------------------------------- store */

export type WritStatus =
  | "draft"
  | "pending_signature"
  | "active"
  | "revoked"
  | "expired";

export interface StoredWrit {
  id: string;
  status: WritStatus;
  spec: WritSpec;
  documentUrl: string | null;
  documentSha256: string | null;
  envelopeId: string | null;
  policy: EnforceablePolicy | null;
  anchoredAt: string | null;
}

export interface WritStore {
  createWrit(spec: WritSpec): Promise<StoredWrit>;
  getWrit(id: string): Promise<StoredWrit | null>;
  getWritByAgentDomain(domain: string): Promise<StoredWrit | null>;
  updateWrit(id: string, patch: Partial<StoredWrit>): Promise<StoredWrit>;

  /** Executed acts, for cumulative limits. Denials do not consume budget. */
  actHistory(writId: string): Promise<ActHistoryEntry[]>;
  recordExecutedAct(writId: string, entry: ActHistoryEntry): Promise<void>;

  appendLedger(entry: LedgerEntryInput): Promise<LedgerEntry>;
  ledger(writId?: string): Promise<LedgerEntry[]>;

  putEvidence(bundle: EvidenceBundle, bundleDigest: string): Promise<{ url: string }>;
}

/* ------------------------------------------------------------------ shared */

export interface ActOutcome {
  bundle: EvidenceBundle;
  /** Present only when the act was allowed and then actually carried out. */
  executed: { kind: ActKind; reference: string; at: string } | null;
}

export type { ActRequest };

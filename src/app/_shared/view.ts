/**
 * What the surfaces are handed.
 *
 * Types only, and deliberately: every field here is either a value the engine
 * produced or a presentation of one, and keeping the shape in a module with no
 * runtime of its own means a client component can name it without dragging the
 * orchestrator into the browser bundle.
 *
 * Two rules the shape enforces. Verdict prose is never assembled here — it
 * arrives as `DecisionReason[]` straight off the `Decision`, because that
 * wording is already written for a human reader. And a station's state is
 * derived from the reason code the engine returned, never from a second
 * evaluation of the act.
 */

import type {
  AgentRef,
  Decision,
  DecisionReason,
  DiligenceFinding,
  Grant,
  PrincipalRef,
} from "@/lib/core/types";
import type { LedgerEntry } from "@/lib/core/ledger";
import type { WritRecord } from "@/lib/core/writ-record";

export type Stage = "empty" | "drafted" | "signed" | "anchored" | "revoked";

/* ------------------------------------------------------------- what is live */

export type Supply = "live" | "scripted" | "unavailable";

export interface ServiceStatus {
  key: string;
  /** The vendor or facility that would answer in production. */
  label: string;
  /** The port it fills, in the words the architecture uses. */
  role: string;
  supply: Supply;
  /** What is answering right now, said plainly. */
  detail: string;
  /** Env vars that would move this to live, listed so the gap is actionable. */
  requires: string[];
  credentialsPresent: boolean;
}

export interface ModeReport {
  /** True when nothing at all is configured, which is the documented default. */
  scriptedThroughout: boolean;
  headline: string;
  services: ServiceStatus[];
}

export interface WritView {
  id: string;
  status: string;
  principal: PrincipalRef;
  agent: AgentRef;
  grants: Grant[];
  effectiveFrom: string;
  expiresAt: string;
  jurisdiction: string;
  documentUrl: string | null;
  documentSha256: string | null;
  envelopeId: string | null;
  anchoredAt: string | null;
  /** Days left on the instrument, rounded down. Negative once it has lapsed. */
  daysRemaining: number;
}

export interface RecordView {
  name: string;
  /** Exactly what the resolver returned, before any parsing. */
  txtRecords: string[];
  resolver: string;
  authenticatedData: boolean;
  resolvedAt: string;
  outcome: "active" | "revoked" | "absent";
  record: WritRecord | null;
  /** True when the zone was served in process rather than over the network. */
  scripted: boolean;
}

export interface DocumentView {
  url: string | null;
  /** The hash DNS publishes: what the principal signed. */
  publishedHash: string | null;
  /** The hash of the bytes the URL would serve right now. */
  currentHash: string | null;
  agrees: boolean;
  /** Set once a byte has been edited, naming the phrase that moved. */
  edit: { before: string; after: string } | null;
}

export type GaugeKind = "count" | "amount" | "allowlist" | "pattern" | "condition";

export interface GaugeView {
  id: string;
  kind: GaugeKind;
  label: string;
  clause: string;
  /** Consumed and permitted, for the two gauges that accumulate. */
  used: number | null;
  max: number | null;
  currency: string | null;
  /** The schedule, for the two gauges that constrain a value. */
  values: string[] | null;
  reading: string;
}

export type StationState = "idle" | "cleared" | "failed" | "skipped" | "dark";

export interface StationView {
  id: string;
  name: string;
  short: string;
  tests: string;
  clause: string;
  line: "authority" | "condition" | "schedule";
  state: StationState;
  /** What this station actually compared on this act. Empty when not reached. */
  note: string;
}

export interface ActView {
  id: string;
  at: string;
  title: string;
  detail: string;
  presetId: string | null;
  kind: string;
  fields: Record<string, string | number | boolean>;
  amountMinorUnits: number | null;
  currency: string | null;
  outcome: "allow" | "deny";
  reasons: DecisionReason[];
  /** The station the act stopped at: `commit` when it was allowed. */
  stopAt: string;
  stations: StationView[];
  diligence: DiligenceFinding[];
  executed: { kind: string; reference: string; at: string } | null;
  bundleDigest: string;
  resolver: string;
  authenticatedData: boolean;
  /** The two hashes the instrument check compared. */
  fetchedHash: string | null;
  publishedHash: string | null;
}

export interface SessionView {
  sessionId: string;
  now: string;
  stage: Stage;
  mode: ModeReport;
  diligenceSupply: "live" | "scripted";
  agentDomain: string;
  recordName: string;
  writ: WritView | null;
  record: RecordView | null;
  document: DocumentView | null;
  gauges: GaugeView[];
  acts: ActView[];
  ledger: LedgerEntry[];
  /** Position in the fourteen-step walkthrough; -1 when it has not been started. */
  step: number;
  /** Head of the append-only chain, so a viewer can quote it. */
  chainHead: string;
}

/* --------------------------------------------------------------- verifier */

export interface VerifierAnswer {
  agentDomain: string;
  name: string;
  /** Where the answer came from, said in the words the evidence bundle uses. */
  source: "public-dns" | "demo-zone" | "unavailable";
  resolver: string;
  txtRecords: string[];
  authenticatedData: boolean;
  resolvedAt: string;
  elapsedMs: number;
  outcome: "active" | "revoked" | "absent" | "error";
  record: WritRecord | null;
  /** Present when the record is malformed or the lookup failed. */
  problem: string | null;
  /** Plain-English reading of the record, one sentence per fact. */
  reading: string[];
  /** Only for the demo agent, whose instrument this deployment holds. */
  instrument: {
    principal: string;
    grants: { ref: string; heading: string; terms: string[] }[];
    documentAgrees: boolean;
    expiresAt: string;
  } | null;
}

export interface ReplayView {
  digest: string;
  agrees: boolean;
  differences: string[];
  recorded: Decision;
  recomputed: Decision;
  evaluatedAt: string;
}

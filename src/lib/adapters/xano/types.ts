/**
 * The wire shapes of the Chancery API group, and the one rule that governs them.
 *
 * Column names are snake_case because that is what the XanoScript tables
 * declare. The *contents* of `limits`, `conditions` and `policy` are not: they
 * are stored and returned verbatim, with the camelCase keys `core/types.ts`
 * defines, because those objects are hashed — into the evidence bundle digest
 * and into the ledger chain. Renaming `maxMinorUnits` to `max_minor_units` on
 * the way through would produce a different digest for the same authority, and
 * every previously published receipt would stop verifying. So the mapping is
 * deliberately shallow: it renames the envelope and never touches the payload.
 */

import type { Condition, Limit } from "../../core/types";
import type { LedgerEntryKind } from "../../core/ledger";
import type { EnforceablePolicy } from "../../core/types";
import type { WritStatus } from "../../service/ports";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Xano hands `timestamp` columns back as epoch milliseconds unless the endpoint
 * formats them, and older rows written through the UI come back as strings. The
 * decision engine compares these as ISO-8601, so the adapter accepts both and
 * normalises rather than trusting whichever one today's stack happens to emit.
 */
export type WireTimestamp = string | number;

export interface WirePrincipal {
  id: string;
  legal_name: string;
  email: string;
  entity_verified: boolean;
}

export interface WireAgent {
  id: string;
  label: string;
  domain: string;
  public_key: string;
}

export interface WireGrant {
  ref: string;
  act_kind: string;
  limits: Limit[];
  conditions: Condition[];
}

export interface WireSpec {
  principal: WirePrincipal;
  agent: WireAgent;
  grants: WireGrant[];
  effective_from: WireTimestamp;
  expires_at: WireTimestamp;
  jurisdiction: string;
}

export interface WireWrit {
  id: string;
  status: WritStatus;
  spec: WireSpec;
  document_url: string | null;
  document_sha256: string | null;
  envelope_id: string | null;
  policy: EnforceablePolicy | null;
  anchored_at: WireTimestamp | null;
}

export interface WireAct {
  kind: string;
  grant_ref: string;
  amount_minor_units: number;
  currency: string;
  executed_at: WireTimestamp;
}

export interface WireLedgerEntry {
  sequence: number;
  previous_hash: string;
  hash: string;
  kind: LedgerEntryKind;
  /**
   * Stored as text, never as a `timestamp` column: this exact string is inside
   * the hash, and a column that reformats it on the way out would break every
   * entry written before the reformat.
   */
  at: string;
  payload: unknown;
}

export interface WireReceipt {
  url: string;
}

export interface WireAuth {
  authToken: string;
  principal: WirePrincipal;
}

/** Public verifier payload — no policy, no principal, nothing a stranger should not see. */
export interface WireVerification {
  agent_domain: string;
  status: WritStatus | null;
  document_sha256: string | null;
  document_url: string | null;
  expires_at: WireTimestamp | null;
  anchored_at: WireTimestamp | null;
  ledger: { length: number; head_hash: string };
}

/**
 * Wire <-> domain mapping.
 *
 * Two jobs, both narrow on purpose. It renames snake_case envelope keys, and it
 * normalises timestamps, because Xano returns `timestamp` columns as epoch
 * milliseconds and the engine compares dates as ISO-8601 strings. It does not
 * walk into `limits`, `conditions` or `policy` — see the note in `types.ts` for
 * why touching those would invalidate published receipts.
 *
 * Every value that crosses this boundary is checked. A backend that returns a
 * writ with an `act_kind` this build has never heard of is not a writ we can
 * enforce, and quietly widening the type with a cast is how an unenforceable
 * clause ends up authorising an irreversible act.
 */

import { ACT_KINDS, type ActHistoryEntry, type ActKind, type Grant } from "../../core/types";
import type { LedgerEntry, LedgerEntryKind } from "../../core/ledger";
import type { StoredWrit, WritSpec, WritStatus } from "../../service/ports";
import { XanoError } from "./errors";
import type {
  WireAct,
  WireGrant,
  WireLedgerEntry,
  WireSpec,
  WireTimestamp,
  WireWrit,
} from "./types";

const WRIT_STATUSES: readonly WritStatus[] = [
  "draft",
  "pending_signature",
  "active",
  "revoked",
  "expired",
];

const LEDGER_KINDS: readonly LedgerEntryKind[] = [
  "writ.issued",
  "writ.anchored",
  "writ.revoked",
  "act.requested",
  "act.decided",
  "act.executed",
  "act.failed",
];

export function toIso(value: WireTimestamp): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new XanoError(`timestamp ${value} is not a finite epoch`, "MALFORMED_RESPONSE");
    }
    return new Date(value).toISOString();
  }
  // Already ISO, or Xano's `Y-m-d H:i:s` form; both parse, and re-emitting from
  // Date normalises the second one without special-casing its shape.
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new XanoError(`timestamp ${JSON.stringify(value)} is unparseable`, "MALFORMED_RESPONSE");
  }
  return new Date(parsed).toISOString();
}

function toIsoOrNull(value: WireTimestamp | null | undefined): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function actKind(raw: string): ActKind {
  const match = ACT_KINDS.find((kind) => kind === raw);
  if (match === undefined) {
    throw new XanoError(`unknown act kind ${JSON.stringify(raw)}`, "MALFORMED_RESPONSE");
  }
  return match;
}

function writStatus(raw: string): WritStatus {
  const match = WRIT_STATUSES.find((status) => status === raw);
  if (match === undefined) {
    throw new XanoError(`unknown writ status ${JSON.stringify(raw)}`, "MALFORMED_RESPONSE");
  }
  return match;
}

function ledgerKind(raw: string): LedgerEntryKind {
  const match = LEDGER_KINDS.find((kind) => kind === raw);
  if (match === undefined) {
    throw new XanoError(`unknown ledger kind ${JSON.stringify(raw)}`, "MALFORMED_RESPONSE");
  }
  return match;
}

export function grantFromWire(wire: WireGrant): Grant {
  return {
    ref: wire.ref,
    actKind: actKind(wire.act_kind),
    limits: wire.limits ?? [],
    conditions: wire.conditions ?? [],
  };
}

export function grantToWire(grant: Grant): WireGrant {
  return {
    ref: grant.ref,
    act_kind: grant.actKind,
    limits: grant.limits,
    conditions: grant.conditions,
  };
}

export function specFromWire(wire: WireSpec): WritSpec {
  return {
    principal: {
      id: wire.principal.id,
      legalName: wire.principal.legal_name,
      email: wire.principal.email,
      entityVerified: wire.principal.entity_verified,
    },
    agent: {
      id: wire.agent.id,
      label: wire.agent.label,
      domain: wire.agent.domain,
      publicKey: wire.agent.public_key,
    },
    grants: (wire.grants ?? []).map(grantFromWire),
    effectiveFrom: toIso(wire.effective_from),
    expiresAt: toIso(wire.expires_at),
    jurisdiction: wire.jurisdiction,
  };
}

export function specToWire(spec: WritSpec): WireSpec {
  return {
    principal: {
      id: spec.principal.id,
      legal_name: spec.principal.legalName,
      email: spec.principal.email,
      entity_verified: spec.principal.entityVerified,
    },
    agent: {
      id: spec.agent.id,
      label: spec.agent.label,
      domain: spec.agent.domain,
      public_key: spec.agent.publicKey,
    },
    grants: spec.grants.map(grantToWire),
    effective_from: spec.effectiveFrom,
    expires_at: spec.expiresAt,
    jurisdiction: spec.jurisdiction,
  };
}

export function writFromWire(wire: WireWrit): StoredWrit {
  return {
    id: wire.id,
    status: writStatus(wire.status),
    spec: specFromWire(wire.spec),
    documentUrl: wire.document_url ?? null,
    documentSha256: wire.document_sha256 ?? null,
    envelopeId: wire.envelope_id ?? null,
    policy: wire.policy ?? null,
    anchoredAt: toIsoOrNull(wire.anchored_at),
  };
}

export function actFromWire(wire: WireAct): ActHistoryEntry {
  return {
    kind: actKind(wire.kind),
    grantRef: wire.grant_ref,
    amountMinorUnits: wire.amount_minor_units,
    currency: wire.currency,
    executedAt: toIso(wire.executed_at),
  };
}

export function actToWire(entry: ActHistoryEntry): WireAct {
  return {
    kind: entry.kind,
    grant_ref: entry.grantRef,
    amount_minor_units: entry.amountMinorUnits,
    currency: entry.currency,
    executed_at: entry.executedAt,
  };
}

export function ledgerEntryFromWire(wire: WireLedgerEntry): LedgerEntry {
  if (!Number.isInteger(wire.sequence) || wire.sequence < 0) {
    throw new XanoError(`ledger sequence ${wire.sequence} is not a position`, "MALFORMED_RESPONSE");
  }
  return {
    sequence: wire.sequence,
    previousHash: wire.previous_hash,
    hash: wire.hash,
    kind: ledgerKind(wire.kind),
    at: wire.at,
    payload: wire.payload,
  };
}

export function ledgerEntryToWire(entry: LedgerEntry): WireLedgerEntry {
  return {
    sequence: entry.sequence,
    previous_hash: entry.previousHash,
    hash: entry.hash,
    kind: entry.kind,
    at: entry.at,
    payload: entry.payload,
  };
}

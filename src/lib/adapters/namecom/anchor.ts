/**
 * Writ anchoring: the registrar side of publishing authority, and the public
 * DNS side of reading it back.
 *
 * Writing goes through name.com because that is who controls the zone. Reading
 * goes through DoH because a verifier who trusted our registrar credentials to
 * tell them what the zone says would be trusting us, not DNS. The asymmetry is
 * the point, and it is why this class holds both a client and a resolver
 * instead of one of them.
 *
 * Three orderings in here are load-bearing:
 *
 *   Rotation publishes before it deletes. Two active writs briefly coexist,
 *   which `selectWritRecord` already resolves in favour of the later expiry;
 *   the reverse order would leave a window with no authority at all, and every
 *   in-flight act would fail closed for no reason.
 *
 *   Revocation publishes the tombstone before removing the active records, for
 *   the same reason in the opposite direction: at no instant may the name serve
 *   an active writ with no tombstone beside it.
 *
 *   Publishing refuses to write over a tombstone. Revocation is meant to be
 *   terminal; quietly resurrecting a revoked name because someone called
 *   `publish` again would undo the one guarantee the tombstone exists to make.
 */

import {
  chunkTxtValue,
  parseWritRecord,
  selectWritRecord,
  serializeWritRecord,
  TXT_CHUNK_LIMIT,
  writRecordName,
  type WritLookup,
  type WritRecord,
  type WritStatus,
} from "../../core/writ-record";
import { DohResolver, type TxtResolver } from "../../dns/resolver";
import { MIN_TTL, type CallOptions, type NameComClient } from "./client";
import type { DnsRecord } from "./types";

export type AnchorErrorCode =
  | "OUT_OF_ZONE"
  | "VALUE_TOO_LONG"
  | "ALREADY_REVOKED"
  | "NOT_ACTIVE"
  | "NO_SOURCE_RECORD";

export class AnchorError extends Error {
  readonly code: AnchorErrorCode;

  constructor(message: string, code: AnchorErrorCode) {
    super(message);
    this.name = "AnchorError";
    this.code = code;
  }
}

export interface AnchorTarget {
  /** The domain registered at name.com, i.e. the zone we can write records in. */
  zone: string;
  /**
   * The FQDN the agent is identified by. Defaults to the zone; set it when the
   * agent lives on a subdomain, e.g. `ops.example.com` inside `example.com`.
   */
  agentDomain?: string;
}

export interface ResolvedAnchorTarget {
  zone: string;
  agentDomain: string;
  /** `_writ.ops.example.com` — what a verifier queries. */
  name: string;
  /** `_writ.ops` — what name.com wants, relative to the zone. */
  host: string;
}

export interface AnchorWriteResult {
  zone: string;
  name: string;
  host: string;
  status: WritStatus;
  /** The serialised TXT value now published. */
  value: string;
  record: DnsRecord;
  /** False when the identical record was already there and nothing was written. */
  created: boolean;
  /** Superseded WRIT1 records removed after the new one went live. */
  removedRecordIds: number[];
}

/**
 * `unverified` is not a DNS state; it is what a verifier must report when the
 * answer was not DNSSEC-validated and therefore could have been tampered with
 * in flight. It exists so the caller fails closed instead of reading an
 * unauthenticated `absent` as "no writ, carry on".
 */
export type AnchorOutcome = "active" | "revoked" | "absent" | "unverified";

export interface WritAuthority {
  /** Outcome after the DNSSEC gate. This is what a decision should key on. */
  outcome: AnchorOutcome;
  /** What DNS literally said, before the gate, for the audit trail. */
  lookup: WritLookup;
  authenticatedData: boolean;
  name: string;
  resolver: string;
  /** Every TXT value at the name, including ones that are not WRIT1 at all. */
  txtRecords: string[];
}

export interface WritAnchorOptions {
  client: NameComClient;
  /** Defaults to Cloudflare with a Google fallback. */
  resolver?: TxtResolver;
  /** Defaults to name.com's 300s floor, which is also as fast as revocation can propagate. */
  ttl?: number;
}

export interface LookupOptions extends CallOptions {
  /**
   * Chancery's spec requires DNSSEC, so this defaults on. Turning it off gives
   * you the raw DNS outcome and moves the responsibility for failing closed
   * onto you.
   */
  requireDnssec?: boolean;
}

/** A TXT record at the anchor name, paired with its raw value. */
interface AnchoredTxt {
  record: DnsRecord;
  value: string;
}

export interface RevokeOptions extends CallOptions {
  /**
   * The writ to tombstone, when there is no active record to derive one from —
   * for instance when revoking after a cache poisoning scare, or before the
   * original publish has propagated.
   */
  from?: WritRecord;
}

export class WritAnchor {
  private readonly client: NameComClient;
  private readonly resolver: TxtResolver;
  private readonly ttl: number;

  constructor(options: WritAnchorOptions) {
    this.client = options.client;
    this.resolver = options.resolver ?? new DohResolver();
    this.ttl = options.ttl ?? MIN_TTL;
  }

  /**
   * First publication for a name. Idempotent: republishing a byte-identical
   * record is a no-op rather than a duplicate TXT, so a retried deploy does not
   * litter the zone with copies a verifier would then have to reconcile.
   */
  async publish(
    target: AnchorTarget,
    record: WritRecord,
    options: CallOptions = {},
  ): Promise<AnchorWriteResult> {
    if (record.status !== "active") {
      throw new AnchorError(
        "publish() takes an active writ; use revoke() to publish a tombstone",
        "NOT_ACTIVE",
      );
    }
    const resolved = resolveTarget(target);
    const existing = await this.readWritRecords(resolved, options);
    assertNotRevoked(existing, resolved.name);

    const value = serialiseForDns(record);
    const duplicate = existing.find((entry) => entry.value === value);
    if (duplicate) {
      return {
        ...this.describe(resolved, record.status, value),
        record: duplicate.record,
        created: false,
        removedRecordIds: [],
      };
    }

    const created = await this.client.createRecord(
      resolved.zone,
      { host: resolved.host, type: "TXT", answer: value, ttl: this.ttl },
      options,
    );
    return {
      ...this.describe(resolved, record.status, value),
      record: created,
      created: true,
      removedRecordIds: [],
    };
  }

  /**
   * Replace the live writ with a new one. The new record is created before any
   * old one is removed, so authority is continuous across the swap.
   */
  async rotate(
    target: AnchorTarget,
    next: WritRecord,
    options: CallOptions = {},
  ): Promise<AnchorWriteResult> {
    if (next.status !== "active") {
      throw new AnchorError(
        "rotate() takes an active writ; use revoke() to publish a tombstone",
        "NOT_ACTIVE",
      );
    }
    const resolved = resolveTarget(target);
    const existing = await this.readWritRecords(resolved, options);
    assertNotRevoked(existing, resolved.name);

    const value = serialiseForDns(next);
    const alreadyLive = existing.find((entry) => entry.value === value);
    const record =
      alreadyLive?.record ??
      (await this.client.createRecord(
        resolved.zone,
        { host: resolved.host, type: "TXT", answer: value, ttl: this.ttl },
        options,
      ));

    const superseded = existing.filter((entry) => entry.value !== value);
    for (const entry of superseded) {
      await this.client.deleteRecord(resolved.zone, entry.record.id, options);
    }

    return {
      ...this.describe(resolved, next.status, value),
      record,
      created: alreadyLive === undefined,
      removedRecordIds: superseded.map((entry) => entry.record.id),
    };
  }

  /**
   * Revoke by publishing a `st=revoked` tombstone, then clearing the active
   * records. Deleting alone would not do: a resolver may still be serving the
   * deleted record from cache, and a cache cannot silently omit a positive
   * statement the way it can keep serving an absent one.
   */
  async revoke(
    target: AnchorTarget,
    options: RevokeOptions = {},
  ): Promise<AnchorWriteResult> {
    const resolved = resolveTarget(target);
    const existing = await this.readWritRecords(resolved, options);

    const current = selectWritRecord(existing.map((entry) => entry.value));
    const source =
      current.outcome === "absent" ? options.from : current.record;
    if (source === undefined) {
      throw new AnchorError(
        `no writ record at ${resolved.name} to revoke; pass \`from\` to tombstone one anyway`,
        "NO_SOURCE_RECORD",
      );
    }

    // Expiry is copied through unchanged: a tombstone outranks every active
    // record at the name whatever its expiry, so there is nothing to gain by
    // moving it and something to lose in auditability.
    const tombstone: WritRecord = { ...source, status: "revoked" };
    const value = serialiseForDns(tombstone);

    const alreadyPublished = existing.find((entry) => entry.value === value);
    const record =
      alreadyPublished?.record ??
      (await this.client.createRecord(
        resolved.zone,
        { host: resolved.host, type: "TXT", answer: value, ttl: this.ttl },
        options,
      ));

    const stale = existing.filter((entry) => entry.value !== value);
    for (const entry of stale) {
      await this.client.deleteRecord(resolved.zone, entry.record.id, options);
    }

    return {
      ...this.describe(resolved, "revoked", value),
      record,
      created: alreadyPublished === undefined,
      removedRecordIds: stale.map((entry) => entry.record.id),
    };
  }

  /**
   * The verification path. Resolves the writ from public DNS and reports
   * whether the answer was DNSSEC-validated.
   *
   * A `revoked` outcome survives the DNSSEC gate untouched. Every other outcome
   * degrades to `unverified` without AD, because an unauthenticated `absent`
   * could be a stripped tombstone — but a tombstone we actually saw is only
   * ever evidence in the safe direction, and downgrading it would turn a
   * definite revocation into something a caller might retry past.
   */
  async lookup(
    agentDomain: string,
    options: LookupOptions = {},
  ): Promise<WritAuthority> {
    const name = writRecordName(agentDomain);
    const answer = await this.resolver.resolveTxt(name, { signal: options.signal });
    const lookup = selectWritRecord(answer.values);
    const requireDnssec = options.requireDnssec ?? true;

    const outcome: AnchorOutcome =
      lookup.outcome === "revoked"
        ? "revoked"
        : requireDnssec && !answer.authenticatedData
          ? "unverified"
          : lookup.outcome;

    return {
      outcome,
      lookup,
      authenticatedData: answer.authenticatedData,
      name,
      resolver: answer.resolver,
      txtRecords: answer.values,
    };
  }

  /**
   * Read the writ back through the registrar rather than DNS.
   *
   * This is NOT verification — it asks the party that can rewrite the zone what
   * the zone says. It exists because sandbox DNS never resolves publicly, so a
   * sandbox demo has no other way to confirm a write landed, and because
   * `rotate` and `revoke` need to see the records before they touch them.
   */
  async readFromRegistrar(
    target: AnchorTarget,
    options: CallOptions = {},
  ): Promise<{ name: string; lookup: WritLookup; txtRecords: string[] }> {
    const resolved = resolveTarget(target);
    const entries = await this.readTxtRecords(resolved, options);
    const values = entries.map((entry) => entry.value);
    return { name: resolved.name, lookup: selectWritRecord(values), txtRecords: values };
  }

  private async readTxtRecords(
    resolved: ResolvedAnchorTarget,
    options: CallOptions,
  ): Promise<AnchoredTxt[]> {
    const { records } = await this.client.listRecords(resolved.zone, {}, options);
    return records
      .filter(
        (record) =>
          record.type === "TXT" && normaliseHost(record.host) === resolved.host,
      )
      .map((record) => ({ record, value: record.answer }));
  }

  /**
   * Only records that actually parse as WRIT1 are eligible for deletion.
   * Nothing stops a zone from carrying an unrelated TXT at the same name, and
   * "supersede the old writ" must never become "delete a stranger's record".
   * A malformed near-writ is left alone too: `selectWritRecord` already ignores
   * it, so removing it would be destruction with no benefit.
   */
  private async readWritRecords(
    resolved: ResolvedAnchorTarget,
    options: CallOptions,
  ): Promise<AnchoredTxt[]> {
    const all = await this.readTxtRecords(resolved, options);
    return all.filter((entry) => isWritRecord(entry.value));
  }

  private describe(
    resolved: ResolvedAnchorTarget,
    status: WritStatus,
    value: string,
  ): Omit<AnchorWriteResult, "record" | "created" | "removedRecordIds"> {
    return {
      zone: resolved.zone,
      name: resolved.name,
      host: resolved.host,
      status,
      value,
    };
  }
}

export function resolveTarget(target: AnchorTarget): ResolvedAnchorTarget {
  const zone = normaliseDomain(target.zone);
  const agentDomain = normaliseDomain(target.agentDomain ?? target.zone);
  if (agentDomain !== zone && !agentDomain.endsWith(`.${zone}`)) {
    throw new AnchorError(
      `${agentDomain} is not inside ${zone}; the writ has to live in a zone we can write`,
      "OUT_OF_ZONE",
    );
  }
  const name = writRecordName(agentDomain);
  return {
    zone,
    agentDomain,
    name,
    host: agentDomain === zone ? "_writ" : name.slice(0, -(zone.length + 1)),
  };
}

/**
 * name.com takes a TXT `answer` as one character-string, and DNS caps that at
 * 255 bytes. A writ that overflows has to be shortened at the source — usually
 * by moving `u=` behind a short URL — because splitting it across chunks needs
 * multi-string support this API does not expose. Failing here is better than
 * publishing a truncated writ that parses into weaker authority than intended.
 */
function serialiseForDns(record: WritRecord): string {
  const value = serializeWritRecord(record);
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > TXT_CHUNK_LIMIT) {
    throw new AnchorError(
      `writ record is ${bytes} bytes; a TXT character-string holds ${TXT_CHUNK_LIMIT} ` +
        `(would need ${chunkTxtValue(value).length} chunks)`,
      "VALUE_TOO_LONG",
    );
  }
  return value;
}

function assertNotRevoked(
  existing: { value: string }[],
  name: string,
): void {
  const lookup = selectWritRecord(existing.map((entry) => entry.value));
  if (lookup.outcome === "revoked") {
    throw new AnchorError(
      `${name} carries a revocation tombstone; delete it deliberately before re-anchoring`,
      "ALREADY_REVOKED",
    );
  }
}

function isWritRecord(value: string): boolean {
  try {
    parseWritRecord(value);
    return true;
  } catch {
    return false;
  }
}

function normaliseDomain(domain: string): string {
  const trimmed = domain.trim().toLowerCase();
  return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
}

/** name.com reports the apex as `""`, but some payloads use `"@"`. */
function normaliseHost(host: string | undefined): string {
  if (host === undefined || host === "@") return "";
  return host.toLowerCase();
}

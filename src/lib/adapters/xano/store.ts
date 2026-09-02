/**
 * The Xano-backed `WritStore`.
 *
 * Xano is the backend of record: the registry, the act history, the receipts and
 * — the part that matters — the ledger. Three decisions in this file follow from
 * that and are worth stating before the code.
 *
 * **The chain is assigned server-side, and checked client-side.** `appendLedger`
 * sends only `{ kind, at, payload }`. Xano allocates the sequence and the
 * previous hash inside a transaction that locks the tail, which is the only
 * place two concurrent appends can be ordered honestly; a client that read the
 * head and then posted its own sequence would race every other client. What
 * comes back is then re-hashed here against `core/canonical.ts`. Server-assigned
 * and client-verified is not belt-and-braces: it is the whole claim. An entry
 * the caller cannot reproduce is not evidence, so it is rejected rather than
 * stored in memory as if it were fine.
 *
 * **Nothing is addressed by row id.** Every endpoint scopes to `$auth.id`
 * server-side, and the public identifiers are UUIDs. Passing a writ id in a
 * request never widens what the caller can see, because the id is not what
 * grants access.
 *
 * **`updateWrit` refuses to patch `spec`.** The port's signature is
 * `Partial<StoredWrit>`, which structurally permits rewriting the terms of a
 * signed instrument. That is the one thing this product exists to prevent, so
 * it is refused here rather than silently dropped, and refused again server-side
 * because a client-side check protects nobody.
 *
 * Everything is driven through an injectable `fetchImpl`, so the whole surface
 * is exercisable without an instance and without credentials.
 */

import { digest } from "../../core/canonical";
import type { EvidenceBundle } from "../../core/evidence";
import type { LedgerEntry, LedgerEntryInput } from "../../core/ledger";
import type { ActHistoryEntry } from "../../core/types";
import type { StoredWrit, WritSpec, WritStore } from "../../service/ports";
import {
  XanoError,
  XanoLedgerError,
  isRateLimited,
  xanoErrorFromResponse,
  type ErrorContext,
} from "./errors";
import type {
  FetchLike,
  WireAct,
  WireAuth,
  WireLedgerEntry,
  WirePrincipal,
  WireReceipt,
  WireVerification,
  WireWrit,
} from "./types";
import {
  actFromWire,
  actToWire,
  grantToWire,
  ledgerEntryFromWire,
  writFromWire,
} from "./wire";

export interface XanoWritStoreOptions {
  /** API group base, e.g. `https://x8ki-letl-twmt.n7.xano.io/api:chancery`. */
  baseUrl: string;
  /** JWT from `auth/login`. Optional so the public endpoints work unauthenticated. */
  token?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Injected so retry hints are derived from a clock a test controls. */
  now?: () => number;
}

export interface CallOptions {
  signal?: AbortSignal;
}

interface RequestOptions extends CallOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Public endpoints deliberately send no Authorization header at all. */
  anonymous?: boolean;
}

const PARSE_FAILED = Symbol("xano.parseFailed");

/** Patching these would rewrite what a human signed. See the header note. */
const IMMUTABLE_WRIT_FIELDS: readonly (keyof StoredWrit)[] = ["id", "spec"];

export class XanoWritStore implements WritStore {
  readonly baseUrl: string;

  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private authToken: string | null;

  constructor(options: XanoWritStoreOptions) {
    if (options.baseUrl.length === 0) {
      throw new XanoError("baseUrl is required", "INVALID_ARGUMENT");
    }
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new XanoError("no fetch implementation available; pass fetchImpl", "INVALID_ARGUMENT");
    }

    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl as FetchLike;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? Date.now;
    this.authToken = options.token ?? null;
  }

  /* -------------------------------------------------------------------- auth */

  get token(): string | null {
    return this.authToken;
  }

  setToken(token: string | null): void {
    this.authToken = token;
  }

  async signup(
    input: { legalName: string; email: string; password: string },
    options: CallOptions = {},
  ): Promise<{ token: string; principal: WirePrincipal }> {
    const body = await this.request<WireAuth>("POST", "/auth/signup", {
      ...options,
      anonymous: true,
      body: {
        legal_name: input.legalName,
        email: input.email,
        password: input.password,
      },
    });
    this.authToken = body.authToken;
    return { token: body.authToken, principal: body.principal };
  }

  async login(
    input: { email: string; password: string },
    options: CallOptions = {},
  ): Promise<{ token: string; principal: WirePrincipal }> {
    const body = await this.request<WireAuth>("POST", "/auth/login", {
      ...options,
      anonymous: true,
      body: { email: input.email, password: input.password },
    });
    this.authToken = body.authToken;
    return { token: body.authToken, principal: body.principal };
  }

  me(options: CallOptions = {}): Promise<WirePrincipal> {
    return this.request<WirePrincipal>("GET", "/auth/me", options);
  }

  /* ------------------------------------------------------------------- writs */

  async createWrit(spec: WritSpec, options: CallOptions = {}): Promise<StoredWrit> {
    // The principal is taken from the token server-side, so it is not sent: a
    // body that could name a principal is a body that could name someone else's.
    const wire = await this.request<WireWrit>("POST", "/writ", {
      ...options,
      body: {
        // The agent's own id is a label the principal chose for their agent; it
        // authorises nothing, so echoing it back is not "trusting an id from the
        // request". The principal id, which does authorise, is never sent.
        agent_external_id: spec.agent.id,
        agent_label: spec.agent.label,
        agent_domain: spec.agent.domain,
        agent_public_key: spec.agent.publicKey,
        effective_from: spec.effectiveFrom,
        expires_at: spec.expiresAt,
        jurisdiction: spec.jurisdiction,
        grants: spec.grants.map(grantToWire),
      },
    });
    return writFromWire(wire);
  }

  async getWrit(id: string, options: CallOptions = {}): Promise<StoredWrit | null> {
    // A missing writ comes back as a 200 with `null`, not a 404. Xano answers
    // 404 for an unrouted path too, and "you typed the URL wrong" must not be
    // indistinguishable from "this principal has no such writ".
    const wire = await this.request<WireWrit | null>("GET", `/writ/${segment(id)}`, options);
    return wire === null ? null : writFromWire(wire);
  }

  async getWritByAgentDomain(
    domain: string,
    options: CallOptions = {},
  ): Promise<StoredWrit | null> {
    const wire = await this.request<WireWrit | null>("GET", "/writ/by_domain", {
      ...options,
      query: { domain },
    });
    return wire === null ? null : writFromWire(wire);
  }

  async updateWrit(
    id: string,
    patch: Partial<StoredWrit>,
    options: CallOptions = {},
  ): Promise<StoredWrit> {
    assertPatchable(patch);
    const body: Record<string, unknown> = {};
    if (patch.status !== undefined) body.status = patch.status;
    if (patch.documentUrl !== undefined) body.document_url = patch.documentUrl;
    if (patch.documentSha256 !== undefined) body.document_sha256 = patch.documentSha256;
    if (patch.envelopeId !== undefined) body.envelope_id = patch.envelopeId;
    if (patch.policy !== undefined) body.policy = patch.policy;
    if (patch.anchoredAt !== undefined) body.anchored_at = patch.anchoredAt;

    if (Object.keys(body).length === 0) {
      throw new XanoError("updateWrit was given nothing to change", "INVALID_ARGUMENT");
    }

    const wire = await this.request<WireWrit>("PATCH", `/writ/${segment(id)}`, {
      ...options,
      body,
    });
    return writFromWire(wire);
  }

  /* -------------------------------------------------------------------- acts */

  async actHistory(writId: string, options: CallOptions = {}): Promise<ActHistoryEntry[]> {
    const rows = await this.request<WireAct[]>("GET", `/writ/${segment(writId)}/act`, options);
    return rows.map(actFromWire);
  }

  async recordExecutedAct(
    writId: string,
    entry: ActHistoryEntry,
    options: CallOptions = {},
  ): Promise<void> {
    await this.request<unknown>("POST", `/writ/${segment(writId)}/act`, {
      ...options,
      body: actToWire(entry),
    });
  }

  /* ------------------------------------------------------------------ ledger */

  async appendLedger(entry: LedgerEntryInput, options: CallOptions = {}): Promise<LedgerEntry> {
    const wire = await this.request<WireLedgerEntry>("POST", "/ledger", {
      ...options,
      body: {
        kind: entry.kind,
        at: entry.at,
        payload: entry.payload,
        writ_id: writIdOf(entry.payload),
      },
    });

    const appended = ledgerEntryFromWire(wire);
    // Recomputed from what the server stored, not from what we sent: if the two
    // differ, the entry that exists is the one we have to be able to verify.
    const expected = digest({
      sequence: appended.sequence,
      previousHash: appended.previousHash,
      kind: appended.kind,
      at: appended.at,
      payload: appended.payload,
    });
    if (expected !== appended.hash) {
      throw new XanoLedgerError(
        `ledger entry ${appended.sequence} does not hash to its recorded value`,
        appended.sequence,
        expected,
        appended.hash,
        { method: "POST", path: "/ledger" },
      );
    }
    return appended;
  }

  async ledger(writId?: string, options: CallOptions = {}): Promise<LedgerEntry[]> {
    const rows = await this.request<WireLedgerEntry[]>("GET", "/ledger", {
      ...options,
      query: { writ_id: writId },
    });
    return rows.map(ledgerEntryFromWire);
  }

  /* ---------------------------------------------------------------- receipts */

  putEvidence(
    bundle: EvidenceBundle,
    bundleDigest: string,
    options: CallOptions = {},
  ): Promise<{ url: string }> {
    // Content-addressed, so the write is idempotent: the same digest is the same
    // bytes, and a retry after a timeout cannot fork the receipt.
    return this.request<WireReceipt>("POST", "/evidence", {
      ...options,
      body: {
        digest: bundleDigest,
        bundle,
        writ_id: bundle.decision.writId,
        outcome: bundle.decision.outcome,
        evaluated_at: bundle.evaluatedAt,
      },
    });
  }

  /* --------------------------------------------------------- public verifier */

  /** Unauthenticated by design: authority is meant to be checkable by strangers. */
  verify(agentDomain: string, options: CallOptions = {}): Promise<WireVerification> {
    return this.request<WireVerification>("GET", "/verify", {
      ...options,
      anonymous: true,
      query: { domain: agentDomain },
    });
  }

  /**
   * The chain's linkage without its payloads. Enough for anyone to confirm that
   * the head they were told about is the head of an unbroken chain, and not
   * enough to read what any of it was about.
   */
  ledgerSpine(
    range: { from?: number; to?: number } = {},
    options: CallOptions = {},
  ): Promise<{ sequence: number; previous_hash: string; hash: string; kind: string; at: string }[]> {
    return this.request("GET", "/ledger/spine", {
      ...options,
      anonymous: true,
      query: { from: range.from, to: range.to },
    });
  }

  /* -------------------------------------------------------------- plumbing */

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      search.set(key, String(value));
    }
    const qs = search.toString();
    return `${this.baseUrl}${path}${qs.length > 0 ? `?${qs}` : ""}`;
  }

  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (!options.anonymous) {
      if (this.authToken === null) {
        throw new XanoError(
          `${method} ${path} needs a JWT; call login() or pass token`,
          "AUTH_REQUIRED",
          { method, path },
        );
      }
      headers.authorization = `Bearer ${this.authToken}`;
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const forwardAbort = () => controller.abort();
    options.signal?.addEventListener("abort", forwardAbort, { once: true });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (cause) {
      if (timedOut) {
        throw new XanoError(`${method} ${path} timed out after ${this.timeoutMs}ms`, "TIMEOUT", {
          method,
          path,
          cause,
        });
      }
      throw new XanoError(`${method} ${path} could not be sent`, "TRANSPORT", {
        method,
        path,
        cause,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", forwardAbort);
    }

    return this.readBody<T>(response, { method, path, now: this.now() });
  }

  private async readBody<T>(response: Response, ctx: ErrorContext): Promise<T> {
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const parsed = text.length === 0 ? undefined : safeJson(text);
    const body = parsed === PARSE_FAILED ? text : parsed;

    // Checked before `response.ok`: the throttle has been seen arriving under a
    // 2xx, and a rate-limit envelope parsed as a writ is worse than an error.
    if (isRateLimited(response.status, body)) {
      throw xanoErrorFromResponse(response.status, response.headers, body, ctx);
    }
    if (!response.ok) {
      throw xanoErrorFromResponse(response.status, response.headers, body, ctx);
    }
    if (parsed === PARSE_FAILED) {
      throw new XanoError(
        `${ctx.method} ${ctx.path} returned ${response.status} with a non-JSON body`,
        "MALFORMED_RESPONSE",
        { status: response.status, method: ctx.method, path: ctx.path, body: text },
      );
    }
    return parsed as T;
  }
}

function assertPatchable(patch: Partial<StoredWrit>): void {
  for (const field of IMMUTABLE_WRIT_FIELDS) {
    if (patch[field] !== undefined) {
      throw new XanoError(
        `${field} cannot be patched: the terms of a signed writ are not editable`,
        "IMMUTABLE_FIELD",
      );
    }
  }
}

/**
 * The ledger row carries a `writ_id` column purely so a read can be scoped to
 * one instrument. It is denormalised out of the payload and is NOT part of the
 * hash, so a row whose column was tampered with still fails `verifyChain` only
 * if the payload itself changed — which is the correct behaviour: the column is
 * an index, not evidence.
 */
function writIdOf(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const value = (payload as { writId?: unknown }).writId;
  return typeof value === "string" ? value : undefined;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function safeJson(text: string): unknown | typeof PARSE_FAILED {
  try {
    return JSON.parse(text);
  } catch {
    return PARSE_FAILED;
  }
}

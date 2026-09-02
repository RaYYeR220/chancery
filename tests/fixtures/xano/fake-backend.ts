/**
 * A stand-in for the deployed XanoScript backend, backed by `MemoryWritStore`.
 *
 * This exists so the HTTP client can be driven end to end without an instance,
 * and — more usefully — so the parity suite can compare the two stores across
 * the wire rather than side by side. `XanoWritStore -> fake fetch -> this ->
 * MemoryWritStore` exercises every mapper, every path, every status code and
 * every timestamp coercion on the way through. A parity test that only called
 * the two classes directly would prove they agree while the thing that actually
 * differs between them — the serialisation — went untested.
 *
 * It mirrors the routes in `xano/api/**` and the semantics stated there: `null`
 * rather than 404 for a missing writ, executed acts only in the history, a
 * content-addressed and idempotent receipt, and timestamps emitted as epoch
 * milliseconds the way Xano emits them.
 *
 * It is NOT a reimplementation of the backend's authorisation. There is one
 * account, and the token check is a string comparison. Everything about
 * `$auth.id` scoping lives in XanoScript and is not testable from here; the
 * README says so rather than this pretending otherwise.
 */

import type { PrincipalRef } from "@/lib/core/types";
import { MemoryWritStore } from "@/lib/adapters/xano/memory-store";
import { grantFromWire, ledgerEntryToWire } from "@/lib/adapters/xano/wire";
import type {
  FetchLike,
  WireGrant,
  WireSpec,
  WireWrit,
} from "@/lib/adapters/xano/types";
import type { StoredWrit, WritSpec } from "@/lib/service/ports";
import { TOO_MANY_REQUESTS, toResponse, type RecordedRequest } from "./fake-fetch";

export const DEFAULT_PRINCIPAL: PrincipalRef = {
  id: "prin_9f3c",
  legalName: "Northwind Coffee Ltd",
  email: "ops@northwind.example",
  entityVerified: true,
};

export const TOKEN = "eyJhbGciOiJIUzI1NiJ9.fake.jwt";

export interface FakeBackendOptions {
  principal?: PrincipalRef;
  password?: string;
  /** Answer the free-tier throttle from this request number onwards (1-based). */
  throttleFrom?: number;
  evidenceBaseUrl?: string;
  newId?: () => string;
}

export interface FakeBackend {
  fetchImpl: FetchLike;
  store: MemoryWritStore;
  calls: RecordedRequest[];
  token: string;
}

export function fakeBackend(options: FakeBackendOptions = {}): FakeBackend {
  const principal = options.principal ?? DEFAULT_PRINCIPAL;
  const password = options.password ?? "correct-horse-battery";
  const evidenceBaseUrl = options.evidenceBaseUrl ?? "https://chancery.local/receipt";
  const store = new MemoryWritStore({ principal, evidenceBaseUrl, newId: options.newId });
  const calls: RecordedRequest[] = [];

  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const rawBody = typeof init.body === "string" ? init.body : undefined;
    const request: RecordedRequest = {
      method: init.method ?? "GET",
      url: input,
      pathname: url.pathname,
      query: url.searchParams,
      headers: new Headers(init.headers as HeadersInit | undefined),
      body: rawBody === undefined ? undefined : JSON.parse(rawBody),
      rawBody,
    };
    calls.push(request);

    if (options.throttleFrom !== undefined && calls.length >= options.throttleFrom) {
      return toResponse(TOO_MANY_REQUESTS);
    }
    return toResponse(await route(request, { store, principal, password, evidenceBaseUrl }));
  };

  return { fetchImpl, store, calls, token: TOKEN };
}

interface Context {
  store: MemoryWritStore;
  principal: PrincipalRef;
  password: string;
  evidenceBaseUrl: string;
}

interface Reply {
  status?: number;
  body?: unknown;
}

const PUBLIC_ROUTES = new Set(["POST /auth/signup", "POST /auth/login"]);

async function route(request: RecordedRequest, ctx: Context): Promise<Reply> {
  // `/api:chancery/writ/x` -> `/writ/x`. Xano gives every API group its own
  // base, and the client is configured with the whole thing.
  const path = request.pathname.replace(/^\/api:[^/]+/, "");
  const key = `${request.method} ${path}`;
  const body = (request.body ?? {}) as Record<string, unknown>;

  const isPublic =
    PUBLIC_ROUTES.has(key) || path === "/verify" || path === "/ledger/spine" ||
    path.startsWith("/receipt/");

  if (!isPublic && request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
    return unauthorized();
  }

  if (key === "POST /auth/signup") {
    return { body: { authToken: TOKEN, principal: wirePrincipal(ctx.principal) } };
  }

  if (key === "POST /auth/login") {
    if (body.email !== ctx.principal.email || body.password !== ctx.password) {
      // Both branches identical, exactly as `auth/login.xs` has it.
      return { status: 403, body: xanoError("ERROR_CODE_ACCESS_DENIED", "Invalid credentials.") };
    }
    return { body: { authToken: TOKEN, principal: wirePrincipal(ctx.principal) } };
  }

  if (key === "GET /me") {
    return { body: wirePrincipal(ctx.principal) };
  }

  if (key === "POST /writ") {
    const spec = specFromCreateBody(body, ctx.principal);
    return { body: wireWrit(await ctx.store.createWrit(spec)) };
  }

  if (key === "GET /writ/by_domain") {
    const domain = request.query.get("domain") ?? "";
    const writ = await ctx.store.getWritByAgentDomain(domain);
    return { body: writ === null ? null : wireWrit(writ) };
  }

  const actMatch = /^\/writ\/([^/]+)\/act$/.exec(path);
  if (actMatch !== null) {
    const writId = decodeURIComponent(actMatch[1]);
    if (request.method === "GET") {
      const history = await ctx.store.actHistory(writId);
      return {
        body: history.map((entry) => ({
          kind: entry.kind,
          grant_ref: entry.grantRef,
          amount_minor_units: entry.amountMinorUnits,
          currency: entry.currency,
          executed_at: Date.parse(entry.executedAt),
        })),
      };
    }
    if (request.method === "POST") {
      try {
        await ctx.store.recordExecutedAct(writId, {
          kind: body.kind as never,
          grantRef: String(body.grant_ref ?? ""),
          amountMinorUnits: Number(body.amount_minor_units ?? 0),
          currency: String(body.currency ?? "USD"),
          executedAt: String(body.executed_at),
        });
      } catch {
        return notFound();
      }
      return { body: { recorded: true } };
    }
  }

  const writMatch = /^\/writ\/([^/]+)$/.exec(path);
  if (writMatch !== null) {
    const writId = decodeURIComponent(writMatch[1]);
    if (request.method === "GET") {
      const writ = await ctx.store.getWrit(writId);
      return { body: writ === null ? null : wireWrit(writ) };
    }
    if (request.method === "PATCH") {
      const patch: Partial<StoredWrit> = {};
      if ("status" in body) patch.status = body.status as StoredWrit["status"];
      if ("document_url" in body) patch.documentUrl = body.document_url as string | null;
      if ("document_sha256" in body) patch.documentSha256 = body.document_sha256 as string | null;
      if ("envelope_id" in body) patch.envelopeId = body.envelope_id as string | null;
      if ("policy" in body) patch.policy = body.policy as StoredWrit["policy"];
      if ("anchored_at" in body) patch.anchoredAt = body.anchored_at as string | null;
      try {
        return { body: wireWrit(await ctx.store.updateWrit(writId, patch)) };
      } catch (error) {
        return errorReply(error);
      }
    }
  }

  if (key === "POST /ledger") {
    const entry = await ctx.store.appendLedger({
      kind: body.kind as never,
      at: String(body.at),
      payload: body.payload,
    });
    return { body: ledgerEntryToWire(entry) };
  }

  if (key === "GET /ledger") {
    const writId = request.query.get("writ_id") ?? undefined;
    const entries = await ctx.store.ledger(writId);
    return { body: entries.map(ledgerEntryToWire) };
  }

  if (key === "GET /ledger/spine") {
    const entries = await ctx.store.ledger();
    return {
      body: entries.map((entry) => ({
        sequence: entry.sequence,
        previous_hash: entry.previousHash,
        hash: entry.hash,
        kind: entry.kind,
        at: entry.at,
      })),
    };
  }

  if (key === "POST /evidence") {
    const result = await ctx.store.putEvidence(
      body.bundle as never,
      String(body.digest),
    );
    return { body: result };
  }

  if (key === "GET /verify") {
    const domain = request.query.get("domain") ?? "";
    const writ = await ctx.store.getWritByAgentDomain(domain);
    const entries = await ctx.store.ledger();
    const head = entries.at(-1) ?? null;
    return {
      body: {
        agent_domain: domain,
        status: writ?.status ?? null,
        document_sha256: writ?.documentSha256 ?? null,
        document_url: writ?.documentUrl ?? null,
        expires_at: writ === null ? null : Date.parse(writ.spec.expiresAt),
        anchored_at: writ?.anchoredAt === undefined || writ.anchoredAt === null
          ? null
          : Date.parse(writ.anchoredAt),
        ledger: {
          length: entries.length,
          head_hash: head?.hash ?? "0".repeat(64),
        },
      },
    };
  }

  return notFound();
}

function specFromCreateBody(
  body: Record<string, unknown>,
  principal: PrincipalRef,
): WritSpec {
  return {
    // The endpoint takes this from `$auth`, never from the body — the client
    // does not even send it. If it ever starts to, this test double will keep
    // ignoring it, which is what makes the omission visible.
    principal,
    agent: {
      id: String(body.agent_external_id ?? ""),
      label: String(body.agent_label ?? ""),
      domain: String(body.agent_domain ?? ""),
      publicKey: String(body.agent_public_key ?? ""),
    },
    grants: ((body.grants ?? []) as WireGrant[]).map(grantFromWire),
    effectiveFrom: String(body.effective_from),
    expiresAt: String(body.expires_at),
    jurisdiction: String(body.jurisdiction ?? ""),
  };
}

function wirePrincipal(principal: PrincipalRef): WireSpec["principal"] {
  return {
    id: principal.id,
    legal_name: principal.legalName,
    email: principal.email,
    entity_verified: principal.entityVerified,
  };
}

/** Timestamps go out as epoch millis, the way Xano emits `timestamp` columns. */
function wireWrit(writ: StoredWrit): WireWrit {
  return {
    id: writ.id,
    status: writ.status,
    spec: {
      principal: wirePrincipal(writ.spec.principal),
      agent: {
        id: writ.spec.agent.id,
        label: writ.spec.agent.label,
        domain: writ.spec.agent.domain,
        public_key: writ.spec.agent.publicKey,
      },
      grants: writ.spec.grants.map((grant) => ({
        ref: grant.ref,
        act_kind: grant.actKind,
        limits: grant.limits,
        conditions: grant.conditions,
      })),
      effective_from: Date.parse(writ.spec.effectiveFrom),
      expires_at: Date.parse(writ.spec.expiresAt),
      jurisdiction: writ.spec.jurisdiction,
    },
    document_url: writ.documentUrl,
    document_sha256: writ.documentSha256,
    envelope_id: writ.envelopeId,
    policy: writ.policy,
    anchored_at: writ.anchoredAt === null ? null : Date.parse(writ.anchoredAt),
  };
}

function xanoError(code: string, message: string): unknown {
  return { code, message };
}

function unauthorized(): Reply {
  return { status: 401, body: xanoError("ERROR_CODE_UNAUTHORIZED", "Authentication required.") };
}

function notFound(): Reply {
  return { status: 404, body: xanoError("ERROR_CODE_NOT_FOUND", "Not found.") };
}

function errorReply(error: unknown): Reply {
  const code = (error as { code?: string }).code;
  if (code === "IMMUTABLE_FIELD") {
    return {
      status: 400,
      body: xanoError("ERROR_CODE_INPUT_ERROR", "The terms of a signed writ are not editable."),
    };
  }
  if (code === "FORBIDDEN") {
    return {
      status: 403,
      body: xanoError("ERROR_CODE_ACCESS_DENIED", "This writ is revoked; that is terminal."),
    };
  }
  return notFound();
}

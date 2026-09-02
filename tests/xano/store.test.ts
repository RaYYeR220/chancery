/**
 * The HTTP store, driven entirely through a fake fetch.
 *
 * The assertions concentrate on the request rather than the reply, because that
 * is where the risk lives: whether the bearer token is attached to the calls
 * that need it and withheld from the ones that must not have it, whether a
 * principal id ever leaves this process, and whether the free-tier throttle is
 * recognised for what it is.
 */

import { describe, expect, it } from "vitest";

import { digest } from "@/lib/core/canonical";
import {
  FREE_TIER_REQUESTS,
  FREE_TIER_WINDOW_MS,
  XanoAuthError,
  XanoError,
  XanoLedgerError,
  XanoRateLimitError,
  XanoWritStore,
} from "@/lib/adapters/xano";
import {
  TOO_MANY_REQUESTS,
  fakeFetch,
  failingFetch,
  hangingFetch,
} from "../fixtures/xano/fake-fetch";
import { bundle, spec } from "../fixtures/xano/specs";

const BASE = "https://x8ki-letl-twmt.n7.xano.io/api:chancery";
const AUTH_BASE = "https://x8ki-letl-twmt.n7.xano.io/api:auth";
const PUBLIC_BASE = "https://x8ki-letl-twmt.n7.xano.io/api:verify";
const TOKEN = "jwt-token";

// `null` means "no token at all", which is not the same as leaving the argument
// off — a default parameter would swallow the case this suite needs to test.
function store(fetchImpl: ReturnType<typeof fakeFetch>, token: string | null = TOKEN) {
  return new XanoWritStore({
    baseUrl: BASE,
    authBaseUrl: AUTH_BASE,
    publicBaseUrl: PUBLIC_BASE,
    token: token ?? undefined,
    fetchImpl,
    now: () => Date.parse("2026-09-03T12:00:00.000Z"),
  });
}

const WRIT_BODY = {
  id: "writ-uuid",
  status: "draft",
  spec: {
    principal: {
      id: "prin_9f3c",
      legal_name: "Northwind Coffee Ltd",
      email: "ops@northwind.example",
      entity_verified: true,
    },
    agent: {
      id: "agent_01",
      label: "Northwind ops agent",
      domain: "ops.northwind.example",
      public_key: "cHVibGljLWtleQ",
    },
    grants: [
      {
        ref: "3(b)",
        act_kind: "domain.register",
        limits: [{ type: "count", max: 3, window: "total" }],
        conditions: [],
      },
    ],
    effective_from: Date.parse("2026-09-01T00:00:00.000Z"),
    expires_at: Date.parse("2026-10-01T00:00:00.000Z"),
    jurisdiction: "IE",
  },
  document_url: null,
  document_sha256: null,
  envelope_id: null,
  policy: null,
  anchored_at: null,
};

describe("transport", () => {
  it("attaches the bearer token to authenticated calls", async () => {
    const fetchImpl = fakeFetch({ body: WRIT_BODY });
    await store(fetchImpl).getWrit("writ-uuid");
    expect(fetchImpl.last().headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("sends no Authorization header at all to the public verifier", async () => {
    const fetchImpl = fakeFetch({ body: { agent_domain: "x", ledger: { length: 0, head_hash: "0" } } });
    await store(fetchImpl).verify("ops.northwind.example");
    expect(fetchImpl.last().headers.has("authorization")).toBe(false);
    expect(fetchImpl.last().url.startsWith(PUBLIC_BASE)).toBe(true);
  });

  it("routes signup and login to the auth group, unauthenticated", async () => {
    const fetchImpl = fakeFetch({
      body: { authToken: "fresh", principal: WRIT_BODY.spec.principal },
    });
    const client = store(fetchImpl, null);
    const result = await client.login({ email: "a@b.test", password: "hunter22hunter" });

    expect(fetchImpl.last().url).toBe(`${AUTH_BASE}/auth/login`);
    expect(fetchImpl.last().headers.has("authorization")).toBe(false);
    expect(result.token).toBe("fresh");
    // The token is retained, so the next authenticated call works without the
    // caller threading it through by hand.
    expect(client.token).toBe("fresh");
  });

  it("refuses an authenticated call with no token rather than sending one anonymously", async () => {
    const fetchImpl = fakeFetch({ body: null });
    await expect(store(fetchImpl, null).getWrit("writ-uuid")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("percent-encodes the writ id into the path", async () => {
    const fetchImpl = fakeFetch({ body: null });
    await store(fetchImpl).getWrit("a/b?c");
    expect(fetchImpl.last().pathname).toBe("/api:chancery/writ/a%2Fb%3Fc");
  });

  it("reports a dropped connection as TRANSPORT, not as a bad response", async () => {
    await expect(store(failingFetch()).getWrit("x")).rejects.toMatchObject({ code: "TRANSPORT" });
  });

  it("times out on its own clock", async () => {
    const client = new XanoWritStore({
      baseUrl: BASE,
      token: TOKEN,
      fetchImpl: hangingFetch(),
      timeoutMs: 5,
    });
    await expect(client.getWrit("x")).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("rejects a non-JSON 200 rather than returning a string as a writ", async () => {
    const fetchImpl = fakeFetch({ rawBody: "<html>maintenance</html>" });
    await expect(store(fetchImpl).getWrit("x")).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
  });
});

describe("the free-tier rate limit", () => {
  it("is a distinct typed error carrying a retry hint", async () => {
    const fetchImpl = fakeFetch(TOO_MANY_REQUESTS);
    const error = await store(fetchImpl)
      .getWrit("x")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(XanoRateLimitError);
    const rateLimit = error as XanoRateLimitError;
    expect(rateLimit.code).toBe("RATE_LIMITED");
    expect(rateLimit.retryAfterMs).toBe(FREE_TIER_WINDOW_MS);
    expect(rateLimit.limit).toBe(FREE_TIER_REQUESTS);
  });

  it("prefers an explicit Retry-After over the documented window", async () => {
    const fetchImpl = fakeFetch({ ...TOO_MANY_REQUESTS, headers: { "retry-after": "7" } });
    const error = (await store(fetchImpl)
      .getWrit("x")
      .catch((e: unknown) => e)) as XanoRateLimitError;
    expect(error.retryAfterMs).toBe(7_000);
  });

  it("is recognised even when it arrives dressed as a 200", async () => {
    // Xano's throttle does not fire inside its own debugger and has been seen
    // arriving under a success status. Parsing that envelope as a writ would be
    // far worse than raising.
    const fetchImpl = fakeFetch({ status: 200, body: TOO_MANY_REQUESTS.body });
    await expect(store(fetchImpl).getWrit("x")).rejects.toBeInstanceOf(XanoRateLimitError);
  });
});

describe("error mapping", () => {
  it("maps Xano's own error code ahead of the status it rides on", async () => {
    const fetchImpl = fakeFetch({
      status: 403,
      body: { code: "ERROR_CODE_UNAUTHORIZED", message: "Authentication required." },
    });
    await expect(store(fetchImpl).getWrit("x")).rejects.toBeInstanceOf(XanoAuthError);
  });

  it("maps a plain 403 to FORBIDDEN", async () => {
    const fetchImpl = fakeFetch({ status: 403, body: { message: "nope" } });
    await expect(store(fetchImpl).getWrit("x")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("carries the method and path so a failure is attributable", async () => {
    const fetchImpl = fakeFetch({ status: 500, body: { message: "boom" } });
    const error = (await store(fetchImpl)
      .actHistory("writ-uuid")
      .catch((e: unknown) => e)) as XanoError;
    expect(error.method).toBe("GET");
    expect(error.path).toBe("/writ/writ-uuid/act");
  });
});

describe("createWrit", () => {
  it("never sends a principal", async () => {
    const fetchImpl = fakeFetch({ body: WRIT_BODY });
    await store(fetchImpl).createWrit(spec());

    const body = fetchImpl.last().body as Record<string, unknown>;
    expect(Object.keys(body).some((key) => key.includes("principal"))).toBe(false);
    expect(body.agent_domain).toBe("ops.northwind.example");
  });

  it("sends limits and conditions verbatim, camelCase keys intact", async () => {
    const fetchImpl = fakeFetch({ body: WRIT_BODY });
    await store(fetchImpl).createWrit(spec());

    const body = fetchImpl.last().body as { grants: { limits: unknown[] }[] };
    // `maxMinorUnits`, not `max_minor_units`: these objects are hashed into the
    // evidence bundle, and renaming a key changes the digest of the same authority.
    expect(body.grants[0].limits[1]).toEqual({
      type: "amount",
      maxMinorUnits: 5_000,
      currency: "USD",
      window: "total",
    });
  });

  it("coerces Xano's epoch-millis timestamps back to ISO-8601", async () => {
    const fetchImpl = fakeFetch({ body: WRIT_BODY });
    const writ = await store(fetchImpl).createWrit(spec());
    expect(writ.spec.effectiveFrom).toBe("2026-09-01T00:00:00.000Z");
    expect(writ.spec.expiresAt).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("getWrit", () => {
  it("treats a 200 null as absent", async () => {
    const fetchImpl = fakeFetch({ body: null });
    await expect(store(fetchImpl).getWrit("nope")).resolves.toBeNull();
  });

  it("does NOT treat a 404 as absent, because a mistyped path is also a 404", async () => {
    const fetchImpl = fakeFetch({ status: 404, body: { code: "ERROR_CODE_NOT_FOUND" } });
    await expect(store(fetchImpl).getWrit("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("updateWrit", () => {
  it("refuses to patch the terms of a signed instrument", async () => {
    const fetchImpl = fakeFetch({ body: WRIT_BODY });
    await expect(
      store(fetchImpl).updateWrit("writ-uuid", { spec: spec() }),
    ).rejects.toMatchObject({ code: "IMMUTABLE_FIELD" });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("refuses to patch the id", async () => {
    const fetchImpl = fakeFetch({ body: WRIT_BODY });
    await expect(store(fetchImpl).updateWrit("writ-uuid", { id: "other" })).rejects.toMatchObject({
      code: "IMMUTABLE_FIELD",
    });
  });

  it("sends only the fields that were given", async () => {
    const fetchImpl = fakeFetch({ body: WRIT_BODY });
    await store(fetchImpl).updateWrit("writ-uuid", { status: "active", envelopeId: null });
    expect(fetchImpl.last().body).toEqual({ status: "active", envelope_id: null });
    expect(fetchImpl.last().method).toBe("PATCH");
  });

  it("refuses an empty patch rather than issuing a pointless write", async () => {
    const fetchImpl = fakeFetch({ body: WRIT_BODY });
    await expect(store(fetchImpl).updateWrit("writ-uuid", {})).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

describe("appendLedger", () => {
  const input = { kind: "act.decided" as const, at: "2026-09-03T12:00:00.000Z", payload: { writId: "w1" } };

  function chained(overrides: Record<string, unknown> = {}) {
    const base = {
      sequence: 0,
      previous_hash: "0".repeat(64),
      kind: input.kind,
      at: input.at,
      payload: input.payload,
    };
    const merged = { ...base, ...overrides };
    return {
      ...merged,
      hash:
        (overrides.hash as string | undefined) ??
        digest({
          sequence: merged.sequence,
          previousHash: merged.previous_hash,
          kind: merged.kind,
          at: merged.at,
          payload: merged.payload,
        }),
    };
  }

  it("sends only kind, at and payload — the server assigns the position", async () => {
    const fetchImpl = fakeFetch({ body: chained() });
    await store(fetchImpl).appendLedger(input);

    const body = fetchImpl.last().body as Record<string, unknown>;
    expect(body).toEqual({ ...input, writ_id: "w1" });
    expect(body.sequence).toBeUndefined();
    expect(body.hash).toBeUndefined();
  });

  it("accepts an entry whose contents reproduce its hash", async () => {
    const fetchImpl = fakeFetch({ body: chained() });
    const entry = await store(fetchImpl).appendLedger(input);
    expect(entry.sequence).toBe(0);
    expect(entry.previousHash).toBe("0".repeat(64));
  });

  it("rejects an entry whose hash it cannot reproduce", async () => {
    // An entry nobody can recompute is not evidence, so it is refused rather
    // than kept as though it were fine.
    const fetchImpl = fakeFetch({ body: chained({ hash: "f".repeat(64) }) });
    const error = await store(fetchImpl)
      .appendLedger(input)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(XanoLedgerError);
    expect((error as XanoLedgerError).receivedHash).toBe("f".repeat(64));
  });

  it("rejects an entry whose payload was altered in flight", async () => {
    const tampered = chained();
    tampered.payload = { writId: "somebody-else" };
    const fetchImpl = fakeFetch({ body: tampered });
    await expect(store(fetchImpl).appendLedger(input)).rejects.toBeInstanceOf(XanoLedgerError);
  });

  it("omits writ_id when the payload names no writ", async () => {
    const anonymous = { kind: "act.failed" as const, at: input.at, payload: { note: "no writ" } };
    const fetchImpl = fakeFetch({ body: chained({ kind: "act.failed", payload: anonymous.payload }) });
    await store(fetchImpl).appendLedger(anonymous);
    expect((fetchImpl.last().body as Record<string, unknown>).writ_id).toBeUndefined();
  });
});

describe("putEvidence", () => {
  it("files the bundle under the digest it was given", async () => {
    const fetchImpl = fakeFetch({ body: { url: "https://chancery.local/receipt/abc" } });
    const result = await store(fetchImpl).putEvidence(bundle(), "abc");

    const body = fetchImpl.last().body as Record<string, unknown>;
    expect(body.digest).toBe("abc");
    expect(body.outcome).toBe("allow");
    expect(result.url).toBe("https://chancery.local/receipt/abc");
  });
});

describe("ledger", () => {
  it("passes the writ filter through as a query parameter", async () => {
    const fetchImpl = fakeFetch({ body: [] });
    await store(fetchImpl).ledger("writ-uuid");
    expect(fetchImpl.last().query.get("writ_id")).toBe("writ-uuid");
  });

  it("omits the filter entirely when none was asked for", async () => {
    const fetchImpl = fakeFetch({ body: [] });
    await store(fetchImpl).ledger();
    expect(fetchImpl.last().url).toBe(`${BASE}/ledger`);
  });

  it("rejects a ledger kind this build does not know how to enforce", async () => {
    const fetchImpl = fakeFetch({
      body: [{ sequence: 0, previous_hash: "0", hash: "h", kind: "writ.teleported", at: "t", payload: {} }],
    });
    await expect(store(fetchImpl).ledger()).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });
});

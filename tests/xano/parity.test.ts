/**
 * The two stores, run side by side against the same script.
 *
 * The claim this suite defends is the one that makes the credential-free demo
 * worth anything: `MemoryWritStore` is not a mock the product hides behind, it
 * is the same semantics with a different substrate. So every operation is
 * performed on both — one directly, one over HTTP through the backend double —
 * and the results are compared for deep equality, errors included.
 *
 * Running the HTTP path through a real serialisation round trip is deliberate.
 * A parity test that called the two classes directly would prove they agree
 * while the thing that actually differs between them — snake_case envelopes,
 * epoch-millis timestamps, JSON round-tripping of policy objects — went
 * completely untested.
 */

import { describe, expect, it } from "vitest";

import { bundleDigest } from "@/lib/core/evidence";
import { verifyChain } from "@/lib/core/ledger";
import { MemoryWritStore, XanoWritStore } from "@/lib/adapters/xano";
import type { WritStore } from "@/lib/service/ports";
import { DEFAULT_PRINCIPAL, TOKEN, fakeBackend } from "../fixtures/xano/fake-backend";
import { AGENT_DOMAIN, bundle, executedAct, spec } from "../fixtures/xano/specs";
import { policy } from "../core/fixtures";

const EVIDENCE_BASE = "https://chancery.local/receipt";

function deterministicIds(): () => string {
  let n = 0;
  return () => `writ_${(n += 1)}`;
}

function pair(): { direct: WritStore; overHttp: WritStore; memory: MemoryWritStore } {
  const direct = new MemoryWritStore({
    principal: DEFAULT_PRINCIPAL,
    evidenceBaseUrl: EVIDENCE_BASE,
    newId: deterministicIds(),
  });
  const backend = fakeBackend({ newId: deterministicIds(), evidenceBaseUrl: EVIDENCE_BASE });
  const overHttp = new XanoWritStore({
    baseUrl: "https://fake.n7.xano.io/api:chancery",
    token: TOKEN,
    fetchImpl: backend.fetchImpl,
  });
  return { direct, overHttp, memory: backend.store };
}

/** Run one operation on both stores and assert they answered identically. */
async function both<T>(
  stores: { direct: WritStore; overHttp: WritStore },
  operation: (store: WritStore) => Promise<T>,
): Promise<T> {
  const a = await operation(stores.direct);
  const b = await operation(stores.overHttp);
  expect(b).toEqual(a);
  return a;
}

async function bothReject(
  stores: { direct: WritStore; overHttp: WritStore },
  operation: (store: WritStore) => Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(operation(stores.direct)).rejects.toMatchObject({ code });
  await expect(operation(stores.overHttp)).rejects.toMatchObject({ code });
}

describe("store parity", () => {
  it("agrees on the whole issuance-to-execution path", async () => {
    const stores = pair();

    const created = await both(stores, (store) => store.createWrit(spec()));
    expect(created.id).toBe("writ_1");
    expect(created.status).toBe("draft");

    await both(stores, (store) => store.getWrit(created.id));
    await both(stores, (store) => store.getWritByAgentDomain(AGENT_DOMAIN));

    await both(stores, (store) =>
      store.updateWrit(created.id, { status: "pending_signature", envelopeId: "env_7" }),
    );

    // The policy round-trips through JSON on the HTTP path. Its camelCase keys
    // and null-vs-absent distinctions have to survive, because the same object
    // is hashed into every receipt.
    const activated = await both(stores, (store) =>
      store.updateWrit(created.id, {
        status: "active",
        documentUrl: "https://chancery.example/writ/writ_1.pdf",
        documentSha256: "Zm9vYmFyLWRvY3VtZW50LWhhc2g",
        policy: policy(),
      }),
    );
    expect(activated.policy?.provenance["/grants/0"].confidence).toBe(0.94);
    expect(activated.policy?.ungrounded).toEqual([]);

    await both(stores, (store) =>
      store.updateWrit(created.id, { anchoredAt: "2026-09-03T12:00:00.000Z" }),
    );

    await both(stores, async (store) => {
      await store.recordExecutedAct(created.id, executedAct());
      await store.recordExecutedAct(created.id, executedAct({ amountMinorUnits: 2_500 }));
      return store.actHistory(created.id);
    });

    await both(stores, (store) => store.getWrit(created.id));
  });

  it("agrees on the ledger, hash for hash", async () => {
    const stores = pair();
    const inputs = [
      { kind: "writ.issued" as const, at: "2026-09-01T00:00:00.000Z", payload: { writId: "w1" } },
      {
        kind: "act.decided" as const,
        at: "2026-09-02T00:00:00.000Z",
        payload: { writId: "w1", outcome: "deny", reasons: [{ code: "AMOUNT_LIMIT_EXCEEDED" }] },
      },
      { kind: "act.executed" as const, at: "2026-09-03T00:00:00.000Z", payload: { writId: "w2" } },
    ];

    for (const input of inputs) {
      await both(stores, (store) => store.appendLedger(input));
    }

    const all = await both(stores, (store) => store.ledger());
    expect(verifyChain(all)).toEqual([]);

    await both(stores, (store) => store.ledger("w1"));
    await both(stores, (store) => store.ledger("w2"));
    await both(stores, (store) => store.ledger("nobody"));
  });

  it("agrees on receipt addresses", async () => {
    const stores = pair();
    const evidence = bundle();
    const key = bundleDigest(evidence);

    const first = await both(stores, (store) => store.putEvidence(evidence, key));
    const second = await both(stores, (store) => store.putEvidence(evidence, key));
    expect(second.url).toBe(first.url);
    expect(first.url.endsWith(key)).toBe(true);
  });

  it("agrees that a missing writ is null and not an error", async () => {
    const stores = pair();
    await both(stores, (store) => store.getWrit("never-existed"));
    await both(stores, (store) => store.getWritByAgentDomain("nowhere.example"));
  });

  it("agrees on the refusals, with the same typed codes", async () => {
    const stores = pair();
    const created = await both(stores, (store) => store.createWrit(spec()));

    await bothReject(stores, (store) => store.updateWrit(created.id, { spec: spec() }), "IMMUTABLE_FIELD");
    await bothReject(stores, (store) => store.updateWrit("ghost", { status: "active" }), "NOT_FOUND");
    await bothReject(stores, (store) => store.recordExecutedAct("ghost", executedAct()), "NOT_FOUND");

    await both(stores, (store) => store.updateWrit(created.id, { status: "revoked" }));
    await bothReject(stores, (store) => store.updateWrit(created.id, { status: "active" }), "FORBIDDEN");
  });

  it("keeps the HTTP path honest about what it actually sent", async () => {
    // Guards the parity above from being satisfied by a double that shortcuts:
    // if the client stopped issuing requests, every comparison would still pass.
    const backend = fakeBackend({ newId: deterministicIds() });
    const client = new XanoWritStore({
      baseUrl: "https://fake.n7.xano.io/api:chancery",
      token: TOKEN,
      fetchImpl: backend.fetchImpl,
    });

    const writ = await client.createWrit(spec());
    await client.getWrit(writ.id);
    await client.appendLedger({ kind: "writ.issued", at: "t", payload: { writId: writ.id } });

    expect(backend.calls.map((call) => `${call.method} ${call.pathname}`)).toEqual([
      "POST /api:chancery/writ",
      "GET /api:chancery/writ/writ_1",
      "POST /api:chancery/ledger",
    ]);
  });
});

describe("the free-tier throttle in the middle of a flow", () => {
  it("surfaces as a retryable rate limit, not as a corrupt writ", async () => {
    const backend = fakeBackend({ newId: deterministicIds(), throttleFrom: 2 });
    const client = new XanoWritStore({
      baseUrl: "https://fake.n7.xano.io/api:chancery",
      token: TOKEN,
      fetchImpl: backend.fetchImpl,
    });

    const writ = await client.createWrit(spec());
    const error = await client.getWrit(writ.id).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 20_000 });
  });
});

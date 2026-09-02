/**
 * The in-memory store, held to the same standard as the backend it stands in for.
 *
 * The chain tests matter most. If this store's ledger were a convenient fiction,
 * every demo run without credentials would be proving nothing — so the entries
 * it produces are checked with `verifyChain`, the same function an outside
 * reviewer would use on entries that came out of Xano.
 */

import { describe, expect, it } from "vitest";

import { GENESIS_HASH, headHash, verifyChain } from "@/lib/core/ledger";
import { bundleDigest } from "@/lib/core/evidence";
import { MemoryWritStore } from "@/lib/adapters/xano";
import { AGENT_DOMAIN, bundle, executedAct, spec } from "../fixtures/xano/specs";

function ids() {
  let n = 0;
  return () => `writ_${(n += 1)}`;
}

describe("writs", () => {
  it("creates a draft with a fresh id and the spec intact", async () => {
    const store = new MemoryWritStore({ newId: ids() });
    const writ = await store.createWrit(spec());

    expect(writ.id).toBe("writ_1");
    expect(writ.status).toBe("draft");
    expect(writ.policy).toBeNull();
    expect(writ.spec.grants).toHaveLength(2);
    expect(writ.spec.grants[0].limits[1]).toEqual({
      type: "amount",
      maxMinorUnits: 5_000,
      currency: "USD",
      window: "total",
    });
  });

  it("returns null for a writ that does not exist", async () => {
    const store = new MemoryWritStore();
    await expect(store.getWrit("nope")).resolves.toBeNull();
    await expect(store.getWritByAgentDomain("nope.example")).resolves.toBeNull();
  });

  it("resolves an agent domain to the newest writ, whatever its status", async () => {
    // A revoked writ has to stay findable: the gate needs to answer
    // WRIT_REVOKED rather than NO_WRIT, and those say very different things.
    const store = new MemoryWritStore({ newId: ids() });
    await store.createWrit(spec());
    const second = await store.createWrit(spec());
    await store.updateWrit(second.id, { status: "revoked" });

    const found = await store.getWritByAgentDomain(AGENT_DOMAIN);
    expect(found?.id).toBe(second.id);
    expect(found?.status).toBe("revoked");
  });

  it("does not hand out a reference a caller could mutate the store through", async () => {
    const store = new MemoryWritStore({ newId: ids() });
    const created = await store.createWrit(spec());
    created.spec.grants[0].limits.length = 0;

    const reread = await store.getWrit(created.id);
    expect(reread?.spec.grants[0].limits).toHaveLength(3);
  });

  it("refuses to patch the terms of a signed instrument", async () => {
    const store = new MemoryWritStore({ newId: ids() });
    const writ = await store.createWrit(spec());
    await expect(store.updateWrit(writ.id, { spec: spec() })).rejects.toMatchObject({
      code: "IMMUTABLE_FIELD",
    });
  });

  it("treats revocation as terminal", async () => {
    const store = new MemoryWritStore({ newId: ids() });
    const writ = await store.createWrit(spec());
    await store.updateWrit(writ.id, { status: "revoked" });

    await expect(store.updateWrit(writ.id, { status: "active" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // A no-status patch on a revoked writ is still allowed: recording where the
    // tombstone was published is not reactivation.
    await expect(
      store.updateWrit(writ.id, { anchoredAt: "2026-09-03T12:00:00.000Z" }),
    ).resolves.toMatchObject({ status: "revoked" });
  });

  it("raises NOT_FOUND for an unknown writ rather than creating one", async () => {
    const store = new MemoryWritStore();
    await expect(store.updateWrit("ghost", { status: "active" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("act history", () => {
  it("keeps executed acts in the order they were recorded", async () => {
    const store = new MemoryWritStore({ newId: ids() });
    const writ = await store.createWrit(spec());

    await store.recordExecutedAct(writ.id, executedAct());
    await store.recordExecutedAct(
      writ.id,
      executedAct({ amountMinorUnits: 2_000, executedAt: "2026-09-02T10:00:00.000Z" }),
    );

    const history = await store.actHistory(writ.id);
    expect(history.map((entry) => entry.amountMinorUnits)).toEqual([1_099, 2_000]);
  });

  it("refuses to record an act against a writ that does not exist", async () => {
    const store = new MemoryWritStore();
    await expect(store.recordExecutedAct("ghost", executedAct())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("is empty for a writ that has done nothing", async () => {
    const store = new MemoryWritStore({ newId: ids() });
    const writ = await store.createWrit(spec());
    await expect(store.actHistory(writ.id)).resolves.toEqual([]);
  });
});

describe("the ledger", () => {
  it("links the first entry to the genesis hash", async () => {
    const store = new MemoryWritStore();
    const first = await store.appendLedger({ kind: "writ.issued", at: "t0", payload: { a: 1 } });
    expect(first.sequence).toBe(0);
    expect(first.previousHash).toBe(GENESIS_HASH);
  });

  it("produces a chain that verifies", async () => {
    const store = new MemoryWritStore();
    for (let i = 0; i < 12; i += 1) {
      await store.appendLedger({ kind: "act.decided", at: `t${i}`, payload: { i } });
    }
    const entries = await store.ledger();
    expect(verifyChain(entries)).toEqual([]);
    expect(headHash(entries)).toBe(entries[11].hash);
    expect(store.chainDefects()).toEqual([]);
  });

  it("records refusals as well as approvals", async () => {
    const store = new MemoryWritStore();
    await store.appendLedger({
      kind: "act.decided",
      at: "t0",
      payload: { writId: "w1", outcome: "deny", reasons: [{ code: "AMOUNT_LIMIT_EXCEEDED" }] },
    });
    const entries = await store.ledger("w1");
    expect(entries).toHaveLength(1);
    expect(verifyChain(entries)).toEqual([]);
  });

  it("filters by the writ named in the payload, and by nothing else", async () => {
    const store = new MemoryWritStore();
    await store.appendLedger({ kind: "writ.issued", at: "t0", payload: { writId: "w1" } });
    await store.appendLedger({ kind: "writ.issued", at: "t1", payload: { writId: "w2" } });
    await store.appendLedger({ kind: "act.failed", at: "t2", payload: "no writ here" });

    expect(await store.ledger("w1")).toHaveLength(1);
    expect(await store.ledger("w2")).toHaveLength(1);
    expect(await store.ledger()).toHaveLength(3);
  });

  it("keeps the global sequence contiguous even when a read is filtered", async () => {
    // The filtered view is a projection, not a chain of its own. Its sequence
    // numbers stay global, so an entry cannot be verified against a renumbered
    // subset and quietly pass.
    const store = new MemoryWritStore();
    await store.appendLedger({ kind: "writ.issued", at: "t0", payload: { writId: "w1" } });
    await store.appendLedger({ kind: "writ.issued", at: "t1", payload: { writId: "w2" } });
    await store.appendLedger({ kind: "act.decided", at: "t2", payload: { writId: "w1" } });

    const filtered = await store.ledger("w1");
    expect(filtered.map((entry) => entry.sequence)).toEqual([0, 2]);
  });
});

describe("receipts", () => {
  it("addresses a bundle by its digest and is idempotent", async () => {
    const store = new MemoryWritStore({ evidenceBaseUrl: "https://chancery.test/receipt/" });
    const evidence = bundle();
    const key = bundleDigest(evidence);

    const first = await store.putEvidence(evidence, key);
    const second = await store.putEvidence(evidence, key);

    expect(first.url).toBe(`https://chancery.test/receipt/${key}`);
    expect(second.url).toBe(first.url);
    expect(store.getEvidence(key)?.decision.outcome).toBe("allow");
  });

  it("has nothing to say about a digest it was never given", async () => {
    const store = new MemoryWritStore();
    expect(store.getEvidence("unknown")).toBeNull();
  });
});

describe("the authenticated-principal asymmetry", () => {
  it("keeps the spec's principal when no account is configured", async () => {
    const store = new MemoryWritStore({ newId: ids() });
    const writ = await store.createWrit(spec());
    expect(writ.spec.principal.email).toBe("ops@northwind.example");
  });

  it("replaces it when one is, exactly as the endpoint replaces it with $auth", async () => {
    const store = new MemoryWritStore({
      newId: ids(),
      principal: {
        id: "prin_other",
        legalName: "Someone Else Ltd",
        email: "else@example.test",
        entityVerified: false,
      },
    });
    const writ = await store.createWrit(
      spec({
        principal: {
          id: "prin_forged",
          legalName: "Not Me",
          email: "attacker@example.test",
          entityVerified: true,
        },
      }),
    );
    expect(writ.spec.principal.id).toBe("prin_other");
  });
});

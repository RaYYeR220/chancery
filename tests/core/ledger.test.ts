import { describe, expect, it } from "vitest";

import {
  appendEntry,
  decisionEntry,
  GENESIS_HASH,
  headHash,
  verifyChain,
  type LedgerEntry,
} from "@/lib/core/ledger";
import { decide } from "@/lib/core/gatekeeper";
import * as f from "./fixtures";

function chain(count: number): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    entries.push(
      appendEntry(entries.at(-1) ?? null, {
        kind: "act.decided",
        at: `2026-09-03T12:0${i}:00.000Z`,
        payload: { i },
      }),
    );
  }
  return entries;
}

describe("appending", () => {
  it("links the first entry to genesis", () => {
    const [first] = chain(1);
    expect(first.sequence).toBe(0);
    expect(first.previousHash).toBe(GENESIS_HASH);
  });

  it("links each entry to the one before it", () => {
    const entries = chain(3);
    expect(entries[1].previousHash).toBe(entries[0].hash);
    expect(entries[2].previousHash).toBe(entries[1].hash);
    expect(entries.map((e) => e.sequence)).toEqual([0, 1, 2]);
  });

  it("is insensitive to key order in the payload", () => {
    const a = appendEntry(null, { kind: "act.decided", at: "t", payload: { x: 1, y: 2 } });
    const b = appendEntry(null, { kind: "act.decided", at: "t", payload: { y: 2, x: 1 } });
    expect(a.hash).toBe(b.hash);
  });

  it("gives the same entry a different hash at a different position", () => {
    const first = appendEntry(null, { kind: "act.decided", at: "t", payload: { x: 1 } });
    const second = appendEntry(first, { kind: "act.decided", at: "t", payload: { x: 1 } });
    expect(second.hash).not.toBe(first.hash);
  });
});

describe("head", () => {
  it("is genesis for an empty chain", () => {
    expect(headHash([])).toBe(GENESIS_HASH);
  });

  it("is the last entry's hash otherwise", () => {
    const entries = chain(2);
    expect(headHash(entries)).toBe(entries[1].hash);
  });
});

describe("verification against a published head", () => {
  it("accepts an untouched chain", () => {
    expect(verifyChain(chain(5))).toEqual([]);
  });

  it("accepts an empty chain", () => {
    expect(verifyChain([])).toEqual([]);
  });

  it("catches an edited payload", () => {
    const entries = chain(3);
    entries[1] = { ...entries[1], payload: { i: 99 } };
    const defects = verifyChain(entries);
    expect(defects.map((d) => d.problem)).toContain("hash-mismatch");
  });

  it("catches a removed entry", () => {
    const entries = chain(4);
    entries.splice(1, 1);
    const problems = verifyChain(entries).map((d) => d.problem);
    expect(problems).toContain("sequence-gap");
    expect(problems).toContain("broken-link");
  });

  it("catches reordering", () => {
    const entries = chain(3);
    [entries[0], entries[1]] = [entries[1], entries[0]];
    expect(verifyChain(entries).length).toBeGreaterThan(0);
  });

  it("catches an entry appended with a forged link", () => {
    const entries = chain(2);
    entries.push({ ...entries[1], sequence: 2, previousHash: GENESIS_HASH });
    expect(verifyChain(entries).map((d) => d.problem)).toContain("broken-link");
  });

  it("reports every defect rather than stopping at the first", () => {
    const entries = chain(4);
    entries[1] = { ...entries[1], payload: { i: 99 } };
    entries[3] = { ...entries[3], payload: { i: 98 } };
    const mismatches = verifyChain(entries).filter((d) => d.problem === "hash-mismatch");
    expect(mismatches).toHaveLength(2);
  });
});

describe("recording decisions", () => {
  it("records a denial as faithfully as an approval", () => {
    const denial = decide(f.input({ lookup: { outcome: "absent" } }));
    const entry = appendEntry(null, decisionEntry(denial, f.request()));
    expect(entry.kind).toBe("act.decided");
    expect((entry.payload as { outcome: string }).outcome).toBe("deny");
    expect(verifyChain([entry])).toEqual([]);
  });

  it("hashes reason codes rather than their wording, so prose can be improved later", () => {
    const decision = decide(f.input());
    const original = appendEntry(null, decisionEntry(decision, f.request()));
    const reworded = {
      ...decision,
      reasons: decision.reasons.map((r) => ({ ...r, message: "different wording entirely" })),
    };
    expect(appendEntry(null, decisionEntry(reworded, f.request())).hash).toBe(original.hash);
  });

  it("changes the hash when the verdict changes", () => {
    const allow = appendEntry(null, decisionEntry(decide(f.input()), f.request()));
    const deny = appendEntry(
      null,
      decisionEntry(decide(f.input({ signatureValid: false })), f.request()),
    );
    expect(deny.hash).not.toBe(allow.hash);
  });
});

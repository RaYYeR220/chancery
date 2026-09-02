import { describe, expect, it } from "vitest";

import { ANSWER_KEY, SCENARIOS } from "@/lib/eval/scenarios";
import { runBenchmark, runScenario } from "@/lib/eval/runner";

describe("the benchmark itself", () => {
  it("has a scenario of every kind, so the score cannot be gamed in one direction", () => {
    const kinds = new Set(SCENARIOS.map((s) => s.kind));
    expect(kinds).toEqual(new Set(["permitted", "refused", "trap"]));
  });

  it("has enough permitted cases that a deny-everything gate would fail", () => {
    expect(SCENARIOS.filter((s) => s.expect.outcome === "allow").length).toBeGreaterThanOrEqual(5);
  });

  it("uses unique ids", () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });

  it("pins the answer key to the scenarios", () => {
    expect(Object.keys(ANSWER_KEY)).toHaveLength(SCENARIOS.length);
  });
});

describe("scoring", () => {
  it("passes every scenario", () => {
    const scorecard = runBenchmark();
    const failures = scorecard.results.filter((r) => !r.passed);
    expect(
      failures.map((r) => `${r.scenario.id}: ${r.detail}`),
      "scenarios the engine got wrong",
    ).toEqual([]);
    expect(scorecard.passed).toBe(scorecard.total);
  });

  it("never allows an act it should have refused", () => {
    expect(runBenchmark().falseAllows).toBe(0);
  });

  it("never refuses an act it should have allowed", () => {
    expect(runBenchmark().falseDenies).toBe(0);
  });

  it("counts a denial for the wrong reason as a failure", () => {
    // A gate can deny for an unrelated reason and still look correct if only
    // the outcome is scored. Confirm the runner does not accept that.
    const wrongReason = runScenario({
      ...SCENARIOS.find((s) => s.id === "R-08")!,
      expect: { outcome: "deny", code: "OUT_OF_JURISDICTION" },
    });
    expect(wrongReason.passed).toBe(false);
    expect(wrongReason.detail).toMatch(/expected OUT_OF_JURISDICTION/);
  });

  it("treats a crash in the engine as a failure rather than a denial", () => {
    const crashing = runScenario({
      id: "X-00",
      kind: "refused",
      description: "the engine throws",
      expect: { outcome: "deny", code: "NO_WRIT" },
      build: () => {
        throw new Error("boom");
      },
    });
    expect(crashing.passed).toBe(false);
    expect(crashing.detail).toMatch(/the engine threw/);
  });
});

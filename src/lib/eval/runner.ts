/**
 * Running the benchmark and scoring it.
 *
 * The scorecard reports each kind separately on purpose. A single aggregate
 * number hides the two ways this can fail badly: a gate that denies everything
 * scores perfectly on the refusals, and a gate that allows everything scores
 * perfectly on the permitted acts. Only the two together mean anything, and the
 * traps are where the difference actually shows.
 */

import { decide } from "../core/gatekeeper";
import type { Decision } from "../core/types";
import { SCENARIOS, type Scenario, type ScenarioKind } from "./scenarios";

export interface ScenarioResult {
  scenario: Scenario;
  decision: Decision;
  passed: boolean;
  /** Why it failed, in one line. Empty when it passed. */
  detail: string;
}

export interface KindScore {
  kind: ScenarioKind;
  passed: number;
  total: number;
}

export interface Scorecard {
  results: ScenarioResult[];
  byKind: KindScore[];
  passed: number;
  total: number;
  /** Allowed something that should have been refused. The expensive direction. */
  falseAllows: number;
  /** Refused something that should have been allowed. */
  falseDenies: number;
}

export function runScenario(scenario: Scenario): ScenarioResult {
  let decision: Decision;
  try {
    decision = decide(scenario.build());
  } catch (error) {
    return {
      scenario,
      decision: crashDecision(error),
      passed: false,
      detail: `the engine threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const outcomeMatches = decision.outcome === scenario.expect.outcome;
  // The reason has to match too. Denying for the wrong reason is a different
  // bug from denying, and it is one a pass/fail on the outcome alone hides.
  const codeMatches = decision.reasons.some((reason) => reason.code === scenario.expect.code);

  const problems: string[] = [];
  if (!outcomeMatches) {
    problems.push(`expected ${scenario.expect.outcome}, got ${decision.outcome}`);
  }
  if (!codeMatches) {
    problems.push(
      `expected ${scenario.expect.code}, got [${decision.reasons.map((r) => r.code).join(", ")}]`,
    );
  }

  return {
    scenario,
    decision,
    passed: problems.length === 0,
    detail: problems.join("; "),
  };
}

export function runBenchmark(scenarios: readonly Scenario[] = SCENARIOS): Scorecard {
  const results = scenarios.map(runScenario);

  const kinds: ScenarioKind[] = ["permitted", "refused", "trap"];
  const byKind = kinds.map((kind) => {
    const forKind = results.filter((r) => r.scenario.kind === kind);
    return {
      kind,
      passed: forKind.filter((r) => r.passed).length,
      total: forKind.length,
    };
  });

  return {
    results,
    byKind,
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    falseAllows: results.filter(
      (r) => r.scenario.expect.outcome === "deny" && r.decision.outcome === "allow",
    ).length,
    falseDenies: results.filter(
      (r) => r.scenario.expect.outcome === "allow" && r.decision.outcome === "deny",
    ).length,
  };
}

export function formatScorecard(scorecard: Scorecard): string {
  const lines: string[] = [];
  lines.push("Chancery decision benchmark");
  lines.push("");

  for (const result of scorecard.results) {
    const mark = result.passed ? "pass" : "FAIL";
    lines.push(`  ${mark}  ${result.scenario.id}  ${result.scenario.description}`);
    if (!result.passed) lines.push(`        ${result.detail}`);
  }

  lines.push("");
  for (const kind of scorecard.byKind) {
    lines.push(`  ${kind.kind.padEnd(10)} ${kind.passed}/${kind.total}`);
  }
  lines.push("");
  lines.push(`  total      ${scorecard.passed}/${scorecard.total}`);
  lines.push(`  allowed something it should have refused: ${scorecard.falseAllows}`);
  lines.push(`  refused something it should have allowed: ${scorecard.falseDenies}`);
  return lines.join("\n");
}

function crashDecision(error: unknown): Decision {
  return {
    outcome: "deny",
    reasons: [
      {
        code: "INTERNAL_FAIL_CLOSED",
        message: error instanceof Error ? error.message : String(error),
      },
    ],
    writId: null,
    documentHash: null,
    evaluatedAt: new Date(0).toISOString(),
    evidence: {
      actRequest: {
        kind: "domain.register",
        fields: {},
        requestedAt: new Date(0).toISOString(),
      },
      historyCount: 0,
      diligence: [],
    },
  };
}

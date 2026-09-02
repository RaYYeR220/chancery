import { describe, expect, it } from "vitest";

import { decide } from "@/lib/core/gatekeeper";
import { DEMO_SCRIPT, verifiableSteps } from "@/lib/demo/script";
import * as w from "@/lib/eval/world";
import type { ActHistoryEntry } from "@/lib/core/types";

/**
 * The walkthrough is only worth showing if it is true. These tests run the
 * scripted acts through the real engine, in order, carrying history forward the
 * way a live session would — so a change that breaks the story fails here
 * rather than on stage.
 */

describe("the demonstration", () => {
  it("does real work before it refuses anything", () => {
    const firstRefusal = DEMO_SCRIPT.findIndex((s) => s.kind === "gated-deny");
    expect(firstRefusal).toBeGreaterThan(4);
  });

  it("shows a refusal for more than one reason", () => {
    const codes = new Set(
      DEMO_SCRIPT.filter((s) => s.expect?.outcome === "deny").map((s) => s.expect!.code),
    );
    expect(codes.size).toBeGreaterThanOrEqual(4);
  });

  it("exercises every sponsor that is load-bearing", () => {
    const vendors = new Set(DEMO_SCRIPT.map((s) => s.vendor));
    for (const vendor of ["foxit", "doctavian", "nutrient", "namecom", "serpapi"]) {
      expect(vendors, `${vendor} never appears in the walkthrough`).toContain(vendor);
    }
  });

  it("gives every step something specific to look at", () => {
    for (const step of DEMO_SCRIPT) {
      expect(step.watch.length, `${step.id} has no watch note`).toBeGreaterThan(20);
      expect(step.narration.length, `${step.id} has no narration`).toBeGreaterThan(30);
    }
  });

  it("uses unique step ids", () => {
    expect(new Set(DEMO_SCRIPT.map((s) => s.id)).size).toBe(DEMO_SCRIPT.length);
  });
});

describe("running the script through the real engine", () => {
  it("produces exactly the verdicts the narration claims", () => {
    const history: ActHistoryEntry[] = [];
    const failures: string[] = [];

    for (const step of verifiableSteps()) {
      // The two verification steps break the world on purpose; everything else
      // runs against the same writ the principal signed in step D-04.
      const broken =
        step.id === "D-12"
          ? { fetchedDocumentHash: "dGFtcGVyZWQtaGFzaC1hZnRlci1lZGl0" }
          : step.id === "D-13"
            ? { lookup: { outcome: "revoked" as const, record: w.record({ status: "revoked" }) } }
            : {};

      const decision = decide(
        w.baseline({
          request: step.request,
          diligence: step.diligence,
          history: [...history],
          ...broken,
        }),
      );

      if (decision.outcome !== step.expect.outcome) {
        failures.push(`${step.id}: expected ${step.expect.outcome}, got ${decision.outcome}`);
      } else if (!decision.reasons.some((r) => r.code === step.expect.code)) {
        failures.push(
          `${step.id}: expected ${step.expect.code}, got [${decision.reasons.map((r) => r.code).join(", ")}]`,
        );
      }

      // Only an executed act consumes budget. A refusal costs the principal
      // nothing, which is why the fourth registration can be attempted at all.
      if (decision.outcome === "allow") {
        history.push({
          kind: step.request.kind,
          grantRef: decision.reasons[0]?.clauseRef ?? "",
          amountMinorUnits: step.request.amountMinorUnits ?? 0,
          currency: step.request.currency ?? "USD",
          executedAt: w.NOW,
        });
      }
    }

    expect(failures, "steps whose narration does not match the engine").toEqual([]);
  });

  it("refuses the fourth registration only because the first three succeeded", () => {
    // Guards against the count denial passing for an unrelated reason.
    const fourth = DEMO_SCRIPT.find((s) => s.id === "D-10")!;
    const withoutHistory = decide(
      w.baseline({ request: fourth.request, diligence: fourth.diligence, history: [] }),
    );
    expect(withoutHistory.outcome).toBe("allow");
  });
});

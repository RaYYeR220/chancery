/**
 * The credential-free path, end to end, and the two places it fails closed.
 *
 * "Works with no credentials" is only worth claiming if the thing that runs is
 * the real orchestrator over the real gatekeeper — so these drive `Chancery`
 * itself: propose, send, sign, collect, anchor, evaluate, act. What differs
 * from a live deployment is which objects answer the ports, and the composition
 * says which those are rather than leaving it to be inferred.
 */

import { describe, expect, it } from "vitest";

import { composeChancery } from "@/lib/service/compose";
import type { ActRequest } from "@/lib/core/types";
import { verifyChain } from "@/lib/core/ledger";
import * as w from "@/lib/eval/world";

import { spec } from "./support";

const NOTHING = {} as Record<string, string | undefined>;

/** The one clause with no diligence condition, so scope alone decides. */
function unconditionalSpec() {
  return spec({ grants: [w.domainGrant({ conditions: [] })] });
}

function registerRequest(overrides: Partial<ActRequest> = {}): ActRequest {
  return w.registerRequest(overrides);
}

/**
 * Propose, sign, read back and publish. `sign` is called explicitly because the
 * stand-in desk does not sign on its own: the ceremony is the one step no
 * software takes, and a stand-in that took it would be the first lie.
 */
async function issue(composition: ReturnType<typeof composeChancery>, writSpec = unconditionalSpec()) {
  const { chancery, standIns } = composition;
  const proposed = await chancery.proposeWrit(writSpec);
  const session = await chancery.sendForSignature(proposed.id);
  standIns.desk?.sign(session.envelopeId);
  const collected = await chancery.collectSignature(proposed.id);
  const anchored = await chancery.anchor(proposed.id);
  return { proposed, session, collected, anchored };
}

describe("the zero-credential composition", () => {
  it("puts every port on a stand-in and says so", () => {
    const { report, ports } = composeChancery({ env: NOTHING, clock: () => w.NOW });

    expect(report.standInThroughout).toBe(true);
    expect(report.headline).toBe("Stand-in throughout — no credentials configured");
    expect(ports.map((port) => port.mode)).toEqual(Array(7).fill("stand-in"));
    // The report is what a UI labels a verdict with, so it has to name the
    // thing that answered rather than the vendor that did not.
    expect(ports.find((port) => port.port === "store")?.implementation).toBe("MemoryWritStore");
    expect(ports.find((port) => port.port === "diligence")?.reason).toContain("Unknown denies");
  });

  it("issues, anchors and evaluates a writ without a single credential", async () => {
    const composition = composeChancery({
      env: { CHANCERY_ALLOW_UNAUTHENTICATED_DNS: "true" },
      clock: () => w.NOW,
    });
    const { chancery, standIns } = composition;

    const { proposed, session, collected, anchored } = await issue(composition);

    expect(session.envelopeId).toContain("stand-in");
    // Nothing may be collected before a human has acted, so this is null until
    // `sign` is called — which `issue` does between these two facts.
    expect(collected?.status).toBe("active");
    expect(collected?.policy?.documentHash).toBe(collected?.documentSha256);
    expect(anchored.value).toContain("v=WRIT1");

    const bundle = await chancery.evaluate(w.AGENT.domain, registerRequest());

    expect(bundle.decision.outcome).toBe("allow");
    expect(bundle.decision.reasons[0].clauseRef).toBe("3(b)");
    // The evidence names the stand-in zone, so a verdict read out of a stored
    // bundle can never be mistaken for one derived from public DNS.
    expect(bundle.resolution.resolver).toContain("in-process zone");
    expect(bundle.resolution.authenticatedData).toBe(false);
    expect(bundle.decision.reasons.some((reason) => reason.message.includes("unauthenticated"))).toBe(
      true,
    );

    const ledger = await standIns.store!.ledger(proposed.id);
    expect(ledger.length).toBeGreaterThan(0);
    expect(standIns.store!.chainDefects()).toEqual([]);
    expect(verifyChain(await standIns.store!.ledger())).toEqual([]);
  });

  it("carries the act out, and the order reference says nothing was bought", async () => {
    const composition = composeChancery({
      env: { CHANCERY_ALLOW_UNAUTHENTICATED_DNS: "true" },
      clock: () => w.NOW,
    });
    await issue(composition);

    const outcome = await composition.chancery.requestAct(w.AGENT.domain, registerRequest());

    expect(outcome.bundle.decision.outcome).toBe("allow");
    expect(outcome.executed?.reference).toContain("nothing-was-purchased");
  });

  it("refuses an unauthenticated answer unless the operator allowed it", async () => {
    // Same wiring, default flag. The stand-in resolver reports the AD flag
    // unset because an in-process zone carries no DNSSEC signature, and the
    // gate treats that exactly as it would a real unvalidated answer.
    const composition = composeChancery({ env: NOTHING, clock: () => w.NOW });
    await issue(composition);

    const bundle = await composition.chancery.evaluate(w.AGENT.domain, registerRequest());

    expect(bundle.decision.outcome).toBe("deny");
    expect(bundle.decision.reasons[0].code).toBe("NO_WRIT");
    expect(bundle.decision.reasons[0].message).toContain("DNSSEC");
  });

  it("revokes through the zone rather than by setting a flag", async () => {
    const composition = composeChancery({
      env: { CHANCERY_ALLOW_UNAUTHENTICATED_DNS: "true" },
      clock: () => w.NOW,
    });
    const { proposed } = await issue(composition);

    await composition.chancery.revoke(proposed.id);
    const bundle = await composition.chancery.evaluate(w.AGENT.domain, registerRequest());

    expect(bundle.decision.outcome).toBe("deny");
    expect(bundle.decision.reasons[0].code).toBe("WRIT_REVOKED");
  });
});

describe("diligence with no key", () => {
  it("returns unknown for the check it was asked to run, and the gate denies", async () => {
    const composition = composeChancery({
      env: { CHANCERY_ALLOW_UNAUTHENTICATED_DNS: "true" },
      clock: () => w.NOW,
    });

    // The benchmark's clause 3(b), which requires a trademark check. Everything
    // else about this act is inside every cap the principal wrote.
    await issue(composition, spec({ grants: [w.domainGrant()] }));
    const bundle = await composition.chancery.evaluate(w.AGENT.domain, registerRequest());

    expect(bundle.diligence).toHaveLength(1);
    expect(bundle.diligence[0]).toMatchObject({
      check: "trademark_clear",
      verdict: "unknown",
      citations: [],
    });
    expect(bundle.diligence[0].summary).toContain("SERPAPI_KEY");

    expect(bundle.decision.outcome).toBe("deny");
    expect(bundle.decision.reasons[0].code).toBe("DILIGENCE_UNKNOWN");
    expect(bundle.decision.reasons[0].clauseRef).toBe("3(b)");
  });

  it("never reports clear, whatever it is asked", async () => {
    const { deps } = composeChancery({ env: NOTHING, clock: () => w.NOW });

    const findings = await deps.diligence.run(
      {
        kind: "domain.register",
        fields: { domainName: "northwindcoffee.com" },
        principalLegalName: "Northwind Coffee Ltd",
      },
      ["trademark_clear", "no_adverse_media", "counterparty_exists"],
    );

    expect(findings).toHaveLength(3);
    expect(findings.every((finding) => finding.verdict === "unknown")).toBe(true);
    expect(findings.every((finding) => finding.citations.length === 0)).toBe(true);
  });
});

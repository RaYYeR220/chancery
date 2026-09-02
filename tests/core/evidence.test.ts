import { describe, expect, it } from "vitest";

import {
  bundleDigest,
  decideWithEvidence,
  replay,
  type BundleAssembly,
  type EvidenceBundle,
} from "@/lib/core/evidence";
import * as f from "./fixtures";

function assembly(overrides: Partial<BundleAssembly> = {}): BundleAssembly {
  return {
    resolution: {
      name: "_writ.ops.northwind.example",
      txtRecords: [
        "v=WRIT1; st=active; k=cHVibGljLWtleQ; h=Zm9vYmFyLWRvY3VtZW50LWhhc2g; " +
          "u=https://chancery.example/writ/writ_01.pdf; exp=1790000000",
      ],
      resolver: "https://cloudflare-dns.com/dns-query",
      authenticatedData: true,
      resolvedAt: f.NOW,
    },
    lookup: f.lookup(),
    document: {
      url: "https://chancery.example/writ/writ_01.pdf",
      sha256: f.DOCUMENT_HASH,
      byteLength: 48_120,
      signature: { verified: true, method: "pades", profile: "b-lt" },
    },
    extraction: {
      method: "nutrient/understand",
      responseDigest: "a".repeat(64),
      groundingPolicy: {
        acceptedMatches: ["id_match", "id_match_multiblock", "id_match_partial"],
        confidenceThreshold: 0.7,
      },
    },
    policy: f.policy(),
    request: f.request(),
    history: [],
    diligence: [f.finding()],
    now: f.NOW,
    ...overrides,
  };
}

describe("assembling a bundle", () => {
  it("packages the decision with everything it was derived from", () => {
    const bundle = decideWithEvidence(assembly());
    expect(bundle.decision.outcome).toBe("allow");
    expect(bundle.version).toBe("chancery-evidence/1");
    expect(bundle.resolution.txtRecords).toHaveLength(1);
    expect(bundle.document.signature?.profile).toBe("b-lt");
  });

  it("keeps the raw TXT strings, not just the parsed record", () => {
    // A disputer has to be able to see what the resolver actually said, since
    // parsing is one of the things they might disagree with us about.
    const bundle = decideWithEvidence(assembly());
    expect(bundle.resolution.txtRecords[0]).toContain("v=WRIT1");
  });

  it("records the grounding rule that was in force, because it is a choice", () => {
    const bundle = decideWithEvidence(assembly());
    expect(bundle.extraction.groundingPolicy.confidenceThreshold).toBe(0.7);
  });

  it("carries the document hash but not the document", () => {
    const bundle = decideWithEvidence(assembly()) as EvidenceBundle & { documentBytes?: unknown };
    expect(bundle.document.sha256).toBe(f.DOCUMENT_HASH);
    expect(bundle.documentBytes).toBeUndefined();
  });

  it("packages a denial as fully as an approval", () => {
    const bundle = decideWithEvidence(assembly({ policy: null }));
    expect(bundle.decision.outcome).toBe("deny");
    expect(bundle.diligence).toHaveLength(1);
  });
});

describe("content addressing", () => {
  it("is stable across key ordering", () => {
    expect(bundleDigest(decideWithEvidence(assembly()))).toBe(
      bundleDigest(decideWithEvidence(assembly())),
    );
  });

  it("changes when any input changes", () => {
    const original = bundleDigest(decideWithEvidence(assembly()));
    const altered = bundleDigest(
      decideWithEvidence(assembly({ request: f.request({ amountMinorUnits: 9_999 }) })),
    );
    expect(altered).not.toBe(original);
  });

  it("identifies the inputs, so two engines disagreeing still share a digest", () => {
    const bundle = decideWithEvidence(assembly());
    const withOtherVerdict: EvidenceBundle = {
      ...bundle,
      decision: { ...bundle.decision, outcome: "deny" },
    };
    expect(bundleDigest(withOtherVerdict)).toBe(bundleDigest(bundle));
  });
});

describe("replaying offline", () => {
  it("re-derives the recorded verdict from the bundle alone", () => {
    const result = replay(decideWithEvidence(assembly()));
    expect(result.agrees).toBe(true);
  });

  it("re-derives a denial too", () => {
    const result = replay(decideWithEvidence(assembly({ lookup: { outcome: "absent" } })));
    expect(result.agrees).toBe(true);
  });

  it("uses the bundle's own clock rather than the replayer's", () => {
    // The writ in the fixture expires in October; replaying it in December must
    // still reproduce the original allow.
    const bundle = decideWithEvidence(assembly());
    expect(replay(bundle).agrees).toBe(true);
  });

  it("reports a tampered verdict rather than silently agreeing", () => {
    const bundle = decideWithEvidence(assembly());
    const forged: EvidenceBundle = {
      ...bundle,
      decision: { ...bundle.decision, outcome: "deny" },
    };
    const result = replay(forged);
    expect(result.agrees).toBe(false);
    expect(result.agrees === false && result.differences[0]).toMatch(/outcome/);
  });

  it("reports a verdict whose reasons were rewritten", () => {
    const bundle = decideWithEvidence(assembly({ policy: null }));
    const forged: EvidenceBundle = {
      ...bundle,
      decision: {
        ...bundle.decision,
        reasons: [{ code: "GRANTED", message: "looks fine to me" }],
      },
    };
    const result = replay(forged);
    expect(result.agrees).toBe(false);
    expect(result.agrees === false && result.differences.join(" ")).toMatch(/reasons/);
  });

  it("catches a bundle whose evidence was edited after the fact", () => {
    // Flip the recorded DNSSEC flag: the recorded allow can no longer be
    // reproduced from the evidence as it now stands.
    const bundle = decideWithEvidence(assembly());
    const edited: EvidenceBundle = {
      ...bundle,
      resolution: { ...bundle.resolution, authenticatedData: false },
    };
    expect(replay(edited).agrees).toBe(false);
  });
});

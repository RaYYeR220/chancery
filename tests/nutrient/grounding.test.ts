import { describe, expect, it } from "vitest";

import type { Citation } from "../../src/lib/adapters/nutrient/extraction";
import {
  describeConfidence,
  expandPointer,
  groundExtraction,
  isFullyGrounded,
  toPolicyFields,
} from "../../src/lib/adapters/nutrient/grounding";
import writExtraction from "../fixtures/nutrient/writ-extraction.json";

function one(match: Citation["match"], confidence?: number) {
  return {
    data: { field: "value" },
    metadata: { field: { match, ...(confidence === undefined ? {} : { confidence }) } },
  };
}

const REQUIRED = ["/field"];

describe("match is the primary gate", () => {
  it("grounds all three id_match variants", () => {
    for (const match of ["id_match", "id_match_multiblock", "id_match_partial"] as const) {
      const report = groundExtraction(one(match, 0.5), { requiredPointers: REQUIRED });
      expect(report.grounded).toEqual(["/field"]);
      expect(report.ungrounded).toEqual([]);
    }
  });

  it("rejects fuzzy_match however high the confidence", () => {
    const report = groundExtraction(one("fuzzy_match", 0.99), { requiredPointers: REQUIRED });
    expect(report.ungrounded).toEqual(["/field"]);
    expect(report.findings[0].failure).toBe("UNGROUNDED_MATCH");
  });

  it("rejects not_found", () => {
    const report = groundExtraction(one("not_found"), { requiredPointers: REQUIRED });
    expect(report.findings[0].failure).toBe("UNGROUNDED_MATCH");
  });

  it("honours a caller-narrowed accepted set", () => {
    const report = groundExtraction(one("id_match_partial", 0.9), {
      requiredPointers: REQUIRED,
      acceptedMatches: ["id_match"],
    });
    expect(report.ungrounded).toEqual(["/field"]);
  });
});

describe("confidence is secondary and uncalibrated", () => {
  it("has no default threshold, so a low score alone does not deny", () => {
    const report = groundExtraction(one("id_match", 0.02), { requiredPointers: REQUIRED });
    expect(report.grounded).toEqual(["/field"]);
  });

  it("applies the threshold only when the caller supplies one", () => {
    const report = groundExtraction(one("id_match", 0.31), {
      requiredPointers: REQUIRED,
      confidenceThreshold: 0.6,
    });
    expect(report.findings[0].failure).toBe("BELOW_THRESHOLD");
    expect(report.findings[0].note).toContain("calibrated threshold 0.6");
  });

  it("treats a missing confidence as no score available, not as low confidence", () => {
    const report = groundExtraction(one("id_match"), {
      requiredPointers: REQUIRED,
      confidenceThreshold: 0.9,
    });
    expect(report.grounded).toEqual(["/field"]);
    expect(report.findings[0].provenance?.confidence).toBeNull();
    expect(report.findings[0].note).toContain("no score available");
  });

  it("can be made paranoid about a missing confidence, but only on request", () => {
    const report = groundExtraction(one("id_match"), {
      requiredPointers: REQUIRED,
      onMissingConfidence: "reject",
    });
    expect(report.findings[0].failure).toBe("NO_CONFIDENCE");
  });

  it("never renders confidence as a percentage", () => {
    expect(describeConfidence(0.31)).toBe(
      "relative signal 0.31 of 1 (uncalibrated, not a probability)",
    );
    expect(describeConfidence(null)).toBe("no score available");
    for (const note of groundExtraction(one("id_match", 0.31), {
      requiredPointers: REQUIRED,
    }).findings.map((f) => f.note)) {
      expect(note).not.toContain("%");
    }
  });
});

describe("absent values and absent citations", () => {
  it("denies a required pointer that is not in the data", () => {
    const report = groundExtraction(
      { data: {}, metadata: {} },
      { requiredPointers: ["/jurisdiction"] },
    );
    expect(report.findings[0].failure).toBe("MISSING_VALUE");
    expect(report.ungrounded).toEqual(["/jurisdiction"]);
  });

  it("treats an empty string as no value", () => {
    const report = groundExtraction(
      { data: { field: "   " }, metadata: { field: { match: "id_match", confidence: 1 } } },
      { requiredPointers: REQUIRED },
    );
    expect(report.findings[0].failure).toBe("MISSING_VALUE");
  });

  it("denies a value the extractor produced without a citation", () => {
    const report = groundExtraction({ data: { field: "value" } }, { requiredPointers: REQUIRED });
    expect(report.findings[0].failure).toBe("NO_CITATION");
    expect(report.provenance).toEqual({});
  });

  it("keeps a value of false or zero, which are real answers", () => {
    const report = groundExtraction(
      {
        data: { a: false, b: 0 },
        metadata: { a: { match: "id_match" }, b: { match: "id_match" } },
      },
      { requiredPointers: ["/a", "/b"] },
    );
    expect(report.ungrounded).toEqual([]);
  });
});

describe("pointer expansion over arrays", () => {
  it("expands `-` across every element", () => {
    expect(expandPointer({ grants: [{ ref: "a" }, { ref: "b" }] }, "/grants/-/ref")).toEqual([
      "/grants/0/ref",
      "/grants/1/ref",
    ]);
  });

  it("expands nested arrays", () => {
    const data = { grants: [{ limits: [{ max: 1 }, { max: 2 }] }, { limits: [{ max: 3 }] }] };
    expect(expandPointer(data, "/grants/-/limits/-/max")).toEqual([
      "/grants/0/limits/0/max",
      "/grants/0/limits/1/max",
      "/grants/1/limits/0/max",
    ]);
  });

  it("expands to nothing when the array is empty, which denies the requirement", () => {
    const report = groundExtraction(
      { data: { grants: [] }, metadata: {} },
      { requiredPointers: ["/grants/-/actKind"] },
    );
    expect(report.ungrounded).toEqual(["/grants/-/actKind"]);
    expect(report.findings[0].failure).toBe("MISSING_VALUE");
  });

  it("leaves a pointer with no wildcard untouched", () => {
    expect(expandPointer({ a: 1 }, "/a")).toEqual(["/a"]);
  });

  it("reports a pointer required twice only once", () => {
    const report = groundExtraction(one("id_match", 0.9), {
      requiredPointers: ["/field", "/field"],
    });
    expect(report.findings).toHaveLength(1);
  });
});

describe("against a full writ extraction", () => {
  const required = [
    "/principal/legalName",
    "/agent/domain",
    "/agent/publicKey",
    "/grants/-/ref",
    "/grants/-/actKind",
    "/limits/-/grantRef",
    "/limits/-/type",
    "/effectiveFrom",
    "/expiresAt",
    "/jurisdiction",
  ];

  it("denies exactly the clauses that did not ground", () => {
    const report = groundExtraction(writExtraction.output, { requiredPointers: required });
    expect(report.ungrounded).toEqual(["/grants/1/actKind"]);
    expect(report.grounded).toContain("/grants/0/actKind");
    expect(report.grounded).toContain("/agent/publicKey");
    expect(isFullyGrounded(report)).toBe(false);
  });

  it("adds a threshold failure only once the caller calibrates one", () => {
    const withValues = [...required, "/limits/1/values"];
    const permissive = groundExtraction(writExtraction.output, { requiredPointers: withValues });
    expect(permissive.ungrounded).toEqual(["/grants/1/actKind"]);

    const strict = groundExtraction(writExtraction.output, {
      requiredPointers: withValues,
      confidenceThreshold: 0.6,
    });
    expect(strict.ungrounded.sort()).toEqual(["/grants/1/actKind", "/limits/1/values"]);
  });

  it("carries the evidence for a denied clause, not just the denial", () => {
    const report = groundExtraction(writExtraction.output, { requiredPointers: required });
    expect(report.provenance["/grants/1/actKind"]).toMatchObject({
      match: "fuzzy_match",
      confidence: 0.72,
      pageNumber: 1,
      bbox: { x: 110, y: 366, width: 140, height: 14 },
    });
  });

  it("exposes every citation, including fields no clause depends on", () => {
    const report = groundExtraction(writExtraction.output, { requiredPointers: ["/jurisdiction"] });
    expect(Object.keys(report.provenance)).toEqual(["/jurisdiction"]);
    expect(report.allProvenance["/agent/label"]).toBeDefined();
  });

  it("produces the two fields EnforceablePolicy needs", () => {
    const report = groundExtraction(writExtraction.output, { requiredPointers: required });
    const fields = toPolicyFields(report);
    expect(Object.keys(fields).sort()).toEqual(["provenance", "ungrounded"]);
    expect(fields.ungrounded).toEqual(report.ungrounded);
    expect(fields.provenance["/jurisdiction"].pointer).toBe("/jurisdiction");
  });
});

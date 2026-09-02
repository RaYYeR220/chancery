import { describe, expect, it } from "vitest";

import {
  extractCreditCost,
  validateExtractionSchema,
  type ExtractionSchema,
} from "../../src/lib/adapters/nutrient/extraction";
import { groundExtraction, isFullyGrounded } from "../../src/lib/adapters/nutrient/grounding";
import {
  conditionsForGrant,
  limitsForGrant,
  splitDelimitedList,
  WRIT_CORE_POINTERS,
  WRIT_EXTRACTION_INSTRUCTIONS,
  WRIT_EXTRACTION_SCHEMA,
  writRequiredPointers,
  type WritExtraction,
} from "../../src/lib/adapters/nutrient/writ-schema";
import { ACT_KINDS } from "../../src/lib/core/types";
import writExtraction from "../fixtures/nutrient/writ-extraction.json";

/** Mirrors the validator's counting: every schema node is a level, root included. */
function maxDepth(schema: ExtractionSchema, depth = 1): number {
  let deepest = depth;
  for (const child of Object.values(schema.properties ?? {})) {
    deepest = Math.max(deepest, maxDepth(child, depth + 1));
  }
  if (schema.items) deepest = Math.max(deepest, maxDepth(schema.items, depth + 1));
  return deepest;
}

function countFields(schema: ExtractionSchema): number {
  let total = Object.keys(schema.properties ?? {}).length;
  for (const child of Object.values(schema.properties ?? {})) total += countFields(child);
  if (schema.items) total += countFields(schema.items);
  return total;
}

const DATA = writExtraction.output.data as WritExtraction;

describe("the writ schema fits Nutrient's dialect and our budget", () => {
  it("is legal under every documented restriction", () => {
    expect(validateExtractionSchema(WRIT_EXTRACTION_SCHEMA)).toEqual([]);
  });

  it("stays inside the 5-level nesting cap under the strictest counting", () => {
    expect(maxDepth(WRIT_EXTRACTION_SCHEMA)).toBe(4);
  });

  it("stays small enough to afford on the free plan", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(WRIT_EXTRACTION_SCHEMA)).length;
    expect(bytes).toBeLessThan(4096);
    expect(countFields(WRIT_EXTRACTION_SCHEMA)).toBeLessThan(50);
    // A one-page writ leaves room for a second run inside the 50 free credits.
    expect(extractCreditCost("understand", 1) * 2).toBeLessThanOrEqual(50);
  });

  it("offers the extractor exactly the act kinds the engine can enforce", () => {
    expect(WRIT_EXTRACTION_SCHEMA.properties.grants.items?.properties?.actKind.enum).toEqual([
      ...ACT_KINDS,
    ]);
  });

  it("keeps the instruction string short, since it is billed with the page", () => {
    expect(WRIT_EXTRACTION_INSTRUCTIONS.length).toBeLessThan(400);
  });

  it("hoists limits and conditions to the root and links them by clause reference", () => {
    const limit = WRIT_EXTRACTION_SCHEMA.properties.limits.items;
    expect(limit?.required).toEqual(["grantRef", "type"]);
    expect(limit?.properties?.values.type).toBe("string");
    expect(WRIT_EXTRACTION_SCHEMA.properties.conditions.items?.required).toEqual([
      "grantRef",
      "type",
    ]);
  });

  it("re-attaches hoisted rows to their clause", () => {
    expect(limitsForGrant(DATA, "3(a)").map((l) => l.type)).toEqual(["count", "allowlist"]);
    expect(limitsForGrant(DATA, "3(b)").map((l) => l.type)).toEqual(["amount"]);
    expect(conditionsForGrant(DATA, "3(a)").map((c) => c.check)).toEqual(["trademark_clear"]);
    expect(conditionsForGrant(DATA, "3(b)")).toEqual([]);
  });

  it("splits a delimited allowlist without inventing empty entries", () => {
    expect(splitDelimitedList("com, dev ,io")).toEqual(["com", "dev", "io"]);
    expect(splitDelimitedList("com,,")).toEqual(["com"]);
    expect(splitDelimitedList(undefined)).toEqual([]);
  });
});

describe("required pointers", () => {
  it("always requires the fields whose location is known up front", () => {
    expect(writRequiredPointers({})).toEqual([...WRIT_CORE_POINTERS]);
  });

  it("requires the value fields the limit's own type selects", () => {
    const pointers = writRequiredPointers(DATA);
    expect(pointers).toContain("/limits/0/max");
    expect(pointers).toContain("/limits/0/window");
    expect(pointers).toContain("/limits/1/field");
    expect(pointers).toContain("/limits/1/values");
    expect(pointers).toContain("/limits/2/maxMinorUnits");
    expect(pointers).toContain("/limits/2/currency");
    // A count limit never needs an allowlist's fields.
    expect(pointers).not.toContain("/limits/0/values");
  });

  it("always requires the clause reference a cap attaches to", () => {
    const pointers = writRequiredPointers(DATA);
    expect(pointers).toContain("/limits/2/grantRef");
    expect(pointers).toContain("/conditions/0/grantRef");
  });

  it("requires the value fields the condition's own type selects", () => {
    const pointers = writRequiredPointers(DATA);
    expect(pointers).toContain("/conditions/0/check");
    expect(pointers).not.toContain("/conditions/0/jurisdictions");
  });

  it("requires only the discriminator when the discriminator is unrecognised", () => {
    const pointers = writRequiredPointers({ limits: [{ type: "constructor" as never }] });
    expect(pointers.filter((p) => p.startsWith("/limits/"))).toEqual([
      "/limits/0/grantRef",
      "/limits/0/type",
    ]);
  });

  it("survives a response with no arrays at all", () => {
    expect(writRequiredPointers(undefined)).toEqual([...WRIT_CORE_POINTERS]);
    expect(writRequiredPointers({ limits: "not an array" })).toEqual([...WRIT_CORE_POINTERS]);
  });
});

describe("end to end: schema, extraction, gate", () => {
  it("denies the amount cap that did not ground and the act kind that was only fuzzy", () => {
    const report = groundExtraction(writExtraction.output, {
      requiredPointers: writRequiredPointers(DATA),
    });

    expect(report.ungrounded.sort()).toEqual(["/grants/1/actKind", "/limits/2/maxMinorUnits"]);
    expect(isFullyGrounded(report)).toBe(false);
    expect(report.grounded).toContain("/limits/0/max");
    expect(report.grounded).toContain("/jurisdiction");
  });

  it("grounds everything once the two weak fields are removed from the requirement set", () => {
    // `/grants/-/actKind` covers the fuzzy one, so it is swapped for the
    // concrete pointer of the grant that did ground.
    const required = writRequiredPointers(DATA)
      .filter(
        (pointer) => pointer !== "/grants/-/actKind" && pointer !== "/limits/2/maxMinorUnits",
      )
      .concat("/grants/0/actKind");
    const report = groundExtraction(writExtraction.output, { requiredPointers: required });
    expect(isFullyGrounded(report)).toBe(true);
  });
});

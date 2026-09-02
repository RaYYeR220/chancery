import { describe, expect, it } from "vitest";

import {
  bboxFromCitation,
  citationToProvenance,
  collectProvenance,
  ExtractionClient,
  ExtractionSchemaError,
  extractCreditCost,
  isCitation,
  validateExtractionSchema,
  type ExtractFileRequest,
  type ExtractionSchema,
} from "../../src/lib/adapters/nutrient/extraction";
import { NutrientError } from "../../src/lib/adapters/nutrient/http";
import { WRIT_EXTRACTION_SCHEMA } from "../../src/lib/adapters/nutrient/writ-schema";
import writExtraction from "../fixtures/nutrient/writ-extraction.json";
import {
  fakeTransport,
  formFieldNames,
  formText,
  jsonResponse,
  PDF_BYTES,
  type FakeTransport,
} from "./helpers";

function client(transport: FakeTransport): ExtractionClient {
  return new ExtractionClient({ apiKey: "pdf_test_key", fetchImpl: transport.fetchImpl });
}

const MINIMAL: ExtractionSchema = {
  type: "object",
  properties: { jurisdiction: { type: "string" } },
};

function codes(schema: unknown): string[] {
  return validateExtractionSchema(schema).map((issue) => issue.code);
}

describe("multipart nesting", () => {
  it("nests schema, parseConfig and options inside the outer `instructions` field", async () => {
    const transport = fakeTransport(() => jsonResponse(writExtraction));
    await client(transport).extract({
      file: PDF_BYTES,
      schema: MINIMAL,
      instructions: "read the writ",
    });

    // Sibling `schema` / `parseConfig` / `options` form fields would fail.
    expect(formFieldNames(transport.calls[0].body)).toEqual(["file", "instructions"]);
    expect(JSON.parse(await formText(transport.calls[0].body, "instructions"))).toEqual({
      schema: MINIMAL,
      parseConfig: { mode: "understand" },
      options: { includeCitations: true },
      instructions: "read the writ",
    });
  });

  it("defaults to understand mode with citations on", async () => {
    const transport = fakeTransport(() => jsonResponse(writExtraction));
    await client(transport).extract({ file: PDF_BYTES, schema: MINIMAL });
    const sent = JSON.parse(await formText(transport.calls[0].body, "instructions"));
    expect(sent.parseConfig.mode).toBe("understand");
    expect(sent.options.includeCitations).toBe(true);
  });

  it("puts the same keys top-level alongside url in JSON mode", async () => {
    const transport = fakeTransport(() => jsonResponse(writExtraction));
    await client(transport).extract({
      url: "https://example.test/writ.pdf",
      schema: MINIMAL,
      parseConfig: { mode: "structure" },
    });
    expect(transport.calls[0].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(transport.calls[0].body as string)).toEqual({
      url: "https://example.test/writ.pdf",
      schema: MINIMAL,
      parseConfig: { mode: "structure" },
      options: { includeCitations: true },
    });
  });

  it("requires either a file or a url", async () => {
    const transport = fakeTransport(() => jsonResponse(writExtraction));
    await expect(
      client(transport).extract({ schema: MINIMAL } as unknown as ExtractFileRequest),
    ).rejects.toBeInstanceOf(NutrientError);
  });

  it("sends parse and classify through the same nested field", async () => {
    const transport = fakeTransport((call) =>
      call.url.endsWith("/parse")
        ? jsonResponse({ output: { text: "..." } })
        : jsonResponse({ output: { classification: { label: "writ", score: 0.8 } } }),
    );
    await client(transport).parse({ file: PDF_BYTES, mode: "text" });
    expect(JSON.parse(await formText(transport.calls[0].body, "instructions"))).toEqual({
      mode: "text",
    });

    const classified = await client(transport).classify({
      file: PDF_BYTES,
      labels: [{ label: "writ", description: "a signed delegation of authority" }],
      topK: 3,
    });
    expect(JSON.parse(await formText(transport.calls[1].body, "instructions"))).toEqual({
      labels: [{ label: "writ", description: "a signed delegation of authority" }],
      topK: 3,
    });
    expect(classified.data.output.classification.label).toBe("writ");
  });
});

describe("schema restrictions", () => {
  it("rejects a non-object root before spending a request", async () => {
    const transport = fakeTransport(() => jsonResponse(writExtraction));
    await expect(
      client(transport).extract({
        file: PDF_BYTES,
        schema: { type: "array", items: { type: "string" } } as ExtractionSchema,
      }),
    ).rejects.toBeInstanceOf(ExtractionSchemaError);
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects $ref and the *Of combinators", () => {
    expect(
      codes({
        type: "object",
        properties: { a: { $ref: "#/$defs/x" }, b: { anyOf: [{ type: "string" }] } },
      }),
    ).toContain("UNSUPPORTED_KEYWORD");

    const issues = validateExtractionSchema({
      type: "object",
      properties: { a: { type: "string" } },
      allOf: [{ type: "object" }],
      $defs: {},
    });
    expect(issues.map((i) => i.pointer).sort()).toEqual(["/$defs", "/allOf"]);
  });

  it("rejects additionalProperties, since schemas are implicitly closed", () => {
    const issues = validateExtractionSchema({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    });
    expect(issues).toEqual([
      {
        pointer: "/additionalProperties",
        code: "UNSUPPORTED_KEYWORD",
        message: "`additionalProperties` is not supported by Nutrient's schema dialect",
      },
    ]);
  });

  it("rejects numeric ranges and length constraints", () => {
    const issues = validateExtractionSchema({
      type: "object",
      properties: {
        n: { type: "integer", minimum: 0, maximum: 10 },
        s: { type: "string", maxLength: 5, pattern: "^a" },
      },
    });
    expect(issues.map((i) => i.pointer).sort()).toEqual([
      "/properties/n/maximum",
      "/properties/n/minimum",
      "/properties/s/maxLength",
      "/properties/s/pattern",
    ]);
  });

  it("allows format only as date on a string", () => {
    expect(
      codes({ type: "object", properties: { d: { type: "string", format: "date" } } }),
    ).toEqual([]);
    expect(
      codes({ type: "object", properties: { d: { type: "string", format: "date-time" } } }),
    ).toEqual(["BAD_FORMAT"]);
    expect(
      codes({ type: "object", properties: { d: { type: "integer", format: "date" } } }),
    ).toEqual(["BAD_FORMAT"]);
  });

  it("allows enum only as a list of strings", () => {
    expect(
      codes({ type: "object", properties: { e: { type: "string", enum: ["a", "b"] } } }),
    ).toEqual([]);
    expect(codes({ type: "object", properties: { e: { type: "integer", enum: [1] } } })).toEqual([
      "BAD_ENUM",
      "BAD_ENUM",
    ]);
  });

  it("rejects an unknown type and a missing items/properties", () => {
    expect(codes({ type: "object", properties: { a: { type: "tuple" } } })).toEqual(["BAD_TYPE"]);
    expect(codes({ type: "object", properties: { a: { type: "array" } } })).toEqual([
      "MISSING_ITEMS",
    ]);
    expect(codes({ type: "object", properties: { a: { type: "object" } } })).toEqual([
      "MISSING_PROPERTIES",
    ]);
  });

  it("rejects a required name that is not declared", () => {
    const issues = validateExtractionSchema({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "b"],
    });
    expect(issues).toEqual([
      {
        pointer: "/required/1",
        code: "REQUIRED_NOT_DECLARED",
        message: 'required lists "b", which is not in properties',
      },
    ]);
  });

  it("enforces the documented limits", () => {
    const many: Record<string, ExtractionSchema> = {};
    for (let i = 0; i < 51; i += 1) many[`p${i}`] = { type: "string" };
    expect(codes({ type: "object", properties: many })).toEqual(["LIMIT_EXCEEDED"]);

    expect(
      codes({
        type: "object",
        properties: { ["x".repeat(129)]: { type: "string" } },
      }),
    ).toEqual(["LIMIT_EXCEEDED"]);

    expect(
      codes({
        type: "object",
        properties: { a: { type: "string", description: "d".repeat(1025) } },
      }),
    ).toEqual(["LIMIT_EXCEEDED"]);

    expect(
      codes({
        type: "object",
        properties: { a: { type: "string", enum: ["v".repeat(257)] } },
      }),
    ).toEqual(["LIMIT_EXCEEDED"]);

    expect(
      codes({
        type: "object",
        properties: {
          a: { type: "string", enum: Array.from({ length: 51 }, (_, i) => `v${i}`) },
        },
      }),
    ).toEqual(["LIMIT_EXCEEDED"]);
  });

  it("rejects nesting past five levels", () => {
    // root(1) -> a(2) -> b(3) -> c(4) -> d(5) -> e(6)
    const deep = {
      type: "object",
      properties: {
        a: {
          type: "object",
          properties: {
            b: {
              type: "object",
              properties: {
                c: {
                  type: "object",
                  properties: {
                    d: { type: "object", properties: { e: { type: "string" } } },
                  },
                },
              },
            },
          },
        },
      },
    };
    expect(codes(deep)).toEqual(["LIMIT_EXCEEDED"]);
  });

  it("rejects a schema over 32 KB", () => {
    const properties: Record<string, ExtractionSchema> = {};
    for (let i = 0; i < 40; i += 1) {
      properties[`p${i}`] = { type: "string", description: "d".repeat(1000) };
    }
    expect(codes({ type: "object", properties })).toContain("LIMIT_EXCEEDED");
  });
});

describe("the metadata mirror", () => {
  it("distinguishes a citation from a nested mirror node", () => {
    expect(isCitation({ match: "id_match", confidence: 0.9 })).toBe(true);
    expect(isCitation({ ref: { match: "id_match" } })).toBe(false);
    expect(isCitation({})).toBe(false);
    expect(isCitation(null)).toBe(false);
    expect(isCitation([{ match: "id_match" }])).toBe(false);
  });

  it("does not mistake a data field literally named `match` for a citation", () => {
    const provenance = collectProvenance({
      data: { match: "3(a)" },
      metadata: { match: { match: "id_match", confidence: 0.9, pageNumber: 1 } },
    });
    expect(Object.keys(provenance)).toEqual(["/match"]);
    expect(provenance["/match"].match).toBe("id_match");
  });

  it("walks the mirror through arrays", () => {
    const provenance = collectProvenance(writExtraction.output);
    expect(provenance["/limits/1/values"]).toMatchObject({
      pointer: "/limits/1/values",
      match: "id_match",
      confidence: 0.31,
      pageNumber: 1,
      blockIds: ["b_tld_list"],
    });
    expect(provenance["/grants/1/actKind"].match).toBe("fuzzy_match");
    expect(provenance["/limits/2/maxMinorUnits"].match).toBe("not_found");
  });

  it("leaves a data field with no mirror entry out of the map", () => {
    const provenance = collectProvenance(writExtraction.output);
    expect(provenance["/principal/email"]).toBeUndefined();
    expect(provenance["/principal/legalName"]).toBeDefined();
  });

  it("collects every block id from a multiblock citation", () => {
    const provenance = collectProvenance(writExtraction.output);
    expect(provenance["/agent/publicKey"].blockIds).toEqual(["b_key_a", "b_key_b"]);
    expect(provenance["/agent/publicKey"].match).toBe("id_match_multiblock");
  });

  it("records a missing confidence as null rather than zero", () => {
    const provenance = collectProvenance(writExtraction.output);
    expect(provenance["/limits/0/max"].confidence).toBeNull();
    expect(provenance["/limits/2/maxMinorUnits"].confidence).toBeNull();
  });

  it("fails closed when a citation carries no match at all", () => {
    expect(citationToProvenance("/x", { confidence: 0.99 }).match).toBe("not_found");
    expect(citationToProvenance("/x", { match: "wat" as never }).match).toBe("not_found");
  });

  it("derives pageNumber from pageIndex when only the index is present", () => {
    expect(citationToProvenance("/x", { match: "id_match", pageIndex: 2 }).pageNumber).toBe(3);
    expect(citationToProvenance("/x", { match: "id_match" }).pageNumber).toBeNull();
  });

  it("reads a bbox as [x, y, width, height] and rejects a malformed one", () => {
    expect(bboxFromCitation({ bbox: [1, 2, 3, 4] })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(bboxFromCitation({ bbox: [1, 2, 3] })).toBeNull();
    expect(bboxFromCitation({})).toBeNull();
  });
});

describe("credit budget", () => {
  it("prices understand-mode extraction at 15 credits per page", () => {
    expect(extractCreditCost("understand", 1)).toBe(15);
    expect(extractCreditCost("text", 1)).toBe(7);
    expect(extractCreditCost("structure", 1)).toBe(7.5);
    expect(extractCreditCost("agentic", 1)).toBe(24);
  });

  it("leaves room for exactly three understand-mode pages on the free plan", () => {
    expect(extractCreditCost("understand", 3)).toBeLessThanOrEqual(50);
    expect(extractCreditCost("understand", 4)).toBeGreaterThan(50);
  });
});

describe("the writ schema is legal under the restrictions", () => {
  it("passes the validator with no issues", () => {
    expect(validateExtractionSchema(WRIT_EXTRACTION_SCHEMA)).toEqual([]);
  });
});

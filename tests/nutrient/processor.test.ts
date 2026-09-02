import { describe, expect, it } from "vitest";

import { IdempotencyConflictError, NutrientError } from "../../src/lib/adapters/nutrient/http";
import {
  BuildOrderError,
  buildInstructions,
  deriveIdempotencyKey,
  ProcessorClient,
  validateBuildInstructions,
  type BuildAction,
  type BuildInstructions,
} from "../../src/lib/adapters/nutrient/processor";
import analyzeBuild from "../fixtures/nutrient/analyze-build.json";
import buildError from "../fixtures/nutrient/build-error.json";
import {
  binaryResponse,
  fakeTransport,
  formFieldNames,
  formText,
  jsonResponse,
  PDF_BYTES,
  SIGNED_BYTES,
  type FakeTransport,
} from "./helpers";

function client(transport: FakeTransport): ProcessorClient {
  return new ProcessorClient({ apiKey: "pdf_test_key", fetchImpl: transport.fetchImpl });
}

const SIMPLE: BuildInstructions = {
  parts: [{ file: "writ" }],
  output: { type: "pdf" },
};

describe("build multipart shape", () => {
  it("names the JSON field `instructions` and every other field after its handle", async () => {
    const transport = fakeTransport(() => binaryResponse(SIGNED_BYTES));
    await client(transport).build({
      instructions: { parts: [{ file: "cover" }, { file: "body" }] },
      files: { cover: PDF_BYTES, body: PDF_BYTES },
    });

    const body = transport.calls[0].body;
    expect(formFieldNames(body)).toEqual(["body", "cover", "instructions"]);
    expect(JSON.parse(await formText(body, "instructions"))).toEqual({
      parts: [{ file: "cover" }, { file: "body" }],
    });
  });

  it("refuses a file handle called `instructions`, which would collide", async () => {
    const transport = fakeTransport(() => binaryResponse(SIGNED_BYTES));
    await expect(
      client(transport).build({
        instructions: { parts: [{ file: "instructions" }] },
        files: { instructions: PDF_BYTES },
      }),
    ).rejects.toBeInstanceOf(NutrientError);
  });

  it("returns the produced bytes with the cost accounting attached", async () => {
    const transport = fakeTransport(() => binaryResponse(SIGNED_BYTES));
    const result = await client(transport).build({ instructions: SIMPLE, files: { writ: PDF_BYTES } });
    expect(result.data).toEqual(SIGNED_BYTES);
    expect(result.meta.requestCost).toBe(15);
    expect(result.meta.remainingCredits).toBe(35);
  });
});

describe("idempotency key", () => {
  it("is always sent on /build without the caller asking", async () => {
    const transport = fakeTransport(() => binaryResponse(SIGNED_BYTES));
    await client(transport).build({ instructions: SIMPLE, files: { writ: PDF_BYTES } });
    const key = transport.calls[0].headers["idempotency-key"];
    expect(key).toBe(deriveIdempotencyKey(SIMPLE, { writ: PDF_BYTES }));
    expect(new TextEncoder().encode(key).length).toBeLessThanOrEqual(255);
  });

  it("is stable across instruction key ordering", () => {
    const a = deriveIdempotencyKey(
      { parts: [{ file: "writ" }], output: { type: "pdf" }, actions: [] },
      { writ: PDF_BYTES },
    );
    const b = deriveIdempotencyKey(
      { actions: [], output: { type: "pdf" }, parts: [{ file: "writ" }] },
      { writ: PDF_BYTES },
    );
    expect(a).toBe(b);
  });

  it("changes when the input bytes change", () => {
    const other = new TextEncoder().encode("%PDF-1.7\nwrit tampered\n%%EOF\n");
    expect(deriveIdempotencyKey(SIMPLE, { writ: PDF_BYTES })).not.toBe(
      deriveIdempotencyKey(SIMPLE, { writ: other }),
    );
  });

  it("changes when the pipeline changes", () => {
    const withOcr: BuildInstructions = {
      ...SIMPLE,
      actions: [{ type: "ocr", language: "english" }],
    };
    expect(deriveIdempotencyKey(SIMPLE, { writ: PDF_BYTES })).not.toBe(
      deriveIdempotencyKey(withOcr, { writ: PDF_BYTES }),
    );
  });

  it("binds bytes to their handle, so swapping two inputs is a different key", () => {
    const a = new TextEncoder().encode("alpha");
    const b = new TextEncoder().encode("beta");
    expect(deriveIdempotencyKey(SIMPLE, { cover: a, body: b })).not.toBe(
      deriveIdempotencyKey(SIMPLE, { cover: b, body: a }),
    );
  });

  it("surfaces a 409 as the tamper signal, not as a generic conflict", async () => {
    const transport = fakeTransport(() =>
      jsonResponse(
        { error: { details: "key already used", requestId: "req_dup", status: 409 } },
        { status: 409 },
      ),
    );
    const error = await client(transport)
      .build({ instructions: SIMPLE, files: { writ: PDF_BYTES } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IdempotencyConflictError);
    const conflict = error as IdempotencyConflictError;
    expect(conflict.message).toContain("the pipeline changed under the same key");
    expect(conflict.meta.idempotencyKey).toBe(deriveIdempotencyKey(SIMPLE, { writ: PDF_BYTES }));
    expect(conflict.meta.requestCost).toBe(15);
  });

  it("does not send an idempotency key on the free dry run", async () => {
    const transport = fakeTransport(() => jsonResponse(analyzeBuild));
    await client(transport).analyzeBuild({ instructions: SIMPLE, files: { writ: PDF_BYTES } });
    expect(transport.calls[0].headers["idempotency-key"]).toBeUndefined();
  });

  it("rejects an over-long override rather than letting the header be dropped", async () => {
    const transport = fakeTransport(() => binaryResponse(SIGNED_BYTES));
    await expect(
      client(transport).build({
        instructions: SIMPLE,
        files: { writ: PDF_BYTES },
        idempotencyKey: "x".repeat(256),
      }),
    ).rejects.toBeInstanceOf(NutrientError);
  });
});

describe("action ordering", () => {
  it("accepts the documented order", () => {
    const instructions = buildInstructions()
      .addFile("writ")
      .ocr({ language: "english", skipOcrForSearchableDocuments: true })
      .applyXfdf("annotations")
      .watermark({ text: "DRAFT", width: "50%", height: "20%", fontColor: "#ff0000" })
      .createRedactions({
        strategy: "preset",
        strategyOptions: { preset: "email-address", includeAnnotations: true },
      })
      .applyRedactions()
      .flatten()
      .outputAs({ type: "pdf" })
      .build();

    expect(instructions.actions?.map((a) => a.type)).toEqual([
      "ocr",
      "applyXfdf",
      "watermark",
      "createRedactions",
      "applyRedactions",
      "flatten",
    ]);
  });

  it("refuses to import after flattening rather than silently reordering", () => {
    const builder = buildInstructions().addFile("writ").flatten();
    expect(() => builder.applyXfdf("annotations")).toThrow(BuildOrderError);
  });

  it("refuses to OCR after redactions have been applied", () => {
    const builder = buildInstructions().addFile("writ").createRedactions({
      strategy: "text",
      strategyOptions: { text: "SECRET" },
    });
    expect(() => builder.ocr({ language: "english" })).toThrow(BuildOrderError);
  });

  it("refuses to add a part once actions have started", () => {
    const builder = buildInstructions().addFile("writ").ocr({ language: "english" });
    expect(() => builder.addFile("appendix")).toThrow(BuildOrderError);
  });

  it("catches misordered hand-written instructions on the way out", async () => {
    const transport = fakeTransport(() => binaryResponse(SIGNED_BYTES));
    const misordered: BuildInstructions = {
      parts: [{ file: "writ" }],
      actions: [{ type: "flatten" }, { type: "ocr", language: "english" }],
    };
    expect(validateBuildInstructions(misordered)).toEqual([
      {
        pointer: "/actions/1",
        code: "ACTION_OUT_OF_ORDER",
        message: "ocr must run before flatten, not after it",
      },
    ]);
    await expect(
      client(transport).build({ instructions: misordered, files: { writ: PDF_BYTES } }),
    ).rejects.toBeInstanceOf(BuildOrderError);
    expect(transport.calls).toHaveLength(0);
  });

  it("requires at least one part", () => {
    expect(validateBuildInstructions({ parts: [] })[0].code).toBe("NO_PARTS");
  });

  it("flags a shorthand watermark colour the API would reject", () => {
    const issues = validateBuildInstructions({
      parts: [{ file: "writ" }],
      actions: [{ type: "watermark", text: "X", width: 10, height: 10, fontColor: "#fff" }],
    });
    expect(issues.map((i) => i.code)).toEqual(["BAD_FONT_COLOR"]);
    expect(issues[0].pointer).toBe("/actions/0/fontColor");
  });

  it("flags an out-of-range watermark opacity", () => {
    const issues = validateBuildInstructions({
      parts: [{ file: "writ" }],
      actions: [{ type: "watermark", text: "X", width: 10, height: 10, opacity: 1.5 }],
    });
    expect(issues.map((i) => i.code)).toEqual(["BAD_OPACITY"]);
  });

  it("flags an action type that is not one of the documented eight", () => {
    const issues = validateBuildInstructions({
      parts: [{ file: "writ" }],
      actions: [{ type: "sign" } as unknown as BuildAction],
    });
    expect(issues.map((i) => i.code)).toEqual(["UNKNOWN_ACTION"]);
  });
});

describe("redaction, staged then applied", () => {
  it("stages marks without destroying anything", async () => {
    const transport = fakeTransport(() => binaryResponse(SIGNED_BYTES));
    await client(transport).stageRedactions({
      instructions: SIMPLE,
      files: { writ: PDF_BYTES },
      redactions: [
        {
          strategy: "preset",
          strategyOptions: { preset: "social-security-number", start: 0, limit: null },
        },
      ],
    });
    const sent = JSON.parse(await formText(transport.calls[0].body, "instructions"));
    expect(sent.actions).toEqual([
      {
        strategy: "preset",
        strategyOptions: { limit: null, preset: "social-security-number", start: 0 },
        type: "createRedactions",
      },
    ]);
  });

  it("applies staged marks as a separate irreversible step", async () => {
    const transport = fakeTransport(() => binaryResponse(SIGNED_BYTES));
    await client(transport).applyStagedRedactions({
      instructions: SIMPLE,
      files: { writ: PDF_BYTES },
    });
    const sent = JSON.parse(await formText(transport.calls[0].body, "instructions"));
    expect(sent.actions).toEqual([{ type: "applyRedactions" }]);
  });

  it("defaults /ai/redact to staging and uses the 1-10 confidence scale", async () => {
    const transport = fakeTransport(() => binaryResponse(SIGNED_BYTES));
    await client(transport).aiRedact({
      criteria: "Redact all PII including personal names",
      documents: [{ file: { url: "https://example.test/doc.pdf" } }],
      confidenceThreshold: 7,
    });
    expect(transport.calls[0].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(transport.calls[0].body as string)).toEqual({
      criteria: "Redact all PII including personal names",
      documents: [{ file: { url: "https://example.test/doc.pdf" } }],
      redaction_state: "stage",
      options: { confidence: { threshold: 7 } },
    });
  });
});

describe("sign", () => {
  it("omitting data yields an invisible but still cryptographic signature", async () => {
    const transport = fakeTransport(() => binaryResponse(SIGNED_BYTES));
    await client(transport).sign({ file: PDF_BYTES });
    expect(formFieldNames(transport.calls[0].body)).toEqual(["file"]);
  });

  it("sends data, image and graphicImage and the password header", async () => {
    const transport = fakeTransport(() => binaryResponse(SIGNED_BYTES));
    await client(transport).sign({
      file: PDF_BYTES,
      image: PDF_BYTES,
      graphicImage: PDF_BYTES,
      password: "hunter2",
      data: {
        position: { pageIndex: 0, rect: [72, 650, 250, 80] },
        appearance: { mode: "signatureAndDescription", showSignDate: true },
        flatten: false,
      },
    });
    expect(formFieldNames(transport.calls[0].body)).toEqual([
      "data",
      "file",
      "graphicImage",
      "image",
    ]);
    expect(transport.calls[0].headers["pspdfkit-pdf-password"]).toBe("hunter2");
    expect(JSON.parse(await formText(transport.calls[0].body, "data")).position.rect).toEqual([
      72, 650, 250, 80,
    ]);
  });

  it("rejects formFieldName together with position, which the API errors on", async () => {
    const transport = fakeTransport(() => binaryResponse(SIGNED_BYTES));
    await expect(
      client(transport).sign({
        file: PDF_BYTES,
        data: { formFieldName: "sig1", position: { pageIndex: 0, rect: [0, 0, 1, 1] } },
      }),
    ).rejects.toBeInstanceOf(NutrientError);
  });

  it("signs last: build runs first, then sign takes its bytes", async () => {
    const transport = fakeTransport((call) =>
      call.url.endsWith("/build") ? binaryResponse(PDF_BYTES) : binaryResponse(SIGNED_BYTES),
    );
    const { built, signed } = await client(transport).buildAndSign({
      instructions: SIMPLE,
      files: { writ: PDF_BYTES },
    });
    expect(transport.calls.map((c) => c.url)).toEqual([
      "https://api.nutrient.io/build",
      "https://api.nutrient.io/sign",
    ]);
    expect(built.data).toEqual(PDF_BYTES);
    expect(signed.data).toEqual(SIGNED_BYTES);
  });

  it("refuses to sign a pipeline that leaves redaction marks unapplied", async () => {
    const transport = fakeTransport(() => binaryResponse(SIGNED_BYTES));
    await expect(
      client(transport).buildAndSign({
        instructions: {
          parts: [{ file: "writ" }],
          actions: [
            { type: "createRedactions", strategy: "text", strategyOptions: { text: "SECRET" } },
          ],
        },
        files: { writ: PDF_BYTES },
      }),
    ).rejects.toBeInstanceOf(BuildOrderError);
    expect(transport.calls).toHaveLength(0);
  });
});

describe("analyze_build, validate_pdfa and tokens", () => {
  it("returns the free execution plan with its JSONPath usage pointers", async () => {
    const transport = fakeTransport(() => jsonResponse(analyzeBuild));
    const result = await client(transport).analyzeBuild({
      instructions: SIMPLE,
      files: { writ: PDF_BYTES },
    });
    expect(result.data.cost).toBe(3.5);
    const features = result.data.required_features as Record<
      string,
      { usage?: string[]; unit_type: string }
    >;
    expect(features.ocr.usage).toEqual(["$.actions[0]"]);
    expect(features.redaction.unit_type).toBe("per_use");
  });

  it("posts the file to /validate_pdfa and keeps the undocumented body", async () => {
    const transport = fakeTransport(() =>
      jsonResponse({ conformance: "pdfa-2b", valid: true, extra: { veraPdf: "passed" } }),
    );
    const result = await client(transport).validatePdfa(PDF_BYTES);
    expect(transport.calls[0].url).toBe("https://api.nutrient.io/validate_pdfa");
    expect(formFieldNames(transport.calls[0].body)).toEqual(["file"]);
    expect(result.data.valid).toBe(true);
    expect(result.data.extra).toEqual({ veraPdf: "passed" });
  });

  it("mints and revokes a scoped token", async () => {
    const transport = fakeTransport((call) =>
      call.method === "POST"
        ? jsonResponse({ id: "tok_1", accessToken: "jat_abc" })
        : jsonResponse({}),
    );
    const created = await client(transport).createToken({
      allowedOperations: ["data_extraction_api", "digital_signatures_api"],
      allowedOrigins: ["https://chancery.test"],
      expirationTime: 900,
    });
    expect(created.data.accessToken).toBe("jat_abc");
    expect(JSON.parse(transport.calls[0].body as string).allowedOperations).toEqual([
      "data_extraction_api",
      "digital_signatures_api",
    ]);

    await client(transport).revokeToken("tok_1");
    expect(transport.calls[1].method).toBe("DELETE");
    expect(JSON.parse(transport.calls[1].body as string)).toEqual({ id: "tok_1" });
  });

  it("keeps failingPaths from a build validation error", async () => {
    const transport = fakeTransport(() => jsonResponse(buildError, { status: 400 }));
    const error = await client(transport)
      .build({ instructions: SIMPLE, files: { writ: PDF_BYTES } })
      .catch((e: unknown) => e);
    expect((error as { failingPaths: { path: string }[] }).failingPaths.map((p) => p.path)).toEqual([
      "$.actions[1].strategyOptions.preset",
      "$.output.conformance",
    ]);
  });
});

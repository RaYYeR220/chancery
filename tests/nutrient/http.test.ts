import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  CreditsExhaustedError,
  escapePointerToken,
  isMatchKind,
  joinPointer,
  NutrientApiError,
  nutrientRequest,
  parseErrorEnvelope,
  resolvePointer,
  unescapePointerToken,
  type NutrientClientConfig,
} from "../../src/lib/adapters/nutrient/http";
import buildError from "../fixtures/nutrient/build-error.json";
import { fakeTransport, jsonResponse, textResponse } from "./helpers";

function config(fetchImpl: NutrientClientConfig["fetchImpl"]): NutrientClientConfig {
  return { apiKey: "pdf_test_key", fetchImpl };
}

describe("transport", () => {
  it("sends the bearer token", async () => {
    const transport = fakeTransport(() => jsonResponse({ ok: true }));
    await nutrientRequest(config(transport.fetchImpl), {
      method: "POST",
      path: "/account/info",
      expect: "json",
    });
    expect(transport.calls[0].headers.authorization).toBe("Bearer pdf_test_key");
    expect(transport.calls[0].url).toBe("https://api.nutrient.io/account/info");
  });

  it("captures the cost headers on a successful call", async () => {
    const transport = fakeTransport(() => jsonResponse({ ok: true }));
    const result = await nutrientRequest(config(transport.fetchImpl), {
      method: "POST",
      path: "/build",
      expect: "json",
    });
    expect(result.meta.requestCost).toBe(15);
    expect(result.meta.remainingCredits).toBe(35);
    expect(result.meta.requestId).toBe("req_abc123");
    expect(result.meta.status).toBe(200);
  });

  it("captures the cost headers on a failed call too", async () => {
    const transport = fakeTransport(() => jsonResponse(buildError, { status: 400 }));
    const error = await nutrientRequest(config(transport.fetchImpl), {
      method: "POST",
      path: "/build",
      expect: "binary",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NutrientApiError);
    const apiError = error as NutrientApiError;
    expect(apiError.meta.requestCost).toBe(15);
    expect(apiError.meta.remainingCredits).toBe(35);
    expect(apiError.meta.status).toBe(400);
  });

  it("treats an absent or unparseable cost header as null, not zero", async () => {
    const transport = fakeTransport(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "x-pspdfkit-request-cost": "not-a-number" },
        }),
    );
    const result = await nutrientRequest(config(transport.fetchImpl), {
      method: "POST",
      path: "/build",
      expect: "json",
    });
    expect(result.meta.requestCost).toBeNull();
    expect(result.meta.remainingCredits).toBeNull();
  });

  it("parses the documented error envelope including failingPaths", async () => {
    const transport = fakeTransport(() => jsonResponse(buildError, { status: 400 }));
    const error = (await nutrientRequest(config(transport.fetchImpl), {
      method: "POST",
      path: "/build",
      expect: "binary",
    }).catch((e: unknown) => e)) as NutrientApiError;

    expect(error.details).toBe("Invalid build instructions.");
    expect(error.supportUrl).toBe("https://support.nutrient.io/hc/en-us/requests/new");
    expect(error.meta.requestId).toBe("req_9f2c41");
    expect(error.failingPaths).toEqual([
      { path: "$.actions[1].strategyOptions.preset", details: "unknown preset" },
      { path: "$.output.conformance" },
    ]);
  });

  it("maps 402 to a distinct credits-exhausted error", async () => {
    const transport = fakeTransport(() =>
      jsonResponse({ error: { details: "out of credits" } }, { status: 402 }),
    );
    const error = await nutrientRequest(config(transport.fetchImpl), {
      method: "POST",
      path: "/extraction/extract",
      expect: "json",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CreditsExhaustedError);
  });

  it("survives a non-JSON error body", async () => {
    const transport = fakeTransport(() => textResponse("<html>502 Bad Gateway</html>", { status: 502 }));
    const error = (await nutrientRequest(config(transport.fetchImpl), {
      method: "POST",
      path: "/build",
      expect: "binary",
    }).catch((e: unknown) => e)) as NutrientApiError;
    expect(error.details).toContain("502 Bad Gateway");
    expect(error.failingPaths).toEqual([]);
  });

  it("reads async-style failures with reason/description/failingPaths", () => {
    const parsed = parseErrorEnvelope(
      JSON.stringify({
        reason: "invalid_instructions",
        description: "actions[0] is not valid",
        failingPaths: ["$.actions[0]"],
      }),
    );
    expect(parsed.reason).toBe("invalid_instructions");
    expect(parsed.details).toBe("actions[0] is not valid");
    expect(parsed.failingPaths).toEqual([{ path: "$.actions[0]" }]);
  });
});

describe("canonicalJson", () => {
  it("is stable across key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it("preserves array order, which is pipeline order", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("drops undefined properties so an explicit undefined cannot change the hash", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe("json pointers", () => {
  it("escapes and unescapes reserved characters", () => {
    expect(escapePointerToken("a/b~c")).toBe("a~1b~0c");
    expect(unescapePointerToken("a~1b~0c")).toBe("a/b~c");
    expect(joinPointer("/x", "a/b")).toBe("/x/a~1b");
    expect(joinPointer("/x", 2)).toBe("/x/2");
  });

  it("resolves through objects and arrays", () => {
    const data = { grants: [{ ref: "3(a)" }, { ref: "3(b)" }] };
    expect(resolvePointer(data, "/grants/1/ref")).toBe("3(b)");
    expect(resolvePointer(data, "")).toBe(data);
  });

  it("returns undefined rather than throwing for a pointer that misses", () => {
    const data = { grants: [] as unknown[] };
    expect(resolvePointer(data, "/grants/0/ref")).toBeUndefined();
    expect(resolvePointer(data, "/nope")).toBeUndefined();
    expect(resolvePointer(data, "relative")).toBeUndefined();
  });
});

describe("isMatchKind", () => {
  it("accepts the five documented values and nothing else", () => {
    for (const kind of [
      "id_match",
      "id_match_multiblock",
      "id_match_partial",
      "fuzzy_match",
      "not_found",
    ]) {
      expect(isMatchKind(kind)).toBe(true);
    }
    expect(isMatchKind("toString")).toBe(false);
    expect(isMatchKind(undefined)).toBe(false);
  });
});

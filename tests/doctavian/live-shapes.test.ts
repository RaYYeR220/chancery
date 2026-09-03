/**
 * The behaviour that could only be settled by calling the live API, pinned so a
 * regression is a test failure rather than a demo failure.
 *
 * The response bodies here are not invented: `tests/fixtures/doctavian/
 * live-transcript.json` is a recording of a real `pnpm writ` run against
 * demo.api.doctavian.com, with tenant and user identifiers redacted. Replaying
 * it through a fake fetch means the parsers are tested against what the server
 * actually sends, with no network in the suite.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DoctavianClient } from "../../src/lib/adapters/doctavian/client";
import { STORAGE_TYPE } from "../../src/lib/adapters/doctavian/types";
import { DOCTAVIAN_DEMO_BASE_URL, DOCTAVIAN_TOKEN_PATH } from "../../src/lib/adapters/doctavian/auth";
import {
  binaryResponse,
  createFakeFetch,
  errorResponse,
  jsonResponse,
  type Responder,
} from "./fake-fetch";

interface TranscriptEntry {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

const transcript: TranscriptEntry[] = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/doctavian/live-transcript.json"), "utf8"),
);

function entry(method: string, path: string): TranscriptEntry {
  const found = transcript.find((e) => e.method === method && e.path === path);
  if (!found) throw new Error(`no live transcript entry for ${method} ${path}`);
  return found;
}

function client(routes: Record<string, Responder>, overrides: Record<string, unknown> = {}) {
  const fake = createFakeFetch(routes);
  return {
    fake,
    doctavian: new DoctavianClient({
      baseUrl: "https://demo.api.doctavian.com",
      bearerToken: "token",
      documentsApiKey: "doc-key",
      signaturesApiKey: "sig-key",
      fetchImpl: fake.fetchImpl,
      ...overrides,
    }),
  };
}

describe("the response envelope the live API actually sends", () => {
  it("wraps every payload in result.data, with consumption as a sibling of result", () => {
    const created = entry("POST", "/v1/documents/datasource/create").body as Record<
      string,
      { data: Record<string, unknown> }
    >;
    expect(Object.keys(created)).toEqual(
      expect.arrayContaining(["result", "origin", "dateTime", "operationId"]),
    );
    expect(created.result.data).toHaveProperty("dataSourceGuid");
  });

  it("reads dataSourceGuid off the live datasource/create body", async () => {
    const { doctavian } = client({
      "POST /v1/documents/datasource/create": () =>
        jsonResponse(entry("POST", "/v1/documents/datasource/create").body),
    });
    const result = await doctavian.createDataSource({ name: "writ" });
    expect(result.dataSourceGuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reads the solution guid from one level deeper, where the live body nests it", async () => {
    const body = entry("POST", "/v1/documents/solution/create").body as {
      result: { data: { documentSolution: { documentSolutionGuid: string } } };
    };
    // The datasource guid is flat but the solution guid is under
    // `result.data.documentSolution` — the two creates do not agree with each
    // other, which is exactly why the reader looks one level down.
    expect(body.result.data.documentSolution.documentSolutionGuid).toBeTruthy();

    const { doctavian } = client({
      "POST /v1/documents/solution/create": () => jsonResponse(body),
    });
    const result = await doctavian.createSolution({ name: "writ", dataGuid: "ds" });
    expect(result.documentSolutionGuid).toBe(
      body.result.data.documentSolution.documentSolutionGuid,
    );
  });

  it("reads an upload id out of result.data.files[], an array even for one file", async () => {
    const body = entry("POST", "/v1/documents/template/upload").body as {
      result: { data: { files: { id: string; fileName: string }[] } };
    };
    expect(body.result.data.files).toHaveLength(1);

    const { doctavian } = client({
      "POST /v1/documents/template/upload": () => jsonResponse(body, 201),
    });
    const uploaded = await doctavian.uploadTemplate({
      fileName: "writ-template.docx",
      bytes: new Uint8Array([80, 75]),
    });
    expect(uploaded.id).toBe(body.result.data.files[0].id);
    expect(uploaded.fileName).toBe("writ-template.docx");
  });

  it("unwraps the named list keys the live API uses", async () => {
    const { doctavian } = client({
      "GET /v1/documents/template/list": () =>
        jsonResponse({
          result: {
            data: {
              documentTemplates: [
                { documentTemplateGuid: "g", name: "writ.docx", fileFormat: "docx", id: "t1" },
              ],
              rowCount: 1,
            },
          },
        }),
    });
    const templates = await doctavian.listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe("writ.docx");
  });

  it("surfaces the innerErrors array the live API reports failures in", async () => {
    const failure = entry("POST", "/v1/documents/document/generate");
    const { doctavian } = client({
      "POST /v1/documents/document/generate": () =>
        errorResponse(failure.body, failure.status, "Internal Server Error"),
    });

    const error = (await doctavian
      .generateDocument({
        template: { name: "t.docx", urn: "t", fileFormat: "docx", loadMethod: "Storage" },
        data: { urn: "d", loadMethod: "Storage" },
        document: {
          name: "w",
          fileFormat: "pdf",
          deliveryMethod: "Storage",
          path: "root",
          locale: "en_IE_EURO",
          timezone: "(GMT+00:00) Greenwich Mean Time (Europe/Dublin)",
        },
      })
      .catch((e: unknown) => e)) as unknown as { status: number; body: unknown };

    expect(error.status).toBe(500);
    const body = error.body as { error: { innerErrors: { code: string }[] } };
    expect(body.error.innerErrors.map((i) => i.code)).toContain("TEMPLATE_READ_FAILED");
  });
});

describe("X-Storage-Type", () => {
  it("pins the container on every upload, since the server does not enforce it", async () => {
    const { fake, doctavian } = client({
      "POST /v1/documents/template/upload": () =>
        jsonResponse({ result: { data: { files: [{ id: "t" }] } } }, 201),
      "POST /v1/documents/data/upload": () =>
        jsonResponse({ result: { data: { files: [{ id: "d" }] } } }, 201),
      "POST /v1/signatures/document/upload": () =>
        jsonResponse({ result: { data: { files: [{ id: "s" }] } } }, 201),
    });

    await doctavian.uploadTemplate({ fileName: "t.docx", bytes: new Uint8Array([1]) });
    await doctavian.uploadData({ Writ: [] });
    await doctavian.uploadSignatureDocument({ fileName: "w.pdf", bytes: new Uint8Array([1]) });

    expect(fake.calls.map((c) => c.headers["x-storage-type"])).toEqual([
      STORAGE_TYPE.template,
      STORAGE_TYPE.data,
      STORAGE_TYPE.signatureDocument,
    ]);
  });

  it("names the generated document's container on download", async () => {
    const { fake, doctavian } = client({
      "GET /v1/documents/document/urn%3A1/download": () => binaryResponse(new Uint8Array([1])),
    });
    await doctavian.downloadDocument("urn:1");
    expect(fake.calls[0].headers["x-storage-type"]).toBe(STORAGE_TYPE.data);
    expect(fake.calls[0].method).toBe("GET");
  });

  it("lets a caller override the container when a file lives elsewhere", async () => {
    const { fake, doctavian } = client({
      "GET /v1/documents/document/tpl/download": () => binaryResponse(new Uint8Array([1])),
    });
    await doctavian.downloadDocument("tpl", { storageType: STORAGE_TYPE.template });
    expect(fake.calls[0].headers["x-storage-type"]).toBe("document-template");
  });
});

describe("token refresh", () => {
  const tokenBody = {
    access_token: "fresh-access-token",
    refresh_token: "rotated-refresh-token",
    expires_in: 3599,
    token_type: "Bearer",
  };

  it("refreshes once on a 401 and retries the same request", async () => {
    let attempts = 0;
    const { fake, doctavian } = client(
      {
        [`POST ${DOCTAVIAN_TOKEN_PATH}`]: () => jsonResponse(tokenBody),
        "GET /v1/documents/template/list": () => {
          attempts += 1;
          return attempts === 1
            ? errorResponse({ error: "AUTHORIZATION_ERROR" }, 401, "Unauthorized")
            : jsonResponse({ result: { data: { documentTemplates: [], rowCount: 0 } } });
        },
      },
      { refresh: { refreshToken: "old-refresh-token" } },
    );

    await expect(doctavian.listTemplates()).resolves.toEqual([]);
    expect(fake.trace()).toEqual([
      "GET /v1/documents/template/list",
      `POST ${DOCTAVIAN_TOKEN_PATH}`,
      "GET /v1/documents/template/list",
    ]);
    expect(fake.calls[2].headers.authorization).toBe("Bearer fresh-access-token");
  });

  it("sends the refresh form-encoded with the client id in the body", async () => {
    const { fake, doctavian } = client(
      {
        [`POST ${DOCTAVIAN_TOKEN_PATH}`]: () => jsonResponse(tokenBody),
        "GET /v1/documents/template/list": () =>
          errorResponse({ error: "AUTHORIZATION_ERROR" }, 401, "Unauthorized"),
      },
      { refresh: { refreshToken: "old-refresh-token" } },
    );

    await doctavian.listTemplates().catch(() => undefined);

    const call = fake.calls[1];
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(call.text ?? "");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("old-refresh-token");
    expect(form.get("client_id")).toBeTruthy();
    // The token endpoint authenticates by refresh token alone; sending the api
    // key there would leak it to an endpoint that has no use for it.
    expect(call.headers["x-api-key"]).toBeUndefined();
  });

  it("hands the rotated refresh token to the caller, since Entra retires the old one", async () => {
    const seen: { access: string; refresh: string }[] = [];
    const { doctavian } = client(
      {
        [`POST ${DOCTAVIAN_TOKEN_PATH}`]: () => jsonResponse(tokenBody),
        "GET /v1/documents/template/list": () =>
          errorResponse({ error: "AUTHORIZATION_ERROR" }, 401, "Unauthorized"),
      },
      {
        refresh: {
          refreshToken: "old-refresh-token",
          onRefresh: (tokens: { accessToken: string; refreshToken: string }) =>
            void seen.push({ access: tokens.accessToken, refresh: tokens.refreshToken }),
        },
      },
    );

    await doctavian.listTemplates().catch(() => undefined);

    expect(seen).toEqual([{ access: "fresh-access-token", refresh: "rotated-refresh-token" }]);
  });

  it("does not retry a 401 forever when refreshing cannot fix it", async () => {
    let attempts = 0;
    const { doctavian } = client(
      {
        [`POST ${DOCTAVIAN_TOKEN_PATH}`]: () => jsonResponse(tokenBody),
        "GET /v1/documents/template/list": () => {
          attempts += 1;
          return errorResponse({ error: "ApiKeyInvalid" }, 401, "Unauthorized");
        },
      },
      { refresh: { refreshToken: "old-refresh-token" } },
    );

    await expect(doctavian.listTemplates()).rejects.toMatchObject({ status: 401 });
    expect(attempts).toBe(2);
  });

  it("leaves a 401 alone when no refresh token was configured", async () => {
    let attempts = 0;
    const { doctavian } = client({
      "GET /v1/documents/template/list": () => {
        attempts += 1;
        return errorResponse({ error: "AUTHORIZATION_ERROR" }, 401, "Unauthorized");
      },
    });

    await expect(doctavian.listTemplates()).rejects.toMatchObject({ status: 401 });
    expect(attempts).toBe(1);
  });
});

describe("base URL", () => {
  it("defaults to the demo tenant, which is a different host from api.doctavian.com", async () => {
    const fake = createFakeFetch({
      "GET /v1/documents/template/list": () => jsonResponse({ result: { data: {} } }),
    });
    const doctavian = new DoctavianClient({
      bearerToken: "t",
      documentsApiKey: "d",
      signaturesApiKey: "s",
      fetchImpl: fake.fetchImpl,
    });

    await doctavian.listTemplates();

    expect(fake.calls[0].url.startsWith(DOCTAVIAN_DEMO_BASE_URL)).toBe(true);
    expect(DOCTAVIAN_DEMO_BASE_URL).toBe("https://demo.api.doctavian.com");
  });

  it("trims a trailing slash rather than producing a double slash", async () => {
    const fake = createFakeFetch({
      "GET /v1/documents/template/list": () => jsonResponse({ result: { data: {} } }),
    });
    const doctavian = new DoctavianClient({
      baseUrl: "https://demo.api.doctavian.com/",
      bearerToken: "t",
      documentsApiKey: "d",
      signaturesApiKey: "s",
      fetchImpl: fake.fetchImpl,
    });

    await doctavian.listTemplates();

    expect(fake.calls[0].url).toBe(
      "https://demo.api.doctavian.com/v1/documents/template/list",
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  DoctavianClient,
  areaForPath,
  assertPathInArea,
} from "../../src/lib/adapters/doctavian/client";
import {
  DoctavianApiError,
  DoctavianKeyScopeError,
  DoctavianResponseError,
} from "../../src/lib/adapters/doctavian/errors";
import {
  binaryResponse,
  createFakeFetch,
  errorResponse,
  jsonResponse,
  type Responder,
} from "./fake-fetch";

const BASE_URL = "https://api.doctavian.com";
const DOCUMENTS_KEY = "doc-key-aaaa";
const SIGNATURES_KEY = "sig-key-bbbb";
const TOKEN = "token-cccc";

function client(
  routes: Record<string, Responder>,
  overrides: { bearerToken?: string | (() => string) } = {},
) {
  const fake = createFakeFetch(routes);
  return {
    fake,
    doctavian: new DoctavianClient({
      baseUrl: BASE_URL,
      bearerToken: overrides.bearerToken ?? TOKEN,
      documentsApiKey: DOCUMENTS_KEY,
      signaturesApiKey: SIGNATURES_KEY,
      fetchImpl: fake.fetchImpl,
    }),
  };
}

/** A fresh Response per call: a Response body can only be read once. */
const GENERATE_OK = () =>
  jsonResponse({
    result: { data: { document: { urn: "urn:doc:9f2" } } },
    consumption: [{ dimension: "documents-generated", value: 1 }],
  });

describe("auth headers", () => {
  it("sends the bearer token and the api key on every call", async () => {
    const { fake, doctavian } = client({
      "POST /v1/documents/datasource/create": () =>
        jsonResponse({ result: { data: { dataSourceGuid: "ds-1" } } }),
    });

    await doctavian.createDataSource({ name: "writ" });

    expect(fake.calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(fake.calls[0].headers["x-api-key"]).toBe(DOCUMENTS_KEY);
  });

  it("scopes the api key per area: signatures calls never carry the documents key", async () => {
    const { fake, doctavian } = client({
      "GET /v1/signatures/envelope/env-1/send": () =>
        jsonResponse({ result: { data: { envelopeId: "env-1", status: "sent" } } }),
      "POST /v1/documents/datasource/create": () =>
        jsonResponse({ result: { data: { dataSourceGuid: "ds-1" } } }),
    });

    await doctavian.createDataSource({ name: "writ" });
    await doctavian.sendEnvelope("env-1");

    const [documents, signatures] = fake.calls;
    expect(documents.headers["x-api-key"]).toBe(DOCUMENTS_KEY);
    expect(signatures.headers["x-api-key"]).toBe(SIGNATURES_KEY);
    expect(signatures.headers["x-api-key"]).not.toBe(DOCUMENTS_KEY);
  });

  it("re-resolves a token provider per request, so an expiring token can rotate", async () => {
    let issued = 0;
    const { fake, doctavian } = client(
      {
        "GET /v1/documents/template/list": () => jsonResponse({ result: { data: [] } }),
      },
      {
        bearerToken: () => {
          issued += 1;
          return `token-${issued}`;
        },
      },
    );

    await doctavian.listTemplates();
    await doctavian.listTemplates();

    expect(fake.calls.map((c) => c.headers.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);
  });
});

describe("api key scoping guard", () => {
  it("maps a path to its area", () => {
    expect(areaForPath("/v1/documents/document/generate")).toBe("documents");
    expect(areaForPath("/v1/signatures/envelope/create")).toBe("signatures");
    expect(() => areaForPath("/v1/nope/x")).toThrow(DoctavianResponseError);
  });

  it("refuses to put a key on a path outside its area before anything is sent", () => {
    expect(() => assertPathInArea("documents", "/v1/documents/document/generate")).not.toThrow();
    expect(() => assertPathInArea("documents", "/v1/signatures/document/upload")).toThrow(
      DoctavianKeyScopeError,
    );
    expect(() => assertPathInArea("signatures", "/v1/documents/data/upload")).toThrow(
      DoctavianKeyScopeError,
    );
  });
});

describe("generation flow", () => {
  it("creates a datasource with the documented body", async () => {
    const { fake, doctavian } = client({
      "POST /v1/documents/datasource/create": () =>
        jsonResponse({ result: { data: { dataSourceGuid: "ds-7" } } }),
    });

    const result = await doctavian.createDataSource({ name: "writ", description: "d" });

    expect(result).toEqual({ dataSourceGuid: "ds-7" });
    expect(fake.calls[0].json).toEqual({
      name: "writ",
      description: "d",
      loadMethod: "Storage",
    });
  });

  it("creates a solution bound to the datasource guid", async () => {
    const { fake, doctavian } = client({
      "POST /v1/documents/solution/create": () =>
        jsonResponse({ result: { data: { documentSolutionGuid: "sol-3" } } }),
    });

    const result = await doctavian.createSolution({ name: "writ", dataGuid: "ds-7" });

    expect(result).toEqual({ documentSolutionGuid: "sol-3" });
    expect(fake.calls[0].json).toMatchObject({ dataGuid: "ds-7" });
  });

  it("uploads the template as multipart under the field name `file`", async () => {
    const { fake, doctavian } = client({
      "POST /v1/documents/template/upload": () => jsonResponse({ result: { data: { files: [{ id: "tpl-1", fileName: "writ-template.docx" }] } } }, 201),
    });

    await doctavian.uploadTemplate(
      { fileName: "writ-template.docx", bytes: new Uint8Array([80, 75, 3, 4]) },
      { documentSolutionGuid: "sol-3" },
    );

    const form = fake.calls[0].form;
    expect(form).not.toBeNull();
    const file = form?.get("file") as File;
    expect(file.name).toBe("writ-template.docx");
    expect(file.type).toContain("wordprocessingml.document");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([80, 75, 3, 4]));
    expect(form?.get("documentSolutionGuid")).toBe("sol-3");
    // fetch owns the multipart boundary; a hand-set content-type would not match it.
    expect(fake.calls[0].headers["content-type"]).toBeUndefined();
  });

  it("does not double-wrap a payload that already carries the data root", async () => {
    const { fake, doctavian } = client({
      "POST /v1/documents/data/upload": () =>
        jsonResponse({ result: { data: { files: [{ id: "dat-1" }] } } }, 201),
    });

    await doctavian.uploadData({ data: { Writ: [{ Id: "w1" }] } });

    const file = fake.calls[0].form?.get("file") as File;
    expect(JSON.parse(await file.text())).toEqual({ data: { Writ: [{ Id: "w1" }] } });
  });

  it("uploads the data payload as a JSON file wrapped in a root data object", async () => {
    const { fake, doctavian } = client({
      "POST /v1/documents/data/upload": () => jsonResponse({ result: { data: { files: [{ id: "dat-1", fileName: "data.json" }] } } }, 201),
    });

    await doctavian.uploadData({ Writ: [{ Id: "w1" }] }, { dataSourceGuid: "ds-7" });

    const file = fake.calls[0].form?.get("file") as File;
    expect(file.name).toBe("data.json");
    expect(file.type).toBe("application/json");
    // Wrapped in a root `data` object. Without it the *generate* call two steps
    // later fails with TEMPLATE_READ_FAILED, naming a file that is fine.
    expect(JSON.parse(await file.text())).toEqual({ data: { Writ: [{ Id: "w1" }] } });
  });

  it("uses the sync generate endpoint and returns the urn and consumption", async () => {
    const { fake, doctavian } = client({
      "POST /v1/documents/document/generate": () => GENERATE_OK(),
    });

    const result = await doctavian.generateDocument({
      template: { name: "t.docx", urn: "tpl-1", fileFormat: "docx", loadMethod: "Storage" },
      data: { urn: "dat-1", loadMethod: "Storage" },
      document: {
        name: "writ",
        fileFormat: "pdf",
        deliveryMethod: "Storage",
        path: "root",
        locale: "en",
        timezone: "Europe/Dublin",
      },
    });

    expect(result.urn).toBe("urn:doc:9f2");
    expect(result.consumption).toEqual([{ dimension: "documents-generated", value: 1 }]);
    expect(fake.calls[0].pathname).toBe("/v1/documents/document/generate");
    // The async variant would need an x-client-authorization header; we never send one.
    expect(fake.calls[0].headers["x-client-authorization"]).toBeUndefined();
  });

  it("throws when generate answers without a urn rather than returning a blank one", async () => {
    const { doctavian } = client({
      "POST /v1/documents/document/generate": () => jsonResponse({ result: { data: {} } }),
    });

    await expect(
      doctavian.generateDocument({
        template: { name: "t.docx", urn: "tpl-1", fileFormat: "docx", loadMethod: "Storage" },
        data: { urn: "dat-1", loadMethod: "Storage" },
        document: {
          name: "writ",
          fileFormat: "pdf",
          deliveryMethod: "Storage",
          path: "root",
          locale: "en",
          timezone: "Europe/Dublin",
        },
      }),
    ).rejects.toBeInstanceOf(DoctavianResponseError);
  });

  it("downloads raw bytes without trying to parse them as JSON", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    const { fake, doctavian } = client({
      "GET /v1/documents/document/urn%3Adoc%3A9f2/download": () =>
        binaryResponse(pdf, { contentType: "application/pdf", fileName: "writ.pdf" }),
    });

    const file = await doctavian.downloadDocument("urn:doc:9f2");

    expect(file.bytes).toEqual(pdf);
    expect(file.contentType).toBe("application/pdf");
    expect(file.fileName).toBe("writ.pdf");
    expect(fake.calls[0].method).toBe("GET");
  });

  it("still reports a JSON error body on a failed download", async () => {
    const { doctavian } = client({
      "GET /v1/documents/document/missing/download": () =>
        errorResponse({ error: "DocumentNotFound" }, 404, "Not Found"),
    });

    const error = await doctavian.downloadDocument("missing").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DoctavianApiError);
    expect((error as DoctavianApiError).status).toBe(404);
    expect((error as DoctavianApiError).body).toEqual({ error: "DocumentNotFound" });
  });

  it("runs all six calls in order and threads each id into the next", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const { fake, doctavian } = client({
      "POST /v1/documents/datasource/create": () =>
        jsonResponse({ result: { data: { dataSourceGuid: "ds-7" } } }),
      "POST /v1/documents/solution/create": () =>
        jsonResponse({ result: { data: { documentSolutionGuid: "sol-3" } } }),
      "POST /v1/documents/template/upload": () => jsonResponse({ result: { data: { files: [{ id: "tpl-1", fileName: "writ-template.docx" }] } } }, 201),
      "POST /v1/documents/data/upload": () => jsonResponse({ result: { data: { files: [{ id: "dat-1", fileName: "data.json" }] } } }, 201),
      "POST /v1/documents/document/generate": () => GENERATE_OK(),
      "GET /v1/documents/document/urn%3Adoc%3A9f2/download": () => binaryResponse(pdf),
    });

    const result = await doctavian.runGenerationFlow({
      name: "writ-01",
      template: { fileName: "writ-template.docx", bytes: new Uint8Array([80, 75]) },
      data: { Writ: [{ Id: "w1" }] },
    });

    expect(fake.trace()).toEqual([
      "POST /v1/documents/datasource/create",
      "POST /v1/documents/solution/create",
      "POST /v1/documents/template/upload",
      "POST /v1/documents/data/upload",
      "POST /v1/documents/document/generate",
      "GET /v1/documents/document/urn%3Adoc%3A9f2/download",
    ]);
    expect(fake.calls[1].json).toMatchObject({ dataGuid: "ds-7" });
    expect(fake.calls[4].json).toEqual({
      template: {
        name: "writ-template.docx",
        urn: "tpl-1",
        fileFormat: "docx",
        loadMethod: "Storage",
      },
      data: { urn: "dat-1", loadMethod: "Storage" },
      document: {
        name: "writ-01",
        fileFormat: "pdf",
        deliveryMethod: "Storage",
        path: "root",
        locale: "en",
        timezone: "Europe/Dublin",
      },
    });
    expect(result.documentUrn).toBe("urn:doc:9f2");
    expect(result.document?.bytes).toEqual(pdf);
  });

  it("skips the download when only the urn is wanted", async () => {
    const { fake, doctavian } = client({
      "POST /v1/documents/datasource/create": () => jsonResponse({ dataSourceGuid: "ds" }),
      "POST /v1/documents/solution/create": () => jsonResponse({ documentSolutionGuid: "sol" }),
      "POST /v1/documents/template/upload": () => jsonResponse({ result: { data: { files: [{ id: "tpl" }] } } }, 201),
      "POST /v1/documents/data/upload": () => jsonResponse({ result: { data: { files: [{ id: "dat" }] } } }, 201),
      "POST /v1/documents/document/generate": () => GENERATE_OK(),
    });

    const result = await doctavian.runGenerationFlow({
      name: "writ-01",
      template: { fileName: "t.docx", bytes: new Uint8Array([1]) },
      data: {},
      download: false,
    });

    expect(result.document).toBeNull();
    expect(fake.trace()).toHaveLength(5);
  });

  it("accepts a flat body and a body nested one level deeper", async () => {
    const { doctavian } = client({
      "POST /v1/documents/datasource/create": () => jsonResponse({ dataSourceGuid: "flat" }),
      "POST /v1/documents/solution/create": () =>
        jsonResponse({ result: { data: { solution: { guid: "nested" } } } }),
    });

    expect(await doctavian.createDataSource({ name: "a" })).toEqual({ dataSourceGuid: "flat" });
    expect(await doctavian.createSolution({ name: "a", dataGuid: "x" })).toEqual({
      documentSolutionGuid: "nested",
    });
  });

  it("unwraps list responses whether they are bare arrays or nested", async () => {
    const { doctavian } = client({
      "GET /v1/documents/template/list": () =>
        jsonResponse({
          result: {
            data: {
              documentTemplates: [{ id: "tpl-1", name: "writ", fileFormat: "docx" }],
              rowCount: 1,
            },
          },
        }),
      "GET /v1/documents/document/list": () => jsonResponse({ result: { data: { documents: [{ urn: "urn:doc:1", name: "writ" }], rowCount: 1 } } }),
    });

    expect(await doctavian.listTemplates()).toEqual([
      { id: "tpl-1", name: "writ", fileFormat: "docx", documentSolutionGuid: undefined },
    ]);
    expect(await doctavian.listDocuments()).toEqual([
      { id: "urn:doc:1", name: "writ", fileFormat: undefined },
    ]);
  });
});

describe("errors", () => {
  it("carries the status and the response body", async () => {
    const { doctavian } = client({
      "POST /v1/documents/document/generate": () =>
        errorResponse({ code: "TemplateInvalid", detail: "unclosed repeater" }, 422, "Unprocessable"),
    });

    const error = (await doctavian
      .generateDocument({
        template: { name: "t.docx", urn: "tpl", fileFormat: "docx", loadMethod: "Storage" },
        data: { urn: "dat", loadMethod: "Storage" },
        document: {
          name: "w",
          fileFormat: "pdf",
          deliveryMethod: "Storage",
          path: "root",
          locale: "en",
          timezone: "Europe/Dublin",
        },
      })
      .catch((e: unknown) => e)) as DoctavianApiError;

    expect(error).toBeInstanceOf(DoctavianApiError);
    expect(error.status).toBe(422);
    expect(error.statusText).toBe("Unprocessable");
    expect(error.body).toEqual({ code: "TemplateInvalid", detail: "unclosed repeater" });
    expect(error.area).toBe("documents");
    expect(error.method).toBe("POST");
    expect(error.isApiKeyScopeFailure).toBe(false);
  });

  it("flags the 401 that means the key was scoped to the wrong area", async () => {
    const { doctavian } = client({
      "POST /v1/signatures/envelope/create": () =>
        errorResponse({ error: "ApiKeyInvalid" }, 401, "Unauthorized"),
    });

    const error = (await doctavian
      .createEnvelope({
        documents: [{ referenceDocumentId: "d1", id: "doc-1", name: "writ.pdf" }],
        signers: [{ referenceSignerId: "s1", name: "A", email: "a@example.com" }],
        fields: [
          {
            referenceDocumentId: "d1",
            referenceSignerId: "s1",
            type: "signature",
            page: 1,
            x: 100,
            y: 600,
          },
        ],
        envelope: { name: "writ" },
      })
      .catch((e: unknown) => e)) as DoctavianApiError;

    expect(error.status).toBe(401);
    expect(error.isApiKeyScopeFailure).toBe(true);
  });

  it("preserves a non-JSON error body verbatim", async () => {
    const { doctavian } = client({
      "GET /v1/documents/template/list": () =>
        errorResponse("<html>502 from the gateway</html>", 502, "Bad Gateway"),
    });

    const error = (await doctavian.listTemplates().catch((e: unknown) => e)) as DoctavianApiError;

    expect(error.body).toBe("<html>502 from the gateway</html>");
  });
});

describe("signatures flow", () => {
  it("uploads, creates, sends and audits an envelope", async () => {
    const audit = new Uint8Array([1, 2, 3]);
    const { fake, doctavian } = client({
      "POST /v1/signatures/document/upload": () => jsonResponse({ result: { data: { files: [{ id: "sdoc-1" }] } } }, 201),
      "POST /v1/signatures/envelope/create": () =>
        jsonResponse({ result: { data: { envelopeId: "env-9" } } }),
      "GET /v1/signatures/envelope/env-9/send": () =>
        jsonResponse({ result: { data: { envelopeId: "env-9", status: "sent" } } }),
      "GET /v1/signatures/envelope/env-9/audit/get": () =>
        jsonResponse({
          result: {
            data: {
              envelopeId: "env-9",
              status: "completed",
              events: [
                { timestamp: "2026-09-03T10:00:00Z", type: "sent", actor: "system" },
                { timestamp: "2026-09-03T10:04:00Z", type: "signed", actor: "a@example.com" },
              ],
            },
          },
        }),
      "GET /v1/signatures/envelope/env-9/audit/download": () =>
        binaryResponse(audit, { contentType: "application/pdf", fileName: "audit.pdf" }),
    });

    const uploaded = await doctavian.uploadSignatureDocument({
      fileName: "writ.pdf",
      bytes: new Uint8Array([0x25, 0x50]),
    });
    const envelope = await doctavian.createEnvelope({
      documents: [{ referenceDocumentId: "d1", id: uploaded.id, name: "writ.pdf" }],
      signers: [
        { referenceSignerId: "s1", name: "Aoife Byrne", email: "aoife@meridian-analytics.ie" },
      ],
      fields: [
        {
          referenceDocumentId: "d1",
          referenceSignerId: "s1",
          type: "digitalsignature",
          page: 3,
          x: 90,
          y: 210,
          required: true,
        },
      ],
      envelope: { name: "Writ of delegated authority", signingOrder: "sequential" },
    });
    const sent = await doctavian.sendEnvelope(envelope.envelopeId);
    const trail = await doctavian.getEnvelopeAudit(envelope.envelopeId);
    const file = await doctavian.downloadEnvelopeAudit(envelope.envelopeId);

    expect(uploaded.id).toBe("sdoc-1");
    expect(envelope.envelopeId).toBe("env-9");
    expect(sent).toEqual({ envelopeId: "env-9", status: "sent" });
    expect(trail.status).toBe("completed");
    expect(trail.events).toHaveLength(2);
    expect(file.bytes).toEqual(audit);

    // documents, signers, fields and envelope settings go up as ONE body
    const created = fake.calls[1].json as Record<string, unknown>;
    expect(Object.keys(created).sort()).toEqual([
      "documents",
      "envelope",
      "fields",
      "signers",
    ]);
    // and every signatures call carried the signatures key
    for (const call of fake.calls) {
      expect(call.headers["x-api-key"]).toBe(SIGNATURES_KEY);
    }
  });
});

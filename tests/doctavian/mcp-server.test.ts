import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it } from "vitest";

import { DoctavianClient } from "../../src/lib/adapters/doctavian/client";
import {
  createDoctavianMcpHandler,
  createDoctavianMcpServer,
} from "../../src/lib/mcp/doctavian-server";
import {
  binaryResponse,
  createFakeFetch,
  errorResponse,
  jsonResponse,
  type FakeFetch,
  type Responder,
} from "./fake-fetch";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

function doctavianClient(routes: Record<string, Responder>): {
  client: DoctavianClient;
  fake: FakeFetch;
} {
  const fake = createFakeFetch(routes);
  return {
    fake,
    client: new DoctavianClient({
      baseUrl: "https://api.doctavian.com",
      bearerToken: "token",
      documentsApiKey: "doc-key",
      signaturesApiKey: "sig-key",
      fetchImpl: fake.fetchImpl,
    }),
  };
}

async function connect(routes: Record<string, Responder> = {}) {
  const { client: doctavian, fake } = doctavianClient(routes);
  const server = createDoctavianMcpServer({ client: doctavian });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, fake };
}

function payload(result: CallToolResult): unknown {
  const first = result.content[0];
  if (first.type !== "text") throw new Error("expected a text content block");
  return JSON.parse(first.text);
}

describe("tool surface", () => {
  let tools: Tool[];

  beforeEach(async () => {
    const { client } = await connect();
    tools = (await client.listTools()).tools;
  });

  it("exposes the generation flow and the signature envelope operations", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      "doctavian_build_writ_template",
      "doctavian_create_datasource",
      "doctavian_create_envelope",
      "doctavian_create_solution",
      "doctavian_download_document",
      "doctavian_download_envelope_audit",
      "doctavian_generate_document",
      "doctavian_generate_writ",
      "doctavian_get_envelope_audit",
      "doctavian_list_documents",
      "doctavian_list_templates",
      "doctavian_run_generation_flow",
      "doctavian_send_envelope",
      "doctavian_upload_data",
      "doctavian_upload_signature_document",
      "doctavian_upload_template",
    ]);
  });

  it("annotates every tool explicitly, because destructiveHint defaults to true", () => {
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(tool.annotations?.title, tool.name).toBeTruthy();
      expect(typeof tool.annotations?.destructiveHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations?.idempotentHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations?.openWorldHint, tool.name).toBe("boolean");
    }
  });

  it("marks exactly one tool destructive: sending an envelope cannot be recalled", () => {
    const destructive = tools.filter((t) => t.annotations?.destructiveHint);
    expect(destructive.map((t) => t.name)).toEqual(["doctavian_send_envelope"]);
  });

  it("marks the read-only tools read-only and idempotent", () => {
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      "doctavian_build_writ_template",
      "doctavian_download_document",
      "doctavian_download_envelope_audit",
      "doctavian_get_envelope_audit",
      "doctavian_list_documents",
      "doctavian_list_templates",
    ]);
    for (const tool of tools) {
      if (tool.annotations?.readOnlyHint) {
        expect(tool.annotations.idempotentHint, tool.name).toBe(true);
        expect(tool.annotations.destructiveHint, tool.name).toBe(false);
      }
    }
  });

  it("marks the local template build as closed-world: it touches no tenant", () => {
    const local = tools.find((t) => t.name === "doctavian_build_writ_template");
    expect(local?.annotations?.openWorldHint).toBe(false);
    for (const tool of tools) {
      if (tool.name === "doctavian_build_writ_template") continue;
      expect(tool.annotations?.openWorldHint, tool.name).toBe(true);
    }
  });

  it("marks the billed generation tools non-idempotent", () => {
    for (const name of [
      "doctavian_generate_document",
      "doctavian_generate_writ",
      "doctavian_run_generation_flow",
    ]) {
      expect(tools.find((t) => t.name === name)?.annotations?.idempotentHint).toBe(false);
    }
  });
});

describe("tool behaviour", () => {
  it("builds the writ template as a real .docx without leaving the process", async () => {
    const { client, fake } = await connect();

    const result = (await client.callTool({
      name: "doctavian_build_writ_template",
      arguments: {},
    })) as CallToolResult;
    const built = payload(result) as { base64: string; byteLength: number };

    const bytes = Buffer.from(built.base64, "base64");
    // PK\x03\x04 — a .docx is a zip.
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(built.byteLength).toBe(bytes.length);
    expect(fake.calls).toHaveLength(0);
  });

  it("drives all six generation calls from one writ tool call", async () => {
    const { client, fake } = await connect({
      "POST /v1/documents/datasource/create": () => jsonResponse({ dataSourceGuid: "ds" }),
      "POST /v1/documents/solution/create": () => jsonResponse({ documentSolutionGuid: "sol" }),
      "POST /v1/documents/template/upload": () => jsonResponse({ id: "tpl" }),
      "POST /v1/documents/data/upload": () => jsonResponse({ id: "dat" }),
      "POST /v1/documents/document/generate": () =>
        jsonResponse({
          result: { data: { document: { urn: "urn:doc:1" } } },
          consumption: [{ dimension: "documents-generated", value: 1 }],
        }),
      "POST /v1/documents/document/urn%3Adoc%3A1/download": () =>
        binaryResponse(PDF, { fileName: "writ.pdf" }),
    });

    const result = (await client.callTool({
      name: "doctavian_generate_writ",
      arguments: { name: "writ-01", writData: { Writ: [{ Id: "w1" }] } },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const body = payload(result) as {
      documentUrn: string;
      consumption: { dimension: string; value: number }[];
      document: { base64: string; fileName: string };
    };
    expect(body.documentUrn).toBe("urn:doc:1");
    expect(body.consumption).toEqual([{ dimension: "documents-generated", value: 1 }]);
    expect(Buffer.from(body.document.base64, "base64")).toEqual(Buffer.from(PDF));
    expect(fake.trace()).toHaveLength(6);

    // the uploaded template really is the writ template, tags and all
    const uploaded = fake.calls[2].form?.get("file") as File;
    expect(uploaded.name).toBe("writ-template.docx");
  });

  it("returns a downloaded document as base64 with its headers", async () => {
    const { client } = await connect({
      "POST /v1/documents/document/urn%3Adoc%3A5/download": () =>
        binaryResponse(PDF, { contentType: "application/pdf", fileName: "writ.pdf" }),
    });

    const result = (await client.callTool({
      name: "doctavian_download_document",
      arguments: { urn: "urn:doc:5" },
    })) as CallToolResult;

    expect(payload(result)).toEqual({
      fileName: "writ.pdf",
      contentType: "application/pdf",
      byteLength: PDF.length,
      base64: Buffer.from(PDF).toString("base64"),
    });
  });

  it("sends an envelope through the signatures key", async () => {
    const { client, fake } = await connect({
      "GET /v1/signatures/envelope/env-1/send": () =>
        jsonResponse({ result: { data: { envelopeId: "env-1", status: "sent" } } }),
    });

    const result = (await client.callTool({
      name: "doctavian_send_envelope",
      arguments: { envelopeId: "env-1" },
    })) as CallToolResult;

    expect(payload(result)).toEqual({ envelopeId: "env-1", status: "sent" });
    expect(fake.calls[0].headers["x-api-key"]).toBe("sig-key");
  });

  it("creates an envelope from one body wired by reference ids", async () => {
    const { client, fake } = await connect({
      "POST /v1/signatures/envelope/create": () => jsonResponse({ envelopeId: "env-2" }),
    });

    const result = (await client.callTool({
      name: "doctavian_create_envelope",
      arguments: {
        envelopeName: "Writ of delegated authority",
        signingOrder: "sequential",
        documents: [{ referenceDocumentId: "d1", id: "doc-1", name: "writ.pdf" }],
        signers: [
          { referenceSignerId: "s1", name: "Aoife Byrne", email: "aoife@example.ie", order: 1 },
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
      },
    })) as CallToolResult;

    expect(payload(result)).toEqual({ envelopeId: "env-2" });
    expect(fake.calls[0].json).toMatchObject({
      envelope: { name: "Writ of delegated authority", signingOrder: "sequential" },
      fields: [{ type: "digitalsignature", page: 3 }],
    });
  });

  it("hands a Doctavian failure back as a readable tool error, not a transport fault", async () => {
    const { client } = await connect({
      "POST /v1/signatures/envelope/create": () =>
        errorResponse({ error: "ApiKeyInvalid" }, 401, "Unauthorized"),
    });

    const result = (await client.callTool({
      name: "doctavian_create_envelope",
      arguments: {
        envelopeName: "writ",
        documents: [{ referenceDocumentId: "d1", id: "doc-1", name: "writ.pdf" }],
        signers: [{ referenceSignerId: "s1", name: "A", email: "a@example.com" }],
        fields: [
          {
            referenceDocumentId: "d1",
            referenceSignerId: "s1",
            type: "signature",
            page: 1,
            x: 1,
            y: 2,
          },
        ],
      },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      error: "doctavian_api_error",
      status: 401,
      area: "signatures",
      apiKeyScopeFailure: true,
    });
  });

  it("rejects arguments that do not match the input schema", async () => {
    const { client } = await connect();

    const result = (await client.callTool({
      name: "doctavian_send_envelope",
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBe(true);
  });
});

describe("streamable http transport", () => {
  it("answers an initialize request with a JSON body", async () => {
    const { client: doctavian } = doctavianClient({});
    const handler = createDoctavianMcpHandler({ client: doctavian });

    const response = await handler(
      new Request("https://chancery.local/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "0.0.0" },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as {
      result: { serverInfo: { name: string }; capabilities: Record<string, unknown> };
    };
    expect(body.result.serverInfo.name).toBe("chancery-doctavian");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("runs stateless: no session id is issued", async () => {
    const { client: doctavian } = doctavianClient({});
    const handler = createDoctavianMcpHandler({ client: doctavian });

    const response = await handler(
      new Request("https://chancery.local/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "0.0.0" },
          },
        }),
      }),
    );

    expect(response.headers.get("mcp-session-id")).toBeNull();
  });
});

/**
 * Driven against a linked in-memory transport and a stub server, never a live
 * one. The stub stands in for foxitsoftware/foxit-pdf-api-mcp-server: a subset
 * of its 40 reversible tools, plus — in the drift tests — the signing tool it
 * does not have today and might have next release.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  FOXIT_MCP_ADVERTISED_TOOL_COUNT,
  FoxitIrreversibleToolError,
  FoxitMcpClient,
  classifyTool,
  textOf,
} from "../../src/lib/adapters/foxit/mcp-client";

/** Named exactly as upstream names them; the classifier keys off the names. */
const REVERSIBLE_TOOLS = [
  "upload_document",
  "download_document",
  "create_share_link",
  "pdf_from_word",
  "pdf_to_word",
  "pdf_compress",
  "pdf_combine",
  "pdf_extract",
  "pdf_ocr",
  "get_task_status",
];

interface Stub {
  client: FoxitMcpClient;
  invocations: string[];
}

async function connect(
  options: { extraTools?: { name: string; annotations?: ToolAnnotations }[] } = {},
): Promise<Stub> {
  const invocations: string[] = [];
  const server = new McpServer({ name: "foxit-pdf-api-mcp-server", version: "0.0.0-stub" });

  const register = (name: string, annotations?: ToolAnnotations) => {
    server.registerTool(
      name,
      {
        description: `Foxit PDF Services: ${name.replace(/_/g, " ")}.`,
        inputSchema: { documentId: z.string().optional() },
        ...(annotations === undefined ? {} : { annotations }),
      },
      async (args: { documentId?: string }) => {
        invocations.push(name);
        return {
          content: [{ type: "text" as const, text: `${name}:${args.documentId ?? ""}` }],
        };
      },
    );
  };

  for (const name of REVERSIBLE_TOOLS) register(name);
  for (const extra of options.extraTools ?? []) register(extra.name, extra.annotations);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new FoxitMcpClient({ transport: clientTransport });
  await Promise.all([server.connect(serverTransport), client.connect()]);
  return { client, invocations };
}

describe("catalogue", () => {
  it("reads the upstream catalogue and classifies every tool as reversible", async () => {
    const { client } = await connect();
    const tools = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([...REVERSIBLE_TOOLS].sort());
    expect(tools.every((tool) => tool.reversible)).toBe(true);
    expect(tools.every((tool) => tool.irreversibleReason === null)).toBe(true);
    await client.close();
  });

  it("carries each tool's input schema through for our runtime to register", async () => {
    const { client } = await connect();
    const upload = (await client.listTools()).find((tool) => tool.name === "upload_document");

    expect(upload?.description).toContain("Foxit PDF Services");
    expect(upload?.inputSchema).toMatchObject({ type: "object" });
    await client.close();
  });

  it("states what upstream advertises, so a drifted count is visible", () => {
    expect(FOXIT_MCP_ADVERTISED_TOOL_COUNT).toBe(40);
  });
});

describe("calling tools", () => {
  it("forwards arguments and hands back the text blocks", async () => {
    const { client, invocations } = await connect();
    const result = await client.callTool("pdf_compress", { documentId: "doc-1" });

    expect(invocations).toEqual(["pdf_compress"]);
    expect(textOf(result)).toBe("pdf_compress:doc-1");
    expect(result.isError).toBe(false);
    await client.close();
  });

  it("connects lazily, so a caller never has to remember to", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: "stub", version: "0.0.0" });
    server.registerTool(
      "upload_document",
      { description: "upload", inputSchema: {} },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );
    await server.connect(serverTransport);

    const client = new FoxitMcpClient({ transport: clientTransport });
    expect(textOf(await client.callTool("upload_document"))).toBe("ok");
    await client.close();
  });

  it("needs either a url or a transport", async () => {
    await expect(new FoxitMcpClient().connect()).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

describe("catalogue drift", () => {
  it("drops a signing tool the server grows, rather than registering it", async () => {
    const { client } = await connect({
      extraTools: [{ name: "esign_send_for_signature" }],
    });

    const all = await client.listTools();
    const reversible = await client.reversibleTools();

    expect(all.map((tool) => tool.name)).toContain("esign_send_for_signature");
    expect(reversible.map((tool) => tool.name)).not.toContain("esign_send_for_signature");
    expect(all.find((tool) => tool.name === "esign_send_for_signature")?.irreversibleReason)
      .toMatch(/not reversible/);
    await client.close();
  });

  it("refuses to call it without troubling the server", async () => {
    const { client, invocations } = await connect({
      extraTools: [{ name: "esign_send_for_signature" }],
    });

    const error = await client
      .callTool("esign_send_for_signature", { folderId: "f1" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FoxitIrreversibleToolError);
    expect((error as FoxitIrreversibleToolError).toolName).toBe("esign_send_for_signature");
    expect(invocations).toEqual([]);
    await client.close();
  });

  it("hands the runtime reversible tools only, and they still work", async () => {
    const { client, invocations } = await connect({
      extraTools: [{ name: "esign_send_for_signature" }],
    });

    const tools = await client.toAgentTools();

    expect(tools.map((tool) => tool.name)).not.toContain("esign_send_for_signature");
    expect(tools.every((tool) => tool.gated === false)).toBe(true);
    expect(await tools[0].run({ documentId: "doc-9" })).toMatchObject({
      isError: false,
      text: "upload_document:doc-9",
    });
    expect(invocations).toEqual(["upload_document"]);
    await client.close();
  });

  it("believes a destructiveHint even on an innocent-looking name", async () => {
    const { client } = await connect({
      extraTools: [
        {
          name: "purge_document",
          annotations: { title: "Purge", destructiveHint: true },
        },
      ],
    });

    const purge = (await client.listTools()).find((tool) => tool.name === "purge_document");
    expect(purge?.reversible).toBe(false);
    expect(purge?.irreversibleReason).toContain("destructiveHint");
    await client.close();
  });
});

describe("classifier", () => {
  it("passes every reversible Foxit tool name", () => {
    for (const name of REVERSIBLE_TOOLS) {
      expect(classifyTool(name)).toBeNull();
    }
  });

  it("catches signing and sending however they are spelled", () => {
    for (const name of [
      "esign_create_folder",
      "send_envelope",
      "add_signature_field",
      "sign_document",
      "email_document",
      "publish_document",
    ]) {
      expect(classifyTool(name)).not.toBeNull();
    }
  });

  it("does not flag a share link, which commits nobody", () => {
    expect(classifyTool("create_share_link")).toBeNull();
  });

  it("fails closed on a self-contradictory annotation", () => {
    expect(classifyTool("pdf_compress", true)).toContain("destructiveHint");
  });
});

describe("textOf", () => {
  it("ignores content blocks that are not text", () => {
    expect(
      textOf({
        content: [
          { type: "image", data: "AAA", mimeType: "image/png" },
          { type: "text", text: "one" },
          null,
          { type: "text", text: "two" },
        ],
        structuredContent: null,
        isError: false,
      }),
    ).toBe("one\ntwo");
  });
});

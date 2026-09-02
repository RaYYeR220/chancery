/**
 * A client for Foxit's own MCP server (foxitsoftware/foxit-pdf-api-mcp-server).
 *
 * We wrap their server rather than reimplementing its 40 tools, because the
 * bounty's premise is that the catalogue is the sponsor's to define and the
 * boundary is ours to argue about. Reimplementing the tools would be arguing
 * about the wrong thing.
 *
 * Transport is Streamable HTTP; the stdio-python variant is deprecated
 * upstream. The transport is injectable, so the suite drives a linked in-memory
 * pair against a stub server and never touches a live one.
 *
 * ── On `reversibleTools` ──────────────────────────────────────────────────
 *
 * Every tool Foxit ships today is reversible, so the filter finds nothing to
 * remove. It exists because the catalogue is someone else's code: a future
 * release that adds a signing tool would otherwise be silently registered into
 * our agent runtime by an upstream version bump.
 *
 * It is worth being precise about how much this is worth. This filter is a
 * *procedural* guard, the kind `agent-surface.ts` argues against, and it is
 * here only as a second line. The load-bearing protection is that this server
 * is configured with PDF Services credentials and nothing else, so a signing
 * tool it grew tomorrow would reach Foxit and be refused there. The filter
 * makes the drift visible; the credential makes it harmless.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { ReversibleTool } from "../../agent/runtime";
import type { JsonObject, JsonValue } from "../../agent/trace";

import { FoxitError } from "./errors";
import type { FetchLike, PdfServicesCredentials } from "./types";

export const FOXIT_MCP_SERVER_REPO =
  "https://github.com/foxitsoftware/foxit-pdf-api-mcp-server";

/** What upstream advertises. A different count is drift worth noticing, not an error. */
export const FOXIT_MCP_ADVERTISED_TOOL_COUNT = 40;

export interface FoxitMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  reversible: boolean;
  /** Populated only when a tool was classified irreversible, so refusals explain themselves. */
  irreversibleReason: string | null;
}

export interface FoxitMcpToolResult {
  content: unknown[];
  structuredContent: unknown;
  isError: boolean;
}

/**
 * Name fragments that mean an act reaches a third party or cannot be undone.
 * Matching is on the name, not the description, because a description is prose
 * an upstream author can reword and a name is what our runtime dispatches on.
 */
const IRREVERSIBLE_NAME_PATTERNS: readonly RegExp[] = [
  /esign/i,
  /signature/i,
  /(^|[_-])sign([_-]|$)/i,
  /(^|[_-])send/i,
  /envelope/i,
  /(^|[_-])email/i,
  /notify/i,
  /(^|[_-])publish/i,
];

export class FoxitIrreversibleToolError extends FoxitError {
  readonly toolName: string;
  readonly reason: string;

  constructor(toolName: string, reason: string) {
    super(
      `refusing to call ${toolName} through the reversible MCP surface: ${reason}`,
      "OUT_OF_SCOPE_PATH",
    );
    this.name = "FoxitIrreversibleToolError";
    this.toolName = toolName;
    this.reason = reason;
  }
}

export interface FoxitMcpClientOptions {
  /** Streamable HTTP endpoint of the running Foxit MCP server. */
  url?: string;
  /**
   * Forwarded to the server, which uses them for its own PDF Services calls.
   * Typed `pdf-services` for the same reason everything else here is: this
   * process should not be able to hand a signing key to a tool runtime.
   */
  credentials?: PdfServicesCredentials;
  /** Extra headers, for a deployment that authenticates the MCP hop separately. */
  headers?: Record<string, string>;
  /** Injected by the suite; a linked in-memory pair replaces the network entirely. */
  transport?: Transport;
  fetchImpl?: FetchLike;
  clientInfo?: { name: string; version: string };
}

export class FoxitMcpClient {
  private readonly options: FoxitMcpClientOptions;
  private readonly client: Client;
  private connected = false;

  constructor(options: FoxitMcpClientOptions = {}) {
    this.options = options;
    this.client = new Client(
      options.clientInfo ?? { name: "chancery-foxit", version: "0.1.0" },
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.options.transport ?? this.buildTransport());
    this.connected = true;
  }

  /** The whole catalogue, each entry classified. Nothing is filtered out here. */
  async listTools(): Promise<FoxitMcpTool[]> {
    await this.connect();
    const { tools } = await this.client.listTools();
    return tools.map((tool) => {
      const reason = classifyTool(tool.name, tool.annotations?.destructiveHint);
      return {
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
        reversible: reason === null,
        irreversibleReason: reason,
      };
    });
  }

  /** What our agent runtime is allowed to register. */
  async reversibleTools(): Promise<FoxitMcpTool[]> {
    return (await this.listTools()).filter((tool) => tool.reversible);
  }

  /**
   * Refuses a tool the classifier rejected, without asking the server. Calling
   * it would not succeed — the server holds no eSign credential — but a refusal
   * that names the tool is a better diagnostic than a 401 from two hops away.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<FoxitMcpToolResult> {
    const reason = classifyTool(name);
    if (reason !== null) throw new FoxitIrreversibleToolError(name, reason);

    await this.connect();
    const result = await this.client.callTool({ name, arguments: args });
    return {
      content: Array.isArray(result.content) ? result.content : [],
      structuredContent: result.structuredContent ?? null,
      isError: result.isError === true,
    };
  }

  /**
   * The catalogue as our own runtime consumes it: `ReversibleTool` only, so a
   * Foxit tool cannot arrive in the agent's inventory as anything else. The
   * runtime's other arm, `GatedTool`, is unreachable from here by construction
   * — nothing on this connection is irreversible, and anything that looked like
   * it was has already been filtered out.
   */
  async toAgentTools(): Promise<ReversibleTool[]> {
    const tools = await this.reversibleTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as JsonObject,
      gated: false as const,
      run: async (args: JsonObject): Promise<JsonValue> => {
        const result = await this.callTool(tool.name, args);
        return {
          isError: result.isError,
          text: textOf(result),
          structured: (result.structuredContent ?? null) as JsonValue,
        };
      },
    }));
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }

  private buildTransport(): Transport {
    if (this.options.url === undefined) {
      throw new FoxitError(
        "a FoxitMcpClient needs either a url or an injected transport",
        "INVALID_ARGUMENT",
      );
    }
    const headers: Record<string, string> = { ...this.options.headers };
    if (this.options.credentials !== undefined) {
      headers.client_id = this.options.credentials.clientId;
      headers.client_secret = this.options.credentials.clientSecret;
    }
    // The SDK's `FetchLike` accepts a `URL`; ours does not, because everything
    // else in this adapter builds URL strings by hand and asserts on them.
    const fetchImpl = this.options.fetchImpl;
    return new StreamableHTTPClientTransport(new URL(this.options.url), {
      requestInit: { headers },
      fetch:
        fetchImpl === undefined
          ? undefined
          : (url, init) => fetchImpl(url.toString(), init),
    });
  }
}

/**
 * Returns why a tool is irreversible, or null when it is not.
 *
 * Fails closed: an explicit `destructiveHint: true` from the server is
 * believed, and so is a name that looks like signing, even if the server also
 * claims the tool is read-only. A server that contradicts itself is one we
 * should be treating conservatively.
 */
export function classifyTool(name: string, destructiveHint?: boolean): string | null {
  if (destructiveHint === true) {
    return "the server annotates it destructiveHint: true";
  }
  const pattern = IRREVERSIBLE_NAME_PATTERNS.find((candidate) => candidate.test(name));
  if (pattern !== undefined) {
    return `its name matches ${pattern} — signing and sending are not reversible work`;
  }
  return null;
}

/** Concatenated text blocks, which is how every Foxit tool answers. */
export function textOf(result: FoxitMcpToolResult): string {
  return result.content
    .flatMap((block) => {
      if (typeof block !== "object" || block === null) return [];
      const typed = block as { type?: unknown; text?: unknown };
      return typed.type === "text" && typeof typed.text === "string" ? [typed.text] : [];
    })
    .join("\n");
}

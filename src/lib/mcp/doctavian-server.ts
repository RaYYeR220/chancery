/**
 * An MCP server for Doctavian.
 *
 * Doctavian publishes no MCP server — the capability is absent from the OpenAPI
 * spec and from every doc — so an agent that wants to generate or sign a
 * document today has to be hand-wired to raw HTTP. This exposes the generation
 * and signature surface as tools instead, over Streamable HTTP (the legacy
 * HTTP+SSE transport is deprecated and deliberately not implemented).
 *
 * The annotations are the part worth reading carefully. `destructiveHint`
 * **defaults to true** in the MCP schema, so every tool here states it
 * explicitly rather than inheriting a default that happens to be wrong for
 * fifteen of the sixteen tools. Exactly one tool is genuinely destructive:
 * sending an envelope mails the counterparties and cannot be recalled. Marking
 * the other fifteen destructive would train a client to auto-approve the one
 * that matters; marking that one non-destructive would let an agent send a writ
 * to a counterparty without asking anybody.
 *
 * `openWorldHint` follows the same logic: every tool that reaches Doctavian is
 * open-world, and the one that renders the template locally is not.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { DoctavianClient } from "../adapters/doctavian/client";
import { DoctavianApiError, DoctavianKeyScopeError } from "../adapters/doctavian/errors";
import type {
  CreateEnvelopeInput,
  DoctavianBinary,
  EnvelopeFieldType,
  OutputFileFormat,
  TemplateFileFormat,
} from "../adapters/doctavian/types";
import { buildWritTemplateDocx } from "../adapters/doctavian/writ-template";

export const DOCTAVIAN_MCP_SERVER_NAME = "chancery-doctavian";
export const DOCTAVIAN_MCP_SERVER_VERSION = "0.1.0";

export interface DoctavianMcpDeps {
  client: DoctavianClient;
}

/* ------------------------------------------------------- annotations */

/** Reads Doctavian and changes nothing. Safe to retry, safe to call twice. */
function readOnly(title: string): ToolAnnotations {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
}

/**
 * Creates something new in the tenant. Not destructive — nothing existing is
 * overwritten or removed — but not idempotent either: calling it twice leaves
 * two objects behind, and for `generate` it also bills twice.
 */
function additive(title: string): ToolAnnotations {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };
}

/**
 * Renders in-process: no tenant, no network, nothing to undo. Read-only like
 * the list tools, but closed-world — it reaches nothing outside this process.
 */
function localRead(title: string): ToolAnnotations {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

export function createDoctavianMcpServer(deps: DoctavianMcpDeps): McpServer {
  const { client } = deps;
  const server = new McpServer(
    { name: DOCTAVIAN_MCP_SERVER_NAME, version: DOCTAVIAN_MCP_SERVER_VERSION },
    {
      capabilities: { tools: {}, logging: {} },
      instructions:
        "Generate and sign documents through Doctavian. The generation flow is: create a datasource, create a solution against it, upload a .docx template, upload the data JSON, generate, download. doctavian_run_generation_flow does all six in order. Templates branch, loop and calculate, so shape the data to the template rather than pre-rendering text. Sending a signature envelope is irreversible.",
    },
  );

  /* ------------------------------------------------------ generation */

  server.registerTool(
    "doctavian_list_templates",
    {
      description: "List the .docx/.xlsx/.pptx templates uploaded to the tenant.",
      inputSchema: {},
      annotations: readOnly("List templates"),
    },
    async () => run(() => client.listTemplates()),
  );

  server.registerTool(
    "doctavian_list_documents",
    {
      description: "List documents already generated in the tenant.",
      inputSchema: {},
      annotations: readOnly("List generated documents"),
    },
    async () => run(() => client.listDocuments()),
  );

  server.registerTool(
    "doctavian_create_datasource",
    {
      description:
        "Step 1 of the generation flow. Creates a Storage-backed datasource and returns its guid.",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().optional(),
      },
      annotations: additive("Create datasource"),
    },
    async ({ name, description }) =>
      run(() => client.createDataSource({ name, description })),
  );

  server.registerTool(
    "doctavian_create_solution",
    {
      description:
        "Step 2. Creates a document solution bound to a datasource guid and returns the solution guid.",
      inputSchema: {
        name: z.string().min(1),
        dataGuid: z.string().min(1),
        description: z.string().optional(),
      },
      annotations: additive("Create document solution"),
    },
    async ({ name, dataGuid, description }) =>
      run(() => client.createSolution({ name, dataGuid, description })),
  );

  server.registerTool(
    "doctavian_upload_template",
    {
      description:
        "Step 3. Uploads a base64-encoded Office template as-is, tags and all. Returns the template id used as the template urn when generating.",
      inputSchema: {
        fileName: z.string().min(1),
        fileBase64: z.string().min(1),
        documentSolutionGuid: z.string().optional(),
      },
      annotations: additive("Upload template"),
    },
    async ({ fileName, fileBase64, documentSolutionGuid }) =>
      run(() =>
        client.uploadTemplate(
          { fileName, bytes: fromBase64(fileBase64) },
          { documentSolutionGuid },
        ),
      ),
  );

  server.registerTool(
    "doctavian_upload_data",
    {
      description:
        "Step 4. Uploads the JSON the template merges against. Every value is treated as a string by Doctavian, so numeric work must happen in the template via toDecimal().",
      inputSchema: {
        data: z.record(z.string(), z.unknown()),
        fileName: z.string().optional(),
        dataSourceGuid: z.string().optional(),
      },
      annotations: additive("Upload template data"),
    },
    async ({ data, fileName, dataSourceGuid }) =>
      run(() => client.uploadData(data, { fileName, dataSourceGuid })),
  );

  server.registerTool(
    "doctavian_generate_document",
    {
      description:
        "Step 5, synchronous. Renders the template against the data and returns the document urn plus the consumption record. Each call bills one documents-generated unit.",
      inputSchema: {
        templateName: z.string().min(1),
        templateUrn: z.string().min(1),
        templateFileFormat: z.enum(["docx", "xlsx", "pptx"]).default("docx"),
        dataUrn: z.string().min(1),
        documentName: z.string().min(1),
        outputFileFormat: z.enum(["pdf", "docx", "xlsx", "csv", "pptx"]).default("pdf"),
        path: z.string().default("root"),
        locale: z.string().default("en"),
        timezone: z.string().default("Europe/Dublin"),
      },
      annotations: additive("Generate document"),
    },
    async (args) =>
      run(() =>
        client.generateDocument({
          template: {
            name: args.templateName,
            urn: args.templateUrn,
            fileFormat: args.templateFileFormat as TemplateFileFormat,
            loadMethod: "Storage",
          },
          data: { urn: args.dataUrn, loadMethod: "Storage" },
          document: {
            name: args.documentName,
            fileFormat: args.outputFileFormat as OutputFileFormat,
            deliveryMethod: "Storage",
            path: args.path,
            locale: args.locale,
            timezone: args.timezone,
          },
        }),
      ),
  );

  server.registerTool(
    "doctavian_download_document",
    {
      description:
        "Step 6. Downloads a generated document by urn. The response is raw file bytes, returned here as base64.",
      inputSchema: { urn: z.string().min(1) },
      annotations: readOnly("Download generated document"),
    },
    async ({ urn }) => run(async () => describeBinary(await client.downloadDocument(urn))),
  );

  server.registerTool(
    "doctavian_run_generation_flow",
    {
      description:
        "All six generation calls in order, from a base64 template and a data object, returning every intermediate id plus the rendered document as base64.",
      inputSchema: {
        name: z.string().min(1),
        templateFileName: z.string().min(1),
        templateBase64: z.string().min(1),
        data: z.record(z.string(), z.unknown()),
        outputFileFormat: z.enum(["pdf", "docx", "xlsx", "csv", "pptx"]).default("pdf"),
        locale: z.string().default("en"),
        timezone: z.string().default("Europe/Dublin"),
      },
      annotations: additive("Run the full generation flow"),
    },
    async (args) =>
      run(async () => {
        const result = await client.runGenerationFlow({
          name: args.name,
          template: {
            fileName: args.templateFileName,
            bytes: fromBase64(args.templateBase64),
          },
          data: args.data,
          document: {
            fileFormat: args.outputFileFormat as OutputFileFormat,
            locale: args.locale,
            timezone: args.timezone,
          },
        });
        return {
          ...result,
          document: result.document ? describeBinary(result.document) : null,
        };
      }),
  );

  server.registerTool(
    "doctavian_build_writ_template",
    {
      description:
        "Render Chancery's writ template to a .docx, returned as base64. The template branches on jurisdiction and on unset limits, loops over granted act classes, and computes the aggregate ceiling, escalation threshold and expiry date. Feed the result straight to doctavian_upload_template.",
      inputSchema: {},
      annotations: localRead("Build the writ .docx template"),
    },
    async () =>
      run(async () => {
        const bytes = await buildWritTemplateDocx();
        return {
          fileName: "writ-template.docx",
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          byteLength: bytes.length,
          base64: toBase64(bytes),
        };
      }),
  );

  server.registerTool(
    "doctavian_generate_writ",
    {
      description:
        "Build the writ template, then run the whole generation flow against the supplied writ data in one call. Returns the signed-ready PDF as base64.",
      inputSchema: {
        name: z.string().min(1),
        writData: z.record(z.string(), z.unknown()),
        locale: z.string().default("en"),
        timezone: z.string().default("Europe/Dublin"),
      },
      annotations: additive("Generate a writ document"),
    },
    async ({ name, writData, locale, timezone }) =>
      run(async () => {
        const result = await client.runGenerationFlow({
          name,
          template: {
            fileName: "writ-template.docx",
            bytes: await buildWritTemplateDocx(),
          },
          data: writData,
          document: { fileFormat: "pdf", locale, timezone },
        });
        return {
          ...result,
          document: result.document ? describeBinary(result.document) : null,
        };
      }),
  );

  /* ------------------------------------------------------ signatures */

  server.registerTool(
    "doctavian_upload_signature_document",
    {
      description:
        "Uploads a PDF to the signatures area and returns its id, for use as an envelope document. Note this area takes a different api key from the documents area.",
      inputSchema: {
        fileName: z.string().min(1),
        fileBase64: z.string().min(1),
      },
      annotations: additive("Upload document for signature"),
    },
    async ({ fileName, fileBase64 }) =>
      run(() =>
        client.uploadSignatureDocument({
          fileName,
          bytes: fromBase64(fileBase64),
        }),
      ),
  );

  server.registerTool(
    "doctavian_create_envelope",
    {
      description:
        "Creates a signature envelope. Documents, signers, fields and settings go up together; fields bind to a document and a signer through referenceDocumentId and referenceSignerId. Creating does not send.",
      inputSchema: {
        envelopeName: z.string().min(1),
        message: z.string().optional(),
        signingOrder: z.enum(["sequential", "parallel"]).default("parallel"),
        expiresInDays: z.number().int().positive().optional(),
        documents: z
          .array(
            z.object({
              referenceDocumentId: z.string().min(1),
              id: z.string().min(1),
              name: z.string().min(1),
            }),
          )
          .min(1),
        signers: z
          .array(
            z.object({
              referenceSignerId: z.string().min(1),
              name: z.string().min(1),
              email: z.string().email(),
              order: z.number().int().optional(),
            }),
          )
          .min(1),
        fields: z
          .array(
            z.object({
              referenceDocumentId: z.string().min(1),
              referenceSignerId: z.string().min(1),
              type: z.enum([
                "signature",
                "digitalsignature",
                "initials",
                "date",
                "text",
                "checkbox",
              ]),
              page: z.number().int().positive(),
              x: z.number(),
              y: z.number(),
              width: z.number().optional(),
              height: z.number().optional(),
              required: z.boolean().optional(),
            }),
          )
          .min(1),
      },
      annotations: additive("Create signature envelope"),
    },
    async (args) =>
      run(() => {
        const input: CreateEnvelopeInput = {
          documents: args.documents,
          signers: args.signers,
          fields: args.fields.map((f) => ({
            ...f,
            type: f.type as EnvelopeFieldType,
          })),
          envelope: {
            name: args.envelopeName,
            message: args.message,
            signingOrder: args.signingOrder,
            expiresInDays: args.expiresInDays,
          },
        };
        return client.createEnvelope(input);
      }),
  );

  server.registerTool(
    "doctavian_send_envelope",
    {
      description:
        "Sends an envelope to its recipients. IRREVERSIBLE: it emails named counterparties and cannot be unsent. Confirm the envelope contents before calling.",
      inputSchema: { envelopeId: z.string().min(1) },
      annotations: {
        title: "Send signature envelope",
        readOnlyHint: false,
        // The one true destructive tool here: the mail leaves the building.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ envelopeId }) => run(() => client.sendEnvelope(envelopeId)),
  );

  server.registerTool(
    "doctavian_get_envelope_audit",
    {
      description:
        "Reads the eIDAS audit trail for an envelope: status and the ordered events behind it.",
      inputSchema: { envelopeId: z.string().min(1) },
      annotations: readOnly("Get envelope audit trail"),
    },
    async ({ envelopeId }) => run(() => client.getEnvelopeAudit(envelopeId)),
  );

  server.registerTool(
    "doctavian_download_envelope_audit",
    {
      description:
        "Downloads the envelope audit trail as a file. Raw bytes, returned here as base64.",
      inputSchema: { envelopeId: z.string().min(1) },
      annotations: readOnly("Download envelope audit trail"),
    },
    async ({ envelopeId }) =>
      run(async () => describeBinary(await client.downloadEnvelopeAudit(envelopeId))),
  );

  return server;
}

/* ------------------------------------------------------- transport */

export interface DoctavianMcpTransportOptions {
  /**
   * Streamable HTTP can answer a POST with a single JSON body instead of an SSE
   * stream. Every tool here is a single request/response, so streaming buys
   * nothing and costs a connection.
   */
  enableJsonResponse?: boolean;
  /** Provide to run stateful; omitted means stateless, one server per request. */
  sessionIdGenerator?: () => string;
}

export function createDoctavianMcpTransport(
  options: DoctavianMcpTransportOptions = {},
): WebStandardStreamableHTTPServerTransport {
  return new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: options.sessionIdGenerator,
    enableJsonResponse: options.enableJsonResponse ?? true,
  });
}

/**
 * A stateless Streamable HTTP handler: one server and one transport per
 * request, so nothing is retained between calls and the route can be deployed
 * to anything that speaks web-standard `Request`/`Response`.
 */
export function createDoctavianMcpHandler(
  deps: DoctavianMcpDeps,
  options: DoctavianMcpTransportOptions = {},
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const server = createDoctavianMcpServer(deps);
    const transport = createDoctavianMcpTransport(options);
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}

/* --------------------------------------------------------- helpers */

/**
 * Doctavian failures come back as tool results rather than protocol errors: a
 * 401 from a mis-scoped api key is something the calling model can read and act
 * on, whereas a transport-level error just looks like the server broke.
 */
async function run(work: () => Promise<unknown> | unknown): Promise<CallToolResult> {
  try {
    return asText(await work());
  } catch (error) {
    if (error instanceof DoctavianApiError) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "doctavian_api_error",
                status: error.status,
                statusText: error.statusText,
                method: error.method,
                path: error.path,
                area: error.area,
                apiKeyScopeFailure: error.isApiKeyScopeFailure,
                body: error.body,
              },
              null,
              2,
            ),
          },
        ],
      };
    }
    if (error instanceof DoctavianKeyScopeError) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "doctavian_key_scope_error", area: error.area, path: error.path },
              null,
              2,
            ),
          },
        ],
      };
    }
    return {
      isError: true,
      content: [{ type: "text", text: String(error) }],
    };
  }
}

function asText(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/** Binary responses cross MCP as base64 plus the headers that describe them. */
function describeBinary(binary: DoctavianBinary): {
  fileName: string | null;
  contentType: string | null;
  byteLength: number;
  base64: string;
} {
  return {
    fileName: binary.fileName,
    contentType: binary.contentType,
    byteLength: binary.bytes.length,
    base64: toBase64(binary.bytes),
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

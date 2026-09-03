/**
 * Typed HTTP client for Doctavian.
 *
 * Doctavian publishes an OpenAPI spec and no SDK, so this is the whole
 * integration surface: the six-call generation flow, the signatures flow, and
 * the two things that make Doctavian easy to get wrong —
 *
 *   1. Auth is TWO headers. `Authorization: Bearer <token>` *and* `x-api-key`,
 *      and the api key is scoped per API area. Sending the documents key to a
 *      signatures path returns `401 ApiKeyInvalid`, which reads like an expired
 *      token and sends you debugging OAuth for an hour. The area is therefore a
 *      type parameter tied to the path prefix (see `DoctavianPath`) and is
 *      re-checked at runtime, so a key can never cross an area boundary.
 *   2. The document download endpoint answers with raw file bytes, not JSON.
 *      Calling `.json()` on it yields a parse error that looks like a server
 *      fault, so binary responses have their own code path that never parses.
 *
 * Every request goes through the injected `fetchImpl`, which is what lets the
 * whole flow be exercised from fixtures with no credentials and no network.
 */

import { DOCTAVIAN_DEMO_BASE_URL, refreshAccessToken } from "./auth";
import {
  DoctavianApiError,
  DoctavianKeyScopeError,
  DoctavianResponseError,
} from "./errors";
import { STORAGE_TYPE } from "./types";
import type {
  ConsumptionEntry,
  CreateDataSourceInput,
  CreateDataSourceResult,
  CreateEnvelopeInput,
  CreateEnvelopeResult,
  CreateSolutionInput,
  CreateSolutionResult,
  DoctavianArea,
  DoctavianBinary,
  DoctavianClientConfig,
  DoctavianFile,
  DoctavianPath,
  DoctavianRefreshConfig,
  EnvelopeAudit,
  GenerateDocumentInput,
  GenerateDocumentResult,
  FetchLike,
  OutputFileFormat,
  SendEnvelopeResult,
  StorageType,
  TemplateFileFormat,
  TemplateSummary,
  UploadResult,
} from "./types";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Path prefixes the two api keys are valid for, and nothing else. */
const AREA_PREFIX: Record<DoctavianArea, string> = {
  documents: "/v1/documents/",
  signatures: "/v1/signatures/",
};

/**
 * The area a path belongs to, derived from the path itself rather than from
 * whatever the caller claimed. Exported because the MCP layer routes
 * caller-supplied paths and needs the same answer.
 */
export function areaForPath(path: string): DoctavianArea {
  for (const area of Object.keys(AREA_PREFIX) as DoctavianArea[]) {
    if (path.startsWith(AREA_PREFIX[area])) return area;
  }
  throw new DoctavianResponseError(`unrecognised Doctavian path: ${path}`, path);
}

export interface RunGenerationFlowInput {
  /** Names the datasource and the solution, so one run is one named artefact. */
  name: string;
  description?: string;
  template: DoctavianFile;
  templateFileFormat?: TemplateFileFormat;
  /** The template's data payload; serialized and uploaded as a JSON file. */
  data: unknown;
  document?: {
    name?: string;
    fileFormat?: OutputFileFormat;
    path?: string;
    locale?: string;
    timezone?: string;
  };
  /** Skip the final download when only the urn is wanted. */
  download?: boolean;
}

export interface RunGenerationFlowResult {
  dataSourceGuid: string;
  documentSolutionGuid: string;
  templateId: string;
  dataId: string;
  documentUrn: string;
  consumption: ConsumptionEntry[];
  /** Present unless `download` was false. */
  document: DoctavianBinary | null;
}

/**
 * The demo tenant is a separate host, so the base URL is configuration rather
 * than a constant. Reading the env here keeps every call site from having to.
 */
export function defaultDoctavianBaseUrl(): string {
  const fromEnv =
    typeof process !== "undefined" ? process.env?.DOCTAVIAN_BASE_URL : undefined;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DOCTAVIAN_DEMO_BASE_URL;
}

export class DoctavianClient {
  private readonly baseUrl: string;
  private readonly bearerToken: string | (() => string | Promise<string>);
  private readonly apiKeys: Record<DoctavianArea, string>;
  private readonly fetchImpl: FetchLike;
  private readonly refreshConfig?: DoctavianRefreshConfig;
  /** Set once a refresh has happened; overrides the configured bearer. */
  private currentToken: string | null = null;
  private currentRefreshToken: string | null = null;
  private tokenExpiresAt: number | null = null;
  /** Concurrent calls share one refresh rather than racing to spend the token. */
  private refreshInFlight: Promise<void> | null = null;

  constructor(config: DoctavianClientConfig) {
    this.baseUrl = (config.baseUrl ?? defaultDoctavianBaseUrl()).replace(/\/+$/, "");
    this.bearerToken = config.bearerToken;
    this.apiKeys = {
      documents: config.documentsApiKey,
      signatures: config.signaturesApiKey,
    };
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.refreshConfig = config.refresh;
    this.currentRefreshToken = config.refresh?.refreshToken ?? null;
  }

  /**
   * Mints a fresh access token now. Callers rarely need this — a 401 refreshes
   * and retries on its own — but a long batch is cheaper to start with a known
   * good token than to discover the problem three calls in.
   */
  async refreshToken(): Promise<void> {
    if (!this.refreshConfig || !this.currentRefreshToken) {
      throw new DoctavianResponseError(
        "no refresh token configured; construct the client with `refresh`",
        null,
      );
    }
    // One refresh at a time: the refresh token is single-use on Entra, so two
    // parallel refreshes would invalidate each other.
    this.refreshInFlight ??= this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<void> {
    const config = this.refreshConfig;
    if (!config || !this.currentRefreshToken) return;
    const tokens = await refreshAccessToken({
      refreshToken: this.currentRefreshToken,
      baseUrl: this.baseUrl,
      tokenUrl: config.tokenUrl,
      clientId: config.clientId,
      scope: config.scope,
      fetchImpl: this.fetchImpl,
    });
    this.currentToken = tokens.accessToken;
    this.currentRefreshToken = tokens.refreshToken;
    this.tokenExpiresAt = tokens.expiresAt;
    await config.onRefresh?.(tokens);
  }

  /* ------------------------------------------------- generation flow */

  /** Step 1 of 6. `loadMethod: "Storage"` is the only mode we use. */
  async createDataSource(
    input: CreateDataSourceInput,
  ): Promise<CreateDataSourceResult> {
    const body = await this.postJson("documents", "/v1/documents/datasource/create", {
      name: input.name,
      description: input.description ?? input.name,
      loadMethod: input.loadMethod ?? "Storage",
    });
    return {
      dataSourceGuid: requireId(body, ["dataSourceGuid", "dataGuid", "guid", "id"]),
    };
  }

  /** Step 2 of 6. `dataGuid` is the datasource guid from step 1. */
  async createSolution(input: CreateSolutionInput): Promise<CreateSolutionResult> {
    const body = await this.postJson("documents", "/v1/documents/solution/create", {
      name: input.name,
      description: input.description ?? input.name,
      dataGuid: input.dataGuid,
    });
    return {
      documentSolutionGuid: requireId(body, [
        "documentSolutionGuid",
        "solutionGuid",
        "guid",
        "id",
      ]),
    };
  }

  /** Step 3 of 6. The .docx goes up as-is, merge tags and all. */
  async uploadTemplate(
    file: DoctavianFile,
    options: { documentSolutionGuid?: string } = {},
  ): Promise<UploadResult> {
    const extra: Record<string, string> = {};
    if (options.documentSolutionGuid) {
      extra.documentSolutionGuid = options.documentSolutionGuid;
    }
    const body = await this.postMultipart(
      "documents",
      "/v1/documents/template/upload",
      { ...file, contentType: file.contentType ?? DOCX_MIME },
      extra,
      STORAGE_TYPE.template,
    );
    return readUploadResult(body);
  }

  /** Step 4 of 6. Same multipart shape as the template upload. */
  async uploadData(
    data: unknown,
    options: { fileName?: string; dataSourceGuid?: string } = {},
  ): Promise<UploadResult> {
    const extra: Record<string, string> = {};
    if (options.dataSourceGuid) extra.dataSourceGuid = options.dataSourceGuid;
    const file: DoctavianFile = {
      fileName: options.fileName ?? "data.json",
      contentType: "application/json",
      bytes:
        data instanceof Uint8Array
          ? data
          : new TextEncoder().encode(JSON.stringify(wrapDataRoot(data))),
    };
    const body = await this.postMultipart(
      "documents",
      "/v1/documents/data/upload",
      file,
      extra,
      STORAGE_TYPE.data,
    );
    return readUploadResult(body);
  }

  /**
   * Step 5 of 6, synchronous variant.
   *
   * The async variant additionally requires an `x-client-authorization` header
   * built from an RS256 JWT encrypted with AES-128-CBC and base64'd. It buys
   * nothing for a document that renders in seconds, so it is deliberately not
   * implemented here.
   */
  async generateDocument(
    input: GenerateDocumentInput,
  ): Promise<GenerateDocumentResult> {
    const raw = await this.request<unknown>({
      area: "documents",
      method: "POST",
      path: "/v1/documents/document/generate",
      json: input,
    });
    const data = unwrapData(raw);
    const document = readObject(data, "document");
    const urn = readString(document ?? data, "urn");
    if (!urn) {
      throw new DoctavianResponseError(
        "generate succeeded but no document urn came back",
        raw,
      );
    }
    return { urn, consumption: readConsumption(raw) };
  }

  /**
   * Step 6 of 6 — the response is the file itself, so nothing here parses JSON.
   *
   * GET, verified live and in the spec. `X-Storage-Type` must name the
   * container the file was written to; a generated document delivered to
   * Storage lands in `document-data`, and an unrecognised value comes back as a
   * generic `FILE_DOWNLOAD_FAILED` rather than as anything that names the
   * header.
   */
  async downloadDocument(
    urn: string,
    options: { method?: "GET" | "POST"; storageType?: StorageType } = {},
  ): Promise<DoctavianBinary> {
    return this.requestBinary({
      area: "documents",
      method: options.method ?? "GET",
      path: `/v1/documents/document/${encodeURIComponent(urn)}/download`,
      storageType: options.storageType ?? STORAGE_TYPE.data,
    });
  }

  async listTemplates(): Promise<TemplateSummary[]> {
    const raw = await this.request<unknown>({
      area: "documents",
      method: "GET",
      path: "/v1/documents/template/list",
    });
    return readList(raw, "documentTemplates").map((entry) => ({
      id: readString(entry, "id") ?? readString(entry, "urn") ?? "",
      name: readString(entry, "name") ?? "",
      fileFormat: readString(entry, "fileFormat") ?? undefined,
      documentSolutionGuid:
        readString(entry, "documentSolutionGuid") ?? undefined,
    }));
  }

  async listDocuments(): Promise<TemplateSummary[]> {
    const raw = await this.request<unknown>({
      area: "documents",
      method: "GET",
      path: "/v1/documents/document/list",
    });
    return readList(raw, "documents").map((entry) => ({
      id: readString(entry, "urn") ?? readString(entry, "id") ?? "",
      name: readString(entry, "name") ?? "",
      fileFormat: readString(entry, "fileFormat") ?? undefined,
    }));
  }

  /**
   * The whole six-call flow, in order, as one call. Each step feeds the next —
   * the datasource guid into the solution, the two upload ids into the generate
   * body — so running them separately only invites getting the wiring wrong.
   */
  async runGenerationFlow(
    input: RunGenerationFlowInput,
  ): Promise<RunGenerationFlowResult> {
    const { dataSourceGuid } = await this.createDataSource({
      name: input.name,
      description: input.description,
    });
    const { documentSolutionGuid } = await this.createSolution({
      name: input.name,
      description: input.description,
      dataGuid: dataSourceGuid,
    });
    const template = await this.uploadTemplate(input.template, {
      documentSolutionGuid,
    });
    const data = await this.uploadData(input.data, { dataSourceGuid });

    const generated = await this.generateDocument({
      template: {
        name: input.template.fileName,
        urn: template.id,
        fileFormat: input.templateFileFormat ?? "docx",
        loadMethod: "Storage",
      },
      data: { urn: data.id, loadMethod: "Storage" },
      document: {
        name: input.document?.name ?? input.name,
        fileFormat: input.document?.fileFormat ?? "pdf",
        deliveryMethod: "Storage",
        path: input.document?.path ?? "root",
        locale: input.document?.locale ?? "en",
        timezone: input.document?.timezone ?? "Europe/Dublin",
      },
    });

    const download =
      input.download === false ? null : await this.downloadDocument(generated.urn);

    return {
      dataSourceGuid,
      documentSolutionGuid,
      templateId: template.id,
      dataId: data.id,
      documentUrn: generated.urn,
      consumption: generated.consumption,
      document: download,
    };
  }

  /* ----------------------------------------------------- signatures */

  /**
   * Signatures calls carry the signatures key. Nothing in this section can
   * reach for the documents key: the path type forbids it and `assertArea`
   * re-checks it.
   */
  async uploadSignatureDocument(file: DoctavianFile): Promise<UploadResult> {
    const body = await this.postMultipart(
      "signatures",
      "/v1/signatures/document/upload",
      { ...file, contentType: file.contentType ?? "application/pdf" },
      {},
      STORAGE_TYPE.signatureDocument,
    );
    return readUploadResult(body);
  }

  /** Documents, signers, fields and settings are one body, wired by reference ids. */
  async createEnvelope(input: CreateEnvelopeInput): Promise<CreateEnvelopeResult> {
    const body = await this.postJson(
      "signatures",
      "/v1/signatures/envelope/create",
      input,
    );
    return { envelopeId: requireId(body, ["envelopeId", "id", "guid"]) };
  }

  /**
   * The one irreversible call in this file: sending mails the recipients and
   * cannot be recalled. It is a GET only because that is what the API defines.
   */
  async sendEnvelope(envelopeId: string): Promise<SendEnvelopeResult> {
    const raw = await this.request<unknown>({
      area: "signatures",
      method: "GET",
      path: `/v1/signatures/envelope/${encodeURIComponent(envelopeId)}/send`,
    });
    const data = unwrapData(raw);
    return {
      envelopeId: readString(data, "envelopeId") ?? envelopeId,
      status: readString(data, "status") ?? "sent",
    };
  }

  async getEnvelopeAudit(envelopeId: string): Promise<EnvelopeAudit> {
    const raw = await this.request<unknown>({
      area: "signatures",
      method: "GET",
      path: `/v1/signatures/envelope/${encodeURIComponent(envelopeId)}/audit/get`,
    });
    const data = unwrapData(raw);
    return {
      envelopeId: readString(data, "envelopeId") ?? envelopeId,
      status: readString(data, "status") ?? "unknown",
      events: readList(data, "events").map((event) => ({
        timestamp: readString(event, "timestamp") ?? "",
        type: readString(event, "type") ?? "",
        actor: readString(event, "actor") ?? undefined,
        detail: readString(event, "detail") ?? undefined,
      })),
    };
  }

  /** The audit trail as a file — bytes again, not JSON. */
  async downloadEnvelopeAudit(envelopeId: string): Promise<DoctavianBinary> {
    return this.requestBinary({
      area: "signatures",
      method: "GET",
      path: `/v1/signatures/envelope/${encodeURIComponent(envelopeId)}/audit/download`,
    });
  }

  /* -------------------------------------------------------- transport */

  private postJson<A extends DoctavianArea>(
    area: A,
    path: DoctavianPath<A>,
    json: unknown,
  ): Promise<unknown> {
    return this.request<unknown>({ area, method: "POST", path, json });
  }

  private postMultipart<A extends DoctavianArea>(
    area: A,
    path: DoctavianPath<A>,
    file: DoctavianFile,
    fields: Record<string, string> = {},
    storageType?: StorageType,
  ): Promise<unknown> {
    const form = new FormData();
    // A fresh ArrayBuffer copy: a Blob over a view into a pooled Node buffer can
    // pick up neighbouring bytes.
    const copy = new Uint8Array(file.bytes.length);
    copy.set(file.bytes);
    form.append(
      "file",
      new Blob([copy], { type: file.contentType ?? "application/octet-stream" }),
      file.fileName,
    );
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return this.request<unknown>({ area, method: "POST", path, form, storageType });
  }

  private async request<T>(spec: {
    area: DoctavianArea;
    method: string;
    path: string;
    json?: unknown;
    form?: FormData;
    storageType?: StorageType;
  }): Promise<T> {
    const response = await this.sendWithRefresh(spec);
    const text = await response.text();
    const body = parseMaybeJson(text);
    if (!response.ok) throw this.toError(spec, response, body);
    return body as T;
  }

  private async requestBinary(spec: {
    area: DoctavianArea;
    method: string;
    path: string;
    storageType?: StorageType;
  }): Promise<DoctavianBinary> {
    const response = await this.sendWithRefresh(spec);
    if (!response.ok) {
      // Only the failure path is text: an error body is JSON even here.
      const body = parseMaybeJson(await response.text());
      throw this.toError(spec, response, body);
    }
    const buffer = await response.arrayBuffer();
    return {
      bytes: new Uint8Array(buffer),
      contentType: response.headers.get("content-type"),
      fileName: fileNameFromDisposition(
        response.headers.get("content-disposition"),
      ),
    };
  }

  /**
   * One retry, and only for 401.
   *
   * An expired access token and a mis-scoped api key both answer 401, and the
   * difference matters: refreshing fixes the first and can never fix the
   * second, so the retry happens once and the second answer is returned as-is.
   * `FormData` is re-sendable — it is a value, not a stream — so a multipart
   * upload survives the retry without being rebuilt.
   */
  private async sendWithRefresh(spec: {
    area: DoctavianArea;
    method: string;
    path: string;
    json?: unknown;
    form?: FormData;
    storageType?: StorageType;
  }): Promise<Response> {
    const response = await this.send(spec);
    if (response.status !== 401 || !this.canRefresh()) return response;
    await this.refreshToken();
    return this.send(spec);
  }

  private canRefresh(): boolean {
    return this.refreshConfig !== undefined && this.currentRefreshToken !== null;
  }

  private async send(spec: {
    area: DoctavianArea;
    method: string;
    path: string;
    json?: unknown;
    form?: FormData;
    storageType?: StorageType;
  }): Promise<Response> {
    assertPathInArea(spec.area, spec.path);
    const headers: Record<string, string> = {
      // The spec declares `X-Api-Key`; every worked example uses lowercase, and
      // HTTP header names are case-insensitive, so lowercase is the safe pick.
      "x-api-key": this.apiKeys[spec.area],
      authorization: `Bearer ${await this.resolveToken()}`,
      accept: "application/json",
    };
    // FormData must set its own content-type: the multipart boundary is
    // generated by fetch and a hand-written header would not match it.
    if (spec.json !== undefined) headers["content-type"] = "application/json";
    if (spec.storageType) headers["x-storage-type"] = spec.storageType;

    return this.fetchImpl(`${this.baseUrl}${spec.path}`, {
      method: spec.method,
      headers,
      body:
        spec.form ?? (spec.json === undefined ? undefined : JSON.stringify(spec.json)),
    });
  }

  private async resolveToken(): Promise<string> {
    // Refresh ahead of expiry rather than on it: Doctavian rejects tokens
    // within ~2 minutes of expiring, so "not expired yet" is not good enough.
    if (this.canRefresh() && this.tokenExpiresAt !== null) {
      const skew = this.refreshConfig?.skewMs ?? 120_000;
      if (Date.now() >= this.tokenExpiresAt - skew) await this.refreshToken();
    }
    if (this.currentToken) return this.currentToken;
    return typeof this.bearerToken === "function"
      ? this.bearerToken()
      : this.bearerToken;
  }

  private toError(
    spec: { area: DoctavianArea; method: string; path: string },
    response: Response,
    body: unknown,
  ): DoctavianApiError {
    return new DoctavianApiError({
      message: `Doctavian ${spec.method} ${spec.path} failed: ${response.status} ${response.statusText}`,
      status: response.status,
      statusText: response.statusText,
      body,
      area: spec.area,
      path: spec.path,
      method: spec.method,
    });
  }
}

/**
 * The runtime half of the api key scoping guarantee. The type system covers
 * literal paths; this covers the ones assembled at runtime, and it fails before
 * the key is ever put on the wire rather than after the server rejects it.
 */
export function assertPathInArea(area: DoctavianArea, path: string): void {
  if (!path.startsWith(AREA_PREFIX[area])) {
    throw new DoctavianKeyScopeError(area, path);
  }
}

function parseMaybeJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Successful payloads sit under `result.data`; flat bodies are accepted too. */
function unwrapData(raw: unknown): unknown {
  const result = readObject(raw, "result");
  if (result && result.data !== undefined && result.data !== null) return result.data;
  return raw;
}

/**
 * `consumption` is a sibling of `result`, not a child of `result.data`, so it
 * is read off the envelope before anything unwraps it.
 */
function readConsumption(raw: unknown): ConsumptionEntry[] {
  const entries = isRecord(raw) && Array.isArray(raw.consumption)
    ? (raw.consumption as unknown[])
    : readList(raw, "consumption");
  return entries.flatMap((entry) => {
    const dimension = readString(entry, "dimension");
    const value = readNumber(entry, "value");
    return dimension === null || value === null ? [] : [{ dimension, value }];
  });
}

/**
 * The uploaded JSON must sit under a root `data` object.
 *
 * Without it the *generate* call — two steps later — fails with
 * `TEMPLATE_READ_FAILED`, which names the wrong file entirely and sends you
 * hunting through a template that was never the problem. The upload itself
 * answers `201`, so nothing at the point of the mistake reports it. Confirmed
 * by Doctavian support; documented nowhere.
 *
 * A payload that already carries the wrapper is passed through, so a caller
 * holding a file in the on-the-wire shape is not double-wrapped.
 */
export function wrapDataRoot(data: unknown): unknown {
  if (isRecord(data) && Object.keys(data).length === 1 && "data" in data) return data;
  return { data };
}

/**
 * Both upload endpoints answer `201` with `result.data.files: [{ id, fileName }]`
 * — an array even for a single file, and the id is *not* on the data object
 * itself. Verified live; the spec's own examples do not show this shape.
 */
function readUploadResult(raw: unknown): UploadResult {
  const data = unwrapData(raw);
  if (isRecord(data) && Array.isArray(data.files) && data.files.length > 0) {
    const first = data.files[0];
    const id = readString(first, "id");
    if (id) return { id, fileName: readString(first, "fileName") ?? undefined };
  }
  return { id: requireId(raw, ["id", "urn", "guid"]) };
}

function requireId(raw: unknown, keys: string[]): string {
  const data = unwrapData(raw);
  for (const key of keys) {
    const direct = readString(data, key);
    if (direct) return direct;
  }
  // Doctavian nests the created object one level deeper on some creates
  // (`result.data.datasource.guid`), so look one level down before giving up.
  if (isRecord(data)) {
    for (const value of Object.values(data)) {
      for (const key of keys) {
        const nested = readString(value, key);
        if (nested) return nested;
      }
    }
  }
  throw new DoctavianResponseError(
    `response carried none of: ${keys.join(", ")}`,
    raw,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readObject(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function readString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const found = value[key];
  return typeof found === "string" && found.length > 0 ? found : null;
}

function readNumber(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const found = value[key];
  return typeof found === "number" ? found : null;
}

/**
 * List endpoints answer with either a bare array or an array nested under
 * `result.data` / a named key, so both are unwrapped here rather than at each
 * call site.
 */
function readList(raw: unknown, key?: string): unknown[] {
  const data = unwrapData(raw);
  if (key !== undefined && isRecord(data) && Array.isArray(data[key])) {
    return data[key] as unknown[];
  }
  if (Array.isArray(data)) return data;
  if (isRecord(data)) {
    for (const candidate of ["items", "list", "results", "data"]) {
      if (Array.isArray(data[candidate])) return data[candidate] as unknown[];
    }
  }
  return [];
}

function fileNameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8) return decodeURIComponent(utf8[1]);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1] : null;
}

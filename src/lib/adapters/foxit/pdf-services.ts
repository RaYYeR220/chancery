/**
 * Foxit PDF Services + Document Generation, on the fusion gateway.
 *
 * This is the client an agent is allowed to hold. Everything it can do is
 * reversible: uploading, rendering, converting and compressing produce new
 * artefacts and destroy nothing, so a wrong answer costs a retry rather than a
 * commitment. That is the whole reason it is a separate class from
 * `FoxitESignClient` rather than a section of one Foxit client — see
 * `agent-surface.ts` for why the split is load-bearing.
 *
 * Two details are worth stating up front.
 *
 * `createShareLink` is the only bridge between the two APIs. eSign has no
 * upload endpoint and cannot resolve a PDF Services `documentId`, so a
 * generated draft reaches an envelope as a URL or not at all. Note what that
 * means for the boundary: producing the bridge is reversible and stays on this
 * side of it. A share link mails nobody and binds nobody. Only the credential
 * on the other side can cross it.
 *
 * `guardPath` is the runtime half of that guarantee. The type system stops a
 * call site from naming an eSign route; the guard stops a caller-supplied
 * document id from traversing onto one. Ids are percent-encoded into a single
 * path segment and the assembled path is re-checked against the two prefixes
 * this client is permitted to address.
 *
 * Endpoint paths live in exported constants rather than inline strings because
 * we have no credentials yet: when the first live call corrects one, it is
 * corrected in one place and every test that asserts on a URL fails loudly.
 */

import { FoxitScopeError, FoxitError, FoxitTaskError } from "./errors";
import { FoxitHttp, segment } from "./http";
import type {
  DocGenRequest,
  DocGenResult,
  FetchLike,
  FoxitBinary,
  FoxitDocumentRef,
  FoxitFile,
  FoxitTask,
  PdfConversionSource,
  PdfConversionTarget,
  PdfServicesCredentials,
  ShareLink,
  TaskStatus,
} from "./types";

/**
 * Single host, US only. `eu1.fusion.foxit.com` resolves and then 404s every
 * path, so a regional base URL is a way to lose an afternoon, not a feature.
 */
export const FUSION_GATEWAY_BASE_URL = "https://na1.fusion.foxit.com";

export const PDF_SERVICES_PREFIX = "/pdf-services/api";
export const DOCUMENT_GENERATION_PREFIX = "/document-generation/api";

/** The prefixes this client may address, and the only ones `guardPath` allows. */
export const REVERSIBLE_PREFIXES: readonly string[] = [
  `${PDF_SERVICES_PREFIX}/`,
  `${DOCUMENT_GENERATION_PREFIX}/`,
];

/** Any appearance of this in an assembled path means something went very wrong. */
export const ESIGN_PATH_MARKER = "/esign/";

export const PDF_SERVICES_PATHS = {
  upload: `${PDF_SERVICES_PREFIX}/documents/upload`,
  task: (taskId: string) => `${PDF_SERVICES_PREFIX}/tasks/${segment(taskId)}`,
  download: (documentId: string) =>
    `${PDF_SERVICES_PREFIX}/documents/${segment(documentId)}/download`,
  shareLink: (documentId: string) =>
    `${PDF_SERVICES_PREFIX}/documents/${segment(documentId)}/create-share-link`,
  createPdfFrom: (source: PdfConversionSource) =>
    `${PDF_SERVICES_PREFIX}/documents/create/pdf-from-${source}`,
  convertPdfTo: (target: PdfConversionTarget) =>
    `${PDF_SERVICES_PREFIX}/documents/modify/pdf-to-${target}`,
  compress: `${PDF_SERVICES_PREFIX}/documents/modify/pdf-compress`,
  combine: `${PDF_SERVICES_PREFIX}/documents/modify/pdf-combine`,
  extract: `${PDF_SERVICES_PREFIX}/documents/modify/pdf-extract`,
  linearize: `${PDF_SERVICES_PREFIX}/documents/modify/pdf-linearize`,
  generateDocument: `${DOCUMENT_GENERATION_PREFIX}/GenerateDocumentBase64`,
} as const;

export interface FoxitPdfServicesOptions {
  /**
   * Branded `pdf-services`. An eSign secret does not typecheck here, which is
   * the point: this object is the one an agent gets to hold.
   */
  credentials: PdfServicesCredentials;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Injected so polling is driven by a clock the test owns, not by wall time. */
  sleep?: (ms: number) => Promise<void>;
}

export interface AwaitTaskOptions {
  /**
   * Sandbox allows 15 requests a minute across the whole account, so a tighter
   * poll spends the budget on asking rather than on working. Webhooks are the
   * right answer in production; this is the fallback.
   */
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ShareLinkOptions {
  expiresInSeconds?: number;
  password?: string;
}

export class FoxitPdfServicesClient {
  readonly baseUrl: string;

  private readonly http: FoxitHttp;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: FoxitPdfServicesOptions) {
    if (options.credentials.clientId.length === 0 || options.credentials.clientSecret.length === 0) {
      throw new FoxitError(
        "client_id and client_secret are both required",
        "INVALID_ARGUMENT",
      );
    }
    this.baseUrl = options.baseUrl ?? FUSION_GATEWAY_BASE_URL;
    this.http = new FoxitHttp({
      baseUrl: this.baseUrl,
      // Header auth, not OAuth2: the gateway has no token endpoint at all.
      headers: {
        client_id: options.credentials.clientId,
        client_secret: options.credentials.clientSecret,
      },
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      guardPath: assertReversiblePath,
    });
    this.sleep = options.sleep ?? defaultSleep;
  }

  /* -------------------------------------------------------------- documents */

  /** Multipart, because the gateway's upload is the one endpoint that is not JSON. */
  async upload(file: FoxitFile, signal?: AbortSignal): Promise<FoxitDocumentRef> {
    const form = new FormData();
    // A fresh copy: a Blob over a view into a pooled Node buffer can pick up
    // neighbouring bytes.
    const copy = new Uint8Array(file.bytes.length);
    copy.set(file.bytes);
    form.append(
      "file",
      new Blob([copy], { type: file.contentType ?? "application/pdf" }),
      file.fileName,
    );

    const body = await this.http.json<unknown>({
      method: "POST",
      path: PDF_SERVICES_PATHS.upload,
      form,
      signal,
    });
    return { documentId: requireDocumentId(body) };
  }

  download(documentId: string, signal?: AbortSignal): Promise<FoxitBinary> {
    return this.http.binary({
      method: "GET",
      path: PDF_SERVICES_PATHS.download(documentId),
      signal,
    });
  }

  /**
   * The bridge to eSign, and the last reversible step in the whole flow.
   *
   * eSign accepts `fileUrls`, `base64FileString` or multipart, and nothing
   * else; a PDF Services `documentId` means nothing to it. Handing the backend
   * a URL rather than a megabyte of base64 also keeps the approval artefact
   * something a human can open and read before deciding.
   */
  async createShareLink(
    documentId: string,
    options: ShareLinkOptions = {},
    signal?: AbortSignal,
  ): Promise<ShareLink> {
    const body = await this.http.json<unknown>({
      method: "POST",
      path: PDF_SERVICES_PATHS.shareLink(documentId),
      json: {
        documentId,
        expiresIn: options.expiresInSeconds,
        password: options.password,
      },
      signal,
    });
    const url = readString(body, "url") ?? readString(body, "shareUrl") ?? readString(body, "link");
    if (url === null) {
      throw new FoxitError(
        "create-share-link succeeded but returned no url",
        "MALFORMED_RESPONSE",
        { path: PDF_SERVICES_PATHS.shareLink(documentId), body },
      );
    }
    return {
      documentId,
      url,
      expiresAt: readString(body, "expiresAt") ?? readString(body, "expireTime"),
    };
  }

  /* ----------------------------------------------------------- generation */

  /**
   * DocGen renders a template against values and hands the file straight back
   * as base64 — there is no task and no document id, because nothing was
   * stored. Upload the result if it needs one.
   */
  async generateDocument(
    request: DocGenRequest,
    signal?: AbortSignal,
  ): Promise<DocGenResult> {
    const body = await this.http.json<unknown>({
      method: "POST",
      path: PDF_SERVICES_PATHS.generateDocument,
      json: request,
      signal,
    });
    const base64 =
      readString(body, "base64FileString") ??
      readString(readObject(body, "data"), "base64FileString");
    if (base64 === null) {
      throw new FoxitError(
        "document generation returned no base64FileString",
        "MALFORMED_RESPONSE",
        { path: PDF_SERVICES_PATHS.generateDocument, body },
      );
    }
    return { base64FileString: base64, bytes: base64ToBytes(base64) };
  }

  /* ---------------------------------------------------------- conversion */

  createPdfFrom(
    source: PdfConversionSource,
    documentId: string,
    extra: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<FoxitTask> {
    return this.startTask(PDF_SERVICES_PATHS.createPdfFrom(source), { documentId, ...extra }, signal);
  }

  convertPdfTo(
    target: PdfConversionTarget,
    documentId: string,
    extra: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<FoxitTask> {
    return this.startTask(PDF_SERVICES_PATHS.convertPdfTo(target), { documentId, ...extra }, signal);
  }

  compress(
    documentId: string,
    compressionLevel: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM",
    signal?: AbortSignal,
  ): Promise<FoxitTask> {
    return this.startTask(PDF_SERVICES_PATHS.compress, { documentId, compressionLevel }, signal);
  }

  combine(documentIds: string[], signal?: AbortSignal): Promise<FoxitTask> {
    return this.startTask(PDF_SERVICES_PATHS.combine, { documentIds }, signal);
  }

  extract(
    documentId: string,
    extractType: "TEXT" | "IMAGE" | "PAGE" = "TEXT",
    signal?: AbortSignal,
  ): Promise<FoxitTask> {
    return this.startTask(PDF_SERVICES_PATHS.extract, { documentId, extractType }, signal);
  }

  linearize(documentId: string, signal?: AbortSignal): Promise<FoxitTask> {
    return this.startTask(PDF_SERVICES_PATHS.linearize, { documentId }, signal);
  }

  /* --------------------------------------------------------------- tasks */

  async getTask(taskId: string, signal?: AbortSignal): Promise<FoxitTask> {
    const body = await this.http.json<unknown>({
      method: "GET",
      path: PDF_SERVICES_PATHS.task(taskId),
      signal,
    });
    return readTask(body, taskId);
  }

  /**
   * Polls to a terminal state. FAILED throws rather than resolving with a task
   * whose `resultDocumentId` is null, because every caller of this would
   * otherwise have to remember to check, and the one that forgets uploads
   * `undefined` to eSign.
   */
  async awaitTask(taskId: string, options: AwaitTaskOptions = {}): Promise<FoxitTask> {
    const interval = options.pollIntervalMs ?? 4_000;
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);

    for (;;) {
      const task = await this.getTask(taskId, options.signal);
      if (task.status === "COMPLETED") return task;
      if (task.status === "FAILED") {
        throw new FoxitTaskError(
          `task ${taskId} failed${task.error ? `: ${task.error}` : ""}`,
          taskId,
          task.status,
        );
      }
      if (Date.now() >= deadline) {
        throw new FoxitTaskError(
          `task ${taskId} was still ${task.status} after ${options.timeoutMs ?? 120_000}ms`,
          taskId,
          task.status,
        );
      }
      await this.sleep(interval);
    }
  }

  /** Start an operation and wait it out, then hand back the produced document. */
  async runToDocument(
    start: Promise<FoxitTask>,
    options: AwaitTaskOptions = {},
  ): Promise<FoxitDocumentRef> {
    const started = await start;
    const finished =
      started.status === "COMPLETED" ? started : await this.awaitTask(started.taskId, options);
    if (finished.resultDocumentId === null) {
      throw new FoxitTaskError(
        `task ${finished.taskId} completed without a result document`,
        finished.taskId,
        finished.status,
      );
    }
    return { documentId: finished.resultDocumentId };
  }

  private async startTask(
    path: string,
    json: unknown,
    signal?: AbortSignal,
  ): Promise<FoxitTask> {
    const body = await this.http.json<unknown>({ method: "POST", path, json, signal });
    const taskId = readString(body, "taskId") ?? readString(readObject(body, "data"), "taskId");
    if (taskId === null) {
      throw new FoxitError(`${path} returned no taskId`, "MALFORMED_RESPONSE", { path, body });
    }
    return readTask(body, taskId);
  }
}

/**
 * Refuses any path outside PDF Services and Document Generation.
 *
 * Exported because it is the claim, not an implementation detail: an object
 * built on this guard cannot reach `/esign/` however its arguments are shaped.
 */
export function assertReversiblePath(path: string): void {
  if (path.includes(ESIGN_PATH_MARKER)) throw new FoxitScopeError(path);
  if (!REVERSIBLE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw new FoxitScopeError(path);
  }
}

const TASK_STATUSES: Record<string, TaskStatus> = {
  PENDING: "PENDING",
  QUEUED: "PENDING",
  PROCESSING: "PROCESSING",
  IN_PROGRESS: "PROCESSING",
  RUNNING: "PROCESSING",
  COMPLETED: "COMPLETED",
  SUCCESS: "COMPLETED",
  FAILED: "FAILED",
  ERROR: "FAILED",
};

function readTask(body: unknown, taskId: string): FoxitTask {
  const source = readObject(body, "data") ?? body;
  const raw = (readString(source, "status") ?? "PENDING").toUpperCase();
  return {
    taskId: readString(source, "taskId") ?? taskId,
    // An unrecognised status is treated as still running rather than as done:
    // the cost of one extra poll is a poll, the cost of a wrong COMPLETED is a
    // download of nothing.
    status: TASK_STATUSES[raw] ?? "PROCESSING",
    resultDocumentId:
      readString(source, "resultDocumentId") ??
      readString(source, "documentId") ??
      readString(readObject(source, "result"), "documentId"),
    progress: readNumber(source, "progress"),
    error: readString(source, "error") ?? readString(source, "errorMessage"),
  };
}

function requireDocumentId(body: unknown): string {
  const source = readObject(body, "data") ?? body;
  const id = readString(source, "documentId") ?? readString(source, "id");
  if (id === null) {
    throw new FoxitError("upload succeeded but returned no documentId", "MALFORMED_RESPONSE", {
      body,
    });
  }
  return id;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Kept off `Buffer` so the same helper works in the browser verifier page. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
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

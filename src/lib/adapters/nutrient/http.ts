/**
 * Shared transport for every Nutrient DWS call.
 *
 * We deliberately do not use `@nutrient-sdk/dws-client-typescript`. Our audit
 * story rests on the per-request cost headers, and it is unconfirmed that the
 * official client surfaces them. Routing every call through one `fetchImpl`
 * means those headers are read in exactly one place — including on failures,
 * where credits are still spent and the number still has to be logged.
 *
 * `fetchImpl` is injectable because there is no API key yet: the whole adapter
 * is exercised against a fake transport, and a caller can wrap it for retries
 * or request recording without this file knowing.
 */

import type { MatchKind } from "../../core/types";

export const NUTRIENT_BASE_URL = "https://api.nutrient.io";

/** Narrower than the DOM signature so a hand-written fake satisfies it. */
export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface NutrientClientConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchImpl;
  /** Sent on token-scoped calls that Nutrient origin-restricts. */
  origin?: string;
}

/**
 * The accounting record for a single HTTP call. Present on successes and on
 * errors alike, because a 4xx that consumed credits still has to be auditable.
 */
export interface RequestMeta {
  status: number;
  /** `x-pspdfkit-request-cost`. Null when the header was absent or unparseable. */
  requestCost: number | null;
  /** `x-pspdfkit-remaining-credits`. */
  remainingCredits: number | null;
  /** Nutrient's per-request correlation id, from the body envelope or a header. */
  requestId: string | null;
  /** Echoed back so a replayed build can be tied to the key that produced it. */
  idempotencyKey: string | null;
}

export interface NutrientResult<T> {
  data: T;
  meta: RequestMeta;
}

export const EMPTY_META: RequestMeta = {
  status: 0,
  requestCost: null,
  remainingCredits: null,
  requestId: null,
  idempotencyKey: null,
};

/* ------------------------------------------------------------------ errors */

export class NutrientError extends Error {
  constructor(
    message: string,
    readonly meta: RequestMeta,
  ) {
    super(message);
    this.name = "NutrientError";
  }
}

/**
 * The documented error envelope: `{"error":{details,requestId,status,supportUrl}}`.
 * Build validation adds `failingPaths[]` — JSONPath pointers into the exact
 * instruction that was rejected, which is far more useful to a reviewer than
 * the prose, so it is kept as structured data rather than folded into `message`.
 */
export class NutrientApiError extends NutrientError {
  readonly details: string;
  readonly supportUrl: string | null;
  /** Async-job failures use `reason` where synchronous ones use `details`. */
  readonly reason: string | null;
  readonly failingPaths: FailingPath[];
  readonly rawBody: unknown;

  constructor(init: {
    message: string;
    meta: RequestMeta;
    details: string;
    supportUrl?: string | null;
    reason?: string | null;
    failingPaths?: FailingPath[];
    rawBody?: unknown;
  }) {
    super(init.message, init.meta);
    this.name = "NutrientApiError";
    this.details = init.details;
    this.supportUrl = init.supportUrl ?? null;
    this.reason = init.reason ?? null;
    this.failingPaths = init.failingPaths ?? [];
    this.rawBody = init.rawBody;
  }
}

export interface FailingPath {
  /** JSONPath into the submitted instructions, e.g. `$.actions[1].strategy`. */
  path: string;
  details?: string;
}

/**
 * A `/build` replayed under an idempotency key that was minted from different
 * bytes. Because we derive the key from a hash of (inputs + instructions), the
 * only way to reach this is for the pipeline to have changed while claiming to
 * be the same one — so we surface it as its own type and treat it as a tamper
 * signal rather than as a retryable conflict.
 */
export class IdempotencyConflictError extends NutrientApiError {
  constructor(init: ConstructorParameters<typeof NutrientApiError>[0]) {
    super(init);
    this.name = "IdempotencyConflictError";
  }
}

/** 402: the credit pool is empty. Distinct because it is never worth retrying. */
export class CreditsExhaustedError extends NutrientApiError {
  constructor(init: ConstructorParameters<typeof NutrientApiError>[0]) {
    super(init);
    this.name = "CreditsExhaustedError";
  }
}

/* --------------------------------------------------------------- multipart */

export interface FileBlob {
  bytes: Uint8Array;
  filename?: string;
  contentType?: string;
}

/** Raw bytes are required, not a stream, because the idempotency key hashes them. */
export type FileInput = Uint8Array | FileBlob;

export function toFileBlob(input: FileInput): FileBlob {
  return input instanceof Uint8Array ? { bytes: input } : input;
}

/**
 * The view is copied out rather than handed to `Blob` directly. A Node `Buffer`
 * is a view into a shared allocation pool, so passing it through would upload
 * whatever else happens to live in that pool.
 */
export function appendFile(form: FormData, field: string, input: FileInput): void {
  const file = toFileBlob(input);
  const view = file.bytes;
  const bytes = view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  ) as ArrayBuffer;
  const blob = new Blob([bytes], { type: file.contentType ?? "application/octet-stream" });
  form.append(field, blob, file.filename ?? field);
}

/**
 * Nutrient reads JSON form fields by content type in some places (`/sign`'s
 * `data`), so JSON parts are always tagged rather than sent as bare text.
 */
export function appendJson(form: FormData, field: string, value: unknown): void {
  form.append(field, new Blob([JSON.stringify(value)], { type: "application/json" }), field);
}

/* ----------------------------------------------------------- canonical json */

/**
 * Key-sorted JSON, so that two structurally identical instruction objects hash
 * to the same idempotency key regardless of how the caller built them. Without
 * this, `{a,b}` and `{b,a}` would be two different pipelines to the server.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = canonicalize(source[key]);
  }
  return out;
}

/* ------------------------------------------------------------------ request */

export type ResponseKind = "json" | "binary" | "none";

export interface RequestSpec {
  method: "POST" | "GET" | "DELETE";
  path: string;
  body?: FormData | string;
  headers?: Record<string, string>;
  expect: ResponseKind;
  /** Set only by `/build`, so 409 can be mapped to the tamper signal. */
  idempotencyKey?: string;
}

export async function nutrientRequest<T>(
  config: NutrientClientConfig,
  spec: RequestSpec,
): Promise<NutrientResult<T>> {
  const fetchImpl = config.fetchImpl ?? (globalThis.fetch as FetchImpl | undefined);
  if (!fetchImpl) {
    throw new NutrientError("no fetch implementation available", EMPTY_META);
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${config.apiKey}`,
    ...(config.origin ? { origin: config.origin } : {}),
    ...spec.headers,
  };
  if (spec.idempotencyKey !== undefined) {
    assertIdempotencyKey(spec.idempotencyKey);
    headers["idempotency-key"] = spec.idempotencyKey;
  }
  if (typeof spec.body === "string") {
    headers["content-type"] = "application/json";
  }

  const url = `${config.baseUrl ?? NUTRIENT_BASE_URL}${spec.path}`;
  const response = await fetchImpl(url, {
    method: spec.method,
    headers,
    ...(spec.body === undefined ? {} : { body: spec.body }),
  });

  const meta = readMeta(response, spec.idempotencyKey ?? null);

  if (!response.ok) {
    throw await toApiError(response, meta, spec);
  }

  return { data: await readBody<T>(response, spec.expect), meta };
}

/** Documented limit; exceeding it turns a determinism feature into a 400. */
const IDEMPOTENCY_KEY_MAX_BYTES = 255;

export function assertIdempotencyKey(key: string): void {
  const size = new TextEncoder().encode(key).length;
  if (size === 0 || size > IDEMPOTENCY_KEY_MAX_BYTES) {
    throw new NutrientError(
      `Idempotency-Key must be 1..${IDEMPOTENCY_KEY_MAX_BYTES} bytes, got ${size}`,
      EMPTY_META,
    );
  }
}

function readMeta(response: Response, idempotencyKey: string | null): RequestMeta {
  return {
    status: response.status,
    requestCost: numericHeader(response, "x-pspdfkit-request-cost"),
    remainingCredits: numericHeader(response, "x-pspdfkit-remaining-credits"),
    requestId: response.headers.get("x-request-id"),
    idempotencyKey,
  };
}

function numericHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function readBody<T>(response: Response, expect: ResponseKind): Promise<T> {
  if (expect === "none") return undefined as T;
  if (expect === "binary") return new Uint8Array(await response.arrayBuffer()) as T;
  const text = await response.text();
  if (text.trim() === "") return undefined as T;
  return JSON.parse(text) as T;
}

async function toApiError(
  response: Response,
  meta: RequestMeta,
  spec: RequestSpec,
): Promise<NutrientApiError> {
  const raw = await safeText(response);
  const parsed = parseErrorEnvelope(raw);
  const init = {
    message: `Nutrient ${spec.method} ${spec.path} failed with ${response.status}: ${parsed.details}`,
    meta: { ...meta, requestId: parsed.requestId ?? meta.requestId },
    details: parsed.details,
    supportUrl: parsed.supportUrl,
    reason: parsed.reason,
    failingPaths: parsed.failingPaths,
    rawBody: parsed.rawBody,
  };

  if (response.status === 409 && spec.idempotencyKey !== undefined) {
    return new IdempotencyConflictError({
      ...init,
      message:
        `Idempotency-Key ${spec.idempotencyKey} was already used for a different ` +
        `payload — the pipeline changed under the same key. ${parsed.details}`,
    });
  }
  if (response.status === 402) return new CreditsExhaustedError(init);
  return new NutrientApiError(init);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

interface ParsedEnvelope {
  details: string;
  requestId: string | null;
  supportUrl: string | null;
  reason: string | null;
  failingPaths: FailingPath[];
  rawBody: unknown;
}

/**
 * Tolerant on purpose. Synchronous errors nest under `error`, async job
 * failures use `{reason, description}` at the top level, and an upstream proxy
 * can return HTML — none of which may cost us the cost headers we already read.
 */
export function parseErrorEnvelope(raw: string): ParsedEnvelope {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return {
      details: raw.slice(0, 500) || "no response body",
      requestId: null,
      supportUrl: null,
      reason: null,
      failingPaths: [],
      rawBody: raw,
    };
  }

  const root = asRecord(body) ?? {};
  const envelope = asRecord(root.error) ?? root;

  return {
    details:
      str(envelope.details) ??
      str(envelope.description) ??
      str(envelope.message) ??
      str(envelope.reason) ??
      "no error details",
    requestId: str(envelope.requestId) ?? str(root.requestId) ?? null,
    supportUrl: str(envelope.supportUrl) ?? null,
    reason: str(envelope.reason) ?? null,
    failingPaths: parseFailingPaths(envelope.failingPaths ?? root.failingPaths),
    rawBody: body,
  };
}

function parseFailingPaths(value: unknown): FailingPath[] {
  if (!Array.isArray(value)) return [];
  const out: FailingPath[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      out.push({ path: entry });
      continue;
    }
    const record = asRecord(entry);
    const path = record ? str(record.path) : undefined;
    if (path !== undefined) {
      out.push({ path, ...(record && str(record.details) ? { details: str(record.details)! } : {}) });
    }
  }
  return out;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/* ---------------------------------------------------------- json pointers */

/** A `Set`, not an object — `"toString" in {}` is true and would let junk through. */
const MATCH_KINDS = new Set<string>([
  "id_match",
  "id_match_multiblock",
  "id_match_partial",
  "fuzzy_match",
  "not_found",
] satisfies MatchKind[]);

export function isMatchKind(value: unknown): value is MatchKind {
  return typeof value === "string" && MATCH_KINDS.has(value);
}

/** RFC 6901 escaping. `~` first, or `/` would be double-escaped. */
export function escapePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function joinPointer(base: string, token: string | number): string {
  return `${base}/${typeof token === "number" ? token : escapePointerToken(token)}`;
}

/** Returns `undefined` for a pointer that does not resolve — never throws. */
export function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;
  let node: unknown = root;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = unescapePointerToken(rawToken);
    if (Array.isArray(node)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) return undefined;
      node = node[index];
      continue;
    }
    const record = asRecord(node);
    if (record === null || !(token in record)) return undefined;
    node = record[token];
  }
  return node;
}

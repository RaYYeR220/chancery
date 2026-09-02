/**
 * Xano failure modes, raised as types rather than left as status codes.
 *
 * One of these matters far more than the rest. The free tier caps you at **10
 * requests per 20 seconds** and answers `ERROR_CODE_TOO_MANY_REQUESTS` — and it
 * does not fire inside Xano's own debugger, so a stack that looks perfect in the
 * UI starts failing the moment two people load the console at once. Left
 * untyped it presents as an intermittent, unattributable failure. So it gets its
 * own class, carrying the window it belongs to and how long to wait, and the
 * caller can tell "we are being throttled" from "we are broken".
 *
 * The code is also detected from the body irrespective of status. Xano's
 * throttle has been observed answering with the error envelope under a 2xx
 * through some paths; a rate limit that arrives dressed as success and gets
 * parsed as a writ is the worst possible outcome here.
 */

export type XanoErrorCode =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_REQUEST"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "UNEXPECTED_STATUS"
  | "TRANSPORT"
  | "TIMEOUT"
  | "MALFORMED_RESPONSE"
  | "LEDGER_CHAIN_MISMATCH"
  | "IMMUTABLE_FIELD"
  | "INVALID_ARGUMENT";

/** Free-tier throughput ceiling, as Xano's pricing table states it. */
export const FREE_TIER_REQUESTS = 10;
export const FREE_TIER_WINDOW_MS = 20_000;

export const TOO_MANY_REQUESTS_CODE = "ERROR_CODE_TOO_MANY_REQUESTS";

export interface XanoErrorInit {
  status?: number | null;
  method?: string | null;
  path?: string | null;
  /** Parsed JSON body when the response had one, raw text otherwise. */
  body?: unknown;
  cause?: unknown;
}

export class XanoError extends Error {
  readonly code: XanoErrorCode;
  readonly status: number | null;
  readonly method: string | null;
  readonly path: string | null;
  readonly body: unknown;

  constructor(message: string, code: XanoErrorCode, init: XanoErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "XanoError";
    this.code = code;
    this.status = init.status ?? null;
    this.method = init.method ?? null;
    this.path = init.path ?? null;
    this.body = init.body;
  }
}

/**
 * No token, an expired token, or a token minted for a different workspace. Xano
 * JWTs carry their own expiry, so this is reachable mid-session and a caller
 * should re-login rather than retry.
 */
export class XanoAuthError extends XanoError {
  constructor(message: string, init: XanoErrorInit = {}) {
    super(message, "AUTH_REQUIRED", init);
    this.name = "XanoAuthError";
  }
}

export class XanoRateLimitError extends XanoError {
  /** How long to wait before the next attempt can succeed. */
  readonly retryAfterMs: number;
  /** Requests permitted per window, so a caller can pace itself instead of retrying blind. */
  readonly limit: number;
  readonly windowMs: number;

  constructor(
    message: string,
    retryAfterMs: number,
    init: XanoErrorInit = {},
    limit = FREE_TIER_REQUESTS,
    windowMs = FREE_TIER_WINDOW_MS,
  ) {
    super(message, "RATE_LIMITED", init);
    this.name = "XanoRateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.limit = limit;
    this.windowMs = windowMs;
  }
}

/**
 * The entry the server chained back does not hash to what its own contents say.
 *
 * Raised rather than swallowed because the ledger's only value is that it can be
 * recomputed: an entry whose hash we cannot reproduce is not evidence of
 * anything, and accepting it would put an unverifiable link in the chain.
 */
export class XanoLedgerError extends XanoError {
  readonly sequence: number;
  readonly expectedHash: string;
  readonly receivedHash: string;

  constructor(
    message: string,
    sequence: number,
    expectedHash: string,
    receivedHash: string,
    init: XanoErrorInit = {},
  ) {
    super(message, "LEDGER_CHAIN_MISMATCH", init);
    this.name = "XanoLedgerError";
    this.sequence = sequence;
    this.expectedHash = expectedHash;
    this.receivedHash = receivedHash;
  }
}

export function isXanoError(value: unknown): value is XanoError {
  return value instanceof XanoError;
}

/** Xano's error envelope: `{ code, message, payload }`. */
interface XanoErrorBody {
  code?: unknown;
  message?: unknown;
  payload?: unknown;
}

export function xanoBodyCode(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const code = (body as XanoErrorBody).code;
  return typeof code === "string" ? code : null;
}

/** True for the free-tier throttle whatever status it arrived under. */
export function isRateLimited(status: number, body: unknown): boolean {
  return status === 429 || xanoBodyCode(body) === TOO_MANY_REQUESTS_CODE;
}

export interface ErrorContext {
  method: string;
  path: string;
  /** Injected so `retryAfterMs` is derived from the same clock a test drives. */
  now: number;
}

export function xanoErrorFromResponse(
  status: number,
  headers: Headers,
  body: unknown,
  ctx: ErrorContext,
): XanoError {
  const detail = messageFromBody(body);
  const init: XanoErrorInit = { status, method: ctx.method, path: ctx.path, body };
  const summary = `${ctx.method} ${ctx.path} failed with ${status}${detail ? `: ${detail}` : ""}`;

  if (isRateLimited(status, body)) {
    return new XanoRateLimitError(
      summary,
      parseRetryAfter(headers.get("retry-after"), ctx.now) ?? FREE_TIER_WINDOW_MS,
      init,
    );
  }

  // Xano's own code is more specific than the status it rides on — the same 403
  // covers "no token" and "this row is not yours" — so it wins where present.
  switch (xanoBodyCode(body)) {
    case "ERROR_CODE_UNAUTHORIZED":
      return new XanoAuthError(summary, init);
    case "ERROR_CODE_ACCESS_DENIED":
      return new XanoError(summary, "FORBIDDEN", init);
    case "ERROR_CODE_NOT_FOUND":
      return new XanoError(summary, "NOT_FOUND", init);
    case "ERROR_CODE_INPUT_ERROR":
      return new XanoError(summary, "INVALID_REQUEST", init);
    default:
      break;
  }

  if (status === 401) return new XanoAuthError(summary, init);
  if (status === 403) return new XanoError(summary, "FORBIDDEN", init);
  if (status === 404) return new XanoError(summary, "NOT_FOUND", init);
  if (status === 409) return new XanoError(summary, "CONFLICT", init);
  if (status === 400 || status === 422) {
    return new XanoError(summary, "INVALID_REQUEST", init);
  }
  if (status >= 500) return new XanoError(summary, "SERVER_ERROR", init);
  return new XanoError(summary, "UNEXPECTED_STATUS", init);
}

function parseRetryAfter(raw: string | null, now: number): number | null {
  if (raw === null) return null;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

function messageFromBody(body: unknown): string {
  if (typeof body === "string") return body.trim();
  if (body === null || typeof body !== "object") return "";
  const record = body as XanoErrorBody;
  return typeof record.message === "string" ? record.message : "";
}

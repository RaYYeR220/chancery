/**
 * name.com failure modes, raised as types rather than left as status codes.
 *
 * Registering a domain spends real money and cannot be undone, so a caller has
 * to be able to tell "you have no credit" from "the price moved under you"
 * from "slow down" without pattern-matching English prose out of a body.
 *
 * The two 429s are deliberately separate. The account-wide limit (20/sec,
 * 3000/hour) is a throughput ceiling that clears on its own and reports
 * `X-RateLimit-Reset`; the limit on `POST /core/v1/domains` is an
 * anti-drop-catch measure with its own cooldown in `Retry-After`. Retrying the
 * second one on the first one's schedule just burns the cooldown again.
 */

export type NameComErrorCode =
  | "AUTH_FAILED"
  | "TWO_FACTOR_ENABLED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "PRICE_MISMATCH"
  | "INVALID_REQUEST"
  | "INSUFFICIENT_CREDIT"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "UNEXPECTED_STATUS"
  | "TRANSPORT"
  | "TIMEOUT"
  | "MALFORMED_RESPONSE"
  | "TTL_TOO_LOW"
  | "INVALID_IDEMPOTENCY_KEY"
  | "INVALID_ARGUMENT";

/**
 * `account` clears by waiting out the shared ceiling. `registration` is the
 * drop-catch guard on the register endpoint and has its own, longer cooldown.
 */
export type RateLimitScope = "account" | "registration";

export interface NameComErrorInit {
  status?: number | null;
  method?: string | null;
  path?: string | null;
  /** Parsed JSON body when the response had one, raw text otherwise. */
  body?: unknown;
  cause?: unknown;
}

export class NameComError extends Error {
  readonly code: NameComErrorCode;
  readonly status: number | null;
  readonly method: string | null;
  readonly path: string | null;
  readonly body: unknown;

  constructor(message: string, code: NameComErrorCode, init: NameComErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "NameComError";
    this.code = code;
    this.status = init.status ?? null;
    this.method = init.method ?? null;
    this.path = init.path ?? null;
    this.body = init.body;
  }
}

/**
 * name.com evaluates credentials before it routes, so a 401 is equally likely
 * to mean "wrong path" as "wrong token" — `path` is carried on the error for
 * exactly that reason.
 */
export class NameComAuthError extends NameComError {
  /**
   * The account has 2FA on and has not enabled the separate "name.com API
   * Access" toggle. No amount of retrying fixes this; a human must go flip it.
   */
  readonly twoFactorEnabled: boolean;

  constructor(
    message: string,
    twoFactorEnabled: boolean,
    init: NameComErrorInit = {},
  ) {
    super(message, twoFactorEnabled ? "TWO_FACTOR_ENABLED" : "AUTH_FAILED", init);
    this.name = "NameComAuthError";
    this.twoFactorEnabled = twoFactorEnabled;
  }
}

/** 402: the account is out of credit. Registration did not happen. */
export class NameComInsufficientCreditError extends NameComError {
  constructor(message: string, init: NameComErrorInit = {}) {
    super(message, "INSUFFICIENT_CREDIT", init);
    this.name = "NameComInsufficientCreditError";
  }
}

/**
 * 400 on register: the `purchasePrice` we quoted no longer matches. Re-quote
 * through search rather than retrying, because the new price may exceed what
 * the writ authorised.
 */
export class NameComPriceMismatchError extends NameComError {
  constructor(message: string, init: NameComErrorInit = {}) {
    super(message, "PRICE_MISMATCH", init);
    this.name = "NameComPriceMismatchError";
  }
}

export class NameComRateLimitError extends NameComError {
  readonly scope: RateLimitScope;
  /** How long to wait, when a header let us work it out. */
  readonly retryAfterMs: number | null;
  /** Absolute moment the account-wide window rolls over, from `X-RateLimit-Reset`. */
  readonly resetAt: Date | null;

  constructor(
    message: string,
    scope: RateLimitScope,
    retryAfterMs: number | null,
    resetAt: Date | null,
    init: NameComErrorInit = {},
  ) {
    super(message, "RATE_LIMITED", init);
    this.name = "NameComRateLimitError";
    this.scope = scope;
    this.retryAfterMs = retryAfterMs;
    this.resetAt = resetAt;
  }
}

export function isNameComError(value: unknown): value is NameComError {
  return value instanceof NameComError;
}

const TWO_FACTOR = /two[\s-]?(step|factor)|\b2fa\b/i;
const PRICE_MISMATCH = /price|amount|cost/i;

export interface ErrorContext {
  method: string;
  path: string;
  /** Injected so `retryAfterMs` is derived from the same clock the test drives. */
  now: number;
}

export function nameComErrorFromResponse(
  status: number,
  headers: Headers,
  body: unknown,
  ctx: ErrorContext,
): NameComError {
  const detail = messageFromBody(body);
  const init: NameComErrorInit = {
    status,
    method: ctx.method,
    path: ctx.path,
    body,
  };
  const summary = `${ctx.method} ${ctx.path} failed with ${status}${detail ? `: ${detail}` : ""}`;

  if (status === 401 || status === 403) {
    return new NameComAuthError(summary, TWO_FACTOR.test(detail), init);
  }
  if (status === 402) {
    return new NameComInsufficientCreditError(summary, init);
  }
  if (status === 429) {
    return rateLimitError(summary, headers, ctx, init);
  }
  if (status === 400 && PRICE_MISMATCH.test(detail)) {
    return new NameComPriceMismatchError(summary, init);
  }
  if (status === 400) {
    return new NameComError(summary, "INVALID_REQUEST", init);
  }
  if (status === 404) {
    // In sandbox this usually means the domain was never registered there
    // rather than that the route is wrong.
    return new NameComError(summary, "NOT_FOUND", init);
  }
  if (status >= 500) {
    return new NameComError(summary, "SERVER_ERROR", init);
  }
  return new NameComError(summary, "UNEXPECTED_STATUS", init);
}

function rateLimitError(
  summary: string,
  headers: Headers,
  ctx: ErrorContext,
  init: NameComErrorInit,
): NameComRateLimitError {
  const retryAfter = parseRetryAfter(headers.get("retry-after"), ctx.now);
  const reset = parseRateLimitReset(headers.get("x-ratelimit-reset"), ctx.now);
  // `Retry-After` is what the drop-catch guard sends; the account-wide ceiling
  // sends `X-RateLimit-Reset`. Which header arrived is the only reliable
  // signal of which limit we hit, since both are plain 429s.
  const scope: RateLimitScope = retryAfter !== null ? "registration" : "account";
  return new NameComRateLimitError(
    summary,
    scope,
    retryAfter ?? reset.retryAfterMs,
    reset.resetAt,
    init,
  );
}

function parseRetryAfter(raw: string | null, now: number): number | null {
  if (raw === null) return null;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

function parseRateLimitReset(
  raw: string | null,
  now: number,
): { retryAfterMs: number | null; resetAt: Date | null } {
  if (raw === null) return { retryAfterMs: null, resetAt: null };
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) return { retryAfterMs: null, resetAt: null };
  // Anything past ~2001 is an absolute unix timestamp; smaller values are the
  // delta-seconds form some proxies rewrite it to.
  const isEpoch = value > 1_000_000_000;
  const resetMs = isEpoch ? value * 1000 : now + value * 1000;
  return { retryAfterMs: Math.max(0, resetMs - now), resetAt: new Date(resetMs) };
}

function messageFromBody(body: unknown): string {
  if (typeof body === "string") return body.trim();
  if (body === null || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  const parts = [record.message, record.details, record.error]
    .filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.join(" - ");
}

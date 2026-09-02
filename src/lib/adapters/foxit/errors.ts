/**
 * Foxit failure modes, raised as types.
 *
 * Three of these exist because Foxit fails in ways an HTTP status does not
 * describe:
 *
 *   1. The legacy eSign host answers **HTTP 200 with `{"result":"error"}`** when
 *      credentials are wrong. A client that trusts `response.ok` treats an auth
 *      failure as a successful send, and the caller believes an envelope went
 *      out that never existed. `FoxitAuthError` is therefore reachable from a
 *      200, and `detectedFrom` records which of the two signals caught it.
 *   2. Pointing the legacy host at the gateway's `/esign/api/v1` prefix returns
 *      a Tomcat 404 HTML page. That is not "route missing", it is "you mixed
 *      the two surfaces", and `FoxitSurfaceError` says so rather than leaving
 *      someone to debug a 404 against a path that genuinely exists elsewhere.
 *   3. eSign drops a field with a missing required key **silently** — the
 *      request succeeds, the envelope goes out, and there is nowhere to sign.
 *      `FoxitFieldError` is raised before the request, because after it there
 *      is nothing left to detect.
 *
 * Everything carries `status` and `body` so the refusal proof in
 * `agent-surface.ts` can show what Foxit actually said, not a paraphrase.
 */

export type FoxitErrorCode =
  | "AUTH_FAILED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "UNEXPECTED_STATUS"
  | "TRANSPORT"
  | "TIMEOUT"
  | "MALFORMED_RESPONSE"
  | "SURFACE_MISMATCH"
  | "FIELD_INCOMPLETE"
  | "TASK_FAILED"
  | "APPROVAL_REQUIRED"
  | "OUT_OF_SCOPE_PATH"
  | "INVALID_ARGUMENT";

export interface FoxitErrorInit {
  status?: number | null;
  method?: string | null;
  path?: string | null;
  /** Parsed JSON when the response had any, raw text otherwise. */
  body?: unknown;
  cause?: unknown;
}

export class FoxitError extends Error {
  readonly code: FoxitErrorCode;
  readonly status: number | null;
  readonly method: string | null;
  readonly path: string | null;
  readonly body: unknown;

  constructor(message: string, code: FoxitErrorCode, init: FoxitErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "FoxitError";
    this.code = code;
    this.status = init.status ?? null;
    this.method = init.method ?? null;
    this.path = init.path ?? null;
    this.body = init.body;
  }
}

/**
 * `status` tells you the gateway rejected the credentials; `body` tells you the
 * legacy host did, while claiming 200. Both are the same failure and both must
 * stop the caller, which is why they are one class.
 */
export class FoxitAuthError extends FoxitError {
  readonly detectedFrom: "status" | "body";

  constructor(
    message: string,
    detectedFrom: "status" | "body",
    init: FoxitErrorInit = {},
  ) {
    super(message, "AUTH_FAILED", init);
    this.name = "FoxitAuthError";
    this.detectedFrom = detectedFrom;
  }
}

/** The host and the path prefix disagree about which front door this is. */
export class FoxitSurfaceError extends FoxitError {
  readonly surface: string;

  constructor(message: string, surface: string, init: FoxitErrorInit = {}) {
    super(message, "SURFACE_MISMATCH", init);
    this.name = "FoxitSurfaceError";
    this.surface = surface;
  }
}

/** Raised before the request, because eSign will not raise anything after it. */
export class FoxitFieldError extends FoxitError {
  readonly fieldIndex: number;
  readonly missingKeys: string[];

  constructor(message: string, fieldIndex: number, missingKeys: string[]) {
    super(message, "FIELD_INCOMPLETE");
    this.name = "FoxitFieldError";
    this.fieldIndex = fieldIndex;
    this.missingKeys = missingKeys;
  }
}

/** A PDF Services task reached FAILED, or never left PENDING before the deadline. */
export class FoxitTaskError extends FoxitError {
  readonly taskId: string;
  readonly taskStatus: string;

  constructor(
    message: string,
    taskId: string,
    taskStatus: string,
    init: FoxitErrorInit = {},
  ) {
    super(message, "TASK_FAILED", init);
    this.name = "FoxitTaskError";
    this.taskId = taskId;
    this.taskStatus = taskStatus;
  }
}

/**
 * The signing service was asked to send bytes no human ever approved. Carries
 * the two hashes so the mismatch is auditable rather than merely refused.
 */
export class FoxitApprovalRequiredError extends FoxitError {
  readonly documentHash: string;
  readonly approvedHashes: string[];

  constructor(message: string, documentHash: string, approvedHashes: string[]) {
    super(message, "APPROVAL_REQUIRED");
    this.name = "FoxitApprovalRequiredError";
    this.documentHash = documentHash;
    this.approvedHashes = approvedHashes;
  }
}

/**
 * A path built inside the agent-facing client did not start with a PDF Services
 * prefix. The type system stops a call site from naming an eSign route; this
 * stops a caller-supplied id from smuggling one in through path traversal.
 */
export class FoxitScopeError extends FoxitError {
  constructor(path: string) {
    super(
      `refusing to send ${path}: the PDF Services client may only address PDF Services paths`,
      "OUT_OF_SCOPE_PATH",
      { path },
    );
    this.name = "FoxitScopeError";
  }
}

export function isFoxitError(value: unknown): value is FoxitError {
  return value instanceof FoxitError;
}

export interface FoxitErrorContext {
  method: string;
  path: string;
}

const TOMCAT = /<html|Apache Tomcat|HTTP Status 404/i;

export function foxitErrorFromResponse(
  status: number,
  body: unknown,
  ctx: FoxitErrorContext,
): FoxitError {
  const detail = messageFromBody(body);
  const init: FoxitErrorInit = { status, method: ctx.method, path: ctx.path, body };
  const summary = `${ctx.method} ${ctx.path} failed with ${status}${detail ? `: ${detail}` : ""}`;

  if (status === 401) return new FoxitAuthError(summary, "status", init);
  if (status === 403) return new FoxitError(summary, "FORBIDDEN", init);
  if (status === 404 && typeof body === "string" && TOMCAT.test(body)) {
    return new FoxitSurfaceError(
      `${summary} — an HTML 404 on an eSign path means the host and the path prefix are from different Foxit surfaces`,
      "unknown",
      init,
    );
  }
  if (status === 404) return new FoxitError(summary, "NOT_FOUND", init);
  if (status === 400) return new FoxitError(summary, "INVALID_REQUEST", init);
  if (status === 429) return new FoxitError(summary, "RATE_LIMITED", init);
  if (status >= 500) return new FoxitError(summary, "SERVER_ERROR", init);
  return new FoxitError(summary, "UNEXPECTED_STATUS", init);
}

/**
 * The legacy-host convention: success and failure are both 200, and only
 * `result` distinguishes them. Applied on every surface rather than only the
 * legacy one, because a body that says it failed is never a success anywhere.
 */
export function errorResultInBody(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const result = body.result;
  if (typeof result === "string" && result.toLowerCase() === "error") {
    return messageFromBody(body) || "the response body reported result=error";
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageFromBody(body: unknown): string {
  if (typeof body === "string") return body.trim().slice(0, 400);
  if (!isRecord(body)) return "";
  const parts = [body.message, body.error, body.errorMessage, body.details, body.description]
    .filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.join(" - ");
}

/**
 * Doctavian failures carry the HTTP status and the response body verbatim.
 *
 * The body matters more here than in most adapters: a Documents key used on a
 * Signatures path comes back as a plain `401 ApiKeyInvalid`, which is
 * indistinguishable from an expired token unless you read what the server
 * actually said.
 */

import type { DoctavianArea } from "./types";

export class DoctavianApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  /** Parsed JSON when the response was JSON, the raw text otherwise. */
  readonly body: unknown;
  readonly area: DoctavianArea;
  readonly path: string;
  readonly method: string;

  constructor(init: {
    message: string;
    status: number;
    statusText: string;
    body: unknown;
    area: DoctavianArea;
    path: string;
    method: string;
  }) {
    super(init.message);
    this.name = "DoctavianApiError";
    this.status = init.status;
    this.statusText = init.statusText;
    this.body = init.body;
    this.area = init.area;
    this.path = init.path;
    this.method = init.method;
  }

  /**
   * True for the one failure that looks like an auth outage but is really a
   * routing mistake, so callers can stop retrying and go fix the key.
   */
  get isApiKeyScopeFailure(): boolean {
    return this.status === 401 && /apikeyinvalid/i.test(bodyText(this.body));
  }
}

/**
 * Raised before any request leaves the process when a path does not belong to
 * the area whose key would be attached. This is the runtime half of the
 * guarantee `DoctavianPath` makes at compile time — it also covers paths built
 * from strings at runtime, which the type system never sees.
 */
export class DoctavianKeyScopeError extends Error {
  readonly area: DoctavianArea;
  readonly path: string;

  constructor(area: DoctavianArea, path: string) {
    super(
      `refusing to send the ${area} API key to ${path}: the key is scoped to /v1/${area}/`,
    );
    this.name = "DoctavianKeyScopeError";
    this.area = area;
    this.path = path;
  }
}

/** The response shape did not carry the id the flow needs to continue. */
export class DoctavianResponseError extends Error {
  readonly body: unknown;

  constructor(message: string, body: unknown) {
    super(message);
    this.name = "DoctavianResponseError";
    this.body = body;
  }
}

function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body) ?? "";
  } catch {
    return "";
  }
}

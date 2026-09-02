/**
 * The transport both Foxit clients sit on.
 *
 * It exists mostly for one reason: `response.ok` is not a reliable success
 * signal against Foxit. The legacy eSign host answers 200 with
 * `{"result":"error"}` on an auth failure, so every body — JSON *and* binary —
 * is inspected before it is handed back. The binary path matters more than it
 * looks: a completed folder download is a ZIP, and a caller that trusted the
 * status would write a JSON error object to disk as `signed.zip` and only find
 * out when unzipping failed hours later. Archives start with `PK`; anything
 * else that parses as JSON is treated as the error it is.
 *
 * Nothing here reaches the network on its own. `fetchImpl` is injected, which
 * is what lets the whole Foxit surface — including the refusal proof — be
 * driven from fixtures with no credentials.
 */

import {
  FoxitAuthError,
  FoxitError,
  errorResultInBody,
  foxitErrorFromResponse,
} from "./errors";
import type { FetchLike, FoxitBinary } from "./types";

export type HeaderSource =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);

export interface FoxitHttpOptions {
  baseUrl: string;
  /** Resolved per request, so an OAuth token can be refreshed between calls. */
  headers: HeaderSource;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /**
   * Last line of defence on the path. The PDF Services client passes a guard
   * that rejects anything outside its own prefix, so a caller-supplied document
   * id cannot traverse its way onto an eSign route.
   */
  guardPath?: (path: string) => void;
}

type QueryValue = string | number | boolean | undefined | null;

export interface FoxitRequestSpec {
  method: string;
  path: string;
  query?: Record<string, QueryValue>;
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

const PARSE_FAILED = Symbol("foxit.parseFailed");

export class FoxitHttp {
  readonly baseUrl: string;

  private readonly headers: HeaderSource;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly guardPath: ((path: string) => void) | undefined;

  constructor(options: FoxitHttpOptions) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new FoxitError(
        "no fetch implementation available; pass fetchImpl",
        "INVALID_ARGUMENT",
      );
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.headers = options.headers;
    this.fetchImpl = fetchImpl as FetchLike;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.guardPath = options.guardPath;
  }

  async json<T>(spec: FoxitRequestSpec): Promise<T> {
    const response = await this.send(spec);
    const text = await response.text();
    const parsed = text.length === 0 ? undefined : safeJson(text);
    const body = parsed === PARSE_FAILED ? text : parsed;

    if (!response.ok) {
      throw foxitErrorFromResponse(response.status, body, {
        method: spec.method,
        path: spec.path,
      });
    }
    this.assertBodyIsNotAnError(body, spec, response.status);
    if (parsed === PARSE_FAILED) {
      throw new FoxitError(
        `${spec.method} ${spec.path} returned ${response.status} with a non-JSON body`,
        "MALFORMED_RESPONSE",
        { status: response.status, method: spec.method, path: spec.path, body: text },
      );
    }
    return parsed as T;
  }

  async binary(spec: FoxitRequestSpec): Promise<FoxitBinary> {
    const response = await this.send(spec);
    if (!response.ok) {
      const text = await response.text();
      const parsed = safeJson(text);
      throw foxitErrorFromResponse(
        response.status,
        parsed === PARSE_FAILED ? text : parsed,
        { method: spec.method, path: spec.path },
      );
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    // A JSON error wearing a 200 and a `Content-Type` nobody set correctly.
    const masquerading = jsonFromBytes(bytes);
    if (masquerading !== undefined) {
      this.assertBodyIsNotAnError(masquerading, spec, response.status);
    }

    return {
      bytes,
      contentType: response.headers.get("content-type"),
      fileName: fileNameFromDisposition(response.headers.get("content-disposition")),
    };
  }

  private assertBodyIsNotAnError(
    body: unknown,
    spec: FoxitRequestSpec,
    status: number,
  ): void {
    const detail = errorResultInBody(body);
    if (detail === null) return;
    throw new FoxitAuthError(
      `${spec.method} ${spec.path} returned ${status} but the body reports a failure: ${detail}`,
      "body",
      { status, method: spec.method, path: spec.path, body },
    );
  }

  private async send(spec: FoxitRequestSpec): Promise<Response> {
    this.guardPath?.(spec.path);

    const url = buildUrl(this.baseUrl, spec.path, spec.query);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(await resolveHeaders(this.headers)),
      ...spec.headers,
    };
    // FormData generates its own multipart boundary; a hand-set content-type
    // would not match it and Foxit would read an empty part.
    if (spec.json !== undefined) headers["content-type"] = "application/json";

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const forwardAbort = () => controller.abort();
    spec.signal?.addEventListener("abort", forwardAbort, { once: true });

    try {
      return await this.fetchImpl(url, {
        method: spec.method,
        headers,
        body: spec.form ?? (spec.json === undefined ? undefined : JSON.stringify(spec.json)),
        signal: controller.signal,
      });
    } catch (cause) {
      if (timedOut) {
        throw new FoxitError(
          `${spec.method} ${spec.path} timed out after ${this.timeoutMs}ms`,
          "TIMEOUT",
          { method: spec.method, path: spec.path, cause },
        );
      }
      throw new FoxitError(`${spec.method} ${spec.path} could not be sent`, "TRANSPORT", {
        method: spec.method,
        path: spec.path,
        cause,
      });
    } finally {
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", forwardAbort);
    }
  }
}

async function resolveHeaders(source: HeaderSource): Promise<Record<string, string>> {
  return typeof source === "function" ? source() : source;
}

export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, QueryValue>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return `${baseUrl}${path}${qs.length > 0 ? `?${qs}` : ""}`;
}

/** Caller-supplied ids only ever appear inside one of these. */
export function segment(value: string): string {
  return encodeURIComponent(value);
}

function safeJson(text: string): unknown | typeof PARSE_FAILED {
  try {
    return JSON.parse(text);
  } catch {
    return PARSE_FAILED;
  }
}

/**
 * Only bodies that are plausibly JSON are decoded. A ZIP begins `PK\x03\x04`
 * and a PDF `%PDF-`, so the cheap first-byte check avoids running a megabyte of
 * binary through `TextDecoder` on every download.
 */
function jsonFromBytes(bytes: Uint8Array): unknown | undefined {
  const first = bytes[0];
  if (first !== 0x7b && first !== 0x5b) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

function fileNameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8) return decodeURIComponent(utf8[1]);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1] : null;
}

/**
 * A fake `fetch` for the Doctavian adapter.
 *
 * We have no Doctavian credentials, so the entire integration is driven from
 * fixtures. That is a constraint worth leaning into: a route that is not
 * explicitly registered throws rather than returning a benign empty body, so a
 * test can never accidentally pass because the client silently skipped a call.
 */

import type { FetchLike } from "../../src/lib/adapters/doctavian/types";

export interface RecordedRequest {
  method: string;
  url: string;
  pathname: string;
  headers: Record<string, string>;
  /** Parsed JSON when the body parsed as JSON, else null. */
  json: unknown;
  /** The raw string body, for the form-encoded token endpoint. */
  text: string | null;
  form: FormData | null;
}

export type Responder = (request: RecordedRequest) => Response | Promise<Response>;

export interface FakeFetch {
  fetchImpl: FetchLike;
  calls: RecordedRequest[];
  /** `["POST /v1/documents/document/generate", …]` in the order they happened. */
  trace(): string[];
}

export function createFakeFetch(routes: Record<string, Responder>): FakeFetch {
  const calls: RecordedRequest[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body;
    const recorded: RecordedRequest = {
      method,
      url: input,
      pathname: url.pathname,
      headers: normalizeHeaders(init.headers),
      json: typeof body === "string" ? tryParse(body) : null,
      text: typeof body === "string" ? body : null,
      form: body instanceof FormData ? body : null,
    };
    calls.push(recorded);

    const key = `${method} ${url.pathname}`;
    const responder = routes[key];
    if (!responder) {
      throw new Error(`fake fetch: no route registered for ${key}`);
    }
    return responder(recorded);
  };

  return { fetchImpl, calls, trace: () => calls.map((c) => `${c.method} ${c.pathname}`) };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function errorResponse(body: unknown, status: number, statusText?: string): Response {
  const isText = typeof body === "string";
  return new Response(isText ? body : JSON.stringify(body), {
    status,
    statusText: statusText ?? "Error",
    headers: { "content-type": isText ? "text/plain" : "application/json" },
  });
}

export function binaryResponse(
  bytes: Uint8Array,
  options: { contentType?: string; fileName?: string } = {},
): Response {
  const headers: Record<string, string> = {
    "content-type": options.contentType ?? "application/pdf",
  };
  if (options.fileName) {
    headers["content-disposition"] = `attachment; filename="${options.fileName}"`;
  }
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Response(new Blob([copy]), { status: 200, headers });
}

function tryParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  new Headers(headers).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

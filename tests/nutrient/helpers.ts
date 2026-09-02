/**
 * Fake transport for the Nutrient adapter.
 *
 * There is no API key yet and no test should ever reach the network, so every
 * test drives `fetchImpl` directly and asserts on the recorded request. The
 * cost headers are attached by default because the adapter is supposed to
 * surface them on every single call.
 */

import type { FetchImpl } from "../../src/lib/adapters/nutrient/http";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: FormData | string | undefined;
}

export interface FakeTransport {
  fetchImpl: FetchImpl;
  calls: RecordedCall[];
}

export function fakeTransport(
  handler: (call: RecordedCall, index: number) => Response | Promise<Response>,
): FakeTransport {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const call: RecordedCall = {
      url,
      method: init.method ?? "GET",
      headers: normaliseHeaders(init.headers),
      body: init.body as FormData | string | undefined,
    };
    const index = calls.length;
    calls.push(call);
    return handler(call, index);
  };
  return { fetchImpl, calls };
}

function normaliseHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key.toLowerCase()] = value;
    return out;
  }
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

export const COST_HEADERS = {
  "x-pspdfkit-request-cost": "15",
  "x-pspdfkit-remaining-credits": "35",
  "x-request-id": "req_abc123",
};

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...COST_HEADERS,
      ...init.headers,
    },
  });
}

export function binaryResponse(
  bytes: Uint8Array,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Response(buffer, {
    status: init.status ?? 200,
    headers: { "content-type": "application/pdf", ...COST_HEADERS, ...init.headers },
  });
}

export function textResponse(
  text: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(text, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html", ...COST_HEADERS, ...init.headers },
  });
}

export function asForm(body: FormData | string | undefined): FormData {
  if (!(body instanceof FormData)) throw new Error("expected a multipart body");
  return body;
}

export async function formText(body: FormData | string | undefined, field: string): Promise<string> {
  const value = asForm(body).get(field);
  if (value === null) throw new Error(`multipart field \`${field}\` is missing`);
  return typeof value === "string" ? value : await value.text();
}

export async function formBytes(
  body: FormData | string | undefined,
  field: string,
): Promise<Uint8Array> {
  const value = asForm(body).get(field);
  if (value === null || typeof value === "string") {
    throw new Error(`multipart field \`${field}\` is not a file`);
  }
  return new Uint8Array(await value.arrayBuffer());
}

export function formFieldNames(body: FormData | string | undefined): string[] {
  return [...asForm(body).keys()].sort();
}

export const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nwrit\n%%EOF\n");
export const SIGNED_BYTES = new TextEncoder().encode("%PDF-1.7\nwrit signed\n%%EOF\n");

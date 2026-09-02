/**
 * Recording fake `fetch` for the Xano client.
 *
 * We have no instance, so nothing in this suite touches a network. It records
 * what the client sent, because most of what matters here is in the request:
 * that the bearer token is attached to the authenticated calls and absent from
 * the public ones, that a writ id is encoded into the path rather than
 * concatenated, and that `createWrit` never sends a principal.
 */

export interface RecordedRequest {
  method: string;
  /** The URL exactly as the client built it, so encoding bugs stay visible. */
  url: string;
  pathname: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
  rawBody: string | undefined;
}

export interface FakeResponse {
  status?: number;
  /** Serialised as JSON unless `rawBody` is given. */
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

export type Responder =
  | FakeResponse
  | FakeResponse[]
  | ((request: RecordedRequest, index: number) => FakeResponse);

export interface FakeFetch {
  (input: string, init?: RequestInit): Promise<Response>;
  readonly calls: RecordedRequest[];
  last(): RecordedRequest;
  nth(index: number): RecordedRequest;
}

/** Xano's throttle envelope, verbatim. It is what a free-tier caller actually sees. */
export const TOO_MANY_REQUESTS: FakeResponse = {
  status: 429,
  body: {
    code: "ERROR_CODE_TOO_MANY_REQUESTS",
    message: "Whoa there! Your plan only supports 10 requests per 20 seconds.",
  },
};

function record(input: string, init: RequestInit): RecordedRequest {
  const url = new URL(input);
  const rawBody = typeof init.body === "string" ? init.body : undefined;
  return {
    method: init.method ?? "GET",
    url: input,
    pathname: url.pathname,
    query: url.searchParams,
    headers: new Headers(init.headers as HeadersInit | undefined),
    body: rawBody === undefined ? undefined : JSON.parse(rawBody),
    rawBody,
  };
}

export function toResponse(spec: FakeResponse): Response {
  const status = spec.status ?? 200;
  const payload =
    spec.rawBody ?? (spec.body === undefined ? undefined : JSON.stringify(spec.body));
  const headers = new Headers(spec.headers);
  if (payload !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const noBody = status === 204 || status === 205 || status === 304;
  return new Response(noBody ? null : (payload ?? ""), { status, headers });
}

export function fakeFetch(responder: Responder): FakeFetch {
  const calls: RecordedRequest[] = [];

  const impl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const request = record(input, init);
    const index = calls.length;
    calls.push(request);
    return toResponse(resolve(responder, request, index));
  };

  return withHelpers(impl, calls);
}

/** Fails outright, the way a dropped socket or a DNS failure would. */
export function failingFetch(error: unknown = new TypeError("fetch failed")): FakeFetch {
  const calls: RecordedRequest[] = [];
  const impl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    calls.push(record(input, init));
    throw error;
  };
  return withHelpers(impl, calls);
}

/**
 * Never settles, so the client's own timeout is the only thing that can end it.
 * A cold start on Xano's free tier is community-reported at several seconds with
 * no documented ceiling, which makes the timeout path reachable in practice.
 */
export function hangingFetch(): FakeFetch {
  const calls: RecordedRequest[] = [];
  const impl = (input: string, init: RequestInit = {}): Promise<Response> => {
    calls.push(record(input, init));
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  };
  return withHelpers(impl, calls);
}

function withHelpers(
  impl: (input: string, init?: RequestInit) => Promise<Response>,
  calls: RecordedRequest[],
): FakeFetch {
  return Object.assign(impl, {
    calls,
    last: () => atOrThrow(calls, calls.length - 1),
    nth: (index: number) => atOrThrow(calls, index),
  }) as FakeFetch;
}

function resolve(responder: Responder, request: RecordedRequest, index: number): FakeResponse {
  if (typeof responder === "function") return responder(request, index);
  if (Array.isArray(responder)) {
    const spec = responder[index];
    if (spec === undefined) {
      throw new Error(
        `fakeFetch ran out of scripted responses at call ${index}: ${request.method} ${request.url}`,
      );
    }
    return spec;
  }
  return responder;
}

function atOrThrow(calls: RecordedRequest[], index: number): RecordedRequest {
  const call = calls[index];
  if (call === undefined) {
    throw new Error(`no recorded request at index ${index} (${calls.length} recorded)`);
  }
  return call;
}

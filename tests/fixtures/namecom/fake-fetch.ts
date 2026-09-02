/**
 * Recording fake `fetch`.
 *
 * We have no name.com credentials, so every test in this suite drives the
 * client through this instead of the network. It records what the client sent
 * — which is most of what these tests actually assert on, since the risky
 * behaviour is in the request (idempotency header, un-encoded colon, full-
 * overwrite body) rather than in the parsing of the reply.
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

export function fakeFetch(responder: Responder): FakeFetch {
  const calls: RecordedRequest[] = [];

  const impl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const rawBody = typeof init.body === "string" ? init.body : undefined;
    const request: RecordedRequest = {
      method: init.method ?? "GET",
      url: input,
      pathname: url.pathname,
      query: url.searchParams,
      headers: new Headers(init.headers as HeadersInit | undefined),
      body: rawBody === undefined ? undefined : JSON.parse(rawBody),
      rawBody,
    };
    const index = calls.length;
    calls.push(request);

    const spec = resolve(responder, request, index);
    const status = spec.status ?? 200;
    const payload =
      spec.rawBody ?? (spec.body === undefined ? undefined : JSON.stringify(spec.body));
    const headers = new Headers(spec.headers);
    if (payload !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    // A 204 with a body is a TypeError in undici, and DELETE really does answer 204.
    const noBody = status === 204 || status === 205 || status === 304;
    return new Response(noBody ? null : (payload ?? ""), { status, headers });
  };

  return Object.assign(impl, {
    calls,
    last: () => atOrThrow(calls, calls.length - 1),
    nth: (index: number) => atOrThrow(calls, index),
  }) as FakeFetch;
}

/** Fails the request outright, the way a DNS failure or a dropped socket would. */
export function failingFetch(error: unknown = new TypeError("fetch failed")): FakeFetch {
  const calls: RecordedRequest[] = [];
  const impl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    calls.push({
      method: init.method ?? "GET",
      url: input,
      pathname: new URL(input).pathname,
      query: new URL(input).searchParams,
      headers: new Headers(init.headers as HeadersInit | undefined),
      body: undefined,
      rawBody: typeof init.body === "string" ? init.body : undefined,
    });
    throw error;
  };
  return Object.assign(impl, {
    calls,
    last: () => atOrThrow(calls, calls.length - 1),
    nth: (index: number) => atOrThrow(calls, index),
  }) as FakeFetch;
}

/** Never settles, so a client's own timeout is the only thing that can end it. */
export function hangingFetch(): FakeFetch {
  const calls: RecordedRequest[] = [];
  const impl = (input: string, init: RequestInit = {}): Promise<Response> => {
    calls.push({
      method: init.method ?? "GET",
      url: input,
      pathname: new URL(input).pathname,
      query: new URL(input).searchParams,
      headers: new Headers(init.headers as HeadersInit | undefined),
      body: undefined,
      rawBody: typeof init.body === "string" ? init.body : undefined,
    });
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  };
  return Object.assign(impl, {
    calls,
    last: () => atOrThrow(calls, calls.length - 1),
    nth: (index: number) => atOrThrow(calls, index),
  }) as FakeFetch;
}

function resolve(
  responder: Responder,
  request: RecordedRequest,
  index: number,
): FakeResponse {
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

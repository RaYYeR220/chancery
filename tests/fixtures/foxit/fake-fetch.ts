/**
 * Recording fake `fetch` for the Foxit suite.
 *
 * We hold no Foxit credentials, so nothing here touches the network. It records
 * what the client sent, which is where most of the risk lives: which host and
 * prefix were paired, which headers carried the credential, whether a document
 * id escaped its path segment, and whether an eSign path was ever addressed at
 * all.
 *
 * It also has to be able to answer with bytes and with HTML, not just JSON,
 * because two of Foxit's more interesting failure modes — a ZIP download and a
 * Tomcat 404 — are unreachable from a JSON-only fake.
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
  form: FormData | undefined;
}

export interface FakeResponse {
  status?: number;
  /** Serialised as JSON unless `rawBody` or `bytes` is given. */
  body?: unknown;
  rawBody?: string;
  bytes?: Uint8Array;
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
  /** Every pathname seen, for asserting on what was never called. */
  paths(): string[];
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
      form: init.body instanceof FormData ? init.body : undefined,
    };
    const index = calls.length;
    calls.push(request);

    const spec = resolve(responder, request, index);
    const status = spec.status ?? 200;
    const headers = new Headers(spec.headers);

    if (spec.bytes !== undefined) {
      if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
      // A fresh copy so the response cannot alias the fixture's buffer.
      const copy = new Uint8Array(spec.bytes.length);
      copy.set(spec.bytes);
      return new Response(copy, { status, headers });
    }

    const payload =
      spec.rawBody ?? (spec.body === undefined ? undefined : JSON.stringify(spec.body));
    if (payload !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const noBody = status === 204 || status === 205 || status === 304;
    return new Response(noBody ? null : (payload ?? ""), { status, headers });
  };

  return Object.assign(impl, {
    calls,
    last: () => atOrThrow(calls, calls.length - 1),
    nth: (index: number) => atOrThrow(calls, index),
    paths: () => calls.map((call) => call.pathname),
  }) as FakeFetch;
}

/**
 * Routes by `METHOD /path` prefix. Most Foxit flows are several calls deep, so
 * scripting them positionally makes a test break when an unrelated step is
 * added; matching on the path does not.
 */
export function routedFetch(routes: Record<string, Responder>): FakeFetch {
  const counters = new Map<string, number>();
  return fakeFetch((request) => {
    const key = Object.keys(routes).find((candidate) => matches(candidate, request));
    if (key === undefined) {
      throw new Error(`no fake route for ${request.method} ${request.pathname}`);
    }
    const index = counters.get(key) ?? 0;
    counters.set(key, index + 1);
    return resolve(routes[key], request, index);
  });
}

/** Fails the request outright, the way a dropped socket would. */
export function failingFetch(error: unknown = new TypeError("fetch failed")): FakeFetch {
  return fakeFetch(() => {
    throw error;
  });
}

function matches(route: string, request: RecordedRequest): boolean {
  const [method, path] = route.split(" ");
  if (method !== request.method) return false;
  return path.endsWith("*")
    ? request.pathname.startsWith(path.slice(0, -1))
    : request.pathname === path;
}

function resolve(
  responder: Responder,
  request: RecordedRequest,
  index: number,
): FakeResponse {
  if (typeof responder === "function") return responder(request, index);
  if (Array.isArray(responder)) {
    const spec = responder[Math.min(index, responder.length - 1)];
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

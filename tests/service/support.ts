/**
 * Fakes for the service layer. Nothing here touches the network: every vendor
 * client in these tests is driven through an injected fetch that answers from a
 * routing table, so a bridge that started reaching past its adapter would show
 * up as an unmatched route rather than as a slow test.
 */

import type { ComposeFetch } from "@/lib/service/compose";
import type { WritSpec } from "@/lib/service/ports";
import * as w from "@/lib/eval/world";

export interface Route {
  /** Matched against the request URL. */
  match: string | RegExp;
  method?: string;
  status?: number;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

export interface RecordedCall {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
}

export interface RoutedFetch {
  (input: string, init?: RequestInit): Promise<Response>;
  calls: RecordedCall[];
  paths(): string[];
}

export function routedFetch(routes: readonly Route[]): RoutedFetch {
  const calls: RecordedCall[] = [];

  const impl = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url: input, method, body: init?.body });

    const route = routes.find(
      (candidate) =>
        matches(candidate.match, input) &&
        (candidate.method === undefined || candidate.method.toUpperCase() === method),
    );
    if (route === undefined) {
      throw new Error(`no fake route for ${method} ${input}`);
    }

    const headers = new Headers(route.headers ?? {});
    if (route.bytes !== undefined) {
      return new Response(route.bytes as unknown as BodyInit, {
        status: route.status ?? 200,
        headers,
      });
    }
    if (route.text !== undefined) {
      return new Response(route.text, { status: route.status ?? 200, headers });
    }
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(route.json ?? {}), {
      status: route.status ?? 200,
      headers,
    });
  };

  const fetchImpl = impl as RoutedFetch;
  fetchImpl.calls = calls;
  fetchImpl.paths = () => calls.map((call) => new URL(call.url).pathname);
  return fetchImpl;
}

function matches(pattern: string | RegExp, url: string): boolean {
  return typeof pattern === "string" ? url.includes(pattern) : pattern.test(url);
}

/** Typed as the shape `composeChancery` accepts, so the cast lives in one place. */
export function asComposeFetch(fetchImpl: RoutedFetch): ComposeFetch {
  return fetchImpl;
}

/* ------------------------------------------------------------------ a writ */

/** The benchmark's world, minus the two fields the registry owns. */
export function spec(overrides: Partial<WritSpec> = {}): WritSpec {
  const writ = w.writ();
  return {
    principal: writ.principal,
    agent: writ.agent,
    grants: writ.grants,
    effectiveFrom: writ.effectiveFrom,
    expiresAt: writ.expiresAt,
    jurisdiction: writ.jurisdiction,
    ...overrides,
  };
}

/* ------------------------------------------------------- extraction mirrors */

/**
 * Nutrient's `output.metadata` is `output.data` with every leaf replaced by a
 * citation, arrays mirrored element for element. Building it by walking the
 * data is the only way to keep a fixture honest as the schema changes.
 */
export function citationMirror(
  data: unknown,
  overrides: Record<string, Record<string, unknown>> = {},
  pointer = "",
): unknown {
  if (Array.isArray(data)) {
    return data.map((entry, index) => citationMirror(entry, overrides, `${pointer}/${index}`));
  }
  if (data !== null && typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      out[key] = citationMirror(value, overrides, `${pointer}/${key}`);
    }
    return out;
  }
  return {
    match: "id_match",
    confidence: 0.93,
    pageNumber: 2,
    bbox: [72, 316, 451, 58],
    ...(overrides[pointer] ?? {}),
  };
}

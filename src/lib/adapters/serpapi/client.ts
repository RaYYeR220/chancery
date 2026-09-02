/**
 * The SerpApi HTTP client.
 *
 * Three decisions are worth stating.
 *
 * The api_key travels in the query string. Header auth on `/search` is not
 * documented, and an undocumented auth path that happens to work today is not
 * something an irreversible-act gate should depend on. (SerpApi's MCP server
 * is the one endpoint that does take a bearer header; this is not it.)
 *
 * `fetchImpl` is injected. Every test in this adapter drives a fake, so the
 * decision logic is exercised against captured response shapes rather than
 * against a live SERP that changes hourly — and the suite needs no key.
 *
 * `searchSafe` is the method diligence actually calls. `search` throws, which
 * is right for a caller that wants the value; a caller that must fail closed
 * needs the failure as data, because the moment a failure becomes an exception
 * somebody writes a catch block that returns a default, and the default is
 * always "fine".
 */

import {
  assertSearchParams,
  SerpApiUsageError,
  type SerpApiParams,
} from "./engines";
import { isRecord, readApiError } from "./parse";
import type { EngineName, SerpApiErrorKind, SerpApiJson, SerpApiOutcome } from "./types";

export const SERPAPI_JSON_ENDPOINT = "https://serpapi.com/search.json";

export interface FetchLikeInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;

export class SerpApiRequestError extends Error {
  constructor(
    message: string,
    readonly kind: SerpApiErrorKind,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SerpApiRequestError";
  }
}

export interface SerpApiClientOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  /** Defaults to `search.json`, which forces JSON regardless of Accept. */
  baseUrl?: string;
  /** Per-request ceiling. A SERP that is slow is a SERP we do not wait for. */
  timeoutMs?: number;
  /** Injected so elapsed times in stored evidence are reproducible in tests. */
  now?: () => number;
}

export interface RequestOptions {
  timeoutMs?: number;
  /** Caller-side cancellation, composed with the per-request timeout. */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export class SerpApiClient {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: SerpApiClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
      throw new SerpApiUsageError("apiKey is required", "-");
    }
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.baseUrl = options.baseUrl ?? SERPAPI_JSON_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * The full request URL, api_key included. Kept public because "what exactly
   * did we ask?" is a question the evidence bundle has to be able to answer,
   * and because the query-string auth is a claim worth asserting in a test.
   */
  buildUrl(params: SerpApiParams): string {
    assertSearchParams(params);
    const url = new URL(this.baseUrl);
    url.searchParams.set("api_key", this.apiKey);
    for (const [key, value] of sortedEntries(params)) {
      url.searchParams.set(key, serializeParam(value));
    }
    return url.toString();
  }

  /** The same URL with the key removed, which is the only form we ever store. */
  redactedUrl(params: SerpApiParams): string {
    return redactUrl(this.buildUrl(params));
  }

  /**
   * A stable identity for a request, independent of the key and of parameter
   * order. Diligence results are cacheable precisely because the decision
   * logic is pure, and this is the key that cache would use.
   */
  cacheKey(params: SerpApiParams): string {
    const parts = sortedEntries(params).map(([key, value]) => `${key}=${serializeParam(value)}`);
    return parts.join("&");
  }

  async search(params: SerpApiParams, options?: RequestOptions): Promise<SerpApiJson> {
    if (params.output === "md") {
      throw new SerpApiUsageError(
        "output=md returns markdown, not JSON; call searchMarkdown instead",
        params.engine,
      );
    }
    const body = await this.fetchText(params, options);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      throw new SerpApiRequestError("response body was not JSON", "malformed", body.url);
    }
    if (!isRecord(parsed)) {
      throw new SerpApiRequestError("response body was not a JSON object", "malformed", body.url);
    }
    const apiError = readApiError(parsed);
    if (apiError !== null) {
      throw new SerpApiRequestError(apiError, "api", body.url, body.status);
    }
    return parsed;
  }

  /**
   * The markdown rendering, for the leg where a model reads the SERP directly.
   * Cheaper in tokens and latency than JSON, and useless for diligence, whose
   * verdicts must come from named fields rather than from prose.
   */
  async searchMarkdown(params: SerpApiParams, options?: RequestOptions): Promise<string> {
    const body = await this.fetchText({ ...params, output: "md" } as SerpApiParams, options);
    return body.text;
  }

  /**
   * Never throws. A transport failure, a timeout, an API error and a malformed
   * body all come back as `ok: false` with a `kind`, so the caller can tell
   * "we could not look" apart from "we looked and found nothing".
   */
  async searchSafe(params: SerpApiParams, options?: RequestOptions): Promise<SerpApiOutcome> {
    const startedAt = this.now();
    const engine = readEngine(params);
    let url = "";
    try {
      url = this.redactedUrl(params);
    } catch (error) {
      return {
        ok: false,
        engine,
        kind: "usage",
        error: messageOf(error),
        url: `${this.baseUrl}?engine=${engine}`,
        elapsedMs: this.now() - startedAt,
      };
    }
    try {
      const json = await this.search(params, options);
      return { ok: true, engine, json, url, elapsedMs: this.now() - startedAt };
    } catch (error) {
      const kind: SerpApiErrorKind =
        error instanceof SerpApiRequestError
          ? error.kind
          : error instanceof SerpApiUsageError
            ? "usage"
            : "network";
      const status = error instanceof SerpApiRequestError ? error.status : undefined;
      return {
        ok: false,
        engine,
        kind,
        error: messageOf(error),
        url,
        elapsedMs: this.now() - startedAt,
        ...(status === undefined ? {} : { status }),
      };
    }
  }

  private async fetchText(
    params: SerpApiParams,
    options?: RequestOptions,
  ): Promise<{ text: string; status: number; url: string }> {
    const url = this.buildUrl(params);
    const safeUrl = redactUrl(url);
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortFromCaller = () => controller.abort();
    options?.signal?.addEventListener("abort", abortFromCaller);

    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        // No Authorization header on purpose: query-string auth is the only
        // documented scheme for /search.
        headers: { accept: "application/json, text/plain, */*" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new SerpApiRequestError(
          `SerpApi returned HTTP ${response.status}`,
          "http",
          safeUrl,
          response.status,
        );
      }
      return { text: await response.text(), status: response.status, url: safeUrl };
    } catch (error) {
      if (error instanceof SerpApiRequestError) throw error;
      if (timedOut) {
        throw new SerpApiRequestError(`request exceeded ${timeoutMs}ms`, "timeout", safeUrl);
      }
      if (options?.signal?.aborted) {
        throw new SerpApiRequestError("request cancelled by caller", "network", safeUrl);
      }
      throw new SerpApiRequestError(messageOf(error), "network", safeUrl);
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

/**
 * Field projections, kept beside the client because they are a wire concern.
 *
 * They are opt-in rather than default: a restrictor that omits a key the
 * decision logic reads turns a real answer into `unknown`, and the whole point
 * of `unknown` is that it denies the act. Cheaper is not worth a false denial
 * unless the caller has looked at what is being dropped.
 */
export const DILIGENCE_JSON_RESTRICTORS: Partial<Record<EngineName, string>> = {
  google: "search_information,organic_results[].{title,link,snippet,displayed_link}",
  google_light: "search_information,organic_results[].{title,link,snippet}",
  google_news: "news_results[].{title,link,snippet,date,source}",
  google_patents: "organic_results[].{title,patent_id,assignee,grant_date,snippet},summary",
  google_scholar_case_law: "case_results[].{title,link,snippet,publication_info}",
  google_maps:
    "place_results.{title,link,rating,reviews,unclaimed_listing,data_id,data_cid,place_id,address}," +
    "local_results[].{title,link,rating,reviews,unclaimed_listing,data_id,place_id,address}",
  google_maps_reviews: "place_info,reviews[].{rating,date,iso_date,snippet,link,user}",
  google_trends: "interest_over_time.{timeline_data,averages}",
  google_ads_transparency_center:
    "ad_creatives[].{advertiser,advertiser_id,link,target_domain,first_shown,last_shown,format}",
  amazon: "organic_results[].{title,link,brand,asin,rating}",
  google_finance: "summary,markets",
};

function sortedEntries(params: SerpApiParams): [string, unknown][] {
  return Object.entries(params as unknown as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function serializeParam(value: unknown): string {
  return typeof value === "boolean" ? (value ? "true" : "false") : String(value);
}

function readEngine(params: SerpApiParams): EngineName {
  return (params as { engine: EngineName }).engine;
}

/**
 * Outcomes are persisted next to decisions, so the key must not survive into
 * one. Redaction happens at the boundary rather than at the log site, because
 * a log site is easy to add and easy to forget.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("api_key")) parsed.searchParams.set("api_key", "REDACTED");
    return parsed.toString();
  } catch {
    return url.replace(/api_key=[^&]*/g, "api_key=REDACTED");
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

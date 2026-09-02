/**
 * Shared test scaffolding: fixture loading, a routing fake fetch, and the two
 * subjects the suite exercises — one that should survive contact with reality
 * and one that should not.
 *
 * No test in this directory touches the network, and none needs an API key.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  DiligenceSubject,
  EngineName,
  FetchLike,
  SerpApiErrorKind,
  SerpApiJson,
  SerpApiOutcome,
} from "../../src/lib/adapters/serpapi";

const FIXTURE_ROOT = new URL("../fixtures/serpapi/", import.meta.url);

export function loadFixture(relative: string): SerpApiJson {
  const path = fileURLToPath(new URL(relative, FIXTURE_ROOT));
  return JSON.parse(readFileSync(path, "utf8")) as SerpApiJson;
}

export interface FakeRoute {
  engine: EngineName;
  /** Decoded-URL substring that must be present for this route to answer. */
  match?: string;
  /** Fixture path under tests/fixtures/serpapi, or a literal body. */
  fixture?: string;
  body?: string;
  status?: number;
  ok?: boolean;
}

export interface FakeFetch {
  fetchImpl: FetchLike;
  /** Redacted-free record of every URL requested, in call order. */
  calls: string[];
}

/**
 * Answers from fixtures, keyed by engine and an optional query substring. An
 * unrouted request rejects loudly rather than resolving to an empty body: a
 * silent empty answer would look like a real "found nothing" and quietly turn
 * a test's expected verdict into an accident.
 */
export function fakeFetch(routes: readonly FakeRoute[]): FakeFetch {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const decoded = decodeURIComponent(url);
    const engine = new URL(url).searchParams.get("engine");
    const route = routes.find(
      (candidate) =>
        candidate.engine === engine &&
        (candidate.match === undefined || decoded.includes(candidate.match)),
    );
    if (route === undefined) {
      throw new Error(`no fake route for ${decoded}`);
    }
    const body =
      route.body ?? (route.fixture ? JSON.stringify(loadFixture(route.fixture)) : "{}");
    return {
      ok: route.ok ?? true,
      status: route.status ?? 200,
      text: async () => body,
    };
  };
  return { fetchImpl, calls };
}

/** Never settles until aborted, so the client's own timeout is what fires. */
export function hangingFetch(): FetchLike {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
}

export function okOutcome(engine: EngineName, json: SerpApiJson): SerpApiOutcome {
  return {
    ok: true,
    engine,
    json,
    url: `https://serpapi.com/search.json?api_key=REDACTED&engine=${engine}`,
    elapsedMs: 12,
  };
}

export function errorOutcome(
  engine: EngineName,
  kind: SerpApiErrorKind = "timeout",
  error = "request exceeded 4000ms",
): SerpApiOutcome {
  return {
    ok: false,
    engine,
    kind,
    error,
    url: `https://serpapi.com/search.json?api_key=REDACTED&engine=${engine}`,
    elapsedMs: 4000,
  };
}

/** The negative-path subject: a name that is already somebody else's. */
export const NORTHWIND: DiligenceSubject = {
  name: "Northwind Logistics",
  legalName: "Northwind Logistics Group, Inc.",
  domain: "northwindlogistics.com",
  country: "US",
  locality: "Austin, Texas, United States",
  ticker: "NWLG:NASDAQ",
};

/** The clean subject: nothing in the world objects to it. */
export const QUILLSWORTH: DiligenceSubject = {
  name: "Quillsworth Advisory",
  legalName: "Quillsworth Advisory Ltd",
  domain: "quillsworth.com",
  country: "GB",
  locality: "Leeds, United Kingdom",
};

/** Every engine answers, and every answer says the name is taken. */
export const FLAGGED_ROUTES: readonly FakeRoute[] = [
  { engine: "google", match: "trademark", fixture: "google/trademark-collision.json" },
  { engine: "google", match: "site:linkedin.com/company", fixture: "google/empty.json" },
  { engine: "google", match: "fraud OR lawsuit", fixture: "google/adverse-web.json" },
  {
    engine: "google_scholar_case_law",
    match: "trademark",
    fixture: "google_scholar_case_law/trademark-opposition.json",
  },
  {
    engine: "google_scholar_case_law",
    match: "patent",
    fixture: "google_scholar_case_law/patent-case.json",
  },
  { engine: "google_light", fixture: "google_light/brand-operator.json" },
  {
    engine: "google_ads_transparency_center",
    fixture: "google_ads_transparency_center/active-advertiser.json",
  },
  { engine: "amazon", fixture: "amazon/brand-products.json" },
  { engine: "google_trends", fixture: "google_trends/rising-interest.json" },
  { engine: "google_maps", fixture: "google_maps/unclaimed-listing.json" },
  { engine: "google_maps_reviews", fixture: "google_maps_reviews/one-star-spike.json" },
  { engine: "google_news", fixture: "google_news/adverse.json" },
  { engine: "google_patents", fixture: "google_patents/litigation-hits.json" },
  { engine: "google_finance", fixture: "google_finance/listed-issuer.json" },
];

/** Every engine answers, and nothing objects. */
export const CLEAR_ROUTES: readonly FakeRoute[] = [
  { engine: "google", match: "trademark", fixture: "google/trademark-clear.json" },
  {
    engine: "google",
    match: "site:linkedin.com/company",
    fixture: "google/corporate-presence.json",
  },
  { engine: "google", match: "fraud OR lawsuit", fixture: "google/empty.json" },
  { engine: "google_scholar_case_law", fixture: "google_scholar_case_law/empty.json" },
  { engine: "google_light", fixture: "google_light/no-operator.json" },
  {
    engine: "google_ads_transparency_center",
    fixture: "google_ads_transparency_center/none.json",
  },
  { engine: "amazon", fixture: "amazon/none.json" },
  { engine: "google_trends", fixture: "google_trends/flat.json" },
  { engine: "google_maps", fixture: "google_maps/claimed-listing.json" },
  { engine: "google_maps_reviews", fixture: "google_maps_reviews/healthy.json" },
  { engine: "google_news", fixture: "google_news/benign.json" },
  { engine: "google_patents", fixture: "google_patents/no-litigation.json" },
];

/** Every engine answers with a well-formed body carrying no result block. */
export const SPARSE_ROUTES: readonly FakeRoute[] = [
  { engine: "google", fixture: "google/sparse.json" },
  { engine: "google_scholar_case_law", fixture: "google_scholar_case_law/sparse.json" },
  { engine: "google_light", fixture: "google_light/sparse.json" },
  {
    engine: "google_ads_transparency_center",
    fixture: "google_ads_transparency_center/sparse.json",
  },
  { engine: "amazon", fixture: "amazon/sparse.json" },
  { engine: "google_trends", fixture: "google_trends/sparse.json" },
  { engine: "google_maps", fixture: "google_maps/sparse.json" },
  { engine: "google_maps_reviews", fixture: "google_maps_reviews/sparse.json" },
  { engine: "google_news", fixture: "google_news/sparse.json" },
  { engine: "google_patents", fixture: "google_patents/sparse.json" },
  { engine: "google_finance", fixture: "google_finance/sparse.json" },
];

export const ALL_FIXTURE_PATHS: readonly string[] = [
  "amazon/brand-products.json",
  "amazon/none.json",
  "amazon/sparse.json",
  "errors/backend-error.json",
  "errors/rate-limit.json",
  "google/adverse-web.json",
  "google/corporate-presence.json",
  "google/empty.json",
  "google/error-invalid-key.json",
  "google/sparse.json",
  "google/trademark-clear.json",
  "google/trademark-collision.json",
  "google_ads_transparency_center/active-advertiser.json",
  "google_ads_transparency_center/none.json",
  "google_ads_transparency_center/sparse.json",
  "google_finance/listed-issuer.json",
  "google_finance/sparse.json",
  "google_light/brand-operator.json",
  "google_light/no-operator.json",
  "google_light/sparse.json",
  "google_maps/claimed-listing.json",
  "google_maps/sparse.json",
  "google_maps/unclaimed-listing.json",
  "google_maps_reviews/healthy.json",
  "google_maps_reviews/one-star-spike.json",
  "google_maps_reviews/sparse.json",
  "google_news/adverse.json",
  "google_news/benign.json",
  "google_news/sparse.json",
  "google_patents/litigation-hits.json",
  "google_patents/no-litigation.json",
  "google_patents/sparse.json",
  "google_scholar_case_law/empty.json",
  "google_scholar_case_law/patent-case.json",
  "google_scholar_case_law/sparse.json",
  "google_scholar_case_law/trademark-opposition.json",
  "google_trends/flat.json",
  "google_trends/rising-interest.json",
  "google_trends/sparse.json",
];

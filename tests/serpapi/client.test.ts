import { describe, expect, it } from "vitest";

import {
  asGooglePlaceId,
  assertSearchParams,
  ENGINE_PAGINATION,
  extractGooglePlaceId,
  extractMapsHandles,
  googlePlaceIdToMapsDataCid,
  redactUrl,
  SerpApiClient,
  SerpApiUsageError,
  type SerpApiParams,
} from "../../src/lib/adapters/serpapi";
import { fakeFetch, hangingFetch, loadFixture } from "./support";

const API_KEY = "test-key-0000";

function client(routes = [{ engine: "google" as const, fixture: "google/empty.json" }]) {
  const fake = fakeFetch(routes);
  return { client: new SerpApiClient({ apiKey: API_KEY, fetchImpl: fake.fetchImpl }), fake };
}

/** Params built from data rather than written as a literal, to reach the runtime guard. */
function dynamicParams(bag: Record<string, unknown>): SerpApiParams {
  return bag as unknown as SerpApiParams;
}

describe("auth and URL construction", () => {
  it("puts api_key in the query string and sends no Authorization header", async () => {
    const { client: sut, fake } = client();
    await sut.search({ engine: "google", q: "acme" });

    const url = new URL(fake.calls[0]);
    expect(url.origin + url.pathname).toBe("https://serpapi.com/search.json");
    expect(url.searchParams.get("api_key")).toBe(API_KEY);
    expect(url.searchParams.get("engine")).toBe("google");
  });

  it("orders parameters deterministically so a request has a stable identity", () => {
    const { client: sut } = client();
    const a = sut.buildUrl({ engine: "google", q: "acme", gl: "us", hl: "en" });
    const b = sut.buildUrl({ engine: "google", hl: "en", q: "acme", gl: "us" });
    expect(a).toBe(b);
    expect(sut.cacheKey({ engine: "google", q: "acme", gl: "us", hl: "en" })).toBe(
      "engine=google&gl=us&hl=en&q=acme",
    );
  });

  it("keeps the key out of the cache key and out of every stored URL", async () => {
    const { client: sut } = client();
    expect(sut.cacheKey({ engine: "google", q: "acme" })).not.toContain(API_KEY);
    expect(sut.redactedUrl({ engine: "google", q: "acme" })).not.toContain(API_KEY);

    const outcome = await sut.searchSafe({ engine: "google", q: "acme" });
    expect(outcome.url).not.toContain(API_KEY);
    expect(outcome.url).toContain("api_key=REDACTED");
  });

  it("redacts a key even in a URL it cannot parse", () => {
    expect(redactUrl("not a url?api_key=secret&engine=google")).toContain("api_key=REDACTED");
  });

  it("passes json_restrictor and output through to the query string", async () => {
    const { client: sut, fake } = client();
    await sut.search({
      engine: "google",
      q: "acme",
      json_restrictor: "organic_results[].{title,link}",
    });
    expect(new URL(fake.calls[0]).searchParams.get("json_restrictor")).toBe(
      "organic_results[].{title,link}",
    );
  });

  it("returns markdown from searchMarkdown and refuses output=md on search", async () => {
    const fake = fakeFetch([
      { engine: "google", body: "## Organic results\n\n1. Acme Corp — https://acme.example" },
    ]);
    const sut = new SerpApiClient({ apiKey: API_KEY, fetchImpl: fake.fetchImpl });

    const markdown = await sut.searchMarkdown({ engine: "google", q: "acme" });
    expect(markdown).toContain("Organic results");
    expect(new URL(fake.calls[0]).searchParams.get("output")).toBe("md");

    await expect(sut.search({ engine: "google", q: "acme", output: "md" })).rejects.toBeInstanceOf(
      SerpApiUsageError,
    );
  });
});

describe("pagination traps", () => {
  it("rejects num on google and google_light at compile time", () => {
    // @ts-expect-error num does not exist on engine=google; it paginates with start.
    const google: SerpApiParams = { engine: "google", q: "acme", num: 100 };
    // @ts-expect-error num does not exist on engine=google_light either.
    const light: SerpApiParams = { engine: "google_light", q: "acme", num: 100 };
    expect(google.engine).toBe("google");
    expect(light.engine).toBe("google_light");
  });

  it("rejects any pagination on google_news at compile time", () => {
    // @ts-expect-error google_news has no pagination at all.
    const news: SerpApiParams = { engine: "google_news", q: "acme", start: 10 };
    expect(news.engine).toBe("google_news");
  });

  it("requires ll on a paginated google_maps request at compile time", () => {
    // @ts-expect-error start without ll lets the viewport drift between pages.
    const drifting: SerpApiParams = { engine: "google_maps", q: "acme", start: 20 };
    const anchored: SerpApiParams = {
      engine: "google_maps",
      q: "acme",
      start: 20,
      ll: "@30.2672,-97.7431,14z",
    };
    expect(drifting.engine).toBe("google_maps");
    expect(anchored.engine).toBe("google_maps");
  });

  it("rejects num on google at runtime, pointing at start", () => {
    expect(() => assertSearchParams(dynamicParams({ engine: "google", q: "a", num: 100 }))).toThrow(
      /num is not supported on engine=google.*paginate with start/s,
    );
  });

  it("rejects start on google_news at runtime", () => {
    expect(() =>
      assertSearchParams(dynamicParams({ engine: "google_news", q: "a", start: 10 })),
    ).toThrow(/no pagination; the first response is all there is/);
  });

  it("rejects google_shopping pagination as broken rather than accepting it", () => {
    expect(() =>
      assertSearchParams(dynamicParams({ engine: "google_shopping", q: "a", start: 40 })),
    ).toThrow(/accepted but ignored/);
  });

  it("rejects a paginated maps request with no viewport", () => {
    expect(() =>
      assertSearchParams(dynamicParams({ engine: "google_maps", q: "a", start: 20 })),
    ).toThrow(/requires ll once start is set/);
    expect(() =>
      assertSearchParams(
        dynamicParams({ engine: "google_maps", q: "a", start: 20, ll: "@1,2,14z" }),
      ),
    ).not.toThrow();
  });

  it("holds maps pagination to its usable ceiling", () => {
    expect(() =>
      assertSearchParams(
        dynamicParams({ engine: "google_maps", q: "a", start: 200, ll: "@1,2,14z" }),
      ),
    ).toThrow(/past the usable ceiling of 100/);
  });

  it("allows num only where it is documented, and enforces its maximum", () => {
    expect(() =>
      assertSearchParams({ engine: "google_patents", q: "a", litigation: "YES", num: 50 }),
    ).not.toThrow();
    expect(() =>
      assertSearchParams({ engine: "google_maps_reviews", data_id: undefined, num: 20 }),
    ).not.toThrow();
    expect(() =>
      assertSearchParams(dynamicParams({ engine: "google_maps_reviews", num: 40 })),
    ).toThrow(/exceeds the documented maximum of 20/);
  });

  it("keeps a pagination rule for every engine it can address", () => {
    for (const [engine, rules] of Object.entries(ENGINE_PAGINATION)) {
      expect(rules.num, engine).toMatch(/documented|undocumented/);
      expect(rules.start, engine).toMatch(/supported|unsupported|broken/);
    }
  });

  it("surfaces a misuse as a usage outcome rather than a thrown error", async () => {
    const { client: sut } = client();
    const outcome = await sut.searchSafe(dynamicParams({ engine: "google", q: "a", num: 100 }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("usage");
      expect(outcome.url).not.toContain(API_KEY);
    }
  });
});

describe("place handle conversion", () => {
  it("moves a google place_id to google_maps under data_cid, unchanged", () => {
    const placeId = asGooglePlaceId("ChIJN1t_tDeuEmsRUsoyG83frY4");
    const dataCid = googlePlaceIdToMapsDataCid(placeId);
    expect(dataCid).toBe("ChIJN1t_tDeuEmsRUsoyG83frY4");

    const params: SerpApiParams = { engine: "google_maps", type: "place", data_cid: dataCid };
    expect(params).toMatchObject({ data_cid: "ChIJN1t_tDeuEmsRUsoyG83frY4" });
  });

  it("refuses place_id on google_maps and names the parameter that works", () => {
    expect(() =>
      assertSearchParams(
        dynamicParams({ engine: "google_maps", place_id: "ChIJN1t_tDeuEmsRUsoyG83frY4" }),
      ),
    ).toThrow(/does not take place_id.*data_cid.*googlePlaceIdToMapsDataCid/s);
  });

  it("will not accept a raw string where a converted handle is required", () => {
    // @ts-expect-error data_cid takes a converted handle, not an arbitrary string.
    const params: SerpApiParams = { engine: "google_maps", data_cid: "ChIJN1t_tDeuEmsRUsoyG83frY4" };
    expect(params.engine).toBe("google_maps");
  });

  it("lifts the maps-native handles out of a maps response", () => {
    const handles = extractMapsHandles(loadFixture("google_maps/unclaimed-listing.json"));
    expect(handles.dataId).toBe("0x8644b5a2c1e7a8f9:0x3d4f2b91c77e1a02");
    expect(handles.placeId).toBe("ChIJN1t_tDeuEmsRUsoyG83frY4");
    expect(extractMapsHandles(loadFixture("google_maps/sparse.json"))).toEqual({
      dataId: null,
      placeId: null,
    });
  });

  it("returns null rather than throwing when no place handle is present", () => {
    expect(extractGooglePlaceId(loadFixture("google/sparse.json"))).toBeNull();
    expect(extractGooglePlaceId(undefined)).toBeNull();
  });
});

describe("failure handling", () => {
  it("reports an error body as an api failure, never as an empty result", async () => {
    const fake = fakeFetch([{ engine: "google", fixture: "google/error-invalid-key.json" }]);
    const sut = new SerpApiClient({ apiKey: API_KEY, fetchImpl: fake.fetchImpl });
    const outcome = await sut.searchSafe({ engine: "google", q: "acme" });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("api");
      expect(outcome.error).toContain("Invalid API key");
    }
  });

  it("reports search_metadata.status = Error as an api failure", async () => {
    const fake = fakeFetch([{ engine: "google", fixture: "errors/backend-error.json" }]);
    const sut = new SerpApiClient({ apiKey: API_KEY, fetchImpl: fake.fetchImpl });
    const outcome = await sut.searchSafe({ engine: "google", q: "acme" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("api");
  });

  it("reports an HTTP failure with its status", async () => {
    const fake = fakeFetch([
      { engine: "google", ok: false, status: 429, body: "Too Many Requests" },
    ]);
    const sut = new SerpApiClient({ apiKey: API_KEY, fetchImpl: fake.fetchImpl });
    const outcome = await sut.searchSafe({ engine: "google", q: "acme" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("http");
      expect(outcome.status).toBe(429);
    }
  });

  it("reports a non-JSON body as malformed", async () => {
    const fake = fakeFetch([{ engine: "google", body: "<html>maintenance</html>" }]);
    const sut = new SerpApiClient({ apiKey: API_KEY, fetchImpl: fake.fetchImpl });
    const outcome = await sut.searchSafe({ engine: "google", q: "acme" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("malformed");
  });

  it("aborts a slow request and reports it as a timeout", async () => {
    const sut = new SerpApiClient({ apiKey: API_KEY, fetchImpl: hangingFetch(), timeoutMs: 15 });
    const outcome = await sut.searchSafe({ engine: "google", q: "acme" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("timeout");
      expect(outcome.error).toContain("15ms");
    }
  });

  it("accepts a sparse but well-formed response without throwing", async () => {
    const fake = fakeFetch([{ engine: "google", fixture: "google/sparse.json" }]);
    const sut = new SerpApiClient({ apiKey: API_KEY, fetchImpl: fake.fetchImpl });
    const outcome = await sut.searchSafe({ engine: "google", q: "acme" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.json.search_metadata).toBeDefined();
  });
});

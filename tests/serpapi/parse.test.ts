import { describe, expect, it } from "vitest";

import {
  hostOf,
  isUsableResponse,
  mentions,
  normalizeText,
  readApiError,
  slugify,
  toCitation,
  toCitations,
} from "../../src/lib/adapters/serpapi";
import { RESULT_KEYS } from "../../src/lib/adapters/serpapi/rules";
import { ALL_FIXTURE_PATHS, loadFixture } from "./support";

describe("polymorphic response handling", () => {
  it("survives every captured fixture without throwing", () => {
    for (const path of ALL_FIXTURE_PATHS) {
      const json = loadFixture(path);
      expect(() => {
        for (const keys of Object.values(RESULT_KEYS)) isUsableResponse(json, keys);
        readApiError(json);
        toCitations("google", [json], 3);
      }, path).not.toThrow();
    }
  });

  it("survives shapes SerpApi never sends, which is where real crashes come from", () => {
    for (const value of [null, undefined, 0, "", [], { organic_results: "not-an-array" }]) {
      expect(isUsableResponse(value, ["organic_results"])).toBe(false);
      expect(readApiError(value)).toBeNull();
      expect(toCitation("google", value)).toBeNull();
    }
  });

  it("treats an empty result array as an answer and a missing one as no answer", () => {
    expect(isUsableResponse({ organic_results: [] }, ["organic_results"])).toBe(true);
    expect(
      isUsableResponse(loadFixture("google/trademark-clear.json"), ["organic_results"]),
      "search_information reporting an empty state is still an answer",
    ).toBe(true);
    expect(
      isUsableResponse(loadFixture("google/sparse.json"), ["organic_results"]),
      "a metadata-only body is not an answer",
    ).toBe(false);
  });

  it("reads both of SerpApi's error channels", () => {
    expect(readApiError(loadFixture("errors/rate-limit.json"))).toContain("run out of searches");
    expect(readApiError(loadFixture("errors/backend-error.json"))).toContain("hasn't returned");
    expect(readApiError(loadFixture("google/trademark-collision.json"))).toBeNull();
  });

  it("finds case law under case_results, where that engine actually puts it", () => {
    const caseLaw = loadFixture("google_scholar_case_law/trademark-opposition.json");
    expect(isUsableResponse(caseLaw, RESULT_KEYS.google_scholar_case_law)).toBe(true);
    expect(isUsableResponse(caseLaw, ["organic_results"])).toBe(false);
  });
});

describe("citations", () => {
  it("cites a clickable patent page rather than a storage-bucket PDF", () => {
    const patents = loadFixture("google_patents/litigation-hits.json");
    const results = patents.organic_results as unknown[];
    const citations = toCitations("google_patents", results, 3);
    expect(citations[0].url).toBe("https://patents.google.com/patent/US10482419B2/en");
    expect(citations[0].engine).toBe("google_patents");
  });

  it("drops a result with no resolvable link instead of inventing one", () => {
    expect(toCitation("google", { title: "No link here" })).toBeNull();
    expect(toCitation("google", { title: "Relative", link: "/local/path" })).toBeNull();
  });

  it("uses whichever title-ish field an engine happens to provide", () => {
    const ads = loadFixture("google_ads_transparency_center/active-advertiser.json");
    const citations = toCitations("google_ads_transparency_center", ads.ad_creatives as unknown[], 2);
    expect(citations[0].title).toContain("Northwind Logistics Group");
  });

  it("deduplicates by URL so one source cannot be counted twice", () => {
    const record = { title: "Same", link: "https://example.com/a" };
    expect(toCitations("google", [record, record, record], 5)).toHaveLength(1);
  });
});

describe("name matching", () => {
  it("folds case, accents and punctuation", () => {
    expect(normalizeText("Ácme, Inc.")).toBe("acme inc");
    expect(slugify("Northwind Logistics")).toBe("northwindlogistics");
  });

  it("matches a name as a phrase or as its run-together domain form", () => {
    expect(mentions("Welcome to Northwind Logistics", "Northwind Logistics")).toBe(true);
    expect(mentions("https://northwindlogistics.com/about", "Northwind Logistics")).toBe(true);
  });

  it("does not match scattered words, which would make every check noise", () => {
    expect(mentions("northwind winds and general logistics advice", "Northwind Logistics")).toBe(
      false,
    );
    expect(mentions("anything", "")).toBe(false);
  });

  it("normalises hosts the way a registrable name is compared", () => {
    expect(hostOf("https://www.Northwindlogistics.com/x?y=1")).toBe("northwindlogistics.com");
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf(null)).toBeNull();
  });
});

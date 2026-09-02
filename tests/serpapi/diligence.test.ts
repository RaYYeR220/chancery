import { describe, expect, it } from "vitest";

import type { DiligenceCheck } from "../../src/lib/core/types";
import {
  DILIGENCE_ENGINES,
  gatherEvidence,
  googlePlaceIdToMapsDataCid,
  asGooglePlaceId,
  asMapsDataId,
  planFollowUpProbes,
  planProbes,
  runDiligence,
  SerpApiClient,
  withDeadline,
  type EngineName,
  type FetchLike,
  type SerpApiParams,
} from "../../src/lib/adapters/serpapi";
import {
  CLEAR_ROUTES,
  fakeFetch,
  FLAGGED_ROUTES,
  hangingFetch,
  loadFixture,
  NORTHWIND,
  okOutcome,
  QUILLSWORTH,
  SPARSE_ROUTES,
  type FakeRoute,
} from "./support";

const ALL_CHECKS: DiligenceCheck[] = [
  "trademark_clear",
  "no_brand_collision",
  "counterparty_exists",
  "no_adverse_media",
  "no_patent_litigation",
];

function makeClient(routes: readonly FakeRoute[]) {
  const fake = fakeFetch(routes);
  return {
    client: new SerpApiClient({ apiKey: "test-key", fetchImpl: fake.fetchImpl }),
    fake,
  };
}

function bagOf(params: SerpApiParams): Record<string, unknown> {
  return params as unknown as Record<string, unknown>;
}

describe("probe planning", () => {
  it("never asks google for a page size it silently ignores", () => {
    for (const check of ALL_CHECKS) {
      for (const params of planProbes(check, NORTHWIND)) {
        if (params.engine === "google" || params.engine === "google_light") {
          expect(bagOf(params).num, check).toBeUndefined();
        }
      }
    }
  });

  it("sends google_news with no pagination parameters at all", () => {
    const news = planProbes("no_adverse_media", NORTHWIND).find(
      (params) => params.engine === "google_news",
    );
    expect(news).toBeDefined();
    const bag = bagOf(news as SerpApiParams);
    expect(bag.start).toBeUndefined();
    expect(bag.num).toBeUndefined();
    expect(bag.page).toBeUndefined();
  });

  it("uses the litigation flag on google_patents, which is the direct answer", () => {
    const patents = planProbes("no_patent_litigation", NORTHWIND).find(
      (params) => params.engine === "google_patents",
    );
    // Confirmed against a live key: SerpApi takes the literal "YES"/"NO" here
    // and rejects a boolean outright, so the wrong spelling fails loudly rather
    // than silently widening the search to every patent naming the assignee.
    expect(bagOf(patents as SerpApiParams).litigation).toBe("YES");
  });

  it("sorts reviews newest first, so a recent collapse is not hidden by an average", () => {
    const probes = planProbes("counterparty_exists", {
      ...NORTHWIND,
      mapsDataId: asMapsDataId("0x8644b5a2c1e7a8f9:0x3d4f2b91c77e1a02"),
    });
    const reviews = probes.find((params) => params.engine === "google_maps_reviews");
    expect(bagOf(reviews as SerpApiParams).sort_by).toBe("newestFirst");
    expect(bagOf(reviews as SerpApiParams).num).toBe(20);
  });

  it("passes a converted google place handle to maps as data_cid, never place_id", () => {
    const dataCid = googlePlaceIdToMapsDataCid(asGooglePlaceId("ChIJN1t_tDeuEmsRUsoyG83frY4"));
    const probes = planProbes("counterparty_exists", { ...NORTHWIND, mapsDataCid: dataCid });
    const maps = bagOf(probes.find((params) => params.engine === "google_maps") as SerpApiParams);
    expect(maps.data_cid).toBe("ChIJN1t_tDeuEmsRUsoyG83frY4");
    expect(maps.place_id).toBeUndefined();
    expect(maps.type).toBe("place");
  });

  it("carries the viewport when the subject has one and omits it otherwise", () => {
    const anchored = planProbes("counterparty_exists", { ...NORTHWIND, ll: "@30.26,-97.74,13z" });
    const maps = bagOf(anchored.find((p) => p.engine === "google_maps") as SerpApiParams);
    expect(maps.ll).toBe("@30.26,-97.74,13z");

    const plain = planProbes("counterparty_exists", NORTHWIND);
    expect(bagOf(plain.find((p) => p.engine === "google_maps") as SerpApiParams).ll).toBeUndefined();
  });

  it("chains reviews off a maps lookup, using the maps-native handle", () => {
    const maps = okOutcome("google_maps", loadFixture("google_maps/unclaimed-listing.json"));
    const follow = planFollowUpProbes("counterparty_exists", NORTHWIND, [maps]);
    expect(follow).toHaveLength(1);
    const bag = bagOf(follow[0]);
    expect(bag.engine).toBe("google_maps_reviews");
    expect(bag.data_id).toBe("0x8644b5a2c1e7a8f9:0x3d4f2b91c77e1a02");
  });

  it("does not chain a follow-up off a maps lookup that failed", () => {
    const sparse = okOutcome("google_maps", loadFixture("google_maps/sparse.json"));
    expect(planFollowUpProbes("counterparty_exists", NORTHWIND, [sparse])).toHaveLength(0);
    expect(planFollowUpProbes("trademark_clear", NORTHWIND, [])).toHaveLength(0);
  });

  it("plans only engines the check declares, across nine or more engines overall", () => {
    const used = new Set<EngineName>();
    for (const check of ALL_CHECKS) {
      for (const params of planProbes(check, NORTHWIND)) {
        expect(DILIGENCE_ENGINES[check], `${check}/${params.engine}`).toContain(params.engine);
        used.add(params.engine);
      }
    }
    for (const engines of Object.values(DILIGENCE_ENGINES)) for (const e of engines) used.add(e);
    expect(used.size).toBeGreaterThanOrEqual(9);
    expect(used.size).toBe(11);
  });
});

describe("end to end", () => {
  it("denies a name the world has already taken, on every check", async () => {
    const { client, fake } = makeClient(FLAGGED_ROUTES);
    const findings = await runDiligence(client, NORTHWIND, ALL_CHECKS);

    expect(findings.map((f) => f.check)).toEqual(ALL_CHECKS);
    expect(findings.map((f) => f.verdict)).toEqual([
      "flagged",
      "flagged",
      "flagged",
      "flagged",
      "flagged",
    ]);
    for (const finding of findings) {
      expect(finding.citations.length, finding.check).toBeGreaterThan(0);
      for (const citation of finding.citations) {
        expect(citation.url, finding.check).toMatch(/^https:\/\//);
        expect(citation.title.length, finding.check).toBeGreaterThan(0);
      }
    }
    // 2 + 4 + 3 first-wave probes plus the chained reviews lookup, 2 and 2.
    expect(fake.calls).toHaveLength(14);
  });

  it("clears a name nothing objects to", async () => {
    const { client } = makeClient(CLEAR_ROUTES);
    const findings = await runDiligence(client, QUILLSWORTH, ALL_CHECKS);
    expect(findings.map((f) => f.verdict)).toEqual([
      "clear",
      "clear",
      "clear",
      "clear",
      "clear",
    ]);
  });

  it("returns unknown for every check when the responses carry no results", async () => {
    const { client } = makeClient(SPARSE_ROUTES);
    const findings = await runDiligence(client, NORTHWIND, ALL_CHECKS);
    expect(findings.every((f) => f.verdict === "unknown")).toBe(true);
    expect(findings.every((f) => f.citations.length === 0)).toBe(true);
  });

  it("returns unknown, never clear, when SerpApi is down", async () => {
    const { client } = makeClient([
      ...ALL_ENGINES.map((engine) => ({ engine, ok: false, status: 503, body: "down" })),
    ]);
    const findings = await runDiligence(client, NORTHWIND, ALL_CHECKS);
    expect(findings.every((f) => f.verdict === "unknown")).toBe(true);
  });

  it("collapses a check requested twice into one run", async () => {
    const { client, fake } = makeClient(FLAGGED_ROUTES);
    const findings = await runDiligence(client, NORTHWIND, [
      "trademark_clear",
      "trademark_clear",
    ]);
    expect(findings).toHaveLength(1);
    expect(fake.calls).toHaveLength(2);
  });

  it("keeps the api key out of every stored outcome URL", async () => {
    const { client } = makeClient(FLAGGED_ROUTES);
    const evidence = await gatherEvidence(client, NORTHWIND, "trademark_clear");
    for (const probe of evidence.probes) {
      expect(probe.url).toContain("api_key=REDACTED");
      expect(probe.url).not.toContain("test-key");
    }
  });

  it("applies json_restrictor only when the caller opts in", async () => {
    const { client, fake } = makeClient(FLAGGED_ROUTES);
    await gatherEvidence(client, NORTHWIND, "trademark_clear");
    expect(fake.calls.some((url) => url.includes("json_restrictor"))).toBe(false);

    const opted = makeClient(FLAGGED_ROUTES);
    await gatherEvidence(opted.client, NORTHWIND, "trademark_clear", { restrict: true });
    expect(opted.fake.calls.some((url) => url.includes("json_restrictor"))).toBe(true);
  });

  it("runs independent probes concurrently", async () => {
    let inFlight = 0;
    let peak = 0;
    const counting: FetchLike = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const client = new SerpApiClient({ apiKey: "test-key", fetchImpl: counting });
    await runDiligence(client, NORTHWIND, ALL_CHECKS);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("time limits", () => {
  it("fails closed on the per-check allowance", async () => {
    const client = new SerpApiClient({ apiKey: "test-key", fetchImpl: hangingFetch() });
    const findings = await runDiligence(client, NORTHWIND, ["trademark_clear"], {
      perProbeTimeoutMs: 5_000,
      perCheckTimeoutMs: 20,
      budgetMs: 5_000,
    });
    expect(findings[0].verdict).toBe("unknown");
    expect(findings[0].summary).toContain("exceeded its 20ms allowance");
    expect(findings[0].citations).toHaveLength(0);
  });

  it("fails closed on the overall budget", async () => {
    const client = new SerpApiClient({ apiKey: "test-key", fetchImpl: hangingFetch() });
    const findings = await runDiligence(client, NORTHWIND, ALL_CHECKS, {
      perProbeTimeoutMs: 5_000,
      perCheckTimeoutMs: 5_000,
      budgetMs: 25,
    });
    expect(findings).toHaveLength(5);
    for (const finding of findings) {
      expect(finding.verdict).toBe("unknown");
      expect(finding.summary).toContain("budget was exhausted");
    }
  });

  it("aborts the underlying request when a probe overruns", async () => {
    const client = new SerpApiClient({ apiKey: "test-key", fetchImpl: hangingFetch() });
    const evidence = await gatherEvidence(client, NORTHWIND, "trademark_clear", {
      perProbeTimeoutMs: 15,
    });
    expect(evidence.probes).toHaveLength(2);
    for (const probe of evidence.probes) {
      expect(probe.ok).toBe(false);
      if (!probe.ok) expect(probe.kind).toBe("timeout");
    }
  });

  it("resolves immediately when there is no time left", async () => {
    const value = await withDeadline(new Promise<string>(() => {}), 0, () => "expired");
    expect(value).toBe("expired");
  });

  it("propagates a rejection rather than swallowing it into a false answer", async () => {
    await expect(
      withDeadline(Promise.reject(new Error("boom")), 1_000, () => "fallback"),
    ).rejects.toThrow("boom");
  });
});

const ALL_ENGINES: EngineName[] = [
  "google",
  "google_light",
  "google_news",
  "google_patents",
  "google_scholar_case_law",
  "google_maps",
  "google_maps_reviews",
  "google_trends",
  "google_ads_transparency_center",
  "amazon",
  "google_finance",
];

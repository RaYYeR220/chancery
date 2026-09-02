import { describe, expect, it } from "vitest";

import type { DiligenceCheck } from "../../src/lib/core/types";
import {
  decide,
  decideCounterpartyExists,
  decideNoAdverseMedia,
  decideNoBrandCollision,
  decideNoPatentLitigation,
  decideTrademarkClear,
  isBlocking,
  type CheckEvidence,
} from "../../src/lib/adapters/serpapi";
import { errorOutcome, loadFixture, NORTHWIND, okOutcome, QUILLSWORTH } from "./support";

const ALL_CHECKS: DiligenceCheck[] = [
  "trademark_clear",
  "no_brand_collision",
  "counterparty_exists",
  "no_adverse_media",
  "no_patent_litigation",
];

describe("trademark_clear", () => {
  const flagged: CheckEvidence = {
    subject: NORTHWIND,
    probes: [
      okOutcome("google", loadFixture("google/trademark-collision.json")),
      okOutcome(
        "google_scholar_case_law",
        loadFixture("google_scholar_case_law/trademark-opposition.json"),
      ),
    ],
  };

  it("flags a live registry record and says which one", () => {
    const finding = decideTrademarkClear(flagged);
    expect(finding.verdict).toBe("flagged");
    expect(finding.summary).toContain("live trademark registry record");
    expect(finding.citations.map((c) => c.url)).toContain(
      "https://tsdr.uspto.gov/statusview/sn97412388",
    );
    expect(finding.citations.every((c) => c.url.startsWith("https://"))).toBe(true);
  });

  it("counts only live marks, so an abandoned record does not block a name", () => {
    const finding = decideTrademarkClear(flagged);
    // The fixture carries two LIVE records and one DEAD/ABANDONED one.
    expect(finding.summary).toContain("2 live trademark registry records");
  });

  it("clears a name with no registry match and names the indexes it checked", () => {
    const finding = decideTrademarkClear({
      subject: QUILLSWORTH,
      probes: [
        okOutcome("google", loadFixture("google/trademark-clear.json")),
        okOutcome("google_scholar_case_law", loadFixture("google_scholar_case_law/empty.json")),
      ],
    });
    expect(finding.verdict).toBe("clear");
    expect(finding.summary).toContain("USPTO");
  });

  it("fails closed on a sparse body rather than reading it as clear", () => {
    const finding = decideTrademarkClear({
      subject: NORTHWIND,
      probes: [
        okOutcome("google", loadFixture("google/sparse.json")),
        okOutcome("google_scholar_case_law", loadFixture("google_scholar_case_law/sparse.json")),
      ],
    });
    expect(finding.verdict).toBe("unknown");
    expect(finding.citations).toHaveLength(0);
    expect(finding.summary).toContain("no readable result block");
  });

  it("fails closed on an API error and repeats the reason", () => {
    const finding = decideTrademarkClear({
      subject: NORTHWIND,
      probes: [errorOutcome("google", "api", "Your account has run out of searches.")],
    });
    expect(finding.verdict).toBe("unknown");
    expect(finding.summary).toContain("run out of searches");
  });

  it("still flags when the registry sweep failed but case law found a proceeding", () => {
    const finding = decideTrademarkClear({
      subject: NORTHWIND,
      probes: [
        errorOutcome("google", "timeout"),
        okOutcome(
          "google_scholar_case_law",
          loadFixture("google_scholar_case_law/trademark-opposition.json"),
        ),
      ],
    });
    expect(finding.verdict).toBe("flagged");
  });
});

describe("no_brand_collision", () => {
  it("flags an operating site, a live advertiser and marketplace listings together", () => {
    const finding = decideNoBrandCollision({
      subject: NORTHWIND,
      probes: [
        okOutcome("google_light", loadFixture("google_light/brand-operator.json")),
        okOutcome(
          "google_ads_transparency_center",
          loadFixture("google_ads_transparency_center/active-advertiser.json"),
        ),
        okOutcome("amazon", loadFixture("amazon/brand-products.json")),
        okOutcome("google_trends", loadFixture("google_trends/rising-interest.json")),
      ],
    });
    expect(finding.verdict).toBe("flagged");
    expect(finding.summary).toContain("northwindlogistics.com");
    expect(finding.summary).toContain("running live ads");
    expect(finding.summary).toContain("marketplace listings");
    expect(finding.citations.length).toBeGreaterThanOrEqual(3);
  });

  it("does not count a directory profile as a second operator", () => {
    const finding = decideNoBrandCollision({
      subject: NORTHWIND,
      probes: [okOutcome("google_light", loadFixture("google_light/brand-operator.json"))],
    });
    // linkedin.com carries the name in its title but is a profile of the same
    // operator, not another one.
    expect(finding.summary).toContain("1 site already operates");
    expect(finding.summary).not.toContain("linkedin.com");
  });

  it("clears a name nobody trades under, and reports trend interest as context only", () => {
    const finding = decideNoBrandCollision({
      subject: QUILLSWORTH,
      probes: [
        okOutcome("google_light", loadFixture("google_light/no-operator.json")),
        okOutcome(
          "google_ads_transparency_center",
          loadFixture("google_ads_transparency_center/none.json"),
        ),
        okOutcome("amazon", loadFixture("amazon/none.json")),
        okOutcome("google_trends", loadFixture("google_trends/flat.json")),
      ],
    });
    expect(finding.verdict).toBe("clear");
  });

  it("never flags on search interest alone", () => {
    const finding = decideNoBrandCollision({
      subject: NORTHWIND,
      probes: [
        okOutcome("google_light", loadFixture("google_light/no-operator.json")),
        okOutcome("google_trends", loadFixture("google_trends/rising-interest.json")),
      ],
    });
    expect(finding.verdict).toBe("clear");
    expect(finding.summary).toContain("generic-term traffic");
  });

  it("fails closed when every commercial sweep is unreadable", () => {
    const finding = decideNoBrandCollision({
      subject: NORTHWIND,
      probes: [
        okOutcome("google_light", loadFixture("google_light/sparse.json")),
        errorOutcome("google_ads_transparency_center", "http", "SerpApi returned HTTP 503"),
        errorOutcome("amazon", "timeout"),
      ],
    });
    expect(finding.verdict).toBe("unknown");
    expect(finding.summary).toContain("HTTP 503");
  });
});

describe("counterparty_exists", () => {
  it("flags an unclaimed listing and a spike of recent one-star reviews", () => {
    const finding = decideCounterpartyExists({
      subject: NORTHWIND,
      probes: [
        okOutcome("google", loadFixture("google/empty.json")),
        okOutcome("google_maps", loadFixture("google_maps/unclaimed-listing.json")),
        okOutcome("google_maps_reviews", loadFixture("google_maps_reviews/one-star-spike.json")),
      ],
    });
    expect(finding.verdict).toBe("flagged");
    expect(finding.summary).toContain("unclaimed");
    expect(finding.summary).toContain("most recent reviews");
    expect(finding.citations.length).toBeGreaterThanOrEqual(2);
  });

  it("clears an entity corroborated by a register, a claimed listing and reviews", () => {
    const finding = decideCounterpartyExists({
      subject: QUILLSWORTH,
      probes: [
        okOutcome("google", loadFixture("google/corporate-presence.json")),
        okOutcome("google_maps", loadFixture("google_maps/claimed-listing.json")),
        okOutcome("google_maps_reviews", loadFixture("google_maps_reviews/healthy.json")),
      ],
    });
    expect(finding.verdict).toBe("clear");
    expect(finding.summary).toContain("opencorporates.com");
    expect(finding.summary).toContain("claimed Google Maps listing");
  });

  it("treats a securities listing as corroboration", () => {
    const finding = decideCounterpartyExists({
      subject: NORTHWIND,
      probes: [
        okOutcome("google", loadFixture("google/empty.json")),
        okOutcome("google_finance", loadFixture("google_finance/listed-issuer.json")),
      ],
    });
    expect(finding.verdict).toBe("clear");
    expect(finding.summary).toContain("NASDAQ");
  });

  it("flags an entity that a completed sweep could not corroborate at all", () => {
    const finding = decideCounterpartyExists({
      subject: NORTHWIND,
      probes: [
        okOutcome("google", loadFixture("google/empty.json")),
        okOutcome("google_maps", loadFixture("google_maps/sparse.json")),
      ],
    });
    expect(finding.verdict).toBe("flagged");
    expect(finding.summary).toContain("No corporate register");
  });

  it("fails closed when nothing was actually searched", () => {
    const finding = decideCounterpartyExists({
      subject: NORTHWIND,
      probes: [errorOutcome("google", "network", "fetch failed"), errorOutcome("google_maps")],
    });
    expect(finding.verdict).toBe("unknown");
  });
});

describe("no_adverse_media", () => {
  it("flags adverse coverage and quotes the headline", () => {
    const finding = decideNoAdverseMedia({
      subject: NORTHWIND,
      probes: [
        okOutcome("google_news", loadFixture("google_news/adverse.json")),
        okOutcome("google", loadFixture("google/adverse-web.json")),
      ],
    });
    expect(finding.verdict).toBe("flagged");
    expect(finding.summary).toContain("SEC opens fraud investigation");
    expect(finding.citations.some((c) => c.engine === "google_news")).toBe(true);
  });

  it("ignores coverage that does not name the subject", () => {
    const finding = decideNoAdverseMedia({
      subject: NORTHWIND,
      probes: [okOutcome("google_news", loadFixture("google_news/adverse.json"))],
    });
    // The fixture's third story is about Texas freight rates generally.
    expect(finding.summary).toContain("2 adverse reports");
  });

  it("clears benign coverage and scopes the claim to one page", () => {
    const finding = decideNoAdverseMedia({
      subject: QUILLSWORTH,
      probes: [
        okOutcome("google_news", loadFixture("google_news/benign.json")),
        okOutcome("google", loadFixture("google/empty.json")),
      ],
    });
    expect(finding.verdict).toBe("clear");
    // google_news cannot be paginated, so the sentence must not claim a sweep.
    expect(finding.summary).toContain("front page");
  });

  it("does not read 'issued' as 'sued'", () => {
    const finding = decideNoAdverseMedia({
      subject: NORTHWIND,
      probes: [
        okOutcome("google_news", {
          news_results: [
            {
              title: "Northwind Logistics issued a new bonded warehouse permit",
              link: "https://example.com/permit",
              source: { name: "Trade Press" },
            },
          ],
        }),
      ],
    });
    expect(finding.verdict).toBe("clear");
  });

  it("fails closed when both news legs are unreadable", () => {
    const finding = decideNoAdverseMedia({
      subject: NORTHWIND,
      probes: [
        okOutcome("google_news", loadFixture("google_news/sparse.json")),
        errorOutcome("google", "timeout"),
      ],
    });
    expect(finding.verdict).toBe("unknown");
  });
});

describe("no_patent_litigation", () => {
  it("flags patents returned under the litigation filter and the matching case", () => {
    const finding = decideNoPatentLitigation({
      subject: NORTHWIND,
      probes: [
        okOutcome("google_patents", loadFixture("google_patents/litigation-hits.json")),
        okOutcome(
          "google_scholar_case_law",
          loadFixture("google_scholar_case_law/patent-case.json"),
        ),
      ],
    });
    expect(finding.verdict).toBe("flagged");
    expect(finding.summary).toContain("2 patents in litigation");
    expect(finding.summary).toContain("Palisade Freight Systems");
    expect(finding.citations.some((c) => c.url.includes("patents.google.com"))).toBe(true);
  });

  it("clears a subject with no disputed patents", () => {
    const finding = decideNoPatentLitigation({
      subject: QUILLSWORTH,
      probes: [
        okOutcome("google_patents", loadFixture("google_patents/no-litigation.json")),
        okOutcome("google_scholar_case_law", loadFixture("google_scholar_case_law/empty.json")),
      ],
    });
    expect(finding.verdict).toBe("clear");
  });

  it("fails closed when neither leg answered", () => {
    const finding = decideNoPatentLitigation({
      subject: NORTHWIND,
      probes: [
        okOutcome("google_patents", loadFixture("google_patents/sparse.json")),
        okOutcome("google_scholar_case_law", loadFixture("google_scholar_case_law/sparse.json")),
      ],
    });
    expect(finding.verdict).toBe("unknown");
  });
});

describe("verdict invariants", () => {
  it("returns a finding for every check with no probes at all, and it is unknown", () => {
    for (const check of ALL_CHECKS) {
      const finding = decide(check, { subject: NORTHWIND, probes: [] });
      expect(finding.check, check).toBe(check);
      expect(finding.verdict, check).toBe("unknown");
      expect(finding.citations, check).toHaveLength(0);
      expect(isBlocking(finding), check).toBe(true);
    }
  });

  it("never cites a source when it could not establish the check", () => {
    for (const check of ALL_CHECKS) {
      const finding = decide(check, {
        subject: NORTHWIND,
        probes: [
          errorOutcome("google"),
          errorOutcome("google_light"),
          errorOutcome("google_news"),
          errorOutcome("google_patents"),
          errorOutcome("google_scholar_case_law"),
          errorOutcome("google_maps"),
          errorOutcome("google_maps_reviews"),
          errorOutcome("google_trends"),
          errorOutcome("google_ads_transparency_center"),
          errorOutcome("amazon"),
          errorOutcome("google_finance"),
        ],
      });
      expect(finding.verdict, check).toBe("unknown");
      expect(finding.citations, check).toHaveLength(0);
      expect(finding.summary, check).toMatch(/^Could not establish this check/);
    }
  });

  it("is deterministic: the same fixtures always produce the same finding", () => {
    const evidence: CheckEvidence = {
      subject: NORTHWIND,
      probes: [
        okOutcome("google", loadFixture("google/trademark-collision.json")),
        okOutcome(
          "google_scholar_case_law",
          loadFixture("google_scholar_case_law/trademark-opposition.json"),
        ),
      ],
    };
    expect(decideTrademarkClear(evidence)).toEqual(decideTrademarkClear(evidence));
  });
});

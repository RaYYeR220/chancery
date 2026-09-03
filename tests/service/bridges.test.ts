/**
 * Every bridge maps correctly.
 *
 * The assertions are about the seam and nothing else: what the port asked for,
 * what the vendor was told, and what came back. The vendor adapters have their
 * own suites and are not re-tested here.
 */

import { describe, expect, it } from "vitest";

import { DoctavianClient } from "@/lib/adapters/doctavian";
import { ExtractionClient } from "@/lib/adapters/nutrient";
import { NameComClient } from "@/lib/adapters/namecom";
import { serializeWritRecord } from "@/lib/core/writ-record";
import { documentHash } from "@/lib/core/bytes";
import { decide } from "@/lib/core/gatekeeper";
import {
  DohWritResolver,
  DoctavianDocumentGenerator,
  NameComDomainRegistry,
  NutrientTermsExtractor,
  toSerpApiSubject,
} from "@/lib/service/adapters";
import type { SignedDocument } from "@/lib/service/ports";
import * as w from "@/lib/eval/world";

import { citationMirror, routedFetch, spec } from "./support";

/* ------------------------------------------------------ DocumentGenerator */

const PDF = new TextEncoder().encode("%PDF-1.7\nwrit\n%%EOF\n");

describe("DoctavianDocumentGenerator", () => {
  it("runs the generation flow and returns the downloaded bytes", async () => {
    const fetchImpl = routedFetch([
      { match: "/datasource/create", json: { result: { data: { dataSourceGuid: "ds_1" } } } },
      { match: "/solution/create", json: { result: { data: { documentSolutionGuid: "sol_1" } } } },
      { match: "/template/upload", json: { result: { data: { files: [{ id: "tpl_1" }] } } } },
      { match: "/data/upload", json: { result: { data: { files: [{ id: "dat_1" }] } } } },
      {
        match: "/document/generate",
        json: {
          result: { data: { document: { urn: "urn:doc:1" } } },
          consumption: [{ dimension: "pages", value: 1 }],
        },
      },
      { match: "/download", bytes: PDF, headers: { "content-type": "application/pdf" } },
    ]);

    const generator = new DoctavianDocumentGenerator(
      new DoctavianClient({
        baseUrl: "https://doctavian.test",
        bearerToken: "bearer",
        documentsApiKey: "documents",
        signaturesApiKey: "",
        fetchImpl,
      }),
    );

    const document = await generator.generateWrit(spec());

    expect(document.reference).toBe("urn:doc:1");
    expect(document.bytes).toEqual(PDF);
    expect(document.contentType).toBe("application/pdf");
    // The response carries no conformance field, so the bridge reports none
    // rather than quoting the vendor's documented default back as an observation.
    expect(document.pdfaConformance).toBeUndefined();

    expect(fetchImpl.paths()).toEqual([
      "/v1/documents/datasource/create",
      "/v1/documents/solution/create",
      "/v1/documents/template/upload",
      "/v1/documents/data/upload",
      "/v1/documents/document/generate",
      "/v1/documents/document/urn%3Adoc%3A1/download",
    ]);
  }, 30_000);

  it("derives a stable writ id from the spec, and takes a real one when offered", async () => {
    const routes = [
      { match: "/datasource/create", json: { result: { data: { dataSourceGuid: "ds_1" } } } },
      { match: "/solution/create", json: { result: { data: { documentSolutionGuid: "sol_1" } } } },
      { match: "/template/upload", json: { result: { data: { files: [{ id: "tpl_1" }] } } } },
      { match: "/data/upload", json: { result: { data: { files: [{ id: "dat_1" }] } } } },
      {
        match: "/document/generate",
        json: { result: { data: { document: { urn: "urn:doc:1" } } } },
      },
      { match: "/download", bytes: PDF },
    ];

    const fetchImpl = routedFetch(routes);
    const generator = new DoctavianDocumentGenerator(
      new DoctavianClient({
        baseUrl: "https://doctavian.test",
        bearerToken: "bearer",
        documentsApiKey: "documents",
        signaturesApiKey: "",
        fetchImpl,
      }),
      { writIdFor: () => "writ_northwind_001" },
    );

    await generator.generateWrit(spec());
    const created = fetchImpl.calls.find((call) => call.url.includes("/datasource/create"));
    expect(String(created?.body)).toContain("writ-writ_northwind_001");
  }, 30_000);
});

/* ---------------------------------------------------------- TermsExtractor */

const EXTRACTED = {
  principal: { legalName: "Northwind Coffee Ltd", email: "ops@northwind.example" },
  agent: {
    label: "Northwind brand-launch agent",
    domain: "ops.northwind.example",
    publicKey: w.AGENT.publicKey,
  },
  grants: [{ ref: "3(b)", actKind: "domain.register" }],
  limits: [
    { grantRef: "3(b)", type: "count", max: 3, window: "total" },
    { grantRef: "3(b)", type: "allowlist", field: "tld", values: "com,net" },
  ],
  conditions: [{ grantRef: "3(b)", type: "diligence", check: "trademark_clear" }],
  effectiveFrom: "2026-09-01",
  expiresAt: "2026-12-01",
  jurisdiction: "IE",
};

function signed(): SignedDocument {
  const bytes = new TextEncoder().encode("signed writ");
  return {
    envelopeId: "env_1",
    bytes,
    sha256: documentHash(bytes),
    signedAt: "2026-09-02T10:00:00.000Z",
  };
}

function extractorFor(overrides: Record<string, Record<string, unknown>> = {}) {
  const fetchImpl = routedFetch([
    {
      match: "/extraction/extract",
      json: {
        output: { data: EXTRACTED, metadata: citationMirror(EXTRACTED, overrides) },
        usage: { pages: 1 },
      },
      headers: {
        "x-pspdfkit-request-cost": "15",
        "x-pspdfkit-remaining-credits": "35",
      },
    },
  ]);
  return {
    fetchImpl,
    extractor: new NutrientTermsExtractor(
      new ExtractionClient({ apiKey: "nutrient", fetchImpl }),
    ),
  };
}

describe("NutrientTermsExtractor", () => {
  it("projects the hoisted rows back onto the clause they name", async () => {
    const { extractor } = extractorFor();
    const document = signed();
    const outcome = await extractor.extractTerms(document, { writId: "writ_1" });

    const grant = outcome.policy.writ.grants[0];
    expect(grant.ref).toBe("3(b)");
    expect(grant.actKind).toBe("domain.register");
    expect(grant.limits).toEqual([
      { type: "count", max: 3, window: "total" },
      { type: "allowlist", field: "tld", values: ["com", "net"] },
    ]);
    expect(grant.conditions).toEqual([{ type: "diligence", check: "trademark_clear" }]);

    // Bound to the bytes handed in, never to a field in the vendor response.
    expect(outcome.policy.documentHash).toBe(document.sha256);
    expect(outcome.policy.ungrounded).toEqual([]);
    expect(outcome.method).toBe("nutrient/understand");
    expect(outcome.cost).toEqual({ charged: 15, remaining: 35 });
    // A bare date widens to the instant it already parses as, and nothing else.
    expect(outcome.policy.writ.effectiveFrom).toBe("2026-09-01T00:00:00.000Z");
  });

  it("rewrites an ungrounded hoisted term onto the clause, so the gate can see it", async () => {
    // `/limits/0/max` is the count cap on clause 3(b). Left in the extractor's
    // own pointer space it matches no grant, is silently ignored, and a cap
    // nobody could read becomes a clause with no cap at all.
    const { extractor } = extractorFor({ "/limits/0/max": { match: "fuzzy_match" } });
    const outcome = await extractor.extractTerms(signed(), { writId: "writ_1" });

    expect(outcome.policy.ungrounded).toContain("/grants/0/limits/0/max");
    expect(outcome.policy.ungrounded).not.toContain("/limits/0/max");

    const decision = decide({
      ...w.baseline(),
      policy: { ...outcome.policy, documentHash: w.DOCUMENT_HASH },
      diligence: [w.clear("trademark_clear")],
    });
    expect(decision.outcome).toBe("deny");
    expect(decision.reasons[0].code).toBe("CLAUSE_UNGROUNDED");
  });

  it("carries provenance across into the clause's own pointer space", async () => {
    const { extractor } = extractorFor();
    const outcome = await extractor.extractTerms(signed(), { writId: "writ_1" });

    expect(outcome.policy.provenance["/grants/0/ref"]).toMatchObject({
      pointer: "/grants/0/ref",
      match: "id_match",
      pageNumber: 2,
    });
  });
});

/* ------------------------------------------------------------ DomainRegistry */

describe("NameComDomainRegistry", () => {
  function registry(routes: Parameters<typeof routedFetch>[0]) {
    const fetchImpl = routedFetch(routes);
    return {
      fetchImpl,
      registry: new NameComDomainRegistry({
        client: new NameComClient({
          environment: "sandbox",
          username: "user",
          token: "token",
          fetchImpl,
        }),
        zoneFor: () => "northwind.example",
      }),
    };
  }

  it("converts prices into minor units on the way out", async () => {
    const { registry: bridge } = registry([
      {
        match: "domains:search",
        json: {
          results: [
            {
              domainName: "northwindcoffee.com",
              sld: "northwindcoffee",
              tld: "com",
              purchasable: true,
              premium: false,
              purchasePrice: 10.99,
              renewalPrice: 12.99,
              purchaseType: "registration",
            },
          ],
        },
      },
    ]);

    expect(await bridge.search("northwind", ["com"])).toEqual([
      {
        domainName: "northwindcoffee.com",
        tld: "com",
        purchasable: true,
        premium: false,
        priceMinorUnits: 1_099,
        currency: "USD",
      },
    ]);
  });

  it("quotes the agreed price and carries the idempotency key", async () => {
    const { fetchImpl, registry: bridge } = registry([
      {
        match: "/core/v1/domains",
        method: "POST",
        json: {
          domain: { domainName: "northwindcoffee.com" },
          order: 4_413_001,
          totalPaid: 10.99,
        },
      },
    ]);

    const key = "6f1d5b7e-9c2a-4f3b-8d1e-2a7c4b5e9f01";
    const registered = await bridge.register("northwindcoffee.com", 1_099, key);

    expect(registered).toEqual({
      domainName: "northwindcoffee.com",
      orderId: "4413001",
      totalPaidMinorUnits: 1_099,
      currency: "USD",
    });
    expect(String(fetchImpl.calls[0].body)).toContain('"purchasePrice":10.99');
  });

  it("publishes a writ record through the anchor, superseding what was there", async () => {
    const value = serializeWritRecord(w.record());
    const { fetchImpl, registry: bridge } = registry([
      { match: "/records", method: "GET", json: { records: [] } },
      {
        match: "/records",
        method: "POST",
        json: {
          id: 77,
          domainName: "northwind.example",
          host: "_writ.ops",
          fqdn: "_writ.ops.northwind.example",
          type: "TXT",
          answer: value,
          ttl: 300,
        },
      },
    ]);

    expect(await bridge.putWritRecord("ops.northwind.example", value)).toEqual({
      id: 77,
      fqdn: "_writ.ops.northwind.example",
    });
    expect(String(fetchImpl.calls[1].body)).toContain("WRIT1");
  });
});

/* -------------------------------------------------------------- WritResolver */

describe("DohWritResolver", () => {
  it("carries the AD flag through untouched and selects the record", async () => {
    const value = serializeWritRecord(w.record());
    const resolver = new DohWritResolver({
      clock: () => w.NOW,
      resolver: {
        async resolveTxt(name) {
          return {
            name,
            status: 0,
            authenticatedData: true,
            answers: [],
            values: [value],
            ttl: 300,
            resolver: "cloudflare",
          };
        },
      },
    });

    const { lookup, resolution } = await resolver.lookupWrit("ops.northwind.example");
    expect(resolution.name).toBe("_writ.ops.northwind.example");
    expect(resolution.authenticatedData).toBe(true);
    expect(resolution.resolver).toBe("cloudflare");
    expect(resolution.resolvedAt).toBe(w.NOW);
    expect(lookup.outcome).toBe("active");
  });

  it("never upgrades an unauthenticated answer", async () => {
    const resolver = new DohWritResolver({
      resolver: {
        async resolveTxt(name) {
          return {
            name,
            status: 0,
            authenticatedData: false,
            answers: [],
            values: [],
            ttl: null,
            resolver: "google",
          };
        },
      },
    });

    const { lookup, resolution } = await resolver.lookupWrit("ops.northwind.example");
    expect(resolution.authenticatedData).toBe(false);
    expect(lookup.outcome).toBe("absent");
  });
});

/* --------------------------------------------------------- DiligenceService */

describe("the diligence subject projection", () => {
  it("searches the mark for a registration and the principal for the entity", () => {
    expect(
      toSerpApiSubject({
        kind: "domain.register",
        fields: { tld: "com", domainName: "northwindcoffee.com" },
        principalLegalName: "Northwind Coffee Ltd",
      }),
    ).toEqual({
      name: "northwindcoffee",
      legalName: "Northwind Coffee Ltd",
      domain: "northwindcoffee.com",
    });
  });

  it("searches the counterparty, not the principal, when the act names one", () => {
    expect(
      toSerpApiSubject({
        kind: "document.send_for_signature",
        fields: { counterparty: "Baltic Roasters OU", locality: "Tallinn" },
        principalLegalName: "Northwind Coffee Ltd",
      }),
    ).toEqual({ name: "Baltic Roasters OU", locality: "Tallinn" });
  });

  it("drops a jurisdiction that is not a two-letter country code", () => {
    const subject = toSerpApiSubject({
      kind: "domain.register",
      fields: { domainName: "northwind.ie", jurisdiction: "Ireland" },
      principalLegalName: "Northwind Coffee Ltd",
    });
    expect(subject.country).toBeUndefined();
  });
});

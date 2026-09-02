import { describe, expect, it } from "vitest";

import {
  idempotencyKey,
  newIdempotencyKey,
  MIN_TTL,
  NAMECOM_BASE_URLS,
  NameComClient,
  type IdempotencyKey,
} from "@/lib/adapters/namecom/client";
import {
  NameComAuthError,
  NameComError,
  NameComInsufficientCreditError,
  NameComPriceMismatchError,
  NameComRateLimitError,
} from "@/lib/adapters/namecom/errors";

import balance from "../fixtures/namecom/balance.json";
import checkAvailability from "../fixtures/namecom/check-availability.json";
import dnssec from "../fixtures/namecom/dnssec.json";
import domain from "../fixtures/namecom/domain.json";
import hello from "../fixtures/namecom/hello.json";
import records from "../fixtures/namecom/records.json";
import register from "../fixtures/namecom/register.json";
import requirements from "../fixtures/namecom/requirements-us.json";
import search from "../fixtures/namecom/search.json";
import tldpricing from "../fixtures/namecom/tldpricing.json";
import zonecheck from "../fixtures/namecom/zonecheck.json";
import {
  failingFetch,
  fakeFetch,
  hangingFetch,
  type FakeFetch,
  type Responder,
} from "../fixtures/namecom/fake-fetch";

const KEY = idempotencyKey("6f1b7c22-2b6e-4b5e-9f1a-9c3f7f6d5e40");

function client(
  responder: Responder,
  overrides: Partial<ConstructorParameters<typeof NameComClient>[0]> = {},
): { api: NameComClient; fetch: FakeFetch } {
  const impl = fakeFetch(responder);
  const api = new NameComClient({
    environment: "sandbox",
    username: "chancery-test",
    token: "tok3n",
    fetchImpl: impl,
    now: () => 1_800_000_000_000,
    ...overrides,
  });
  return { api, fetch: impl };
}

describe("construction", () => {
  it("derives the sandbox base URL rather than trusting the OpenAPI default", () => {
    const { api } = client({ body: hello });
    expect(api.baseUrl).toBe(NAMECOM_BASE_URLS.sandbox);
    expect(api.baseUrl).toBe("https://api.dev.name.com");
  });

  it("derives the production base URL", () => {
    const { api } = client({ body: hello }, { environment: "production" });
    expect(api.baseUrl).toBe("https://api.name.com");
  });

  it("rejects empty credentials", () => {
    expect(
      () =>
        new NameComClient({
          environment: "sandbox",
          username: "",
          token: "tok3n",
          fetchImpl: fakeFetch({ body: {} }),
        }),
    ).toThrow(NameComError);
  });

  it("builds HTTP Basic auth from username and token", async () => {
    const { api, fetch } = client({ body: hello });
    await api.hello();
    const expected = `Basic ${Buffer.from("chancery-test:tok3n").toString("base64")}`;
    expect(fetch.last().headers.get("authorization")).toBe(expected);
  });

  it("omits content-type on requests that carry no body", async () => {
    const { api, fetch } = client({ body: hello });
    await api.hello();
    expect(fetch.last().headers.get("content-type")).toBeNull();
    expect(fetch.last().rawBody).toBeUndefined();
  });
});

describe("discovery endpoints", () => {
  it("hello hits /core/v1/hello and returns the echoed username", async () => {
    const { api, fetch } = client({ body: hello });
    const result = await api.hello();
    expect(fetch.last().url).toBe("https://api.dev.name.com/core/v1/hello");
    expect(result.username).toBe("chancery-test");
  });

  it("leaves the colon in domains:checkAvailability unencoded", async () => {
    const { api, fetch } = client({ body: checkAvailability });
    const result = await api.checkAvailability({
      domainNames: ["chancery-writ.com", "google.com"],
      purchaseType: "registration",
    });
    expect(fetch.last().url).toContain("/core/v1/domains:checkAvailability");
    expect(fetch.last().url).not.toContain("%3A");
    expect(fetch.last().body).toEqual({
      domainNames: ["chancery-writ.com", "google.com"],
      purchaseType: "registration",
    });
    expect(result.results[1].purchasable).toBe(false);
  });

  it("leaves the colon in domains:search unencoded", async () => {
    const { api, fetch } = client({ body: search });
    const result = await api.searchDomains({
      keyword: "chancery-writ",
      tldFilter: ["com", "dev"],
      timeout: 2500,
    });
    expect(fetch.last().url).toBe("https://api.dev.name.com/core/v1/domains:search");
    expect(fetch.last().method).toBe("POST");
    expect(result.results).toHaveLength(2);
  });

  it("posts zonecheck for the bulk fast path", async () => {
    const { api, fetch } = client({ body: zonecheck });
    const result = await api.zoneCheck({ domainNames: ["chancery-writ.com"] });
    expect(fetch.last().pathname).toBe("/core/v1/zonecheck");
    expect(result.removed).toBe(1);
  });
});

describe("registration", () => {
  it("sends the idempotency key as X-Idempotency-Key", async () => {
    const { api, fetch } = client({ body: register });
    const result = await api.registerDomain(
      {
        domain: { domainName: "chancery-writ.com" },
        years: 1,
        purchasePrice: 10.99,
        purchaseType: "registration",
      },
      KEY,
    );
    expect(fetch.last().headers.get("x-idempotency-key")).toBe(KEY);
    expect(fetch.last().pathname).toBe("/core/v1/domains");
    expect(result.order).toBe(449283);
    expect(result.totalPaid).toBe(10.99);
  });

  it("rejects a key that is not a UUID v4, even one smuggled past the brand", async () => {
    const { api, fetch } = client({ body: register });
    await expect(
      api.registerDomain(
        { domain: { domainName: "chancery-writ.com" } },
        "not-a-uuid" as unknown as IdempotencyKey,
      ),
    ).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
    // Nothing was sent, so nothing could have been bought.
    expect(fetch.calls).toHaveLength(0);
  });

  it("rejects a v1 UUID, which is not random enough to be a replay token", () => {
    expect(() => idempotencyKey("6f1b7c22-2b6e-11ee-9f1a-9c3f7f6d5e40")).toThrow(
      NameComError,
    );
  });

  it("mints usable v4 keys", () => {
    const minted = newIdempotencyKey();
    expect(() => idempotencyKey(minted)).not.toThrow();
  });

  it("maps 402 to an insufficient-credit error", async () => {
    const { api } = client({
      status: 402,
      body: { message: "Payment Required", details: "Insufficient account funds" },
    });
    await expect(
      api.registerDomain({ domain: { domainName: "chancery-writ.com" } }, KEY),
    ).rejects.toBeInstanceOf(NameComInsufficientCreditError);
  });

  it("maps a 400 about price to a price-mismatch error", async () => {
    const { api } = client({
      status: 400,
      body: { message: "Invalid Argument", details: "purchasePrice does not match" },
    });
    const error = await api
      .registerDomain(
        { domain: { domainName: "chancery-writ.com" }, purchasePrice: 1.0 },
        KEY,
      )
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(NameComPriceMismatchError);
    expect((error as NameComPriceMismatchError).code).toBe("PRICE_MISMATCH");
  });

  it("leaves an unrelated 400 as an invalid-request error", async () => {
    const { api } = client({
      status: 400,
      body: { message: "Invalid Argument", details: "domainName is required" },
    });
    await expect(
      api.registerDomain({ domain: { domainName: "" } }, KEY),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("documented failure modes", () => {
  it("treats a 429 carrying Retry-After as the drop-catch limit", async () => {
    const { api } = client({
      status: 429,
      body: { message: "Too Many Requests" },
      headers: { "retry-after": "45" },
    });
    const error = (await api
      .registerDomain({ domain: { domainName: "chancery-writ.com" } }, KEY)
      .catch((cause: unknown) => cause)) as NameComRateLimitError;
    expect(error).toBeInstanceOf(NameComRateLimitError);
    expect(error.scope).toBe("registration");
    expect(error.retryAfterMs).toBe(45_000);
  });

  it("treats a 429 carrying X-RateLimit-Reset as the account-wide limit", async () => {
    const { api } = client({
      status: 429,
      body: { message: "Too Many Requests" },
      headers: { "x-ratelimit-reset": "1800000060" },
    });
    const error = (await api.hello().catch((cause: unknown) => cause)) as NameComRateLimitError;
    expect(error.scope).toBe("account");
    expect(error.retryAfterMs).toBe(60_000);
    expect(error.resetAt?.toISOString()).toBe(new Date(1_800_000_060_000).toISOString());
  });

  it("flags the 2FA-blocks-the-API auth failure distinctly", async () => {
    const { api } = client({
      status: 401,
      body: {
        message: "Authentication Error",
        details: "Account Has Two-Step Verification Enabled",
      },
    });
    const error = (await api.hello().catch((cause: unknown) => cause)) as NameComAuthError;
    expect(error).toBeInstanceOf(NameComAuthError);
    expect(error.twoFactorEnabled).toBe(true);
    expect(error.code).toBe("TWO_FACTOR_ENABLED");
  });

  it("keeps a plain 401 separate from the 2FA case", async () => {
    const { api } = client({ status: 401, body: { message: "Authentication Error" } });
    const error = (await api.hello().catch((cause: unknown) => cause)) as NameComAuthError;
    expect(error.twoFactorEnabled).toBe(false);
    expect(error.code).toBe("AUTH_FAILED");
    // Auth is evaluated before routing, so the path is part of the diagnosis.
    expect(error.path).toBe("/core/v1/hello");
  });

  it("maps 404 to NOT_FOUND", async () => {
    const { api } = client({ status: 404, body: { message: "Domain not found" } });
    await expect(api.getDomain("nope.com")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("maps 5xx to SERVER_ERROR", async () => {
    const { api } = client({ status: 503, rawBody: "upstream unavailable" });
    await expect(api.hello()).rejects.toMatchObject({ code: "SERVER_ERROR" });
  });

  it("reports a transport failure without pretending it was a timeout", async () => {
    const api = new NameComClient({
      environment: "sandbox",
      username: "u",
      token: "t",
      fetchImpl: failingFetch(),
    });
    await expect(api.hello()).rejects.toMatchObject({ code: "TRANSPORT" });
  });

  it("times out on its own schedule", async () => {
    const api = new NameComClient({
      environment: "sandbox",
      username: "u",
      token: "t",
      fetchImpl: hangingFetch(),
      timeoutMs: 10,
    });
    await expect(api.hello()).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("rejects a 200 whose body is not JSON", async () => {
    const { api } = client({ status: 200, rawBody: "<html>nope</html>" });
    await expect(api.hello()).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });
});

describe("domains", () => {
  it("passes pagination through as query parameters", async () => {
    const { api, fetch } = client({ body: { domains: [domain], nextPage: 2 } });
    const result = await api.listDomains({ page: 2, perPage: 50 });
    expect(fetch.last().query.get("page")).toBe("2");
    expect(fetch.last().query.get("perPage")).toBe("50");
    expect(result.domains).toHaveLength(1);
  });

  it("omits absent pagination parameters entirely", async () => {
    const { api, fetch } = client({ body: { domains: [] } });
    await api.listDomains();
    expect(fetch.last().url).toBe("https://api.dev.name.com/core/v1/domains");
  });

  it("gets a single domain", async () => {
    const { api, fetch } = client({ body: domain });
    const result = await api.getDomain("chancery-writ.com");
    expect(fetch.last().pathname).toBe("/core/v1/domains/chancery-writ.com");
    expect(result.autorenewEnabled).toBe(false);
  });

  it("PATCHes toggles without touching the flags it was not given", async () => {
    const { api, fetch } = client({ body: { ...domain, autorenewEnabled: true } });
    const result = await api.patchDomain("chancery-writ.com", {
      autorenewEnabled: true,
    });
    expect(fetch.last().method).toBe("PATCH");
    expect(fetch.last().body).toEqual({ autorenewEnabled: true });
    expect(result.autorenewEnabled).toBe(true);
  });

  it("keeps the colon in the setNameservers action path", async () => {
    const { api, fetch } = client({ body: { domain } });
    await api.setNameservers("chancery-writ.com", ["ns1.example.com"]);
    expect(fetch.last().url).toContain("/domains/chancery-writ.com:setNameservers");
    expect(fetch.last().url).not.toContain("%3A");
    expect(fetch.last().body).toEqual({ nameservers: ["ns1.example.com"] });
  });

  it("lists and creates vanity nameservers", async () => {
    const { api, fetch } = client([
      { body: { vanityNameservers: [] } },
      { body: { hostname: "ns1.chancery-writ.com", ips: ["203.0.113.10"] } },
    ]);
    await api.listVanityNameservers("chancery-writ.com");
    expect(fetch.last().pathname).toBe(
      "/core/v1/domains/chancery-writ.com/vanity_nameservers",
    );
    const created = await api.createVanityNameserver("chancery-writ.com", {
      hostname: "ns1.chancery-writ.com",
      ips: ["203.0.113.10"],
    });
    expect(created.hostname).toBe("ns1.chancery-writ.com");
  });
});

describe("dns records", () => {
  it("lists records", async () => {
    const { api, fetch } = client({ body: records });
    const result = await api.listRecords("chancery-writ.com");
    expect(fetch.last().pathname).toBe("/core/v1/domains/chancery-writ.com/records");
    expect(result.records).toHaveLength(3);
  });

  it("defaults a created record to the 300s floor", async () => {
    const { api, fetch } = client({ body: records.records[1] });
    await api.createRecord("chancery-writ.com", {
      host: "_writ",
      type: "TXT",
      answer: "v=WRIT1",
    });
    expect((fetch.last().body as { ttl: number }).ttl).toBe(MIN_TTL);
  });

  it("refuses a TTL below the 300s floor before sending anything", async () => {
    const { api, fetch } = client({ body: records.records[1] });
    await expect(
      api.createRecord("chancery-writ.com", {
        host: "_writ",
        type: "TXT",
        answer: "v=WRIT1",
        ttl: 60,
      }),
    ).rejects.toMatchObject({ code: "TTL_TOO_LOW" });
    expect(fetch.calls).toHaveLength(0);
  });

  it("PUTs the complete record on replace, because PUT is a full overwrite", async () => {
    const { api, fetch } = client({ body: records.records[1] });
    await api.replaceRecord("chancery-writ.com", 1002, {
      host: "_writ",
      type: "TXT",
      answer: "v=WRIT1; st=revoked",
      ttl: 300,
    });
    expect(fetch.last().method).toBe("PUT");
    expect(fetch.last().pathname).toBe(
      "/core/v1/domains/chancery-writ.com/records/1002",
    );
    expect(fetch.last().body).toEqual({
      host: "_writ",
      type: "TXT",
      answer: "v=WRIT1; st=revoked",
      ttl: 300,
    });
  });

  it("enforces the TTL floor on replace too", async () => {
    const { api } = client({ body: records.records[1] });
    await expect(
      api.replaceRecord("chancery-writ.com", 1002, {
        host: "_writ",
        type: "TXT",
        answer: "x",
        ttl: 299,
      }),
    ).rejects.toMatchObject({ code: "TTL_TOO_LOW" });
  });

  it("updateRecord GETs first so a partial change cannot blank the answer", async () => {
    const { api, fetch } = client([
      { body: records.records[1] },
      { body: { ...records.records[1], ttl: 900 } },
    ]);
    const result = await api.updateRecord("chancery-writ.com", 1002, { ttl: 900 });

    expect(fetch.nth(0).method).toBe("GET");
    expect(fetch.nth(1).method).toBe("PUT");
    expect(fetch.nth(1).body).toEqual({
      host: "_writ",
      type: "TXT",
      answer: records.records[1].answer,
      ttl: 900,
    });
    expect(result.ttl).toBe(900);
  });

  it("keeps an apex host as the empty string through a read-modify-write", async () => {
    const { api, fetch } = client([
      { body: records.records[0] },
      { body: records.records[0] },
    ]);
    await api.updateRecord("chancery-writ.com", 1001, { answer: "203.0.113.11" });
    expect((fetch.nth(1).body as { host: string }).host).toBe("");
  });

  it("handles the empty 204 that DELETE answers with", async () => {
    const { api, fetch } = client({ status: 204 });
    await expect(
      api.deleteRecord("chancery-writ.com", 1002),
    ).resolves.toBeUndefined();
    expect(fetch.last().method).toBe("DELETE");
  });
});

describe("dnssec, account and pricing", () => {
  it("lists DNSSEC keys", async () => {
    const { api, fetch } = client({ body: dnssec });
    const result = await api.listDnssec("chancery-writ.com");
    expect(fetch.last().pathname).toBe("/core/v1/domains/chancery-writ.com/dnssec");
    expect(result.dnssec[0].keyTag).toBe(21212);
  });

  it("creates a DNSSEC key", async () => {
    const { api, fetch } = client({ body: dnssec.dnssec[0] });
    await api.createDnssec("chancery-writ.com", {
      keyTag: 21212,
      algorithm: 13,
      digestType: 2,
      digest: dnssec.dnssec[0].digest,
    });
    expect(fetch.last().method).toBe("POST");
    expect((fetch.last().body as { algorithm: number }).algorithm).toBe(13);
  });

  it("addresses a DNSSEC key by digest, not by id", async () => {
    const { api, fetch } = client([{ body: dnssec.dnssec[0] }, { status: 204 }]);
    await api.getDnssec("chancery-writ.com", dnssec.dnssec[0].digest);
    expect(fetch.last().pathname).toBe(
      `/core/v1/domains/chancery-writ.com/dnssec/${dnssec.dnssec[0].digest}`,
    );
    await expect(
      api.deleteDnssec("chancery-writ.com", dnssec.dnssec[0].digest),
    ).resolves.toBeUndefined();
  });

  it("reads the account balance", async () => {
    const { api, fetch } = client({ body: balance });
    const result = await api.getBalance();
    expect(fetch.last().pathname).toBe("/core/v1/accountinfo/balance");
    expect(result.balance).toBe(100000);
  });

  it("normalises the tldpricing envelope", async () => {
    const { api } = client({ body: tldpricing });
    const result = await api.listTldPricing({ page: 1 });
    expect(result.results.map((entry) => entry.tld)).toEqual(["com", "dev"]);
    expect(result.nextPage).toBe(2);
  });

  it("accepts the alternate tldPricing envelope key", async () => {
    const { api } = client({ body: { tldPricing: [{ tld: "io" }] } });
    const result = await api.listTldPricing();
    expect(result.results).toEqual([{ tld: "io" }]);
  });

  it("fetches the JSON Schema a TLD's registration form is generated from", async () => {
    const { api, fetch } = client({ body: requirements });
    const schema = await api.getTldRequirements(".us");
    expect(fetch.last().pathname).toBe("/core/v1/domaininfo/requirementsV2/us");
    expect(schema.required).toEqual(["nexusCategory", "applicationPurpose"]);
  });
});

import { describe, expect, it } from "vitest";

import {
  CLOUDFLARE_DOH,
  decodeTxtEscapes,
  DohError,
  DohResolver,
  GOOGLE_DOH,
  RCODE,
  splitCharacterStrings,
  TXT_TYPE,
} from "@/lib/dns/resolver";

import {
  failingFetch,
  fakeFetch,
  hangingFetch,
  type FakeResponse,
  type RecordedRequest,
} from "../fixtures/namecom/fake-fetch";

const WRIT =
  "v=WRIT1; st=active; k=cHVibGljLWtleQ; h=ZG9jLWhhc2g; " +
  "u=https://chancery.example/w/1.pdf; exp=1790000000";

interface DohAnswerSpec {
  name?: string;
  type?: number;
  TTL?: number;
  data: string;
}

function dohBody(spec: {
  status?: number;
  ad?: boolean;
  answers?: DohAnswerSpec[];
}): FakeResponse {
  return {
    body: {
      Status: spec.status ?? RCODE.NOERROR,
      TC: false,
      RD: true,
      RA: true,
      AD: spec.ad ?? false,
      CD: false,
      Question: [{ name: "_writ.ops.example.com.", type: TXT_TYPE }],
      Answer: (spec.answers ?? []).map((answer) => ({
        name: answer.name ?? "_writ.ops.example.com.",
        type: answer.type ?? TXT_TYPE,
        TTL: answer.TTL ?? 300,
        data: answer.data,
      })),
    },
  };
}

/** Routes by hostname so a test can make one resolver fail and the other answer. */
function byResolver(map: {
  cloudflare?: FakeResponse;
  google?: FakeResponse;
}): (request: RecordedRequest) => FakeResponse {
  return (request) => {
    const which = request.url.includes("cloudflare") ? "cloudflare" : "google";
    const spec = map[which];
    if (spec === undefined) throw new Error(`unexpected call to ${which}`);
    return spec;
  };
}

describe("query construction", () => {
  it("asks Cloudflare first, in JSON, with checking not disabled", async () => {
    const fetch = fakeFetch(dohBody({ ad: true, answers: [{ data: `"${WRIT}"` }] }));
    const resolver = new DohResolver({ fetchImpl: fetch });
    await resolver.resolveTxt("_writ.ops.example.com");

    const call = fetch.last();
    expect(call.url.startsWith(CLOUDFLARE_DOH.url)).toBe(true);
    expect(call.headers.get("accept")).toBe("application/dns-json");
    expect(call.query.get("name")).toBe("_writ.ops.example.com");
    expect(call.query.get("type")).toBe("TXT");
    expect(call.query.get("cd")).toBe("false");
  });

  it("strips a trailing dot before querying", async () => {
    const fetch = fakeFetch(dohBody({ answers: [] }));
    const resolver = new DohResolver({ fetchImpl: fetch });
    const lookup = await resolver.resolveTxt("_writ.ops.example.com.");
    expect(fetch.last().query.get("name")).toBe("_writ.ops.example.com");
    expect(lookup.name).toBe("_writ.ops.example.com");
  });

  it("refuses an empty name", async () => {
    const resolver = new DohResolver({ fetchImpl: fakeFetch(dohBody({})) });
    await expect(resolver.resolveTxt("   ")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("requires at least one endpoint", () => {
    expect(
      () => new DohResolver({ fetchImpl: fakeFetch(dohBody({})), endpoints: [] }),
    ).toThrow(DohError);
  });
});

describe("DNSSEC signalling", () => {
  it("reports AD when the answer was validated", async () => {
    const resolver = new DohResolver({
      fetchImpl: fakeFetch(dohBody({ ad: true, answers: [{ data: `"${WRIT}"` }] })),
    });
    const lookup = await resolver.resolveTxt("_writ.ops.example.com");
    expect(lookup.authenticatedData).toBe(true);
  });

  it("reports AD false for an unsigned zone", async () => {
    const resolver = new DohResolver({
      fetchImpl: fakeFetch(dohBody({ ad: false, answers: [{ data: `"${WRIT}"` }] })),
    });
    const lookup = await resolver.resolveTxt("_writ.ops.example.com");
    expect(lookup.authenticatedData).toBe(false);
  });

  it("never defaults a missing AD field to true", async () => {
    const fetch = fakeFetch({
      body: { Status: 0, Answer: [{ name: "x.", type: 16, TTL: 300, data: `"${WRIT}"` }] },
    });
    const resolver = new DohResolver({ fetchImpl: fetch });
    const lookup = await resolver.resolveTxt("_writ.ops.example.com");
    expect(lookup.authenticatedData).toBe(false);
  });

  it("does not shop for a second opinion when AD is false", async () => {
    const fetch = fakeFetch(dohBody({ ad: false, answers: [{ data: `"${WRIT}"` }] }));
    const resolver = new DohResolver({ fetchImpl: fetch });
    await resolver.resolveTxt("_writ.ops.example.com");
    expect(fetch.calls).toHaveLength(1);
  });
});

describe("TXT parsing", () => {
  it("concatenates the character-strings of a multi-string record", async () => {
    const head = WRIT.slice(0, 120);
    const tail = WRIT.slice(120);
    const resolver = new DohResolver({
      fetchImpl: fakeFetch(
        dohBody({ ad: true, answers: [{ data: `"${head}" "${tail}"` }] }),
      ),
    });
    const lookup = await resolver.resolveTxt("_writ.ops.example.com");
    expect(lookup.answers[0].chunks).toHaveLength(2);
    expect(lookup.values).toEqual([WRIT]);
  });

  it("does not split a value on the spaces inside it", async () => {
    const resolver = new DohResolver({
      fetchImpl: fakeFetch(dohBody({ answers: [{ data: `"a b c"` }] })),
    });
    const lookup = await resolver.resolveTxt("example.com");
    expect(lookup.values).toEqual(["a b c"]);
  });

  it("unescapes quotes and decimal escapes", async () => {
    const resolver = new DohResolver({
      fetchImpl: fakeFetch(dohBody({ answers: [{ data: `"say \\"hi\\"" "\\032end"` }] })),
    });
    const lookup = await resolver.resolveTxt("example.com");
    expect(lookup.values).toEqual(['say "hi" end']);
  });

  it("accepts an unquoted single-string answer", async () => {
    const resolver = new DohResolver({
      fetchImpl: fakeFetch(dohBody({ answers: [{ data: WRIT }] })),
    });
    const lookup = await resolver.resolveTxt("_writ.ops.example.com");
    expect(lookup.values).toEqual([WRIT]);
  });

  it("ignores CNAME entries that share the Answer section", async () => {
    const resolver = new DohResolver({
      fetchImpl: fakeFetch(
        dohBody({
          answers: [
            { type: 5, data: "writ.example.net." },
            { data: `"${WRIT}"` },
          ],
        }),
      ),
    });
    const lookup = await resolver.resolveTxt("_writ.ops.example.com");
    expect(lookup.values).toEqual([WRIT]);
  });

  it("reports the tightest TTL across answers", async () => {
    const resolver = new DohResolver({
      fetchImpl: fakeFetch(
        dohBody({
          answers: [
            { TTL: 900, data: `"a"` },
            { TTL: 300, data: `"b"` },
          ],
        }),
      ),
    });
    const lookup = await resolver.resolveTxt("example.com");
    expect(lookup.ttl).toBe(300);
  });

  it("returns NXDOMAIN as an answer rather than an error", async () => {
    const fetch = fakeFetch(dohBody({ status: RCODE.NXDOMAIN }));
    const resolver = new DohResolver({ fetchImpl: fetch });
    const lookup = await resolver.resolveTxt("_writ.nothing.example.com");
    expect(lookup.status).toBe(RCODE.NXDOMAIN);
    expect(lookup.values).toEqual([]);
    expect(lookup.ttl).toBeNull();
    // Absence is a definitive answer; asking Google too would be pointless.
    expect(fetch.calls).toHaveLength(1);
  });

  it("names the resolver that answered", async () => {
    const resolver = new DohResolver({
      fetchImpl: fakeFetch(dohBody({ answers: [{ data: `"${WRIT}"` }] })),
    });
    const lookup = await resolver.resolveTxt("_writ.ops.example.com");
    expect(lookup.resolver).toBe(CLOUDFLARE_DOH.name);
  });
});

describe("fallback", () => {
  it("falls back to Google on SERVFAIL", async () => {
    const fetch = fakeFetch(
      byResolver({
        cloudflare: dohBody({ status: RCODE.SERVFAIL }),
        google: dohBody({ ad: true, answers: [{ data: `"${WRIT}"` }] }),
      }),
    );
    const resolver = new DohResolver({ fetchImpl: fetch });
    const lookup = await resolver.resolveTxt("_writ.ops.example.com");
    expect(lookup.resolver).toBe(GOOGLE_DOH.name);
    expect(lookup.values).toEqual([WRIT]);
    expect(fetch.calls).toHaveLength(2);
  });

  it("falls back on an HTTP error", async () => {
    const fetch = fakeFetch(
      byResolver({
        cloudflare: { status: 502, rawBody: "bad gateway" },
        google: dohBody({ answers: [{ data: `"${WRIT}"` }] }),
      }),
    );
    const resolver = new DohResolver({ fetchImpl: fetch });
    const lookup = await resolver.resolveTxt("_writ.ops.example.com");
    expect(lookup.resolver).toBe(GOOGLE_DOH.name);
  });

  it("falls back on a body that is JSON but not a DNS answer", async () => {
    const fetch = fakeFetch(
      byResolver({
        cloudflare: { body: { hello: "world" } },
        google: dohBody({ answers: [{ data: `"${WRIT}"` }] }),
      }),
    );
    const resolver = new DohResolver({ fetchImpl: fetch });
    const lookup = await resolver.resolveTxt("_writ.ops.example.com");
    expect(lookup.resolver).toBe(GOOGLE_DOH.name);
  });

  it("falls back when the first endpoint is unreachable", async () => {
    let call = 0;
    const resolver = new DohResolver({
      fetchImpl: async (input, init) => {
        call += 1;
        if (call === 1) throw new TypeError("fetch failed");
        return fakeFetch(dohBody({ answers: [{ data: `"${WRIT}"` }] }))(input, init);
      },
    });
    const lookup = await resolver.resolveTxt("_writ.ops.example.com");
    expect(lookup.resolver).toBe(GOOGLE_DOH.name);
  });

  it("reports every attempt when no resolver could answer", async () => {
    const resolver = new DohResolver({ fetchImpl: failingFetch() });
    const error = (await resolver
      .resolveTxt("_writ.ops.example.com")
      .catch((cause: unknown) => cause)) as DohError;
    expect(error).toBeInstanceOf(DohError);
    expect(error.code).toBe("ALL_RESOLVERS_FAILED");
    expect(error.attempts.map((attempt) => attempt.resolver)).toEqual([
      "cloudflare",
      "google",
    ]);
    expect(error.attempts.every((attempt) => attempt.error.code === "TRANSPORT")).toBe(
      true,
    );
  });

  it("times out per endpoint instead of hanging forever", async () => {
    const resolver = new DohResolver({ fetchImpl: hangingFetch(), timeoutMs: 10 });
    const error = (await resolver
      .resolveTxt("_writ.ops.example.com")
      .catch((cause: unknown) => cause)) as DohError;
    expect(error.code).toBe("ALL_RESOLVERS_FAILED");
    expect(error.attempts.map((attempt) => attempt.error.code)).toEqual([
      "TIMEOUT",
      "TIMEOUT",
    ]);
  });
});

describe("character-string helpers", () => {
  it("splits on quote boundaries, keeping the quotes for joinTxtChunks", () => {
    expect(splitCharacterStrings('"one" "two"')).toEqual(['"one"', '"two"']);
  });

  it("keeps an escaped quote inside its own string", () => {
    expect(splitCharacterStrings('"a\\"b" "c"')).toEqual(['"a\\"b"', '"c"']);
  });

  it("passes an unquoted value through whole", () => {
    expect(splitCharacterStrings("v=spf1 -all")).toEqual(["v=spf1 -all"]);
  });

  it("returns nothing for an empty presentation string", () => {
    expect(splitCharacterStrings("")).toEqual([]);
  });

  it("decodes the escapes DNS presentation format uses", () => {
    expect(decodeTxtEscapes('a\\"b')).toBe('a"b');
    expect(decodeTxtEscapes("a\\\\b")).toBe("a\\b");
    expect(decodeTxtEscapes("a\\032b")).toBe("a b");
  });

  it("leaves an escape-free string untouched", () => {
    expect(decodeTxtEscapes(WRIT)).toBe(WRIT);
  });
});

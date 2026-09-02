import { describe, expect, it } from "vitest";

import {
  AnchorError,
  resolveTarget,
  WritAnchor,
} from "@/lib/adapters/namecom/anchor";
import { NameComClient } from "@/lib/adapters/namecom/client";
import type { DnsRecord } from "@/lib/adapters/namecom/types";
import type { TxtLookup, TxtResolver } from "@/lib/dns/resolver";
import { serializeWritRecord, type WritRecord } from "@/lib/core/writ-record";

import { fakeFetch, type FakeFetch, type RecordedRequest } from "../fixtures/namecom/fake-fetch";

const ZONE = "chancery-writ.com";

const ACTIVE: WritRecord = {
  version: "WRIT1",
  status: "active",
  publicKey: "cHVibGljLWtleQ",
  documentHash: "ZG9jLWhhc2g",
  url: "https://chancery.example/w/1.pdf",
  expiresAt: 1_790_000_000,
};

const NEXT: WritRecord = { ...ACTIVE, documentHash: "ZG9jLWhhc2gtMg", expiresAt: 1_800_000_000 };
const TOMBSTONE: WritRecord = { ...ACTIVE, status: "revoked" };

function txtRecord(id: number, answer: string, host = "_writ"): DnsRecord {
  return {
    id,
    domainName: ZONE,
    host,
    fqdn: `${host}.${ZONE}.`,
    type: "TXT",
    answer,
    ttl: 300,
  };
}

/**
 * Drives the anchor against a scripted registrar: the first call is always the
 * record listing, and every write after it answers from `writes`.
 */
function anchorOver(existing: DnsRecord[], writes: unknown[] = []): {
  anchor: WritAnchor;
  fetch: FakeFetch;
} {
  const fetch = fakeFetch((_request: RecordedRequest, index: number) => {
    if (index === 0) return { body: { records: existing } };
    const write = writes[index - 1];
    if (write === undefined) return { status: 204 };
    return { body: write };
  });
  const client = new NameComClient({
    environment: "sandbox",
    username: "chancery-test",
    token: "tok3n",
    fetchImpl: fetch,
  });
  return { anchor: new WritAnchor({ client, resolver: stubResolver([]) }), fetch };
}

function stubResolver(
  values: string[],
  overrides: Partial<TxtLookup> = {},
): TxtResolver {
  return {
    async resolveTxt(name: string): Promise<TxtLookup> {
      return {
        name,
        status: 0,
        authenticatedData: true,
        answers: values.map((value) => ({ name, ttl: 300, chunks: [value], value })),
        values,
        ttl: values.length === 0 ? null : 300,
        resolver: "cloudflare",
        ...overrides,
      };
    },
  };
}

function anchorWithResolver(resolver: TxtResolver): WritAnchor {
  const client = new NameComClient({
    environment: "sandbox",
    username: "u",
    token: "t",
    fetchImpl: fakeFetch({ body: { records: [] } }),
  });
  return new WritAnchor({ client, resolver });
}

describe("target resolution", () => {
  it("anchors at _writ on the apex", () => {
    expect(resolveTarget({ zone: ZONE })).toEqual({
      zone: ZONE,
      agentDomain: ZONE,
      name: `_writ.${ZONE}`,
      host: "_writ",
    });
  });

  it("makes the host relative to the zone for a subdomain agent", () => {
    expect(resolveTarget({ zone: ZONE, agentDomain: `ops.${ZONE}` })).toMatchObject({
      name: `_writ.ops.${ZONE}`,
      host: "_writ.ops",
    });
  });

  it("normalises case and a trailing dot", () => {
    expect(resolveTarget({ zone: `${ZONE}.`, agentDomain: `OPS.${ZONE}` })).toMatchObject({
      host: "_writ.ops",
    });
  });

  it("refuses an agent domain outside the zone we can write", () => {
    expect(() => resolveTarget({ zone: ZONE, agentDomain: "ops.elsewhere.com" })).toThrow(
      AnchorError,
    );
  });

  it("is not fooled by a zone that is merely a suffix of the agent domain", () => {
    expect(() =>
      resolveTarget({ zone: "writ.com", agentDomain: "chancery-writ.com" }),
    ).toThrow(AnchorError);
  });
});

describe("publish", () => {
  it("creates a TXT record at _writ with the serialised writ and a 300s TTL", async () => {
    const value = serializeWritRecord(ACTIVE);
    const { anchor, fetch } = anchorOver([], [txtRecord(2001, value)]);
    const result = await anchor.publish({ zone: ZONE }, ACTIVE);

    expect(fetch.nth(1).method).toBe("POST");
    expect(fetch.nth(1).pathname).toBe(`/core/v1/domains/${ZONE}/records`);
    expect(fetch.nth(1).body).toEqual({
      host: "_writ",
      type: "TXT",
      answer: value,
      ttl: 300,
    });
    expect(result).toMatchObject({
      name: `_writ.${ZONE}`,
      host: "_writ",
      status: "active",
      created: true,
      removedRecordIds: [],
    });
  });

  it("is a no-op when the identical record is already published", async () => {
    const value = serializeWritRecord(ACTIVE);
    const { anchor, fetch } = anchorOver([txtRecord(2001, value)]);
    const result = await anchor.publish({ zone: ZONE }, ACTIVE);
    expect(result.created).toBe(false);
    expect(result.record.id).toBe(2001);
    // Listing only; nothing was written.
    expect(fetch.calls).toHaveLength(1);
  });

  it("refuses to write over a tombstone", async () => {
    const { anchor } = anchorOver([txtRecord(2001, serializeWritRecord(TOMBSTONE))]);
    await expect(anchor.publish({ zone: ZONE }, ACTIVE)).rejects.toMatchObject({
      code: "ALREADY_REVOKED",
    });
  });

  it("rejects a revoked writ, which belongs to revoke()", async () => {
    const { anchor } = anchorOver([]);
    await expect(anchor.publish({ zone: ZONE }, TOMBSTONE)).rejects.toMatchObject({
      code: "NOT_ACTIVE",
    });
  });

  it("refuses a writ too long for a single TXT character-string", async () => {
    const { anchor } = anchorOver([]);
    const huge: WritRecord = {
      ...ACTIVE,
      url: `https://chancery.example/${"w".repeat(240)}.pdf`,
    };
    await expect(anchor.publish({ zone: ZONE }, huge)).rejects.toMatchObject({
      code: "VALUE_TOO_LONG",
    });
  });

  it("ignores a subdomain's records when anchoring the apex", async () => {
    const value = serializeWritRecord(ACTIVE);
    const { anchor, fetch } = anchorOver(
      [txtRecord(2001, value, "_writ.ops")],
      [txtRecord(2002, value)],
    );
    const result = await anchor.publish({ zone: ZONE }, ACTIVE);
    expect(result.created).toBe(true);
    expect(fetch.nth(1).method).toBe("POST");
  });
});

describe("rotate", () => {
  it("publishes the replacement before deleting what it supersedes", async () => {
    const oldValue = serializeWritRecord(ACTIVE);
    const newValue = serializeWritRecord(NEXT);
    const { anchor, fetch } = anchorOver(
      [txtRecord(2001, oldValue)],
      [txtRecord(2002, newValue)],
    );
    const result = await anchor.rotate({ zone: ZONE }, NEXT);

    expect(fetch.nth(1).method).toBe("POST");
    expect((fetch.nth(1).body as { answer: string }).answer).toBe(newValue);
    expect(fetch.nth(2).method).toBe("DELETE");
    expect(fetch.nth(2).pathname).toBe(`/core/v1/domains/${ZONE}/records/2001`);
    expect(result.removedRecordIds).toEqual([2001]);
  });

  it("leaves unrelated TXT records at the same name alone", async () => {
    const oldValue = serializeWritRecord(ACTIVE);
    const newValue = serializeWritRecord(NEXT);
    const { anchor, fetch } = anchorOver(
      [
        txtRecord(2001, oldValue),
        txtRecord(2009, "google-site-verification=not-a-writ"),
      ],
      [txtRecord(2002, newValue)],
    );
    const result = await anchor.rotate({ zone: ZONE }, NEXT);
    expect(result.removedRecordIds).toEqual([2001]);
    const deleted = fetch.calls
      .filter((call) => call.method === "DELETE")
      .map((call) => call.pathname);
    expect(deleted).toEqual([`/core/v1/domains/${ZONE}/records/2001`]);
  });

  it("refuses to rotate past a tombstone", async () => {
    const { anchor } = anchorOver([txtRecord(2001, serializeWritRecord(TOMBSTONE))]);
    await expect(anchor.rotate({ zone: ZONE }, NEXT)).rejects.toMatchObject({
      code: "ALREADY_REVOKED",
    });
  });

  it("does not republish a record that is already the live one", async () => {
    const newValue = serializeWritRecord(NEXT);
    const { anchor, fetch } = anchorOver([txtRecord(2002, newValue)]);
    const result = await anchor.rotate({ zone: ZONE }, NEXT);
    expect(result.created).toBe(false);
    expect(fetch.calls).toHaveLength(1);
  });
});

describe("revoke", () => {
  it("publishes a st=revoked tombstone before clearing the active record", async () => {
    const activeValue = serializeWritRecord(ACTIVE);
    const tombstoneValue = serializeWritRecord(TOMBSTONE);
    const { anchor, fetch } = anchorOver(
      [txtRecord(2001, activeValue)],
      [txtRecord(2002, tombstoneValue)],
    );
    const result = await anchor.revoke({ zone: ZONE });

    expect(fetch.nth(1).method).toBe("POST");
    expect((fetch.nth(1).body as { answer: string }).answer).toBe(tombstoneValue);
    expect((fetch.nth(1).body as { answer: string }).answer).toContain("st=revoked");
    expect(fetch.nth(2).method).toBe("DELETE");
    expect(fetch.nth(2).pathname).toBe(`/core/v1/domains/${ZONE}/records/2001`);
    expect(result.status).toBe("revoked");
    expect(result.removedRecordIds).toEqual([2001]);
  });

  it("carries the key, hash, url and expiry of the writ it revokes", async () => {
    const { anchor, fetch } = anchorOver(
      [txtRecord(2001, serializeWritRecord(ACTIVE))],
      [txtRecord(2002, serializeWritRecord(TOMBSTONE))],
    );
    await anchor.revoke({ zone: ZONE });
    const answer = (fetch.nth(1).body as { answer: string }).answer;
    expect(answer).toContain(`k=${ACTIVE.publicKey}`);
    expect(answer).toContain(`h=${ACTIVE.documentHash}`);
    expect(answer).toContain(`exp=${ACTIVE.expiresAt}`);
  });

  it("refuses when there is nothing to revoke and no writ was supplied", async () => {
    const { anchor } = anchorOver([]);
    await expect(anchor.revoke({ zone: ZONE })).rejects.toMatchObject({
      code: "NO_SOURCE_RECORD",
    });
  });

  it("tombstones from an explicit writ when the record never propagated", async () => {
    const tombstoneValue = serializeWritRecord(TOMBSTONE);
    const { anchor, fetch } = anchorOver([], [txtRecord(2002, tombstoneValue)]);
    const result = await anchor.revoke({ zone: ZONE }, { from: ACTIVE });
    expect((fetch.nth(1).body as { answer: string }).answer).toBe(tombstoneValue);
    expect(result.created).toBe(true);
  });

  it("is idempotent once the tombstone is up", async () => {
    const { anchor, fetch } = anchorOver([
      txtRecord(2002, serializeWritRecord(TOMBSTONE)),
    ]);
    const result = await anchor.revoke({ zone: ZONE });
    expect(result.created).toBe(false);
    expect(result.removedRecordIds).toEqual([]);
    expect(fetch.calls).toHaveLength(1);
  });
});

describe("lookup over public DNS", () => {
  it("reports an active, DNSSEC-validated writ", async () => {
    const anchor = anchorWithResolver(stubResolver([serializeWritRecord(ACTIVE)]));
    const authority = await anchor.lookup(`ops.${ZONE}`);
    expect(authority.name).toBe(`_writ.ops.${ZONE}`);
    expect(authority.outcome).toBe("active");
    expect(authority.authenticatedData).toBe(true);
    expect(authority.resolver).toBe("cloudflare");
  });

  it("degrades an unvalidated active writ to unverified, which fails closed", async () => {
    const anchor = anchorWithResolver(
      stubResolver([serializeWritRecord(ACTIVE)], { authenticatedData: false }),
    );
    const authority = await anchor.lookup(`ops.${ZONE}`);
    expect(authority.outcome).toBe("unverified");
    // The raw DNS answer is still reported, so the audit trail keeps the facts.
    expect(authority.lookup.outcome).toBe("active");
  });

  it("degrades an unvalidated absence to unverified, since a tombstone could have been stripped", async () => {
    const anchor = anchorWithResolver(stubResolver([], { authenticatedData: false }));
    expect((await anchor.lookup(ZONE)).outcome).toBe("unverified");
  });

  it("reports a validated absence as absent", async () => {
    const anchor = anchorWithResolver(stubResolver([]));
    expect((await anchor.lookup(ZONE)).outcome).toBe("absent");
  });

  it("keeps a revocation revoked even without DNSSEC", async () => {
    const anchor = anchorWithResolver(
      stubResolver([serializeWritRecord(TOMBSTONE)], { authenticatedData: false }),
    );
    const authority = await anchor.lookup(ZONE);
    expect(authority.outcome).toBe("revoked");
  });

  it("lets a tombstone outrank a later-expiring active record at the same name", async () => {
    const anchor = anchorWithResolver(
      stubResolver([
        serializeWritRecord({ ...ACTIVE, expiresAt: 1_999_999_999 }),
        serializeWritRecord(TOMBSTONE),
      ]),
    );
    expect((await anchor.lookup(ZONE)).outcome).toBe("revoked");
  });

  it("hands back the raw DNS outcome when the DNSSEC gate is waived", async () => {
    const anchor = anchorWithResolver(
      stubResolver([serializeWritRecord(ACTIVE)], { authenticatedData: false }),
    );
    const authority = await anchor.lookup(ZONE, { requireDnssec: false });
    expect(authority.outcome).toBe("active");
    expect(authority.authenticatedData).toBe(false);
  });

  it("surfaces every TXT value it saw, writ or not", async () => {
    const anchor = anchorWithResolver(
      stubResolver([serializeWritRecord(ACTIVE), "v=spf1 -all"]),
    );
    expect((await anchor.lookup(ZONE)).txtRecords).toHaveLength(2);
  });
});

describe("registrar read-back", () => {
  it("reads the published writ through name.com for sandbox demos", async () => {
    const { anchor } = anchorOver([
      txtRecord(2001, serializeWritRecord(ACTIVE)),
      txtRecord(2009, "google-site-verification=not-a-writ"),
    ]);
    const readBack = await anchor.readFromRegistrar({ zone: ZONE });
    expect(readBack.name).toBe(`_writ.${ZONE}`);
    expect(readBack.txtRecords).toHaveLength(2);
    expect(readBack.lookup).toMatchObject({ outcome: "active" });
  });
});

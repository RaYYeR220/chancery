import { describe, expect, it } from "vitest";

import {
  chunkTxtValue,
  joinTxtChunks,
  parseWritRecord,
  selectWritRecord,
  serializeWritRecord,
  writRecordName,
  WritRecordError,
  type WritRecord,
} from "@/lib/core/writ-record";

const VALID =
  "v=WRIT1; st=active; k=cHVibGljLWtleQ; h=ZG9jLWhhc2g; " +
  "u=https://chancery.example/w/1.pdf; exp=1790000000";

const base: WritRecord = {
  version: "WRIT1",
  status: "active",
  publicKey: "cHVibGljLWtleQ",
  documentHash: "ZG9jLWhhc2g",
  url: "https://chancery.example/w/1.pdf",
  expiresAt: 1_790_000_000,
};

const code = (raw: string) => {
  try {
    parseWritRecord(raw);
    return "no-error";
  } catch (error) {
    return error instanceof WritRecordError ? error.code : "wrong-error-type";
  }
};

describe("record name", () => {
  it("prefixes the agent domain", () => {
    expect(writRecordName("ops.example.com")).toBe("_writ.ops.example.com");
  });

  it("tolerates a fully qualified name with a trailing dot", () => {
    expect(writRecordName("ops.example.com.")).toBe("_writ.ops.example.com");
  });
});

describe("parsing", () => {
  it("round-trips a record through serialisation", () => {
    expect(parseWritRecord(serializeWritRecord(base))).toEqual(base);
  });

  it("reads every tag", () => {
    const record = parseWritRecord(VALID);
    expect(record).toEqual(base);
  });

  it("defaults a record with no status tag to active", () => {
    const record = parseWritRecord(VALID.replace("st=active; ", ""));
    expect(record.status).toBe("active");
  });

  it("keeps an optional signature when present", () => {
    expect(parseWritRecord(`${VALID}; s=c2ln`).signature).toBe("c2ln");
  });

  it("is insensitive to tag case and stray whitespace", () => {
    expect(parseWritRecord(`  V=WRIT1 ;  ST=active ; ${VALID.split("; ").slice(2).join("; ")} `))
      .toEqual(base);
  });

  it("ignores a trailing empty segment", () => {
    expect(parseWritRecord(`${VALID};`)).toEqual(base);
  });

  it.each([
    ["an empty record", "", "MALFORMED"],
    ["a segment that is not a pair", "v=WRIT1; garbage", "MALFORMED"],
    ["a missing version", "k=a; h=b; u=https://x.test; exp=1", "MISSING_TAG"],
    ["a future version", VALID.replace("WRIT1", "WRIT2"), "WRONG_VERSION"],
    ["a missing key", VALID.replace("k=cHVibGljLWtleQ; ", ""), "MISSING_TAG"],
    ["a missing hash", VALID.replace("h=ZG9jLWhhc2g; ", ""), "MISSING_TAG"],
    ["a non-base64url key", VALID.replace("cHVibGljLWtleQ", "not+valid/"), "BAD_VALUE"],
    ["a non-https url", VALID.replace("https://", "http://"), "BAD_VALUE"],
    ["a non-numeric expiry", VALID.replace("1790000000", "soon"), "BAD_VALUE"],
    ["a negative expiry", VALID.replace("1790000000", "-1"), "BAD_VALUE"],
    ["an unknown status", VALID.replace("st=active", "st=maybe"), "BAD_VALUE"],
  ])("rejects %s", (_label, raw, expected) => {
    expect(code(raw)).toBe(expected);
  });

  it("cannot be tricked into re-activating by a duplicate status tag", () => {
    // First occurrence wins, so appending `st=active` after a tombstone must
    // not flip it back.
    const record = parseWritRecord(VALID.replace("st=active", "st=revoked") + "; st=active");
    expect(record.status).toBe("revoked");
  });
});

describe("TXT chunking", () => {
  it("splits a long value into resolver-sized pieces", () => {
    const chunks = chunkTxtValue("x".repeat(600));
    expect(chunks.map((c) => c.length)).toEqual([255, 255, 90]);
  });

  it("yields one empty chunk for an empty value", () => {
    expect(chunkTxtValue("")).toEqual([""]);
  });

  it("reassembles what it split", () => {
    const value = "y".repeat(700);
    expect(joinTxtChunks(chunkTxtValue(value))).toBe(value);
  });

  it("strips the quotes some resolvers add around each chunk", () => {
    expect(joinTxtChunks(['"v=WRIT1;"', '" k=a"'])).toBe("v=WRIT1; k=a");
  });
});

describe("selecting the record to act on", () => {
  it("reports absence when nothing is published", () => {
    expect(selectWritRecord([]).outcome).toBe("absent");
  });

  it("ignores unrelated TXT records on the same name", () => {
    const result = selectWritRecord(["v=spf1 -all", "google-site-verification=abc", VALID]);
    expect(result.outcome).toBe("active");
  });

  it("reports absence when every record on the name is unrelated", () => {
    expect(selectWritRecord(["v=spf1 -all"]).outcome).toBe("absent");
  });

  it("prefers the active record expiring latest, so a rotation never narrows authority", () => {
    const later = serializeWritRecord({ ...base, expiresAt: 1_800_000_000 });
    const result = selectWritRecord([VALID, later]);
    expect(result.outcome).toBe("active");
    expect(result.outcome === "active" && result.record.expiresAt).toBe(1_800_000_000);
  });

  it("lets a tombstone outrank an active record that expires later", () => {
    const tombstone = serializeWritRecord({ ...base, status: "revoked", expiresAt: 1 });
    const stillActive = serializeWritRecord({ ...base, expiresAt: 1_900_000_000 });
    expect(selectWritRecord([stillActive, tombstone]).outcome).toBe("revoked");
  });

  it("finds the tombstone whatever order the resolver returns records in", () => {
    const tombstone = serializeWritRecord({ ...base, status: "revoked" });
    expect(selectWritRecord([tombstone, VALID]).outcome).toBe("revoked");
    expect(selectWritRecord([VALID, tombstone]).outcome).toBe("revoked");
  });

  it("cannot be made to grant anything by a malformed record", () => {
    expect(selectWritRecord(["v=WRIT1; k=; h=; u=; exp="]).outcome).toBe("absent");
  });
});

describe("byte-accurate handling", () => {
  it("counts the 255-byte limit in bytes, not characters", () => {
    // A 200-character string of 3-byte characters is 600 bytes, which must be
    // three chunks, not one.
    const chunks = chunkTxtValue("あ".repeat(200));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(255);
    }
  });

  it("never splits a multi-byte character across two chunks", () => {
    const value = "é".repeat(300);
    expect(joinTxtChunks(chunkTxtValue(value))).toBe(value);
  });

  it("refuses to serialise a url containing a semicolon rather than corrupting the record", () => {
    expect(() =>
      serializeWritRecord({ ...base, url: "https://chancery.example/w?a=1;b=2" }),
    ).toThrow(WritRecordError);
  });
});

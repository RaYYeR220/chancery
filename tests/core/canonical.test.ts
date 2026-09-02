import { describe, expect, it } from "vitest";

import { canonicalize, CanonicalizationError, digest } from "@/lib/core/canonical";

describe("canonicalisation", () => {
  it("sorts object keys so insertion order cannot change the hash", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(digest({ b: 1, a: 2 })).toBe(digest({ a: 2, b: 1 }));
  });

  it("sorts nested keys too", () => {
    expect(canonicalize({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it("sorts on code units rather than locale collation", () => {
    expect(canonicalize({ a: 1, A: 2, "ä": 3 })).toBe('{"A":2,"a":1,"ä":3}');
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("emits no insignificant whitespace", () => {
    expect(canonicalize({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}');
  });

  it("normalises negative zero, which is the same number", () => {
    expect(canonicalize(-0)).toBe("0");
    expect(digest({ n: -0 })).toBe(digest({ n: 0 }));
  });

  it("escapes strings the way JSON does", () => {
    expect(canonicalize({ s: 'a"b\n' })).toBe('{"s":"a\\"b\\n"}');
  });

  it("handles null and booleans", () => {
    expect(canonicalize({ a: null, b: true, c: false })).toBe('{"a":null,"b":true,"c":false}');
  });
});

describe("values JSON cannot round-trip", () => {
  it.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("refuses %s rather than coercing it", (_label, value) => {
    expect(() => canonicalize(value)).toThrow(CanonicalizationError);
  });

  it("refuses an undefined property instead of silently dropping it", () => {
    expect(() => canonicalize({ a: 1, b: undefined })).toThrow(CanonicalizationError);
  });

  it("refuses a function instead of silently dropping it", () => {
    expect(() => canonicalize({ fn: () => 1 })).toThrow(CanonicalizationError);
  });

  it("names the path of the offending value", () => {
    try {
      canonicalize({ grants: [{ cap: Number.NaN }] });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as CanonicalizationError).path).toBe("/grants/0/cap");
    }
  });
});

describe("digest", () => {
  it("produces a 64-character hex sha256", () => {
    expect(digest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any value changes", () => {
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
  });

  it("distinguishes a number from its string form", () => {
    expect(digest({ a: 1 })).not.toBe(digest({ a: "1" }));
  });
});

import { describe, expect, it } from "vitest";

import { documentHash, toBase64Url } from "@/lib/core/bytes";

/**
 * The encoder is hand-rolled so it also runs in the browser, which means it has
 * to be checked against something authoritative rather than against itself.
 * Node's Buffer is that reference.
 */
function reference(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

describe("base64url", () => {
  it.each([0, 1, 2, 3, 4, 5, 15, 16, 17, 31, 32, 33, 64, 255])(
    "matches Buffer for a %i-byte input",
    (length) => {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) % 256);
      expect(toBase64Url(bytes)).toBe(reference(bytes));
    },
  );

  it("covers every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(toBase64Url(bytes)).toBe(reference(bytes));
  });

  it("emits no padding, which the record grammar would have to escape", () => {
    expect(toBase64Url(new Uint8Array([1]))).not.toContain("=");
    expect(toBase64Url(new Uint8Array([1, 2]))).not.toContain("=");
  });

  it("uses the url-safe alphabet", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(toBase64Url(bytes)).not.toMatch(/[+/=]/);
  });

  it("is empty for empty input", () => {
    expect(toBase64Url(new Uint8Array())).toBe("");
  });
});

describe("documentHash", () => {
  it("agrees with an independent sha256 of the same bytes", () => {
    const bytes = new TextEncoder().encode("a writ of authority");
    const expected = Buffer.from(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:crypto").createHash("sha256").update(bytes).digest(),
    ).toString("base64url");
    expect(documentHash(bytes)).toBe(expected);
  });

  it("changes when a single byte changes", () => {
    const a = documentHash(new TextEncoder().encode("clause 3(b): up to 3 domains"));
    const b = documentHash(new TextEncoder().encode("clause 3(b): up to 4 domains"));
    expect(a).not.toBe(b);
  });

  it("produces a fixed-length digest whatever the input size", () => {
    expect(documentHash(new Uint8Array())).toHaveLength(43);
    expect(documentHash(new Uint8Array(100_000))).toHaveLength(43);
  });

  it("survives the DNS record grammar without escaping", () => {
    const hash = documentHash(new TextEncoder().encode("x"));
    expect(hash).not.toMatch(/[;=\s"]/);
  });
});

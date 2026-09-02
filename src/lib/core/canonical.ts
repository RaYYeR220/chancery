/**
 * Canonical serialisation.
 *
 * Every hash we publish — the ledger chain, the evidence bundle digest, the
 * document hash in the DNS record — has to be reproducible by someone who only
 * has the JSON, on another machine, in another language. `JSON.stringify` is not
 * that: key order follows insertion order, so two structurally identical objects
 * can serialise differently and hash differently.
 *
 * This is JCS (RFC 8785) in the shape we actually need: keys sorted by their
 * UTF-16 code units, no insignificant whitespace, and a hard refusal on the
 * values JSON cannot round-trip rather than JSON's silent coercions —
 * `undefined` and functions vanishing from objects, `NaN` and `Infinity`
 * becoming `null`. A hash over silently-dropped data is worse than an error.
 */

// @noble/hashes v2 publishes its subpaths with the `.js` suffix; dropping it
// resolves under tsc but fails at runtime under Vite's stricter exports check.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export class CanonicalizationError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} (at ${path || "root"})`);
    this.name = "CanonicalizationError";
  }
}

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export function canonicalize(value: unknown): string {
  return write(value, "");
}

function write(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";

    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`${value} cannot be hashed`, path);
      }
      // `-0` and `0` are the same number but stringify differently.
      return Object.is(value, -0) ? "0" : JSON.stringify(value);

    case "string":
      return JSON.stringify(value);

    case "undefined":
      throw new CanonicalizationError("undefined cannot be hashed", path);

    case "object":
      break;

    default:
      throw new CanonicalizationError(`${typeof value} cannot be hashed`, path);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, i) => write(item, `${path}/${i}`)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  // Sort on code units, which is what `Array.prototype.sort` does by default
  // and what RFC 8785 specifies — not locale collation.
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const parts = entries.map(([key, item]) => {
    const child = `${path}/${key}`;
    if (item === undefined) {
      throw new CanonicalizationError(`property "${key}" is undefined`, child);
    }
    return `${JSON.stringify(key)}:${write(item, child)}`;
  });
  return `{${parts.join(",")}}`;
}

/** Hex sha256 of the canonical form. Hex, not base64url, so it can be eyeballed. */
export function digest(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalize(value))));
}

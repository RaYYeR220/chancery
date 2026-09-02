/**
 * Document hashing.
 *
 * base64url rather than hex, because this value has to survive a trip through a
 * DNS TXT record: it is roughly a third shorter, and it contains no character
 * that needs escaping in the `tag=value` grammar the record uses.
 *
 * Node's Buffer is avoided so the same function works unchanged in a browser,
 * where the public verifier page runs.
 */

import { sha256 } from "@noble/hashes/sha2.js";

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];

    out += BASE64URL_ALPHABET[a >> 2];
    out += BASE64URL_ALPHABET[((a & 0b11) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += BASE64URL_ALPHABET[((b & 0b1111) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += BASE64URL_ALPHABET[c & 0b111111];
  }
  // No `=` padding: it is not needed to decode a known-length digest, and it
  // would have to be escaped in the record grammar.
  return out;
}

/** The canonical document hash used in the WRIT1 record and everywhere downstream. */
export function documentHash(bytes: Uint8Array): string {
  return toBase64Url(sha256(bytes));
}

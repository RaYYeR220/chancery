/**
 * The WRIT1 DNS record.
 *
 * Closest existing analogue: CAA (RFC 8659). CAA is a DNS record that says who
 * is permitted to perform a consequential act for a domain — issue a
 * certificate. WRIT1 says which irreversible acts an agent is permitted to
 * perform on a principal's behalf, and points at the human-signed instrument
 * that grants them.
 *
 *   _writ.ops.example.com. 300 IN TXT
 *     "v=WRIT1; st=active; k=<ed25519 pubkey>; h=<sha256 of signed pdf>; u=<url>; exp=<unix>"
 *
 * Tags:
 *   v    version, always `WRIT1`
 *   st   `active` (default when absent) or `revoked` — see the tombstone rule below
 *   k    base64url ed25519 public key of the agent the writ was granted to
 *   h    base64url sha256 of the signed PDF, so a tampered document stops verifying
 *   u    https URL the signed PDF and its evidence bundle can be fetched from
 *   exp  unix seconds after which the writ is void, independent of the record TTL
 *   s    optional base64url ed25519 signature over the canonical payload
 *
 * DNSSEC is REQUIRED for a verifier to treat a WRIT1 record as authoritative.
 * Without it an on-path resolver can strip the tombstone described below, and
 * revocation stops being reliable. A verifier that cannot confirm the zone is
 * signed must report the authority as unverified, which fails closed.
 */

export const WRIT_RECORD_VERSION = "WRIT1";
export const WRIT_RECORD_PREFIX = "_writ";

/** Longest a single TXT character-string may be, per RFC 1035 3.3.14. */
export const TXT_CHUNK_LIMIT = 255;

/**
 * Revocation must outrank expiry, not compete with it.
 *
 * Revoking by deleting the record is not enough on its own: a resolver may
 * still be serving the deleted record from cache, and during a rotation two
 * records are briefly live at once. So revocation publishes a *tombstone* —
 * a `st=revoked` record — and any tombstone at the name wins over every active
 * record there, whatever its expiry. Publishing beats deleting because a
 * tombstone is a positive statement a cache cannot silently omit.
 */
export type WritStatus = "active" | "revoked";

export interface WritRecord {
  version: string;
  status: WritStatus;
  publicKey: string;
  documentHash: string;
  url: string;
  expiresAt: number;
  signature?: string;
}

export type WritLookup =
  | { outcome: "active"; record: WritRecord }
  | { outcome: "revoked"; record: WritRecord }
  | { outcome: "absent" };

export class WritRecordError extends Error {
  constructor(
    message: string,
    readonly code: "MALFORMED" | "WRONG_VERSION" | "MISSING_TAG" | "BAD_VALUE",
  ) {
    super(message);
    this.name = "WritRecordError";
  }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function writRecordName(domain: string): string {
  return `${WRIT_RECORD_PREFIX}.${stripTrailingDot(domain)}`;
}

function stripTrailingDot(name: string): string {
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

export function serializeWritRecord(record: WritRecord): string {
  const tags: string[] = [
    `v=${record.version}`,
    `st=${record.status}`,
    `k=${record.publicKey}`,
    `h=${record.documentHash}`,
    `u=${record.url}`,
    `exp=${record.expiresAt}`,
  ];
  if (record.signature) tags.push(`s=${record.signature}`);
  return tags.join("; ");
}

/**
 * Resolvers hand back TXT records as a list of <=255-byte strings the client is
 * expected to concatenate. Long records arrive pre-split, and some resolvers
 * wrap each chunk in quotes.
 */
export function joinTxtChunks(chunks: readonly string[]): string {
  return chunks.map((chunk) => chunk.replace(/^"|"$/g, "")).join("");
}

export function chunkTxtValue(value: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += TXT_CHUNK_LIMIT) {
    chunks.push(value.slice(i, i + TXT_CHUNK_LIMIT));
  }
  return chunks.length > 0 ? chunks : [""];
}

export function parseWritRecord(raw: string): WritRecord {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new WritRecordError("empty TXT record", "MALFORMED");
  }

  const tags = new Map<string, string>();
  for (const segment of trimmed.split(";")) {
    const part = segment.trim();
    if (part.length === 0) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) {
      throw new WritRecordError(`segment is not a tag=value pair: ${part}`, "MALFORMED");
    }
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    // First occurrence wins, so a trailing duplicate cannot override an earlier
    // tag — in particular it cannot flip `st=revoked` back to active.
    if (!tags.has(key)) tags.set(key, value);
  }

  const version = tags.get("v");
  if (version === undefined) {
    throw new WritRecordError("missing v= tag", "MISSING_TAG");
  }
  if (version !== WRIT_RECORD_VERSION) {
    throw new WritRecordError(`unsupported version ${version}`, "WRONG_VERSION");
  }

  const status = parseStatus(tags.get("st"));
  const publicKey = requireTag(tags, "k");
  const documentHash = requireTag(tags, "h");
  const url = requireTag(tags, "u");
  const expiresAt = parseExpiry(requireTag(tags, "exp"));

  if (!BASE64URL.test(publicKey)) {
    throw new WritRecordError("k= is not base64url", "BAD_VALUE");
  }
  if (!BASE64URL.test(documentHash)) {
    throw new WritRecordError("h= is not base64url", "BAD_VALUE");
  }
  if (!url.startsWith("https://")) {
    throw new WritRecordError("u= must be an https URL", "BAD_VALUE");
  }

  const signature = tags.get("s");
  if (signature !== undefined && !BASE64URL.test(signature)) {
    throw new WritRecordError("s= is not base64url", "BAD_VALUE");
  }

  return { version, status, publicKey, documentHash, url, expiresAt, signature };
}

function parseStatus(raw: string | undefined): WritStatus {
  if (raw === undefined) return "active";
  const value = raw.toLowerCase();
  if (value === "active" || value === "revoked") return value;
  // An unrecognised status is not assumed benign.
  throw new WritRecordError(`unknown st= value ${raw}`, "BAD_VALUE");
}

function parseExpiry(raw: string): number {
  const expiresAt = Number(raw);
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) {
    throw new WritRecordError("exp= must be a positive unix timestamp", "BAD_VALUE");
  }
  return expiresAt;
}

function requireTag(tags: Map<string, string>, key: string): string {
  const value = tags.get(key);
  if (value === undefined || value.length === 0) {
    throw new WritRecordError(`missing ${key}= tag`, "MISSING_TAG");
  }
  return value;
}

/**
 * Pick the record a verifier should act on.
 *
 * Order matters and is deliberately not "latest expiry wins":
 *   1. Any tombstone at the name revokes the name. A stale active record with a
 *      later expiry must never outrank a revocation.
 *   2. Otherwise take the active record expiring latest, so re-issuing a writ
 *      before the old one lapses never narrows authority mid-flight.
 *
 * Records that fail to parse are ignored rather than fatal — other systems
 * publish TXT records on the same name — but a malformed record can therefore
 * never *grant* anything either.
 */
export function selectWritRecord(rawRecords: readonly string[]): WritLookup {
  const parsed: WritRecord[] = [];
  for (const raw of rawRecords) {
    try {
      parsed.push(parseWritRecord(raw));
    } catch {
      continue;
    }
  }
  if (parsed.length === 0) return { outcome: "absent" };

  const tombstone = parsed.find((record) => record.status === "revoked");
  if (tombstone) return { outcome: "revoked", record: tombstone };

  const latest = parsed.reduce((best, candidate) =>
    candidate.expiresAt > best.expiresAt ? candidate : best,
  );
  return { outcome: "active", record: latest };
}

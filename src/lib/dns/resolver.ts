/**
 * DNS-over-HTTPS TXT resolver.
 *
 * This is the verifier's only source of truth about who may act for a
 * principal. It deliberately has no access to our database, our cache, or our
 * registrar client: if authority could be read out of Chancery's own storage,
 * revoking a writ would mean asking Chancery nicely, and a compromised
 * Chancery could keep an agent alive after its principal pulled the plug.
 * Public DNS is the only thing a third party can check without trusting us.
 *
 * The AD (Authenticated Data) bit is carried out to the caller for the same
 * reason. Revocation is published as a tombstone TXT record, and an on-path
 * resolver can strip a record it does not like. Without DNSSEC validation a
 * verifier cannot tell "no writ was ever published" from "the tombstone was
 * removed in flight", so a lookup that comes back with AD unset has to be
 * reported as unverified rather than treated as an answer.
 *
 * Two resolvers, because a single DoH endpoint is a single point of failure for
 * every verification in the system. The fallback is for transport failures
 * only: a definitive NOERROR or NXDOMAIN from the first resolver is the answer,
 * and asking a second resolver to get a different one would be shopping for the
 * result we wanted.
 */

import { joinTxtChunks } from "../core/writ-record";

export interface DohEndpoint {
  /** Reported back on the result so a verifier can record who answered. */
  name: string;
  url: string;
}

export const CLOUDFLARE_DOH: DohEndpoint = {
  name: "cloudflare",
  url: "https://cloudflare-dns.com/dns-query",
};

export const GOOGLE_DOH: DohEndpoint = {
  name: "google",
  url: "https://dns.google/resolve",
};

export const DEFAULT_DOH_ENDPOINTS: readonly DohEndpoint[] = [
  CLOUDFLARE_DOH,
  GOOGLE_DOH,
];

/** RFC 1035 §4.1.1 response codes we branch on. */
export const RCODE = {
  NOERROR: 0,
  FORMERR: 1,
  SERVFAIL: 2,
  NXDOMAIN: 3,
  REFUSED: 5,
} as const;

/** TXT. The DoH JSON API reports record types numerically. */
export const TXT_TYPE = 16;

export type DohErrorCode =
  | "TIMEOUT"
  | "TRANSPORT"
  | "HTTP_ERROR"
  | "MALFORMED_RESPONSE"
  | "SERVER_FAILURE"
  | "ALL_RESOLVERS_FAILED"
  | "INVALID_ARGUMENT";

export interface DohAttempt {
  resolver: string;
  error: DohError;
}

export class DohError extends Error {
  readonly code: DohErrorCode;
  readonly resolver: string | null;
  readonly status: number | null;
  /** Populated only on ALL_RESOLVERS_FAILED, one entry per endpoint tried. */
  readonly attempts: readonly DohAttempt[];

  constructor(
    message: string,
    code: DohErrorCode,
    init: {
      resolver?: string | null;
      status?: number | null;
      attempts?: readonly DohAttempt[];
      cause?: unknown;
    } = {},
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "DohError";
    this.code = code;
    this.resolver = init.resolver ?? null;
    this.status = init.status ?? null;
    this.attempts = init.attempts ?? [];
  }
}

export interface TxtAnswer {
  name: string;
  ttl: number;
  /** Character-strings exactly as presented, quotes and escapes intact. */
  chunks: string[];
  /** Chunks concatenated and unescaped — the value the publisher wrote. */
  value: string;
}

export interface TxtLookup {
  /** The name asked about, without a trailing dot. */
  name: string;
  /** DNS RCODE. NXDOMAIN is an answer, not a failure. */
  status: number;
  /**
   * True only when the answering resolver validated the DNSSEC chain. False
   * means the zone is unsigned, the resolver does not validate, or someone
   * tampered — none of which a verifier is allowed to treat as authoritative.
   */
  authenticatedData: boolean;
  answers: TxtAnswer[];
  /** `answers.map(a => a.value)`, which is all most callers want. */
  values: string[];
  /** Shortest TTL across the answers, so a cache honours the tightest one. */
  ttl: number | null;
  resolver: string;
}

export interface TxtResolver {
  resolveTxt(name: string, options?: { signal?: AbortSignal }): Promise<TxtLookup>;
}

export interface DohResolverOptions {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Tried in order; only transport-level failures move on to the next. */
  endpoints?: readonly DohEndpoint[];
  timeoutMs?: number;
}

interface DohJsonAnswer {
  name?: unknown;
  type?: unknown;
  TTL?: unknown;
  data?: unknown;
}

interface DohJsonResponse {
  Status?: unknown;
  AD?: unknown;
  Answer?: unknown;
}

export class DohResolver implements TxtResolver {
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly endpoints: readonly DohEndpoint[];
  private readonly timeoutMs: number;

  constructor(options: DohResolverOptions = {}) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new DohError(
        "no fetch implementation available; pass fetchImpl",
        "INVALID_ARGUMENT",
      );
    }
    this.fetchImpl = fetchImpl;
    this.endpoints = options.endpoints ?? DEFAULT_DOH_ENDPOINTS;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (this.endpoints.length === 0) {
      throw new DohError("at least one DoH endpoint is required", "INVALID_ARGUMENT");
    }
  }

  async resolveTxt(
    name: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TxtLookup> {
    const target = normaliseName(name);
    const attempts: DohAttempt[] = [];

    for (const endpoint of this.endpoints) {
      try {
        const lookup = await this.query(endpoint, target, options.signal);
        // SERVFAIL is the one RCODE worth a second opinion: it is what a
        // validating resolver returns when DNSSEC validation fails, and it is
        // also what it returns when it simply could not reach the zone.
        if (lookup.status === RCODE.SERVFAIL) {
          attempts.push({
            resolver: endpoint.name,
            error: new DohError(
              `${endpoint.name} returned SERVFAIL for ${target}`,
              "SERVER_FAILURE",
              { resolver: endpoint.name },
            ),
          });
          continue;
        }
        return lookup;
      } catch (error) {
        if (!(error instanceof DohError)) throw error;
        attempts.push({ resolver: endpoint.name, error });
      }
    }

    throw new DohError(
      `no DoH resolver could answer TXT ${target} (${attempts
        .map((attempt) => `${attempt.resolver}: ${attempt.error.code}`)
        .join(", ")})`,
      "ALL_RESOLVERS_FAILED",
      { attempts, cause: attempts[attempts.length - 1]?.error },
    );
  }

  private async query(
    endpoint: DohEndpoint,
    name: string,
    signal: AbortSignal | undefined,
  ): Promise<TxtLookup> {
    const search = new URLSearchParams({
      name,
      type: "TXT",
      // Checking-disabled off, stated explicitly: with cd=1 the resolver skips
      // validation and AD would be meaningless.
      cd: "false",
    });
    const url = `${endpoint.url}?${search.toString()}`;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const forwardAbort = () => controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        // Both endpoints serve DNS wire format by default; this header is what
        // selects the JSON representation parsed below.
        headers: { accept: "application/dns-json" },
        signal: controller.signal,
      });
    } catch (cause) {
      throw new DohError(
        timedOut
          ? `${endpoint.name} timed out after ${this.timeoutMs}ms`
          : `${endpoint.name} was unreachable`,
        timedOut ? "TIMEOUT" : "TRANSPORT",
        { resolver: endpoint.name, cause },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }

    if (!response.ok) {
      throw new DohError(
        `${endpoint.name} answered ${response.status}`,
        "HTTP_ERROR",
        { resolver: endpoint.name, status: response.status },
      );
    }

    let payload: DohJsonResponse;
    try {
      payload = (await response.json()) as DohJsonResponse;
    } catch (cause) {
      throw new DohError(
        `${endpoint.name} returned a body that is not JSON`,
        "MALFORMED_RESPONSE",
        { resolver: endpoint.name, status: response.status, cause },
      );
    }

    if (typeof payload.Status !== "number") {
      throw new DohError(
        `${endpoint.name} returned no DNS Status field`,
        "MALFORMED_RESPONSE",
        { resolver: endpoint.name, status: response.status },
      );
    }

    const answers = parseAnswers(payload.Answer);
    return {
      name,
      status: payload.Status,
      // Absent AD is unset AD. Never default this to true.
      authenticatedData: payload.AD === true,
      answers,
      values: answers.map((answer) => answer.value),
      ttl: answers.length === 0
        ? null
        : answers.reduce((min, answer) => Math.min(min, answer.ttl), Infinity),
      resolver: endpoint.name,
    };
  }
}

export function createDohResolver(options: DohResolverOptions = {}): DohResolver {
  return new DohResolver(options);
}

function parseAnswers(raw: unknown): TxtAnswer[] {
  if (!Array.isArray(raw)) return [];
  const answers: TxtAnswer[] = [];
  for (const entry of raw as DohJsonAnswer[]) {
    if (entry === null || typeof entry !== "object") continue;
    // A CNAME in the chain shows up in Answer alongside the TXT it points at.
    if (entry.type !== TXT_TYPE) continue;
    if (typeof entry.data !== "string") continue;
    const chunks = splitCharacterStrings(entry.data);
    answers.push({
      name: typeof entry.name === "string" ? stripTrailingDot(entry.name) : "",
      ttl: typeof entry.TTL === "number" ? entry.TTL : 0,
      chunks,
      value: decodeTxtEscapes(joinTxtChunks(chunks)),
    });
  }
  return answers;
}

/**
 * A TXT record is a *list* of character-strings, each capped at 255 bytes, and
 * the DoH JSON API hands the whole list back in one presentation-format string:
 * `"first" "second"`. Splitting on spaces would corrupt any value containing
 * one, so the boundaries are found by tracking quotes and honouring backslash
 * escapes. The pieces are then concatenated with the shared `joinTxtChunks`, so
 * a writ split across chunks parses identically to one that fit in a single
 * string.
 */
export function splitCharacterStrings(data: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < data.length) {
    const char = data[i];
    if (char === " " || char === "\t") {
      i += 1;
      continue;
    }
    if (char !== '"') {
      // Some resolvers hand back a short single-string TXT unquoted.
      const rest = data.slice(i).trim();
      if (rest.length > 0) tokens.push(rest);
      break;
    }
    let token = '"';
    let j = i + 1;
    while (j < data.length) {
      const current = data[j];
      if (current === "\\") {
        token += current + (data[j + 1] ?? "");
        j += 2;
        continue;
      }
      token += current;
      j += 1;
      if (current === '"') break;
    }
    tokens.push(token);
    i = j;
  }
  return tokens;
}

/**
 * Undoes DNS presentation-format escaping: `\"`, `\\`, and the `\DDD` decimal
 * form. Run after joining, because the escapes are character-local and the
 * tokenizer has already found the real chunk boundaries.
 */
export function decodeTxtEscapes(value: string): string {
  if (!value.includes("\\")) return value;
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "\\") {
      out += value[i];
      continue;
    }
    const decimal = value.slice(i + 1, i + 4);
    if (/^\d{3}$/.test(decimal)) {
      out += String.fromCharCode(Number(decimal));
      i += 3;
      continue;
    }
    out += value[i + 1] ?? "";
    i += 1;
  }
  return out;
}

function normaliseName(name: string): string {
  const trimmed = stripTrailingDot(name.trim());
  if (trimmed.length === 0) {
    throw new DohError("cannot resolve an empty name", "INVALID_ARGUMENT");
  }
  return trimmed;
}

function stripTrailingDot(name: string): string {
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

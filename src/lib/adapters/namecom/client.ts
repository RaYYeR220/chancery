/**
 * name.com Core API v1 client.
 *
 * Two constraints shape this file, and both come from the fact that domain
 * registration is one of Chancery's gated irreversible acts:
 *
 *   1. Registration cannot be called without an idempotency key. The key is a
 *      branded type, so a plain string will not compile at the call site. A
 *      timeout on `POST /core/v1/domains` is not evidence that nothing was
 *      bought, and replaying the same key is the only way to find out safely.
 *   2. A DNS `PUT` is a full overwrite, and the writ record lives in DNS. A
 *      partial update that silently blanks `answer` would revoke authority by
 *      accident, so the overwrite path demands a complete record and the
 *      convenience path does the GET itself.
 *
 * Everything is driven through an injectable `fetchImpl`: nothing here reaches
 * the network on its own, so the whole surface is testable without credentials.
 */

import {
  NameComError,
  nameComErrorFromResponse,
} from "./errors";
import type {
  AccountBalance,
  CheckAvailabilityRequest,
  DnsRecord,
  DnsRecordDraft,
  DnsRecordReplacement,
  DnssecDraft,
  DnssecKey,
  Domain,
  DomainToggles,
  FetchLike,
  HelloResponse,
  ListDnssecResponse,
  ListDomainsParams,
  ListDomainsResponse,
  ListRecordsParams,
  ListRecordsResponse,
  ListTldPricingParams,
  ListVanityNameserversResponse,
  NameComEnvironment,
  RegisterDomainRequest,
  RegisterDomainResponse,
  SearchRequest,
  SearchResponse,
  SetNameserversResponse,
  TldPrice,
  TldPricingResponse,
  TldRequirementsSchema,
  VanityNameserver,
  ZoneCheckRequest,
  ZoneCheckResponse,
} from "./types";

export const CORE_V1 = "/core/v1";

export const NAMECOM_BASE_URLS: Record<NameComEnvironment, string> = {
  // The published OpenAPI lists only the sandbox server, so codegen'd clients
  // quietly default there. Deriving the base URL from an explicit environment
  // removes the chance of a production register landing in sandbox or worse.
  sandbox: "https://api.dev.name.com",
  production: "https://api.name.com",
};

/** name.com rejects anything shorter, and short TTLs are what make revocation fast. */
export const MIN_TTL = 300;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Branded so `register(request, "whatever")` is a compile error. The brand is
 * the mechanism by which "you must not be able to double-buy" is enforced at
 * the type level rather than by a code review comment.
 */
export type IdempotencyKey = string & {
  readonly __brand: "namecom.idempotencyKey";
};

export function idempotencyKey(value: string): IdempotencyKey {
  if (!UUID_V4.test(value)) {
    throw new NameComError(
      `idempotency key must be a UUID v4, got ${JSON.stringify(value)}`,
      "INVALID_IDEMPOTENCY_KEY",
    );
  }
  return value as IdempotencyKey;
}

export function newIdempotencyKey(): IdempotencyKey {
  return crypto.randomUUID() as IdempotencyKey;
}

export interface NameComClientOptions {
  environment: NameComEnvironment;
  username: string;
  /** The API token from account settings, never the account password. */
  token: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  userAgent?: string;
  /** Injected so rate-limit backoff is derived from a clock a test controls. */
  now?: () => number;
}

export interface CallOptions {
  signal?: AbortSignal;
}

type QueryValue = string | number | boolean | undefined | null;
type QueryParams = Record<string, QueryValue | QueryValue[]>;

interface RequestOptions extends CallOptions {
  query?: QueryParams;
  body?: unknown;
  headers?: Record<string, string>;
}

const PARSE_FAILED = Symbol("namecom.parseFailed");

export class NameComClient {
  readonly environment: NameComEnvironment;
  readonly baseUrl: string;
  readonly username: string;

  private readonly authorization: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly userAgent: string | undefined;
  private readonly now: () => number;

  constructor(options: NameComClientOptions) {
    if (options.username.length === 0 || options.token.length === 0) {
      throw new NameComError(
        "username and token are both required",
        "INVALID_ARGUMENT",
      );
    }
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new NameComError(
        "no fetch implementation available; pass fetchImpl",
        "INVALID_ARGUMENT",
      );
    }

    this.environment = options.environment;
    this.baseUrl = NAMECOM_BASE_URLS[options.environment];
    this.username = options.username;
    this.authorization = basicAuth(options.username, options.token);
    this.fetchImpl = fetchImpl as FetchLike;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.userAgent = options.userAgent;
    this.now = options.now ?? Date.now;
  }

  /* ------------------------------------------------------------- discovery */

  /** Cheapest possible credential check: it echoes back the username it saw. */
  hello(options: CallOptions = {}): Promise<HelloResponse> {
    return this.request<HelloResponse>("GET", `${CORE_V1}/hello`, options);
  }

  checkAvailability(
    request: CheckAvailabilityRequest,
    options: CallOptions = {},
  ): Promise<SearchResponse> {
    return this.request<SearchResponse>(
      "POST",
      `${CORE_V1}/domains:checkAvailability`,
      { ...options, body: request },
    );
  }

  searchDomains(
    request: SearchRequest,
    options: CallOptions = {},
  ): Promise<SearchResponse> {
    return this.request<SearchResponse>("POST", `${CORE_V1}/domains:search`, {
      ...options,
      body: request,
    });
  }

  /**
   * Cached zone data. Much faster than a live registry check and correspondingly
   * weaker evidence — treat `available: true` as a shortlist, then confirm with
   * `checkAvailability` before spending anything.
   */
  zoneCheck(
    request: ZoneCheckRequest,
    options: CallOptions = {},
  ): Promise<ZoneCheckResponse> {
    return this.request<ZoneCheckResponse>("POST", `${CORE_V1}/zonecheck`, {
      ...options,
      body: request,
    });
  }

  /* --------------------------------------------------------------- domains */

  /**
   * The one call in this client that spends money.
   *
   * `key` is positional and branded so it cannot be forgotten or fudged. Reuse
   * the same key when retrying a request that timed out: name.com will return
   * the original order rather than buying a second domain.
   */
  // `async` so a bad key surfaces as a rejection like every other failure,
  // rather than as a synchronous throw the caller's `.catch` would miss.
  async registerDomain(
    request: RegisterDomainRequest,
    key: IdempotencyKey,
    options: CallOptions = {},
  ): Promise<RegisterDomainResponse> {
    // Re-validate at runtime: the brand is erased by compilation, so a value
    // that arrived through JSON or `as` still has to be a real UUID v4.
    const validated = idempotencyKey(key);
    return this.request<RegisterDomainResponse>("POST", `${CORE_V1}/domains`, {
      ...options,
      body: request,
      headers: { "x-idempotency-key": validated },
    });
  }

  listDomains(
    params: ListDomainsParams = {},
    options: CallOptions = {},
  ): Promise<ListDomainsResponse> {
    return this.request<ListDomainsResponse>("GET", `${CORE_V1}/domains`, {
      ...options,
      query: { page: params.page, perPage: params.perPage },
    });
  }

  getDomain(domainName: string, options: CallOptions = {}): Promise<Domain> {
    return this.request<Domain>(
      "GET",
      `${CORE_V1}/domains/${segment(domainName)}`,
      options,
    );
  }

  /** PATCH, so an unmentioned flag keeps its current value. */
  patchDomain(
    domainName: string,
    toggles: DomainToggles,
    options: CallOptions = {},
  ): Promise<Domain> {
    return this.request<Domain>(
      "PATCH",
      `${CORE_V1}/domains/${segment(domainName)}`,
      { ...options, body: toggles },
    );
  }

  /* ------------------------------------------------------------------- dns */

  listRecords(
    domainName: string,
    params: ListRecordsParams = {},
    options: CallOptions = {},
  ): Promise<ListRecordsResponse> {
    return this.request<ListRecordsResponse>(
      "GET",
      `${CORE_V1}/domains/${segment(domainName)}/records`,
      { ...options, query: { page: params.page, perPage: params.perPage } },
    );
  }

  getRecord(
    domainName: string,
    recordId: number,
    options: CallOptions = {},
  ): Promise<DnsRecord> {
    return this.request<DnsRecord>(
      "GET",
      `${CORE_V1}/domains/${segment(domainName)}/records/${segment(String(recordId))}`,
      options,
    );
  }

  async createRecord(
    domainName: string,
    draft: DnsRecordDraft,
    options: CallOptions = {},
  ): Promise<DnsRecord> {
    const ttl = draft.ttl ?? MIN_TTL;
    assertTtl(ttl);
    return this.request<DnsRecord>(
      "POST",
      `${CORE_V1}/domains/${segment(domainName)}/records`,
      { ...options, body: { ...draft, ttl } },
    );
  }

  /**
   * Full overwrite. Named `replaceRecord`, not `updateRecord`, because that is
   * what the server does: fields absent from the body are cleared. The
   * `DnsRecordReplacement` type requires all of them so the call site has to
   * state the record it intends to end up with.
   */
  async replaceRecord(
    domainName: string,
    recordId: number,
    record: DnsRecordReplacement,
    options: CallOptions = {},
  ): Promise<DnsRecord> {
    assertTtl(record.ttl);
    return this.request<DnsRecord>(
      "PUT",
      `${CORE_V1}/domains/${segment(domainName)}/records/${segment(String(recordId))}`,
      { ...options, body: record },
    );
  }

  /**
   * Read-modify-write around the overwrite. Fetches the record, applies the
   * patch, and PUTs the merged result, so changing a TTL cannot blank an
   * `answer` the caller never looked at.
   */
  async updateRecord(
    domainName: string,
    recordId: number,
    patch: Partial<DnsRecordReplacement>,
    options: CallOptions = {},
  ): Promise<DnsRecord> {
    const current = await this.getRecord(domainName, recordId, options);
    const merged: DnsRecordReplacement = {
      host: patch.host ?? current.host ?? "",
      type: patch.type ?? current.type,
      answer: patch.answer ?? current.answer,
      ttl: patch.ttl ?? current.ttl,
    };
    const priority = patch.priority ?? current.priority;
    if (priority !== undefined) merged.priority = priority;
    return this.replaceRecord(domainName, recordId, merged, options);
  }

  /** Returns 204 with an empty body, so there is nothing to hand back. */
  async deleteRecord(
    domainName: string,
    recordId: number,
    options: CallOptions = {},
  ): Promise<void> {
    await this.request<void>(
      "DELETE",
      `${CORE_V1}/domains/${segment(domainName)}/records/${segment(String(recordId))}`,
      options,
    );
  }

  /* ---------------------------------------------------------------- dnssec */

  listDnssec(
    domainName: string,
    options: CallOptions = {},
  ): Promise<ListDnssecResponse> {
    return this.request<ListDnssecResponse>(
      "GET",
      `${CORE_V1}/domains/${segment(domainName)}/dnssec`,
      options,
    );
  }

  createDnssec(
    domainName: string,
    draft: DnssecDraft,
    options: CallOptions = {},
  ): Promise<DnssecKey> {
    return this.request<DnssecKey>(
      "POST",
      `${CORE_V1}/domains/${segment(domainName)}/dnssec`,
      { ...options, body: draft },
    );
  }

  getDnssec(
    domainName: string,
    digest: string,
    options: CallOptions = {},
  ): Promise<DnssecKey> {
    return this.request<DnssecKey>(
      "GET",
      `${CORE_V1}/domains/${segment(domainName)}/dnssec/${segment(digest)}`,
      options,
    );
  }

  async deleteDnssec(
    domainName: string,
    digest: string,
    options: CallOptions = {},
  ): Promise<void> {
    await this.request<void>(
      "DELETE",
      `${CORE_V1}/domains/${segment(domainName)}/dnssec/${segment(digest)}`,
      options,
    );
  }

  /* ----------------------------------------------------------- nameservers */

  setNameservers(
    domainName: string,
    nameservers: string[],
    options: CallOptions = {},
  ): Promise<SetNameserversResponse> {
    return this.request<SetNameserversResponse>(
      "POST",
      // Action suffix: the colon belongs to the route, the domain does not.
      `${CORE_V1}/domains/${segment(domainName)}:setNameservers`,
      { ...options, body: { nameservers } },
    );
  }

  listVanityNameservers(
    domainName: string,
    options: CallOptions = {},
  ): Promise<ListVanityNameserversResponse> {
    return this.request<ListVanityNameserversResponse>(
      "GET",
      `${CORE_V1}/domains/${segment(domainName)}/vanity_nameservers`,
      options,
    );
  }

  createVanityNameserver(
    domainName: string,
    nameserver: { hostname: string; ips: string[] },
    options: CallOptions = {},
  ): Promise<VanityNameserver> {
    return this.request<VanityNameserver>(
      "POST",
      `${CORE_V1}/domains/${segment(domainName)}/vanity_nameservers`,
      { ...options, body: nameserver },
    );
  }

  /* --------------------------------------------------------------- account */

  getBalance(options: CallOptions = {}): Promise<AccountBalance> {
    return this.request<AccountBalance>(
      "GET",
      `${CORE_V1}/accountinfo/balance`,
      options,
    );
  }

  /** Normalises the two envelope spellings so callers only read `results`. */
  async listTldPricing(
    params: ListTldPricingParams = {},
    options: CallOptions = {},
  ): Promise<{ results: TldPrice[]; nextPage?: number; lastPage?: number }> {
    const response = await this.request<TldPricingResponse>(
      "GET",
      `${CORE_V1}/tldpricing`,
      { ...options, query: { page: params.page, perPage: params.perPage } },
    );
    return {
      results: response.results ?? response.tldPricing ?? [],
      nextPage: response.nextPage,
      lastPage: response.lastPage,
    };
  }

  /**
   * JSON Schema Draft-7 for a TLD's extra registration fields. Fetch it before
   * registering under an unfamiliar TLD rather than discovering the requirement
   * as a 400 mid-purchase.
   */
  getTldRequirements(
    tld: string,
    options: CallOptions = {},
  ): Promise<TldRequirementsSchema> {
    return this.request<TldRequirementsSchema>(
      "GET",
      `${CORE_V1}/domaininfo/requirementsV2/${segment(stripLeadingDot(tld))}`,
      options,
    );
  }

  /* ---------------------------------------------------------------- plumbing */

  private buildUrl(path: string, query?: QueryParams): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item === undefined || item === null) continue;
          search.append(key, String(item));
        }
        continue;
      }
      search.set(key, String(value));
    }
    const qs = search.toString();
    return `${this.baseUrl}${path}${qs.length > 0 ? `?${qs}` : ""}`;
  }

  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      authorization: this.authorization,
      accept: "application/json",
    };
    if (this.userAgent !== undefined) headers["user-agent"] = this.userAgent;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    Object.assign(headers, options.headers);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const forwardAbort = () => controller.abort();
    options.signal?.addEventListener("abort", forwardAbort, { once: true });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (cause) {
      if (timedOut) {
        throw new NameComError(
          `${method} ${path} timed out after ${this.timeoutMs}ms`,
          "TIMEOUT",
          { method, path, cause },
        );
      }
      throw new NameComError(`${method} ${path} could not be sent`, "TRANSPORT", {
        method,
        path,
        cause,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", forwardAbort);
    }

    return this.readBody<T>(response, method, path);
  }

  private async readBody<T>(
    response: Response,
    method: string,
    path: string,
  ): Promise<T> {
    // DELETE answers 204 with nothing at all; calling .json() on it throws.
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const parsed = text.length === 0 ? undefined : safeJson(text);
    const body = parsed === PARSE_FAILED ? text : parsed;

    if (!response.ok) {
      throw nameComErrorFromResponse(response.status, response.headers, body, {
        method,
        path,
        now: this.now(),
      });
    }
    if (parsed === PARSE_FAILED) {
      throw new NameComError(
        `${method} ${path} returned ${response.status} with a non-JSON body`,
        "MALFORMED_RESPONSE",
        { status: response.status, method, path, body: text },
      );
    }
    return parsed as T;
  }
}

/**
 * `domains:search`, `domains:checkAvailability` and `{domain}:setNameservers`
 * are action routes where the colon is part of the path. Percent-encoding it to
 * `%3A` makes name.com miss the route, so only caller-supplied segments go
 * through `encodeURIComponent` and the literal action suffix is concatenated
 * afterwards.
 */
function segment(value: string): string {
  return encodeURIComponent(value);
}

function stripLeadingDot(tld: string): string {
  return tld.startsWith(".") ? tld.slice(1) : tld;
}

function assertTtl(ttl: number): void {
  if (!Number.isInteger(ttl) || ttl < MIN_TTL) {
    throw new NameComError(
      `ttl must be an integer >= ${MIN_TTL}, got ${ttl}`,
      "TTL_TOO_LOW",
    );
  }
}

/**
 * Built by hand rather than with `btoa` on the raw string, because `btoa`
 * throws on any non-latin1 character and a username can legitimately contain
 * one.
 */
function basicAuth(username: string, token: string): string {
  const bytes = new TextEncoder().encode(`${username}:${token}`);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `Basic ${btoa(binary)}`;
}

function safeJson(text: string): unknown | typeof PARSE_FAILED {
  try {
    return JSON.parse(text);
  } catch {
    return PARSE_FAILED;
  }
}

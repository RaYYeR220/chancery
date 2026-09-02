/**
 * Wire types for name.com Core API v1.
 *
 * Core v1, not v4: v4 is marked deprecated and sunsets in 2026, and only v1+
 * receives new endpoints. Every path in this adapter is prefixed `/core/v1`.
 *
 * Shapes come from the Core v1 spec. Where the spec pins an envelope key we
 * name it exactly; where a payload is documented only by example (pricing,
 * balance) the interface is a best-effort surface and the raw body is still
 * returned, so an unexpected field is never silently dropped.
 */

export type NameComEnvironment = "sandbox" | "production";

/**
 * Narrower than the DOM `fetch` so a test can supply a two-line function
 * instead of implementing an overloaded global.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PurchaseType = "registration" | "renewal" | "transfer";

export interface HelloResponse {
  motd: string;
  serverName: string;
  serverTime: string;
  /** Echoes the authenticated username, which makes this the credential smoke test. */
  username: string;
}

/* --------------------------------------------------------------- discovery */

export interface DomainSearchResult {
  domainName: string;
  sld: string;
  tld: string;
  purchasable: boolean;
  premium: boolean;
  purchasePrice: number;
  renewalPrice: number;
  purchaseType: string;
  /** Why a name is not purchasable. Present only on rejections. */
  reason?: string;
}

export interface CheckAvailabilityRequest {
  /** name.com caps this at 50 per call. */
  domainNames: string[];
  purchaseType?: PurchaseType;
}

export interface SearchRequest {
  keyword: string;
  /** At most 50 TLDs. */
  tldFilter?: string[];
  /** Milliseconds name.com will spend before returning what it has. */
  timeout?: number;
  purchaseType?: PurchaseType;
}

/**
 * `domains:search` omits names it could not match; `domains:checkAvailability`
 * returns them with `purchasable: false` and a `reason`. Same envelope, so the
 * difference only shows up in what is missing.
 */
export interface SearchResponse {
  results: DomainSearchResult[];
}

export interface ZoneCheckRequest {
  domainNames: string[];
}

export interface ZoneCheckResult {
  domainName: string;
  available: boolean;
}

/** Cached zone data rather than a live registry check — fast, and only a hint. */
export interface ZoneCheckResponse {
  results: ZoneCheckResult[];
  total: number;
  /** How many inputs were dropped as unparseable or unsupported. */
  removed: number;
}

/* ----------------------------------------------------------------- domains */

export interface Contact {
  firstName: string;
  lastName: string;
  companyName?: string;
  address1: string;
  address2?: string;
  city: string;
  state?: string;
  zip: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  phone: string;
  email: string;
  fax?: string;
}

export interface Contacts {
  registrant?: Contact;
  admin?: Contact;
  tech?: Contact;
  billing?: Contact;
}

export interface Domain {
  domainName: string;
  nameservers?: string[];
  contacts?: Contacts;
  privacyEnabled?: boolean;
  locked?: boolean;
  autorenewEnabled?: boolean;
  expireDate?: string;
  createDate?: string;
  renewalPrice?: number;
}

export interface DomainDraft {
  domainName: string;
  nameservers?: string[];
  privacyEnabled?: boolean;
  autorenewEnabled?: boolean;
  locked?: boolean;
  /** Omit entirely to fall back to the account's default contact set. */
  contacts?: Contacts;
}

export interface RegisterDomainRequest {
  domain: DomainDraft;
  years?: number;
  /**
   * The price the caller agreed to. A mismatch is a 400 rather than a silent
   * charge at the new price, which is what makes a spend cap enforceable.
   */
  purchasePrice?: number;
  purchaseType?: PurchaseType;
  promoCode?: string;
}

export interface RegisterDomainResponse {
  domain: Domain;
  order: number;
  totalPaid: number;
}

export interface ListDomainsParams {
  page?: number;
  /** name.com defaults to 250. */
  perPage?: number;
}

export interface ListDomainsResponse {
  domains: Domain[];
  nextPage?: number;
  lastPage?: number;
}

/** The three flags `PATCH /core/v1/domains/{domain}` accepts. */
export interface DomainToggles {
  autorenewEnabled?: boolean;
  privacyEnabled?: boolean;
  locked?: boolean;
}

/* --------------------------------------------------------------------- dns */

export type DnsRecordType =
  | "A"
  | "AAAA"
  | "ANAME"
  | "CNAME"
  | "MX"
  | "NS"
  | "SRV"
  | "TXT";

export interface DnsRecord {
  id: number;
  domainName: string;
  /** Relative to the zone; empty string is the apex. */
  host: string;
  fqdn: string;
  type: DnsRecordType;
  answer: string;
  ttl: number;
  priority?: number;
}

/** What `POST .../records` needs. `host` defaults to the apex, `ttl` to 300. */
export interface DnsRecordDraft {
  host?: string;
  type: DnsRecordType;
  answer: string;
  ttl?: number;
  priority?: number;
}

/**
 * What `PUT .../records/{id}` needs. Every field is required because the PUT
 * is a full overwrite: anything omitted here is erased on the server, not
 * preserved. Use `NameComClient.updateRecord` when you only mean to change one
 * field.
 */
export interface DnsRecordReplacement {
  host: string;
  type: DnsRecordType;
  answer: string;
  ttl: number;
  priority?: number;
}

export interface ListRecordsParams {
  page?: number;
  perPage?: number;
}

export interface ListRecordsResponse {
  records: DnsRecord[];
  nextPage?: number;
  lastPage?: number;
}

/* ------------------------------------------------------------------ dnssec */

/**
 * DS data as published in the parent zone. Keyed by `digest`, not by an id,
 * so deleting one means quoting the digest back.
 */
export interface DnssecKey {
  domainName?: string;
  keyTag: number;
  algorithm: number;
  digestType: number;
  digest: string;
}

export interface ListDnssecResponse {
  dnssec: DnssecKey[];
}

export interface DnssecDraft {
  keyTag: number;
  algorithm: number;
  digestType: number;
  digest: string;
}

/* ------------------------------------------------------------- nameservers */

export interface SetNameserversResponse {
  domain: Domain;
}

export interface VanityNameserver {
  domainName?: string;
  hostname: string;
  ips: string[];
}

export interface ListVanityNameserversResponse {
  vanityNameservers: VanityNameserver[];
}

/* ----------------------------------------------------------------- account */

/** Sandbox accounts start with $100,000 of credit, so this reads high there. */
export interface AccountBalance {
  balance: number;
  currency?: string;
  creditLimit?: number;
}

export interface TldPrice {
  tld: string;
  registrationPrice?: number;
  renewalPrice?: number;
  transferPrice?: number;
  premium?: boolean;
  [key: string]: unknown;
}

/**
 * The pricing envelope key is not pinned by the published examples, so both
 * observed spellings are surfaced and `NameComClient.listTldPricing` normalises
 * them into `results`.
 */
export interface TldPricingResponse {
  results?: TldPrice[];
  tldPricing?: TldPrice[];
  nextPage?: number;
  lastPage?: number;
}

export interface ListTldPricingParams {
  page?: number;
  perPage?: number;
}

/**
 * `domaininfo/requirementsV2/{tld}` returns a JSON Schema Draft-7 document
 * describing the extra fields that TLD demands at registration. It is data, not
 * a fixed shape — feed it to a form generator rather than hand-modelling it.
 */
export interface TldRequirementsSchema {
  $schema?: string;
  title?: string;
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

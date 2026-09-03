/**
 * `DomainRegistry`, backed by name.com.
 *
 * Two vendor pieces sit behind this one port, and the split is not arbitrary:
 * `NameComClient` does the priced, irreversible half, and `WritAnchor` does the
 * DNS half — including the three orderings that make revocation reliable
 * (publish before delete, tombstone before clearing, and a refusal to write over
 * a tombstone). Reimplementing the record writes against the raw client here
 * would have thrown all three away, so the anchor is used as the anchor.
 *
 * That costs one translation. The port hands this bridge an already-serialised
 * TXT value; the anchor takes a parsed `WritRecord`. Parsing it back is not a
 * round-trip for its own sake — it is what lets the anchor read the record's
 * status, refuse to resurrect a revoked name, and supersede an older writ
 * instead of leaving two live at the same name.
 *
 * Prices cross a unit boundary. name.com quotes major units and the port counts
 * minor ones, because a spend cap compared in floating-point dollars is a spend
 * cap that rounds. The conversion happens here, once, in both directions.
 */

import { parseWritRecord } from "../../core/writ-record";
import {
  idempotencyKey,
  resolveTarget,
  WritAnchor,
  type AnchorTarget,
  type DnsRecord,
  type DomainSearchResult,
  type NameComClient,
} from "../../adapters/namecom";
import { NameComError } from "../../adapters/namecom";
import type {
  DnsRecordRef,
  DomainCandidate,
  DomainRegistry,
  RegisteredDomain,
} from "../ports";

/** name.com caps a single availability call at this many names. */
const AVAILABILITY_BATCH = 50;

export interface NameComDomainRegistryOptions {
  client: NameComClient;
  /** Defaults to one built over `client`, resolving through public DoH. */
  anchor?: WritAnchor;
  /**
   * Which registered zone an agent domain lives in. Defaults to asking the
   * account, because the answer is a fact about the account rather than a
   * guess a public-suffix heuristic can make.
   */
  zoneFor?: (agentDomain: string) => string | Promise<string>;
  /**
   * ISO 4217 code for the account. name.com's search and register responses
   * carry prices with no currency at all, and the port has to report one.
   */
  currency?: string;
  /** Registration term. name.com's own default is one year. */
  years?: number;
}

export class NameComDomainRegistry implements DomainRegistry {
  private readonly client: NameComClient;
  private readonly anchor: WritAnchor;
  private readonly currency: string;
  private readonly years: number;
  private readonly lookupZone: (agentDomain: string) => string | Promise<string>;
  private readonly zones = new Map<string, string>();

  constructor(options: NameComDomainRegistryOptions) {
    this.client = options.client;
    this.anchor = options.anchor ?? new WritAnchor({ client: options.client });
    this.currency = options.currency ?? "USD";
    this.years = options.years ?? 1;
    this.lookupZone = options.zoneFor ?? ((domain) => this.zoneFromAccount(domain));
  }

  /* ------------------------------------------------------------ discovery */

  async search(keyword: string, tlds: string[]): Promise<DomainCandidate[]> {
    const response = await this.client.searchDomains({
      keyword,
      ...(tlds.length === 0 ? {} : { tldFilter: tlds }),
      purchaseType: "registration",
    });
    return response.results.map((result) => this.toCandidate(result));
  }

  async checkAvailability(domainNames: string[]): Promise<DomainCandidate[]> {
    const results: DomainCandidate[] = [];
    for (let at = 0; at < domainNames.length; at += AVAILABILITY_BATCH) {
      const response = await this.client.checkAvailability({
        domainNames: domainNames.slice(at, at + AVAILABILITY_BATCH),
        purchaseType: "registration",
      });
      results.push(...response.results.map((result) => this.toCandidate(result)));
    }
    return results;
  }

  /* -------------------------------------------------------- the money call */

  async register(
    domainName: string,
    priceMinorUnits: number,
    key: string,
  ): Promise<RegisteredDomain> {
    const response = await this.client.registerDomain(
      {
        domain: { domainName },
        years: this.years,
        purchaseType: "registration",
        // Quoted only when the caller declared one. A `purchasePrice` of zero
        // is a 400, and sending it would turn "this act declared no amount"
        // into a failed purchase rather than an unpriced one.
        ...(priceMinorUnits > 0 ? { purchasePrice: toMajorUnits(priceMinorUnits) } : {}),
      },
      idempotencyKey(key),
    );

    return {
      domainName: response.domain.domainName,
      orderId: String(response.order),
      totalPaidMinorUnits: toMinorUnits(response.totalPaid),
      currency: this.currency,
    };
  }

  /* -------------------------------------------------------------- the dns */

  async putWritRecord(domain: string, value: string): Promise<DnsRecordRef> {
    const target = await this.targetFor(domain);
    // `rotate`, not `publish`: re-anchoring has to supersede the record that is
    // already there, and it creates the new one before removing the old so
    // authority is continuous across the swap.
    const result = await this.anchor.rotate(target, parseWritRecord(value));
    return { id: result.record.id, fqdn: result.name };
  }

  /**
   * The tombstone the registrar publishes is derived from the record actually
   * live at the name, and `from` is only used when nothing is live there. The
   * two agree whenever the anchor is the thing that published the active
   * record; where they disagree, DNS carries the registrar's, and this returns
   * the reference to it rather than to the value it was handed.
   */
  async revokeWritRecord(domain: string, tombstoneValue: string): Promise<DnsRecordRef> {
    const target = await this.targetFor(domain);
    const result = await this.anchor.revoke(target, { from: parseWritRecord(tombstoneValue) });
    return { id: result.record.id, fqdn: result.name };
  }

  async listWritRecords(domain: string): Promise<{ id: number; value: string }[]> {
    const target = resolveTarget(await this.targetFor(domain));
    const { records } = await this.client.listRecords(target.zone);
    return records
      .filter((record) => record.type === "TXT" && hostOf(record) === target.host)
      .map((record) => ({ id: record.id, value: record.answer }));
  }

  /* ----------------------------------------------------------------- zones */

  private async targetFor(agentDomain: string): Promise<AnchorTarget> {
    const normalised = agentDomain.trim().toLowerCase().replace(/\.$/, "");
    const cached = this.zones.get(normalised);
    if (cached !== undefined) return { zone: cached, agentDomain: normalised };

    const zone = await this.lookupZone(normalised);
    this.zones.set(normalised, zone);
    return { zone, agentDomain: normalised };
  }

  /**
   * The zone is whichever registered domain the agent lives inside, longest
   * first so `ops.eu.example.com` prefers `eu.example.com` over `example.com`
   * when the account holds both. Failing here is right: writing into a zone the
   * account does not hold cannot succeed, and guessing the registrable part of
   * a name without a public-suffix list gets `co.uk` wrong.
   */
  private async zoneFromAccount(agentDomain: string): Promise<string> {
    const { domains } = await this.client.listDomains();
    const candidates = domains
      .map((domain) => domain.domainName.trim().toLowerCase())
      .filter((name) => agentDomain === name || agentDomain.endsWith(`.${name}`))
      .sort((a, b) => b.length - a.length);

    if (candidates.length === 0) {
      throw new NameComError(
        `no domain in this name.com account contains ${agentDomain}, so there is no zone to ` +
          "write the writ record into",
        "INVALID_ARGUMENT",
      );
    }
    return candidates[0];
  }

  private toCandidate(result: DomainSearchResult): DomainCandidate {
    return {
      domainName: result.domainName,
      tld: result.tld,
      purchasable: result.purchasable,
      premium: result.premium,
      priceMinorUnits:
        typeof result.purchasePrice === "number" ? toMinorUnits(result.purchasePrice) : null,
      currency: this.currency,
    };
  }
}

/** name.com reports the apex as `""`, and some payloads use `"@"`. */
function hostOf(record: DnsRecord): string {
  const host = record.host;
  if (host === undefined || host === "@") return "";
  return host.toLowerCase();
}

function toMinorUnits(major: number): number {
  return Math.round(major * 100);
}

function toMajorUnits(minor: number): number {
  return minor / 100;
}

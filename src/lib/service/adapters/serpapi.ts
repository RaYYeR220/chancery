/**
 * `DiligenceService`, backed by SerpApi.
 *
 * `runDiligence` already carries the whole engine — planning, execution, three
 * levels of deadline, and the rule that every one of them produces `unknown`
 * rather than a guess. What this bridge owns is the subject projection, and it
 * is the only place the two vocabularies have to be reconciled.
 *
 * The port describes the *act*: a kind and a flat bag of fields the writ's
 * limits address. SerpApi's diligence describes a *thing in the world*: a
 * trading name, optionally a legal name, a place, a ticker. The mapping between
 * them is not cosmetic, because `name` and `legalName` are consulted by
 * different checks:
 *
 *   trademark_clear / no_brand_collision  read `name` — the mark the act would
 *                                         put into the world
 *   counterparty_exists / no_adverse_media / no_patent_litigation
 *                                         read `legalName ?? name` — the entity
 *
 * So a domain registration searches the marks for the label being registered
 * and searches the registries for the principal behind it, while a document
 * sent for signature searches both against the counterparty — because on that
 * act the counterparty is the entity the check is about, and pointing it at the
 * principal would clear the wrong company.
 *
 * Nothing is invented to fill a gap. A field the act did not supply is simply
 * absent from the subject, which narrows the evidence rather than sharpening it
 * with a value nobody wrote down.
 */

import type { ActKind, DiligenceCheck, DiligenceFinding } from "../../core/types";
import {
  runDiligence,
  type DiligenceOptions,
  type DiligenceSubject as SerpApiSubject,
  type SerpApiClient,
} from "../../adapters/serpapi";
import type { DiligenceService, DiligenceSubject } from "../ports";

export class SerpApiDiligenceService implements DiligenceService {
  constructor(
    private readonly client: SerpApiClient,
    private readonly options: DiligenceOptions = {},
  ) {}

  async run(
    subject: DiligenceSubject,
    checks: DiligenceCheck[],
  ): Promise<DiligenceFinding[]> {
    // Not an optimisation. `runDiligence` with no checks would still start a
    // budget clock, and an act with no diligence condition should cost nothing.
    if (checks.length === 0) return [];
    return runDiligence(this.client, toSerpApiSubject(subject), checks, this.options);
  }
}

/** The act, projected onto the thing in the world a search engine can look for. */
export function toSerpApiSubject(subject: DiligenceSubject): SerpApiSubject {
  const fields = subject.fields;
  const counterparty = str(fields.counterparty) ?? str(fields.counterpartyName);
  const domainName = str(fields.domainName);
  const mark = str(fields.brand) ?? str(fields.name) ?? labelOf(domainName) ?? undefined;

  const name = counterparty ?? mark ?? subject.principalLegalName;
  const legalName = counterparty ?? subject.principalLegalName;

  return {
    name,
    ...(legalName !== name ? { legalName } : {}),
    ...(domainName === undefined ? {} : { domain: domainName }),
    ...optional("country", countryCode(fields.country) ?? countryCode(fields.jurisdiction)),
    ...optional("locality", str(fields.locality)),
    ...optional("ll", str(fields.ll)),
    ...optional("ticker", str(fields.ticker)),
  };
}

/** Which fields a given act kind can be expected to carry, for callers building requests. */
export const SUBJECT_FIELDS: Record<ActKind, readonly string[]> = {
  "domain.register": ["domainName", "brand", "country"],
  "domain.renew": ["domainName", "brand", "country"],
  "domain.transfer": ["domainName", "brand", "country"],
  "dns.write": ["domainName"],
  "document.send_for_signature": ["counterparty", "locality", "ticker", "country"],
  "document.publish": ["name", "locality"],
};

function optional<K extends string>(
  key: K,
  value: string | undefined,
): Record<K, string> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function str(value: string | number | boolean | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** The second-level label, which is the part a trademark reads on. */
function labelOf(domainName: string | undefined): string | undefined {
  if (domainName === undefined) return undefined;
  const label = domainName.split(".")[0]?.trim();
  return label === undefined || label.length === 0 ? undefined : label;
}

/**
 * Only a two-letter code. SerpApi's `gl` is an ISO 3166-1 alpha-2 parameter, and
 * a jurisdiction written out in full would be sent as a country nobody has.
 */
function countryCode(value: string | number | boolean | undefined): string | undefined {
  const raw = str(value);
  return raw !== undefined && /^[A-Za-z]{2}$/.test(raw) ? raw.toLowerCase() : undefined;
}

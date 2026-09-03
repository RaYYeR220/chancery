/**
 * The data payload uploaded to Doctavian, and the projection from a `Writ` onto
 * it.
 *
 * Two decisions here are load-bearing:
 *
 * 1. **Every value is a string.** Doctavian treats uploaded fields as strings
 *    by default — `{!$Invoice[0].Total + 10}` renders `"1250.510"`, a
 *    concatenation, not a sum. Rather than pretend otherwise and get caught by
 *    it on a live render, the payload type says `string` everywhere and the
 *    template does its arithmetic through `toDecimal(...)`. The type is
 *    therefore documentation of the API's behaviour, not a limitation of ours.
 *
 * 2. **Clause refs come from the writ, not from print order.** A denial cites a
 *    clause ref so a human can find the clause in the signed PDF. If the
 *    document numbered its own clauses independently, a re-ordered `grants`
 *    array would silently point every citation at the wrong paragraph. So the
 *    ref travels with the grant, and `clauseRef` exists to mint refs in the
 *    same scheme when a grant has none.
 */

import type {
  AllowlistLimit,
  AmountLimit,
  ActKind,
  CountLimit,
  EscalationCondition,
  Grant,
  PatternLimit,
  Writ,
} from "../../core/types";

/** Sub-clauses are lettered; the parent clause number is fixed at 3. */
const GRANT_CLAUSE_NUMBER = 3;
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * `3(a)`, `3(b)`, … and `3(aa)` past 26, which never happens in practice but
 * beats throwing inside a document render.
 */
export function clauseRef(index: number): string {
  const letter =
    index < LETTERS.length
      ? LETTERS[index]
      : LETTERS[Math.floor(index / LETTERS.length) - 1] +
        LETTERS[index % LETTERS.length];
  return `${GRANT_CLAUSE_NUMBER}(${letter})`;
}

/** One limit as a sentence, so the nested repeater has something to print. */
export interface WritLimitRow {
  /** `3(a)(i)`, `3(a)(ii)`, … */
  SubRef: string;
  Kind: string;
  Text: string;
}

export interface WritGrantRow {
  Ref: string;
  ActKind: string;
  ActTitle: string;
  /** The permission, phrased as an instrument would phrase it. */
  ActNarrative: string;
  /** "true" / "false" — drives the `hidden=` on the cap clause. */
  HasCap: string;
  /** Minor units. Always numeric-looking, "0" when uncapped, so `sum` is safe. */
  CapMinor: string;
  CapWindow: string;
  CountMax: string;
  CountWindow: string;
  AllowlistField: string;
  AllowlistValues: string;
  PatternField: string;
  Pattern: string;
  DiligenceChecks: string;
  JurisdictionAllowed: string;
  /** Per-grant escalation floor in minor units; "" when the grant has none. */
  EscalationMinor: string;
  Limits: WritLimitRow[];
}

export interface WritRow {
  Id: string;
  Version: string;
  PrincipalName: string;
  PrincipalEmail: string;
  /** "true" / "false". */
  PrincipalVerified: string;
  AgentLabel: string;
  AgentDomain: string;
  AgentPublicKey: string;
  Jurisdiction: string;
  JurisdictionName: string;
  /** "true" / "false" — decides whether the eIDAS clause renders at all. */
  JurisdictionIsEea: string;
  /**
   * "true" / "false". A flag rather than a template-side comparison because
   * `hidden=` rejects `!=`, `!(...)` and ternaries, so "not GB" cannot be
   * written in the template at all.
   */
  JurisdictionIsUk: string;
  Currency: string;
  CurrencySymbol: string;
  EffectiveFrom: string;
  /** Days of validity; the expiry date is computed in the template from this. */
  TermDays: string;
  /** Percent of the aggregate cap above which a single act needs a human. */
  EscalationPercent: string;
  /** Below this aggregate cap the escalation clause is pointless and hides. */
  EscalationFloorMinor: string;
  /** "" when the principal set no daily ceiling — that clause then disappears. */
  DailyCapMinor: string;
  Grants: WritGrantRow[];
}

/** Doctavian addresses the root as `Writ[0]`, hence the array of one. */
export interface WritTemplateData {
  Writ: WritRow[];
}

const ACT_TITLES: Record<ActKind, string> = {
  "domain.register": "Registration of domain names",
  "domain.renew": "Renewal of domain names",
  "domain.transfer": "Transfer of domain names",
  "dns.write": "Modification of DNS records",
  "document.send_for_signature": "Dispatch of documents for signature",
  "document.publish": "Publication of documents",
};

const ACT_NARRATIVES: Record<ActKind, string> = {
  "domain.register":
    "to register domain names in the Principal's name and to pay the registry and registrar fees arising",
  "domain.renew":
    "to renew domain names already held in the Principal's name before their expiry",
  "domain.transfer":
    "to transfer domain names between registrars, including the release of authorisation codes",
  "dns.write":
    "to create, amend and delete DNS records within the zones listed below",
  "document.send_for_signature":
    "to dispatch documents to named counterparties for electronic signature",
  "document.publish":
    "to publish documents to a public address under the Principal's control",
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
};

/**
 * eIDAS applies by territory, not by contract, so the eIDAS clause has to be
 * gated on where the principal actually is.
 */
const EEA_JURISDICTIONS = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IE", "IS", "IT", "LV", "LI", "LT", "LU", "MT", "NL", "NO", "PL", "PT", "RO",
  "SK", "SI", "ES", "SE",
]);

const JURISDICTION_NAMES: Record<string, string> = {
  IE: "Ireland",
  DE: "Germany",
  FR: "France",
  NL: "the Netherlands",
  ES: "Spain",
  GB: "England and Wales",
  US: "the State of Delaware",
  CH: "Switzerland",
};

export interface BuildWritDataOptions {
  /** Percent of the aggregate cap above which one act needs a fresh decision. */
  escalationPercent?: number;
  /** Aggregate cap below which the escalation clause does not render. */
  escalationFloorMinorUnits?: number;
  /** Omit to drop the daily-ceiling clause from the document entirely. */
  dailyCapMinorUnits?: number;
  /** Defaults to the currency of the first amount limit, else EUR. */
  currency?: string;
}

export function buildWritData(
  writ: Writ,
  options: BuildWritDataOptions = {},
): WritTemplateData {
  const currency = options.currency ?? inferCurrency(writ) ?? "EUR";
  const termDays = daysBetween(writ.effectiveFrom, writ.expiresAt);

  return {
    Writ: [
      {
        Id: writ.id,
        Version: String(writ.version),
        PrincipalName: writ.principal.legalName,
        PrincipalEmail: writ.principal.email,
        PrincipalVerified: String(writ.principal.entityVerified),
        AgentLabel: writ.agent.label,
        AgentDomain: writ.agent.domain,
        AgentPublicKey: writ.agent.publicKey,
        Jurisdiction: writ.jurisdiction,
        JurisdictionName: JURISDICTION_NAMES[writ.jurisdiction] ?? writ.jurisdiction,
        JurisdictionIsEea: String(EEA_JURISDICTIONS.has(writ.jurisdiction)),
        JurisdictionIsUk: String(writ.jurisdiction === "GB"),
        Currency: currency,
        CurrencySymbol: CURRENCY_SYMBOLS[currency] ?? currency,
        EffectiveFrom: writ.effectiveFrom.slice(0, 10),
        TermDays: String(termDays),
        EscalationPercent: String(options.escalationPercent ?? 25),
        EscalationFloorMinor: String(options.escalationFloorMinorUnits ?? 100000),
        DailyCapMinor:
          options.dailyCapMinorUnits === undefined
            ? ""
            : String(options.dailyCapMinorUnits),
        Grants: writ.grants.map((grant, index) => grantRow(grant, index)),
      },
    ],
  };
}

function grantRow(grant: Grant, index: number): WritGrantRow {
  const ref = grant.ref || clauseRef(index);
  const amount = grant.limits.find(isAmountLimit);
  const count = grant.limits.find(isCountLimit);
  const allowlist = grant.limits.find(isAllowlistLimit);
  const pattern = grant.limits.find(isPatternLimit);
  const jurisdiction = grant.conditions.find((c) => c.type === "jurisdiction");
  const escalation = grant.conditions.find(isEscalationCondition);

  return {
    Ref: ref,
    ActKind: grant.actKind,
    ActTitle: ACT_TITLES[grant.actKind],
    ActNarrative: ACT_NARRATIVES[grant.actKind],
    HasCap: String(amount !== undefined),
    CapMinor: String(amount?.maxMinorUnits ?? 0),
    CapWindow: amount ? windowLabel(amount.window) : "",
    CountMax: count ? String(count.max) : "",
    CountWindow: count ? windowLabel(count.window) : "",
    AllowlistField: allowlist?.field ?? "",
    AllowlistValues: allowlist ? allowlist.values.join(", ") : "",
    PatternField: pattern?.field ?? "",
    Pattern: pattern?.pattern ?? "",
    DiligenceChecks: grant.conditions
      .filter((c) => c.type === "diligence")
      .map((c) => c.check.replace(/_/g, " "))
      .join(", "),
    JurisdictionAllowed: jurisdiction ? jurisdiction.allowed.join(", ") : "",
    EscalationMinor: escalation ? String(escalation.aboveMinorUnits) : "",
    Limits: grant.limits.map((limit, limitIndex) => ({
      SubRef: `${ref}(${roman(limitIndex + 1)})`,
      Kind: limit.type,
      Text: limitSentence(limit),
    })),
  };
}

function limitSentence(limit: Grant["limits"][number]): string {
  switch (limit.type) {
    case "amount":
      return `Cumulative spend may not exceed ${formatMajor(limit.maxMinorUnits)} ${limit.currency} ${windowLabel(limit.window)}.`;
    case "count":
      return `The act may be performed at most ${limit.max} times ${windowLabel(limit.window)}.`;
    case "allowlist":
      return `The value of "${limit.field}" must be one of: ${limit.values.join(", ")}.`;
    case "pattern":
      return `The value of "${limit.field}" must match the pattern ${limit.pattern}.`;
  }
}

function windowLabel(window: "total" | "day" | "month"): string {
  return window === "total"
    ? "over the term of this writ"
    : window === "day"
      ? "in any calendar day"
      : "in any calendar month";
}

function formatMajor(minorUnits: number): string {
  return (minorUnits / 100).toFixed(2);
}

function inferCurrency(writ: Writ): string | null {
  for (const grant of writ.grants) {
    const amount = grant.limits.find(isAmountLimit);
    if (amount) return amount.currency;
  }
  return null;
}

/**
 * Whole days, floored. The template adds this back onto the effective date, so
 * flooring here means a rendered expiry never lands after the real one.
 */
function daysBetween(from: string, to: string): number {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86_400_000)) : 0;
}

function roman(n: number): string {
  const numerals: [number, string][] = [
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let rest = n;
  let out = "";
  for (const [value, symbol] of numerals) {
    while (rest >= value) {
      out += symbol;
      rest -= value;
    }
  }
  return out;
}

function isAmountLimit(limit: Grant["limits"][number]): limit is AmountLimit {
  return limit.type === "amount";
}

function isCountLimit(limit: Grant["limits"][number]): limit is CountLimit {
  return limit.type === "count";
}

function isAllowlistLimit(limit: Grant["limits"][number]): limit is AllowlistLimit {
  return limit.type === "allowlist";
}

function isPatternLimit(limit: Grant["limits"][number]): limit is PatternLimit {
  return limit.type === "pattern";
}

function isEscalationCondition(
  condition: Grant["conditions"][number],
): condition is EscalationCondition {
  return condition.type === "escalation";
}

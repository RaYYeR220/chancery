/**
 * The prose of the instrument, and the acts a viewer can put on the line.
 *
 * The clause text here is the wording that gets rendered into the document the
 * principal signs, so it is written the way a solicitor would write it rather
 * than the way a schema would. Everything that can be derived from the `Grant`
 * objects is derived, so the readable clause and the enforced clause cannot
 * drift apart: `describeGrant` walks the same limits the gatekeeper walks.
 */

import type { ActRequest, Condition, Grant, Limit } from "@/lib/core/types";
import type { Stage, StationView } from "./view";
import * as world from "@/lib/eval/world";

export const PRINCIPAL = world.PRINCIPAL;
export const AGENT = world.AGENT;

/** Where the demo agent's authority is published, and where a signed copy lives. */
export const DOCUMENT_BASE_URL = "https://writs.northwind.example";

/** The human who executes the instrument. Named because a writ names its signer. */
export const SIGNER = {
  name: "Mairéad Ní Bhriain",
  role: "Director",
  place: "Dublin",
  witness: "Colm Doherty, Solicitor, Ó Ríordáin & Doherty, 12 Fitzwilliam Square, Dublin 2",
};

/* ------------------------------------------------------------------ clauses */

export interface ClauseView {
  ref: string;
  page: number;
  lines: string | null;
  heading: string;
  /** The operative text, as it is printed in the signed document. */
  text: string;
  /** Machine terms this clause carries, rendered from the grant itself. */
  terms: string[];
}

/** Clauses that carry no grant: the frame the grants sit inside. */
const FRAME: ClauseView[] = [
  {
    ref: "1",
    page: 1,
    lines: "ll. 4–11",
    heading: "Appointment",
    text:
      "Northwind Coffee Ltd (“the Principal”) appoints the software agent published at " +
      "ops.northwind.example (“the Attorney”) to act in the limited matters set out below, and in no others.",
    terms: [],
  },
  {
    ref: "2",
    page: 1,
    lines: "ll. 13–17",
    heading: "Default position",
    text:
      "Authority under this instrument extends only to acts expressly permitted below. Any act not " +
      "expressly permitted is refused, and an act whose terms cannot be read back from this document " +
      "is treated as not permitted rather than as unrestricted.",
    terms: ["Every unknown denies"],
  },
  {
    ref: "3(a)",
    page: 2,
    lines: "ll. 4–7",
    heading: "Reversible enquiry",
    text:
      "The Attorney may query registrar pricing and availability, search public registers, draft " +
      "documents and run diligence without limit, such acts being reversible and committing the " +
      "Principal to nothing.",
    terms: ["Ungated"],
  },
];

const TAIL: ClauseView[] = [
  {
    ref: "5",
    page: 4,
    lines: "ll. 3–14",
    heading: "Term and withdrawal",
    text:
      "This instrument expires on the date recorded in the published record, or upon publication of a " +
      "revocation at _writ.ops.northwind.example, whichever is earlier. A revocation is published as a " +
      "positive record and not as a deletion, and takes effect at the next resolution. Withdrawal is " +
      "not retroactive: acts already committed stand.",
    terms: ["Tombstone, not deletion"],
  },
  {
    ref: "6",
    page: 4,
    lines: "l. 22",
    heading: "Governing law",
    text:
      "This instrument is governed by the law of Ireland. Page 5 is the signature page; page 6 is the " +
      "schedule of permitted registrars.",
    terms: ["IE"],
  },
];

const GRANT_HEADINGS: Record<string, { heading: string; page: number; lines: string }> = {
  "3(b)": { heading: "Domain registration", page: 2, lines: "ll. 12–21" },
  "4(a)": { heading: "Agreements for signature", page: 3, lines: "ll. 6–19" },
};

const GRANT_TEXT: Record<string, string> = {
  "3(b)":
    "The Attorney may register domain names on the Principal’s behalf, subject to the limits scheduled " +
    "at this clause, and only where a trade mark search of the live registers returns no mark " +
    "confusingly similar to the name in Class 30 or Class 43. Registrations shall be made in the name " +
    "of the Principal with registrar lock and privacy protection enabled at the time of purchase.",
  "4(a)":
    "The Attorney may prepare and send agreements for signature by a counterparty whose existence it " +
    "has corroborated, in the jurisdiction scheduled at this clause. An agreement above the scheduled " +
    "value requires a fresh decision by the Principal and is not authorised by this instrument.",
};

export function describeLimit(limit: Limit): string {
  switch (limit.type) {
    case "count":
      return `No more than ${limit.max} ${limit.max === 1 ? "act" : "acts"} ${windowPhrase(limit.window)}`;
    case "amount":
      return `Total cost not exceeding ${money(limit.maxMinorUnits, limit.currency)} ${windowPhrase(limit.window)}`;
    case "allowlist":
      return `${fieldLabel(limit.field)} must be one of ${limit.values.join(" or ")}`;
    case "pattern":
      return `${fieldLabel(limit.field)} must match ${limit.pattern}`;
  }
}

export function describeCondition(condition: Condition): string {
  switch (condition.type) {
    case "diligence":
      return `A ${condition.check.replace(/_/g, " ")} check must return clear against live data`;
    case "jurisdiction":
      return `Only in ${condition.allowed.join(", ")}`;
    case "escalation":
      return `Above ${money(condition.aboveMinorUnits, condition.currency)} a fresh human decision is required`;
  }
}

export function describeGrant(grant: Grant): ClauseView {
  const meta = GRANT_HEADINGS[grant.ref] ?? { heading: grant.actKind, page: 2, lines: "" };
  return {
    ref: grant.ref,
    page: meta.page,
    lines: meta.lines || null,
    heading: meta.heading,
    text: GRANT_TEXT[grant.ref] ?? `The Attorney may perform ${grant.actKind}, subject to the limits scheduled here.`,
    terms: [...grant.limits.map(describeLimit), ...grant.conditions.map(describeCondition)],
  };
}

/** The whole instrument as a reader sees it, with the grants in clause order. */
export function clauseTable(grants: Grant[]): ClauseView[] {
  return [...FRAME, ...grants.map(describeGrant), ...TAIL].sort(byClauseRef);
}

function byClauseRef(a: ClauseView, b: ClauseView): number {
  return a.page - b.page || a.ref.localeCompare(b.ref);
}

function windowPhrase(window: "total" | "day" | "month"): string {
  return window === "total" ? "in total" : window === "day" ? "per day" : "per calendar month";
}

function fieldLabel(field: string): string {
  return field === "tld" ? "Top-level domain" : field === "domainName" ? "The name" : field;
}

export function money(minorUnits: number, currency: string): string {
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
  const figure = (minorUnits / 100).toFixed(2);
  return symbol ? `${symbol}${figure}` : `${figure} ${currency}`;
}

/* --------------------------------------------------------------- the stations */

/**
 * The checks an act passes through, in the order the gatekeeper applies them.
 * The UI draws these as stations on a line; the verdict decides where a token
 * stops. `codes` maps each station to the deny codes that stop there, which is
 * how a `Decision` from the engine is turned into a position on the line
 * without the UI re-deciding anything.
 */
export interface StationDef {
  id: string;
  name: string;
  /** Fits under a station marker on the diagram. */
  short: string;
  /** What the station actually compares. */
  tests: string;
  clause: string;
  codes: string[];
  /** Which of the three service lines the leg into this station belongs to. */
  line: LineName;
}

/**
 * Three lines, and they are contiguous because the gatekeeper is: it settles
 * whether there is an instrument at all, then whether the clause reaches this
 * act and the world agrees, then whether the act fits the numbers the principal
 * wrote. A viewer who learns the colours learns the order of the checks.
 */
export type LineName = "authority" | "condition" | "schedule";

export const LINES: { id: LineName; label: string; colour: string }[] = [
  { id: "authority", label: "Authority line", colour: "#00843d" },
  { id: "condition", label: "Condition line", colour: "#0072ce" },
  { id: "schedule", label: "Schedule line", colour: "#f5a623" },
];

export const STATIONS: StationDef[] = [
  {
    id: "record",
    name: "Published record",
    short: "Record",
    tests: "A WRIT1 record stands in DNS, DNSSEC-validated, with no tombstone at the name",
    clause: "5",
    codes: ["NO_WRIT", "WRIT_REVOKED"],
    line: "authority",
  },
  {
    id: "instrument",
    name: "Instrument check",
    short: "Instrument",
    tests: "The document fetched hashes to the value the record publishes, and its signature verifies",
    clause: "5",
    codes: ["DOCUMENT_HASH_MISMATCH", "SIGNATURE_INVALID"],
    line: "authority",
  },
  {
    id: "term",
    name: "Term",
    short: "Term",
    tests: "The instrument is in force at the instant the act is attempted",
    clause: "5",
    codes: ["WRIT_EXPIRED", "WRIT_NOT_YET_EFFECTIVE"],
    line: "authority",
  },
  {
    id: "grant",
    name: "Grant",
    short: "Grant",
    tests: "A clause grants this kind of act, and every term of it grounded in the page it came from",
    clause: "2",
    codes: ["ACT_NOT_GRANTED", "CLAUSE_UNGROUNDED", "INTERNAL_FAIL_CLOSED"],
    line: "condition",
  },
  {
    id: "world",
    name: "Diligence",
    short: "Diligence",
    tests: "The conditions on the clause hold against live data, and an unfinished check is a failed check",
    clause: "3(b)",
    codes: [
      "DILIGENCE_FLAGGED",
      "DILIGENCE_UNKNOWN",
      "OUT_OF_JURISDICTION",
      "ESCALATION_REQUIRED",
    ],
    line: "condition",
  },
  {
    id: "scope",
    name: "Schedule",
    short: "Schedule",
    tests: "The name and the suffix are inside the schedule the clause sets",
    clause: "3(b)",
    codes: ["VALUE_NOT_ALLOWLISTED", "VALUE_PATTERN_MISMATCH"],
    line: "schedule",
  },
  {
    id: "budget",
    name: "Budget",
    short: "Budget",
    tests: "The act fits inside the count and the sum the principal wrote",
    clause: "3(b)",
    codes: ["COUNT_LIMIT_EXCEEDED", "AMOUNT_LIMIT_EXCEEDED"],
    line: "schedule",
  },
  {
    id: "commit",
    name: "Commit",
    short: "Commit",
    tests: "Irreversible from here: the registrar is called and a receipt is minted",
    clause: "3(c)",
    codes: [],
    line: "schedule",
  },
];

/**
 * The line when no act is on it: dark until an instrument is published, idle
 * once one is. Pure, so both the route handler and the browser can draw it.
 */
export function standingStations(stage: Stage): StationView[] {
  const dark = stage !== "anchored";
  return STATIONS.map((station) => ({
    id: station.id,
    name: station.name,
    short: station.short,
    tests: station.tests,
    clause: station.clause,
    line: station.line,
    state: dark ? ("dark" as const) : ("idle" as const),
    note: "",
  }));
}

/* ------------------------------------------------------------- the act board */

export interface ActPreset {
  id: string;
  /** Short label for the board. */
  title: string;
  detail: string;
  /** What a viewer should be watching while this runs. */
  watch: string;
  request: ActRequest;
}

const USD = "USD";

function registration(domainName: string, tld: string, priceMinorUnits: number): ActRequest {
  return {
    kind: "domain.register",
    fields: { tld, domainName },
    amountMinorUnits: priceMinorUnits,
    currency: USD,
    requestedAt: new Date().toISOString(),
  };
}

/**
 * Every act a viewer can fire, including the four the walkthrough uses. None of
 * these carries an expected verdict: the board prints whatever the engine
 * answered, so an act cannot be labelled with a refusal it did not receive.
 */
export const ACT_PRESETS: ActPreset[] = [
  {
    id: "reg-coffee",
    title: "Register northwindcoffee.com",
    detail: "$10.99, the first of the three the clause allows",
    watch: "The budget meter moving, and the clause reference on the approval.",
    request: registration("northwindcoffee.com", "com", 1_099),
  },
  {
    id: "reg-roasters",
    title: "Register northwindroasters.net",
    detail: "$10.99, on the other allowlisted suffix",
    watch: ".net passing the same allowlist that .io fails.",
    request: registration("northwindroasters.net", "net", 1_099),
  },
  {
    id: "reg-beans",
    title: "Register northwindbeans.com",
    detail: "$10.99, landing exactly on the cap the principal wrote",
    watch: "The meter reaching three of three, still green.",
    request: registration("northwindbeans.com", "com", 1_099),
  },
  {
    id: "reg-espresso",
    title: "Register northwindespresso.com",
    detail: "$10.99, one past the count",
    watch: "A refusal that names the clause and the page where the number three is written.",
    request: registration("northwindespresso.com", "com", 1_099),
  },
  {
    id: "reg-trade-io",
    title: "Register northwindtrade.io",
    detail: "$32.00, a suffix the schedule does not carry",
    watch: "The name is well formed and the budget is untouched. The suffix alone stops it.",
    request: registration("northwindtrade.io", "io", 3_200),
  },
  {
    id: "reg-collision",
    title: "Register northwindcoffeeco.com",
    detail: "$10.99, inside every cap",
    watch: "Scope said yes and the world said no. The refusal carries the register entry it read.",
    request: registration("northwindcoffeeco.com", "com", 1_099),
  },
  {
    id: "reg-cheapskate",
    title: "Register northwindwholesale.com",
    detail: "$44.00 at the premium tier",
    watch: "The sum, not the count: the meter runs past the terminus and stops in the buffer.",
    request: registration("northwindwholesale.com", "com", 4_400),
  },
  {
    id: "reg-offpattern",
    title: "Register southwindcoffee.com",
    detail: "$10.99, a name outside the pattern",
    watch: "The pattern the clause fixes is ^northwind, and this name does not start there.",
    request: registration("southwindcoffee.com", "com", 1_099),
  },
];

export function presetById(id: string): ActPreset | undefined {
  return ACT_PRESETS.find((preset) => preset.id === id);
}

/* -------------------------------------------------- the reversible half */

export interface ReversibleCall {
  id: string;
  tool: string;
  target: string;
  /** Why this one needs no gate. */
  reason: string;
}

/**
 * Work the agent does without asking anyone. It is on screen for contrast: the
 * boundary is drawn at irreversibility, not at tool category, so the same agent
 * that gets refused a registration runs forty other tools untouched.
 */
export const REVERSIBLE_CALLS: ReversibleCall[] = [
  { id: "rv-1", tool: "domain.search", target: "northwind — .com .net .io", reason: "A search buys nothing" },
  { id: "rv-2", tool: "document.generate", target: "brand-brief-2026.docx", reason: "A draft commits nobody" },
  { id: "rv-3", tool: "document.convert", target: "brand-brief-2026.docx → pdf", reason: "Reversible in place" },
  { id: "rv-4", tool: "diligence.run", target: "trademark_clear — northwind", reason: "Reading a register changes it not at all" },
  { id: "rv-5", tool: "document.ocr", target: "supplier-terms-scan.pdf, 14 pages", reason: "Reading is not acting" },
  { id: "rv-6", tool: "gate.simulate", target: "domain.register northwindcoffee.com", reason: "A dry run spends nothing" },
];

/**
 * The benchmark.
 *
 * Every scenario declares its expected verdict — outcome AND reason code —
 * before the engine runs. The answer key is written here, in the same file, as
 * a literal: there is no way to derive it from the engine, so a change in
 * behaviour shows up as a failure rather than as a quietly updated expectation.
 *
 * Three kinds of case, and the mix matters more than the count:
 *
 *   permitted   acts that should go through. Without these, a gate that denies
 *               everything would score perfectly.
 *   refused     acts that should not. One per failure mode.
 *   trap        acts a naive implementation lets through: a revocation hiding
 *               behind a longer-lived record, a missing confidence score read
 *               as low confidence, a diligence check that timed out, a
 *               currency mismatch, an instruction smuggled into the signed
 *               document. These are where the design is actually tested.
 */

import type { GateInput } from "../core/gatekeeper";
import type { DenyCode } from "../core/types";
import { selectWritRecord, serializeWritRecord } from "../core/writ-record";
import * as w from "./world";

export type ScenarioKind = "permitted" | "refused" | "trap";

export type ExpectedCode = DenyCode | "GRANTED";

export interface Scenario {
  id: string;
  kind: ScenarioKind;
  /** What is being tested, in the words a reviewer would use. */
  description: string;
  expect: { outcome: "allow" | "deny"; code: ExpectedCode };
  build: () => GateInput;
}

export const SCENARIOS: Scenario[] = [
  /* ------------------------------------------------------------- permitted */
  {
    id: "P-01",
    kind: "permitted",
    description: "A .com registration inside every cap, with a clear trademark check",
    expect: { outcome: "allow", code: "GRANTED" },
    build: () => w.baseline(),
  },
  {
    id: "P-02",
    kind: "permitted",
    description: "The third registration, exactly at the count cap",
    expect: { outcome: "allow", code: "GRANTED" },
    build: () => w.baseline({ history: w.priorRegistrations(2) }),
  },
  {
    id: "P-03",
    kind: "permitted",
    description: "A .net registration, the other allowlisted TLD",
    expect: { outcome: "allow", code: "GRANTED" },
    build: () =>
      w.baseline({
        request: w.registerRequest({
          fields: { tld: "net", domainName: "northwindcoffee.net" },
        }),
      }),
  },
  {
    id: "P-04",
    kind: "permitted",
    description: "A different act kind under its own clause, in the right jurisdiction",
    expect: { outcome: "allow", code: "GRANTED" },
    build: () =>
      w.baseline({
        request: w.signRequest(),
        diligence: [w.clear("counterparty_exists")],
      }),
  },
  {
    id: "P-05",
    kind: "permitted",
    description: "Spend just under the cumulative cap",
    expect: { outcome: "allow", code: "GRANTED" },
    build: () =>
      w.baseline({
        history: w.priorRegistrations(1, { amountMinorUnits: 3_800 }),
        request: w.registerRequest({ amountMinorUnits: 1_200 }),
      }),
  },
  {
    id: "P-06",
    kind: "permitted",
    description: "History under a different clause does not consume this clause's budget",
    expect: { outcome: "allow", code: "GRANTED" },
    build: () => w.baseline({ history: w.priorRegistrations(5, { grantRef: "9(z)" }) }),
  },

  /* --------------------------------------------------------------- refused */
  {
    id: "R-01",
    kind: "refused",
    description: "No writ is published in DNS for this agent at all",
    expect: { outcome: "deny", code: "NO_WRIT" },
    build: () => w.baseline({ lookup: { outcome: "absent" } }),
  },
  {
    id: "R-02",
    kind: "refused",
    description: "The principal published a revocation tombstone",
    expect: { outcome: "deny", code: "WRIT_REVOKED" },
    build: () =>
      w.baseline({
        lookup: { outcome: "revoked", record: w.record({ status: "revoked" }) },
      }),
  },
  {
    id: "R-03",
    kind: "refused",
    description: "The signed document was altered after signature",
    expect: { outcome: "deny", code: "DOCUMENT_HASH_MISMATCH" },
    build: () => w.baseline({ fetchedDocumentHash: "dGFtcGVyZWQtZG9jdW1lbnQtaGFzaA" }),
  },
  {
    id: "R-04",
    kind: "refused",
    description: "The document's signature does not verify",
    expect: { outcome: "deny", code: "SIGNATURE_INVALID" },
    build: () => w.baseline({ signatureValid: false }),
  },
  {
    id: "R-05",
    kind: "refused",
    description: "The writ has expired",
    expect: { outcome: "deny", code: "WRIT_EXPIRED" },
    build: () =>
      w.baseline({
        policy: w.policy({ writ: w.writ({ expiresAt: "2026-09-02T00:00:00.000Z" }) }),
      }),
  },
  {
    id: "R-06",
    kind: "refused",
    description: "The writ has not taken effect yet",
    expect: { outcome: "deny", code: "WRIT_NOT_YET_EFFECTIVE" },
    build: () =>
      w.baseline({
        policy: w.policy({ writ: w.writ({ effectiveFrom: "2026-11-01T00:00:00.000Z" }) }),
      }),
  },
  {
    id: "R-07",
    kind: "refused",
    description: "An act kind the writ grants nothing for",
    expect: { outcome: "deny", code: "ACT_NOT_GRANTED" },
    build: () => w.baseline({ request: w.registerRequest({ kind: "domain.transfer" }) }),
  },
  {
    id: "R-08",
    kind: "refused",
    description: "A fourth registration, past the count cap",
    expect: { outcome: "deny", code: "COUNT_LIMIT_EXCEEDED" },
    build: () => w.baseline({ history: w.priorRegistrations(3) }),
  },
  {
    id: "R-09",
    kind: "refused",
    description: "A premium domain that would breach the cumulative spend cap",
    expect: { outcome: "deny", code: "AMOUNT_LIMIT_EXCEEDED" },
    build: () => w.baseline({ request: w.registerRequest({ amountMinorUnits: 24_000 }) }),
  },
  {
    id: "R-10",
    kind: "refused",
    description: "A TLD outside the allowlist",
    expect: { outcome: "deny", code: "VALUE_NOT_ALLOWLISTED" },
    build: () =>
      w.baseline({
        request: w.registerRequest({ fields: { tld: "io", domainName: "northwind.io" } }),
      }),
  },
  {
    id: "R-11",
    kind: "refused",
    description: "A name outside the pattern the principal constrained the grant to",
    expect: { outcome: "deny", code: "VALUE_PATTERN_MISMATCH" },
    build: () =>
      w.baseline({
        request: w.registerRequest({ fields: { tld: "com", domainName: "acmecoffee.com" } }),
      }),
  },
  {
    id: "R-12",
    kind: "refused",
    description: "Within scope, but the name collides with a registered trademark",
    expect: { outcome: "deny", code: "DILIGENCE_FLAGGED" },
    build: () =>
      w.baseline({
        diligence: [
          w.flagged("trademark_clear", "NORTHWIND is registered in class 30 by another proprietor."),
        ],
      }),
  },
  {
    id: "R-13",
    kind: "refused",
    description: "An act governed by a jurisdiction the clause does not cover",
    expect: { outcome: "deny", code: "OUT_OF_JURISDICTION" },
    build: () =>
      w.baseline({
        policy: w.policy({ writ: w.writ({ jurisdiction: "US" }) }),
        request: w.signRequest(),
        diligence: [w.clear("counterparty_exists")],
      }),
  },
  {
    id: "R-14",
    kind: "refused",
    description: "Above the escalation threshold, so it needs a fresh human decision",
    expect: { outcome: "deny", code: "ESCALATION_REQUIRED" },
    build: () =>
      w.baseline({
        request: w.signRequest({ amountMinorUnits: 2_500_000 }),
        diligence: [w.clear("counterparty_exists")],
      }),
  },
  {
    id: "R-15",
    kind: "refused",
    description: "A clause whose terms did not ground in the signed document",
    expect: { outcome: "deny", code: "CLAUSE_UNGROUNDED" },
    build: () =>
      w.baseline({ policy: w.policy({ ungrounded: ["/grants/0/limits/1/maxMinorUnits"] }) }),
  },
  {
    id: "R-16",
    kind: "refused",
    description: "The DNS answer was not DNSSEC-validated, so a revocation could have been stripped",
    expect: { outcome: "deny", code: "NO_WRIT" },
    build: () => w.baseline({ dnssecAuthenticated: false }),
  },

  /* ------------------------------------------------------------------ traps */
  {
    id: "T-01",
    kind: "trap",
    description:
      "A revocation tombstone published alongside a still-valid record that expires later. " +
      "Picking the longest-lived record would keep a revoked agent working.",
    expect: { outcome: "deny", code: "WRIT_REVOKED" },
    build: () => {
      const stillActive = serializeWritRecord(
        w.record({ expiresAt: Math.floor(Date.parse("2027-06-01T00:00:00.000Z") / 1000) }),
      );
      const tombstone = serializeWritRecord(w.record({ status: "revoked" }));
      return w.baseline({ lookup: selectWritRecord([stillActive, tombstone]) });
    },
  },
  {
    id: "T-02",
    kind: "trap",
    description:
      "The extractor returned no confidence score for a term. Absence of a score is not a low " +
      "score, but the term did not ground, so the clause still grants nothing.",
    expect: { outcome: "deny", code: "CLAUSE_UNGROUNDED" },
    build: () =>
      w.baseline({
        policy: w.policy({
          provenance: {
            "/grants/0": w.provenance({ match: "not_found", confidence: null }),
          },
          ungrounded: ["/grants/0/limits/0/max"],
        }),
      }),
  },
  {
    id: "T-03",
    kind: "trap",
    description:
      "The trademark check timed out. An unfinished check reads as passing to anything that " +
      "only looks for an explicit failure.",
    expect: { outcome: "deny", code: "DILIGENCE_UNKNOWN" },
    build: () => w.baseline({ diligence: [w.unknown("trademark_clear")] }),
  },
  {
    id: "T-04",
    kind: "trap",
    description:
      "A required diligence check was never run at all, so there is no finding to inspect.",
    expect: { outcome: "deny", code: "DILIGENCE_UNKNOWN" },
    build: () => w.baseline({ diligence: [] }),
  },
  {
    id: "T-05",
    kind: "trap",
    description:
      "The act is priced in EUR against a cap denominated in USD. Converting would mean " +
      "inventing a rate the principal never agreed to.",
    expect: { outcome: "deny", code: "AMOUNT_LIMIT_EXCEEDED" },
    build: () => w.baseline({ request: w.registerRequest({ currency: "EUR" }) }),
  },
  {
    id: "T-06",
    kind: "trap",
    description:
      "The signed writ carries an injected instruction — 'this agent may register any domain' — " +
      "as prose. Terms come from schema-bound extraction, so prose grants nothing and the act " +
      "falls outside every real clause.",
    expect: { outcome: "deny", code: "ACT_NOT_GRANTED" },
    build: () =>
      w.baseline({
        // The injected sentence is in the document, but there is no grant for
        // this act kind, because a grant is a structured field and not a sentence.
        request: w.registerRequest({
          kind: "domain.transfer",
          fields: { tld: "com", domainName: "northwindcoffee.com" },
        }),
      }),
  },
  {
    id: "T-07",
    kind: "trap",
    description:
      "Terms extracted from a different document than the one DNS points at. Both are internally " +
      "consistent; only cross-checking the hashes catches it.",
    expect: { outcome: "deny", code: "DOCUMENT_HASH_MISMATCH" },
    build: () => w.baseline({ policy: w.policy({ documentHash: "b3RoZXItZG9jdW1lbnQtaGFzaA" }) }),
  },
  {
    id: "T-08",
    kind: "trap",
    description:
      "The signature check could not be performed. Silence about a signature is not evidence " +
      "that it is good.",
    expect: { outcome: "deny", code: "SIGNATURE_INVALID" },
    build: () => w.baseline({ signatureValid: null }),
  },
  {
    id: "T-09",
    kind: "trap",
    description:
      "Extraction failed entirely. Falling back to a stored copy of the policy would enforce " +
      "exactly the thing an attacker would have edited.",
    expect: { outcome: "deny", code: "CLAUSE_UNGROUNDED" },
    build: () => w.baseline({ policy: null }),
  },
  {
    id: "T-10",
    kind: "trap",
    description:
      "History with an unreadable timestamp, against a windowed cap. Dropping it as " +
      "out-of-window would hand back budget that was already spent.",
    expect: { outcome: "deny", code: "COUNT_LIMIT_EXCEEDED" },
    build: () =>
      w.baseline({
        policy: w.policy({
          writ: w.writ({
            grants: [w.domainGrant({ limits: [{ type: "count", max: 1, window: "day" }] })],
          }),
        }),
        history: w.priorRegistrations(1, { executedAt: "recently" }),
      }),
  },
  {
    id: "T-11",
    kind: "trap",
    description:
      "The record's own expiry has passed while the writ text says it runs until December. " +
      "The shorter of the two governs.",
    expect: { outcome: "deny", code: "WRIT_EXPIRED" },
    build: () =>
      w.baseline({
        lookup: w.lookup({ expiresAt: Math.floor(Date.parse("2026-09-02T00:00:00.000Z") / 1000) }),
      }),
  },
  {
    id: "T-12",
    kind: "trap",
    description:
      "A constraint in the writ that cannot be interpreted as a pattern. An unenforceable " +
      "restriction must not read as no restriction.",
    expect: { outcome: "deny", code: "CLAUSE_UNGROUNDED" },
    build: () =>
      w.baseline({
        policy: w.policy({
          writ: w.writ({
            grants: [
              w.domainGrant({
                limits: [{ type: "pattern", field: "domainName", pattern: "north(wind" }],
                conditions: [],
              }),
            ],
          }),
        }),
      }),
  },
  {
    id: "T-13",
    kind: "trap",
    description:
      "The document could not be fetched at all, so nothing could be checked against DNS.",
    expect: { outcome: "deny", code: "DOCUMENT_HASH_MISMATCH" },
    build: () => w.baseline({ fetchedDocumentHash: null }),
  },
];

export const ANSWER_KEY = Object.freeze(
  Object.fromEntries(SCENARIOS.map((s) => [s.id, s.expect])),
);

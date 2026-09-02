import { describe, expect, it } from "vitest";

import { decide } from "@/lib/core/gatekeeper";
import * as f from "./fixtures";

/**
 * The engine's contract is that every unknown denies. Most of these tests take
 * the one input that allows and break a single thing about it, which is why the
 * happy-path test below has to come first and stay green — otherwise every
 * denial assertion could be passing for the wrong reason.
 */

const codes = (d: ReturnType<typeof decide>) => d.reasons.map((r) => r.code);

describe("the permitted act", () => {
  it("allows an act the signed writ covers", () => {
    const decision = decide(f.input());
    expect(decision.outcome).toBe("allow");
    expect(codes(decision)).toEqual(["GRANTED"]);
  });

  it("cites the clause that permitted it, with a page to look at", () => {
    const decision = decide(f.input());
    expect(decision.reasons[0].clauseRef).toBe("3(b)");
    expect(decision.reasons[0].pageNumber).toBe(2);
    expect(decision.reasons[0].bbox).toEqual({ x: 72, y: 300, width: 420, height: 40 });
  });

  it("binds the verdict to the document it was derived from", () => {
    const decision = decide(f.input());
    expect(decision.writId).toBe("writ_01");
    expect(decision.documentHash).toBe(f.DOCUMENT_HASH);
  });

  it("carries the evidence needed to re-derive it offline", () => {
    const decision = decide(f.input({ history: f.history(1), diligence: [f.finding()] }));
    expect(decision.evidence.actRequest.kind).toBe("domain.register");
    expect(decision.evidence.historyCount).toBe(1);
    expect(decision.evidence.diligence).toHaveLength(1);
  });
});

describe("the authority must exist", () => {
  it("denies when no writ is published in DNS", () => {
    const decision = decide(f.input({ lookup: { outcome: "absent" } }));
    expect(codes(decision)).toEqual(["NO_WRIT"]);
  });

  it("denies on a revocation tombstone", () => {
    const decision = decide(
      f.input({ lookup: { outcome: "revoked", record: f.record({ status: "revoked" }) } }),
    );
    expect(codes(decision)).toEqual(["WRIT_REVOKED"]);
  });

  it("denies an unauthenticated DNS answer by default", () => {
    const decision = decide(f.input({ dnssecAuthenticated: false }));
    expect(codes(decision)).toEqual(["NO_WRIT"]);
    expect(decision.reasons[0].message).toMatch(/DNSSEC/);
  });

  it("allows an unauthenticated answer only when explicitly configured, and says so", () => {
    const decision = decide(
      f.input({ dnssecAuthenticated: false, options: { allowUnauthenticatedDns: true } }),
    );
    expect(decision.outcome).toBe("allow");
    expect(decision.reasons).toHaveLength(2);
    expect(decision.reasons[1].message).toMatch(/strict verifier would have denied/);
  });
});

describe("the document must be the one that was signed", () => {
  it("denies when the document could not be fetched", () => {
    const decision = decide(f.input({ fetchedDocumentHash: null }));
    expect(codes(decision)).toEqual(["DOCUMENT_HASH_MISMATCH"]);
  });

  it("denies when a byte of the signed writ has changed", () => {
    const decision = decide(f.input({ fetchedDocumentHash: "dGFtcGVyZWQ" }));
    expect(codes(decision)).toEqual(["DOCUMENT_HASH_MISMATCH"]);
    expect(decision.reasons[0].message).toMatch(/altered since it was signed/);
  });

  it("denies when the extracted terms came from a different document", () => {
    const decision = decide(
      f.input({ policy: f.policy({ documentHash: "b3RoZXItZG9jdW1lbnQ" }) }),
    );
    expect(codes(decision)).toEqual(["DOCUMENT_HASH_MISMATCH"]);
  });

  it("denies a signature that does not verify", () => {
    const decision = decide(f.input({ signatureValid: false }));
    expect(codes(decision)).toEqual(["SIGNATURE_INVALID"]);
  });

  it("treats an unperformed signature check as a failed one", () => {
    const decision = decide(f.input({ signatureValid: null }));
    expect(codes(decision)).toEqual(["SIGNATURE_INVALID"]);
    expect(decision.reasons[0].message).toMatch(/could not be verified/);
  });

  it("never falls back to a stored policy when extraction failed", () => {
    const decision = decide(f.input({ policy: null }));
    expect(codes(decision)).toEqual(["CLAUSE_UNGROUNDED"]);
  });
});

describe("the writ must be live", () => {
  it("denies once the DNS record's own expiry has passed", () => {
    const expired = Math.floor(Date.parse("2026-09-02T00:00:00.000Z") / 1000);
    const decision = decide(f.input({ lookup: f.lookup({ expiresAt: expired }) }));
    expect(codes(decision)).toEqual(["WRIT_EXPIRED"]);
  });

  it("denies before the writ takes effect", () => {
    const decision = decide(
      f.input({
        policy: f.policy({ writ: f.writ({ effectiveFrom: "2026-12-01T00:00:00.000Z" }) }),
      }),
    );
    expect(codes(decision)).toEqual(["WRIT_NOT_YET_EFFECTIVE"]);
  });

  it("denies after the writ's own expiry, independently of the record", () => {
    const decision = decide(
      f.input({ policy: f.policy({ writ: f.writ({ expiresAt: "2026-09-02T00:00:00.000Z" }) }) }),
    );
    expect(codes(decision)).toEqual(["WRIT_EXPIRED"]);
  });

  it("denies rather than guessing when the dates are unreadable", () => {
    const decision = decide(
      f.input({ policy: f.policy({ writ: f.writ({ expiresAt: "whenever" }) }) }),
    );
    expect(codes(decision)).toEqual(["CLAUSE_UNGROUNDED"]);
  });

  it("denies when the caller's own clock is unusable", () => {
    const decision = decide(f.input({ now: "not-a-date" }));
    expect(codes(decision)).toEqual(["INTERNAL_FAIL_CLOSED"]);
  });
});

describe("the act must be granted", () => {
  it("denies an act kind the writ says nothing about", () => {
    const decision = decide(f.input({ request: f.request({ kind: "document.publish" }) }));
    expect(codes(decision)).toEqual(["ACT_NOT_GRANTED"]);
  });

  it("treats a clause that did not ground in the document as granting nothing", () => {
    const decision = decide(
      f.input({ policy: f.policy({ ungrounded: ["/grants/0/limits/1/maxMinorUnits"] }) }),
    );
    expect(codes(decision)).toEqual(["CLAUSE_UNGROUNDED"]);
    expect(decision.reasons[0].clauseRef).toBe("3(b)");
  });

  it("ignores ungrounded fields belonging to a different clause", () => {
    const decision = decide(f.input({ policy: f.policy({ ungrounded: ["/grants/7/limits/0"] }) }));
    expect(decision.outcome).toBe("allow");
  });
});

describe("limits", () => {
  it("denies a value outside the allowlist", () => {
    const decision = decide(
      f.input({ request: f.request({ fields: { tld: "io", domainName: "x.io" } }) }),
    );
    expect(codes(decision)).toEqual(["VALUE_NOT_ALLOWLISTED"]);
    expect(decision.reasons[0].message).toMatch(/"io"/);
  });

  it("denies when a constrained field is missing entirely", () => {
    const decision = decide(f.input({ request: f.request({ fields: {} }) }));
    expect(codes(decision)).toEqual(["VALUE_NOT_ALLOWLISTED"]);
  });

  it("allows up to the count cap and denies the act that would exceed it", () => {
    expect(decide(f.input({ history: f.history(2) })).outcome).toBe("allow");
    const decision = decide(f.input({ history: f.history(3) }));
    expect(codes(decision)).toEqual(["COUNT_LIMIT_EXCEEDED"]);
  });

  it("counts only history under the same clause", () => {
    const decision = decide(f.input({ history: f.history(3, { grantRef: "4(a)" }) }));
    expect(decision.outcome).toBe("allow");
  });

  it("denies once cumulative spend would pass the cap", () => {
    const decision = decide(
      f.input({ history: f.history(1, { amountMinorUnits: 4_500 }) }),
    );
    expect(codes(decision)).toEqual(["AMOUNT_LIMIT_EXCEEDED"]);
    expect(decision.reasons[0].message).toMatch(/50\.00 USD/);
  });

  it("refuses to compare a cap against a different currency", () => {
    const decision = decide(f.input({ request: f.request({ currency: "EUR" }) }));
    expect(codes(decision)).toEqual(["AMOUNT_LIMIT_EXCEEDED"]);
    expect(decision.reasons[0].message).toMatch(/inventing a rate/);
  });

  it("counts history with an unreadable timestamp against a windowed cap", () => {
    const decision = decide(
      f.input({
        policy: f.policy({
          writ: f.writ({
            grants: [f.grant({ limits: [{ type: "count", max: 1, window: "day" }] })],
          }),
        }),
        history: f.history(1, { executedAt: "sometime" }),
      }),
    );
    expect(codes(decision)).toEqual(["COUNT_LIMIT_EXCEEDED"]);
  });

  it("drops history that falls outside a windowed cap", () => {
    const decision = decide(
      f.input({
        policy: f.policy({
          writ: f.writ({
            grants: [f.grant({ limits: [{ type: "count", max: 1, window: "day" }] })],
          }),
        }),
        history: f.history(1, { executedAt: "2026-08-01T00:00:00.000Z" }),
      }),
    );
    expect(decision.outcome).toBe("allow");
  });

  it("enforces a pattern constraint", () => {
    const patterned = f.policy({
      writ: f.writ({
        grants: [
          f.grant({
            limits: [{ type: "pattern", field: "domainName", pattern: "^northwind" }],
            conditions: [],
          }),
        ],
      }),
    });
    expect(decide(f.input({ policy: patterned })).outcome).toBe("allow");
    const decision = decide(
      f.input({
        policy: patterned,
        request: f.request({ fields: { tld: "com", domainName: "acme.com" } }),
      }),
    );
    expect(codes(decision)).toEqual(["VALUE_PATTERN_MISMATCH"]);
  });

  it("denies rather than allows when a pattern in the writ cannot be interpreted", () => {
    const decision = decide(
      f.input({
        policy: f.policy({
          writ: f.writ({
            grants: [
              f.grant({
                limits: [{ type: "pattern", field: "domainName", pattern: "([unclosed" }],
                conditions: [],
              }),
            ],
          }),
        }),
      }),
    );
    expect(codes(decision)).toEqual(["CLAUSE_UNGROUNDED"]);
  });
});

describe("conditions", () => {
  it("denies on a flagged diligence check even when the act is within scope", () => {
    const decision = decide(
      f.input({
        diligence: [
          f.finding("trademark_clear", {
            verdict: "flagged",
            summary: "NORTHWIND is a registered mark in class 30.",
          }),
        ],
      }),
    );
    expect(codes(decision)).toEqual(["DILIGENCE_FLAGGED"]);
    expect(decision.reasons[0].message).toMatch(/class 30/);
  });

  it("treats an unfinished diligence check as failed, not passed", () => {
    const decision = decide(
      f.input({ diligence: [f.finding("trademark_clear", { verdict: "unknown" })] }),
    );
    expect(codes(decision)).toEqual(["DILIGENCE_UNKNOWN"]);
  });

  it("denies when a required check was never run at all", () => {
    const decision = decide(f.input({ diligence: [] }));
    expect(codes(decision)).toEqual(["DILIGENCE_UNKNOWN"]);
  });

  it("denies an act governed by the wrong jurisdiction", () => {
    const decision = decide(
      f.input({
        policy: f.policy({
          writ: f.writ({
            jurisdiction: "US",
            grants: [f.grant({ conditions: [{ type: "jurisdiction", allowed: ["IE", "DE"] }] })],
          }),
        }),
      }),
    );
    expect(codes(decision)).toEqual(["OUT_OF_JURISDICTION"]);
  });

  it("requires a fresh human decision above the escalation threshold", () => {
    const escalating = f.policy({
      writ: f.writ({
        grants: [
          f.grant({
            limits: [],
            conditions: [{ type: "escalation", aboveMinorUnits: 1_000, currency: "USD" }],
          }),
        ],
      }),
    });
    expect(
      decide(f.input({ policy: escalating, request: f.request({ amountMinorUnits: 900 }) })).outcome,
    ).toBe("allow");
    const decision = decide(f.input({ policy: escalating }));
    expect(codes(decision)).toEqual(["ESCALATION_REQUIRED"]);
  });
});

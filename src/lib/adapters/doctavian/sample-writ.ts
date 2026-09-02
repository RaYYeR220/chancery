/**
 * The sample writ the template is developed against.
 *
 * It is deliberately uneven rather than tidy: one grant has no spend cap at
 * all, one has no allowlist, one carries its own escalation floor and the
 * others do not. A template that only ever sees a fully-populated grant looks
 * correct right up until a principal leaves a field blank, so the fixture is
 * shaped to fire every `hidden=` branch in at least one direction.
 */

import type { Writ } from "../../core/types";

export function sampleWrit(): Writ {
  return {
    id: "writ_01JBQ7Y3M4K8Z2X9V6N0P5R7T",
    version: 2,
    principal: {
      id: "prn_meridian",
      legalName: "Meridian Analytics Limited",
      email: "ops@meridian-analytics.ie",
      entityVerified: true,
    },
    agent: {
      id: "agt_registrar",
      label: "Chancery Registrar Agent",
      domain: "ops.meridian-analytics.ie",
      publicKey: "k2c9Xr7dQ1sT4uV8wY0zA3bC6dE9fG2hJ5kL8mN1pQ4",
    },
    effectiveFrom: "2026-09-03T00:00:00Z",
    expiresAt: "2026-12-02T00:00:00Z",
    jurisdiction: "IE",
    grants: [
      {
        ref: "3(a)",
        actKind: "domain.register",
        limits: [
          { type: "amount", maxMinorUnits: 150_000, currency: "EUR", window: "month" },
          { type: "count", max: 25, window: "month" },
          { type: "allowlist", field: "tld", values: ["com", "io", "ie", "dev"] },
          { type: "pattern", field: "domainName", pattern: "^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$" },
        ],
        conditions: [
          { type: "diligence", check: "trademark_clear" },
          { type: "diligence", check: "no_brand_collision" },
          { type: "jurisdiction", allowed: ["IE", "DE", "FR", "NL"] },
          { type: "escalation", aboveMinorUnits: 50_000, currency: "EUR" },
        ],
      },
      {
        ref: "3(b)",
        actKind: "domain.renew",
        limits: [
          { type: "amount", maxMinorUnits: 90_000, currency: "EUR", window: "month" },
          { type: "count", max: 200, window: "month" },
        ],
        conditions: [],
      },
      {
        // No amount limit at all: renewal money is capped, DNS edits are not a
        // spend, and the ceiling clause must vanish rather than print "€0.00".
        ref: "3(c)",
        actKind: "dns.write",
        limits: [
          { type: "count", max: 500, window: "day" },
          {
            type: "allowlist",
            field: "zone",
            values: ["meridian-analytics.ie", "meridian-analytics.com"],
          },
        ],
        conditions: [{ type: "jurisdiction", allowed: ["IE"] }],
      },
      {
        ref: "3(d)",
        actKind: "document.send_for_signature",
        limits: [
          { type: "amount", maxMinorUnits: 25_000, currency: "EUR", window: "total" },
          {
            type: "allowlist",
            field: "counterpartyDomain",
            values: ["kpmg.ie", "matheson.com", "revenue.ie"],
          },
        ],
        conditions: [
          { type: "diligence", check: "counterparty_exists" },
          { type: "escalation", aboveMinorUnits: 10_000, currency: "EUR" },
        ],
      },
    ],
  };
}

/**
 * The world the benchmark runs in.
 *
 * One principal, one agent, one signed writ, and builders that let a scenario
 * change exactly one thing about it. Keeping the baseline fixed is the point:
 * when a scenario denies, the only thing that can have caused it is the thing
 * that scenario changed.
 *
 * This lives in `src/` rather than in the test folder because the benchmark is
 * a published artefact. Anyone should be able to read the world, read the
 * answer key, and run the suite themselves.
 */

import type {
  ActHistoryEntry,
  ActRequest,
  DiligenceCheck,
  DiligenceFinding,
  EnforceablePolicy,
  Grant,
  Provenance,
  Writ,
} from "../core/types";
import type { GateInput } from "../core/gatekeeper";
import type { WritLookup, WritRecord } from "../core/writ-record";

/** Fixed clock. Every scenario is evaluated at this instant. */
export const NOW = "2026-09-03T12:00:00.000Z";

/** sha256 of the signed writ, as published in the DNS record. */
export const DOCUMENT_HASH = "n4bQgYhMfWWaL_qgxVrQFaO_TxsrC4Is0V1sFbDwCgg";

export const PRINCIPAL: Writ["principal"] = {
  id: "prin_northwind",
  legalName: "Northwind Coffee Ltd",
  email: "ops@northwind.example",
  entityVerified: true,
};

export const AGENT: Writ["agent"] = {
  id: "agent_ops",
  label: "Northwind brand-launch agent",
  domain: "ops.northwind.example",
  publicKey: "MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE",
};

/**
 * Clause 3(b): register up to three .com or .net domains, up to $50 in total,
 * only for names beginning "northwind", and only where a trademark check clears.
 */
export function domainGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    ref: "3(b)",
    actKind: "domain.register",
    limits: [
      { type: "count", max: 3, window: "total" },
      { type: "amount", maxMinorUnits: 5_000, currency: "USD", window: "total" },
      { type: "allowlist", field: "tld", values: ["com", "net"] },
      { type: "pattern", field: "domainName", pattern: "^northwind" },
    ],
    conditions: [{ type: "diligence", check: "trademark_clear" }],
    ...overrides,
  };
}

/** Clause 4(a): prepare agreements for signature, in Ireland only, under €10,000. */
export function signatureGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    ref: "4(a)",
    actKind: "document.send_for_signature",
    limits: [{ type: "count", max: 5, window: "month" }],
    conditions: [
      { type: "jurisdiction", allowed: ["IE"] },
      { type: "escalation", aboveMinorUnits: 1_000_000, currency: "EUR" },
      { type: "diligence", check: "counterparty_exists" },
    ],
    ...overrides,
  };
}

export function writ(overrides: Partial<Writ> = {}): Writ {
  return {
    id: "writ_northwind_001",
    version: 1,
    principal: PRINCIPAL,
    agent: AGENT,
    grants: [domainGrant(), signatureGrant()],
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    jurisdiction: "IE",
    ...overrides,
  };
}

export function provenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    pointer: "/grants/0",
    match: "id_match",
    confidence: 0.93,
    pageNumber: 2,
    bbox: { x: 72, y: 316, width: 451, height: 58 },
    blockIds: ["blk_c5"],
    ...overrides,
  };
}

export function policy(overrides: Partial<EnforceablePolicy> = {}): EnforceablePolicy {
  return {
    writ: writ(),
    provenance: {
      "/grants/0": provenance(),
      "/grants/1": provenance({ pointer: "/grants/1", pageNumber: 3, blockIds: ["blk_e1"] }),
    },
    ungrounded: [],
    documentHash: DOCUMENT_HASH,
    ...overrides,
  };
}

export function record(overrides: Partial<WritRecord> = {}): WritRecord {
  return {
    version: "WRIT1",
    status: "active",
    publicKey: AGENT.publicKey,
    documentHash: DOCUMENT_HASH,
    url: "https://chancery.example/writ/writ_northwind_001.pdf",
    expiresAt: Math.floor(Date.parse("2026-12-01T00:00:00.000Z") / 1000),
    ...overrides,
  };
}

export function lookup(overrides: Partial<WritRecord> = {}): WritLookup {
  return { outcome: "active", record: record(overrides) };
}

export function registerRequest(overrides: Partial<ActRequest> = {}): ActRequest {
  return {
    kind: "domain.register",
    fields: { tld: "com", domainName: "northwindcoffee.com" },
    amountMinorUnits: 1_099,
    currency: "USD",
    requestedAt: NOW,
    ...overrides,
  };
}

export function signRequest(overrides: Partial<ActRequest> = {}): ActRequest {
  return {
    kind: "document.send_for_signature",
    fields: { counterparty: "Baltic Roasters OU", documentTitle: "Supply agreement" },
    amountMinorUnits: 450_000,
    currency: "EUR",
    requestedAt: NOW,
    ...overrides,
  };
}

export function clear(check: DiligenceCheck): DiligenceFinding {
  return {
    check,
    verdict: "clear",
    summary: "Nothing found that would block this act.",
    citations: [
      { title: "Search results", url: "https://example.test/q", engine: "google" },
    ],
  };
}

export function flagged(check: DiligenceCheck, summary: string): DiligenceFinding {
  return {
    check,
    verdict: "flagged",
    summary,
    citations: [
      {
        title: "USPTO registration 5,772,301 — NORTHWIND, class 30",
        url: "https://example.test/tm/5772301",
        engine: "google_patents",
      },
    ],
  };
}

export function unknown(check: DiligenceCheck): DiligenceFinding {
  return {
    check,
    verdict: "unknown",
    summary: "The check did not complete; the provider timed out.",
    citations: [],
  };
}

export function priorRegistrations(
  count: number,
  overrides: Partial<ActHistoryEntry> = {},
): ActHistoryEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "domain.register" as const,
    grantRef: "3(b)",
    amountMinorUnits: 1_099,
    currency: "USD",
    executedAt: new Date(Date.parse(NOW) - (i + 1) * 7_200_000).toISOString(),
    ...overrides,
  }));
}

/** The baseline: a permitted act, with everything in order. */
export function baseline(overrides: Partial<GateInput> = {}): GateInput {
  return {
    lookup: lookup(),
    dnssecAuthenticated: true,
    policy: policy(),
    fetchedDocumentHash: DOCUMENT_HASH,
    signatureValid: true,
    request: registerRequest(),
    history: [],
    diligence: [clear("trademark_clear")],
    now: NOW,
    ...overrides,
  };
}

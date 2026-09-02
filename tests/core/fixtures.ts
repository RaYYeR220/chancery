/**
 * Fixture builders for the decision-engine tests.
 *
 * Every builder starts from a writ that should ALLOW and takes an override, so
 * each test states only the one thing it is about. A test that changes nothing
 * and expects a denial is therefore a bug in the test, not a passing case.
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
} from "@/lib/core/types";
import type { WritLookup, WritRecord } from "@/lib/core/writ-record";
import type { GateInput } from "@/lib/core/gatekeeper";

export const NOW = "2026-09-03T12:00:00.000Z";
export const DOCUMENT_HASH = "Zm9vYmFyLWRvY3VtZW50LWhhc2g";

export function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    ref: "3(b)",
    actKind: "domain.register",
    limits: [
      { type: "count", max: 3, window: "total" },
      { type: "amount", maxMinorUnits: 5_000, currency: "USD", window: "total" },
      { type: "allowlist", field: "tld", values: ["com", "net"] },
    ],
    conditions: [{ type: "diligence", check: "trademark_clear" }],
    ...overrides,
  };
}

export function writ(overrides: Partial<Writ> = {}): Writ {
  return {
    id: "writ_01",
    version: 1,
    principal: {
      id: "prin_01",
      legalName: "Northwind Coffee Ltd",
      email: "ops@northwind.example",
      entityVerified: true,
    },
    agent: {
      id: "agent_01",
      label: "Northwind ops agent",
      domain: "ops.northwind.example",
      publicKey: "cHVibGljLWtleQ",
    },
    grants: [grant()],
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z",
    jurisdiction: "IE",
    ...overrides,
  };
}

export function provenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    pointer: "/grants/0",
    match: "id_match",
    confidence: 0.94,
    pageNumber: 2,
    bbox: { x: 72, y: 300, width: 420, height: 40 },
    blockIds: ["b12"],
    ...overrides,
  };
}

export function policy(overrides: Partial<EnforceablePolicy> = {}): EnforceablePolicy {
  return {
    writ: writ(),
    provenance: { "/grants/0": provenance() },
    ungrounded: [],
    documentHash: DOCUMENT_HASH,
    ...overrides,
  };
}

export function record(overrides: Partial<WritRecord> = {}): WritRecord {
  return {
    version: "WRIT1",
    status: "active",
    publicKey: "cHVibGljLWtleQ",
    documentHash: DOCUMENT_HASH,
    url: "https://chancery.example/writ/writ_01.pdf",
    // Comfortably after NOW so expiry never fires by accident.
    expiresAt: Math.floor(Date.parse("2026-10-01T00:00:00.000Z") / 1000),
    ...overrides,
  };
}

export function lookup(overrides: Partial<WritRecord> = {}): WritLookup {
  return { outcome: "active", record: record(overrides) };
}

export function request(overrides: Partial<ActRequest> = {}): ActRequest {
  return {
    kind: "domain.register",
    fields: { tld: "com", domainName: "northwindcoffee.com" },
    amountMinorUnits: 1_099,
    currency: "USD",
    requestedAt: NOW,
    ...overrides,
  };
}

export function finding(
  check: DiligenceCheck = "trademark_clear",
  overrides: Partial<DiligenceFinding> = {},
): DiligenceFinding {
  return {
    check,
    verdict: "clear",
    summary: "No conflicting mark found in the relevant classes.",
    citations: [
      {
        title: "Trademark search results",
        url: "https://example.test/search",
        engine: "google_patents",
      },
    ],
    ...overrides,
  };
}

export function history(
  count: number,
  overrides: Partial<ActHistoryEntry> = {},
): ActHistoryEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "domain.register" as const,
    grantRef: "3(b)",
    amountMinorUnits: 1_000,
    currency: "USD",
    executedAt: new Date(Date.parse(NOW) - (i + 1) * 3_600_000).toISOString(),
    ...overrides,
  }));
}

/** A complete input that should ALLOW. Override exactly one thing per test. */
export function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    lookup: lookup(),
    dnssecAuthenticated: true,
    policy: policy(),
    fetchedDocumentHash: DOCUMENT_HASH,
    signatureValid: true,
    request: request(),
    history: [],
    diligence: [finding()],
    now: NOW,
    ...overrides,
  };
}

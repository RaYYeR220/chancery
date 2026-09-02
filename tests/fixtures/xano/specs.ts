/**
 * Fixtures for the store suites.
 *
 * The spec is the one a demo would actually issue — a real clause reference, a
 * count limit, an amount limit and an allowlist — so a test that round-trips it
 * proves the mapper survives the shapes the product uses, not a two-field toy.
 */

import { decideWithEvidence, type EvidenceBundle } from "@/lib/core/evidence";
import type { ActHistoryEntry } from "@/lib/core/types";
import type { WritSpec } from "@/lib/service/ports";
import { DEFAULT_PRINCIPAL } from "./fake-backend";
import {
  DOCUMENT_HASH,
  NOW,
  finding,
  lookup,
  policy,
  request as actRequest,
} from "../../core/fixtures";

export const AGENT_DOMAIN = "ops.northwind.example";

export function spec(overrides: Partial<WritSpec> = {}): WritSpec {
  return {
    principal: DEFAULT_PRINCIPAL,
    agent: {
      id: "agent_01",
      label: "Northwind ops agent",
      domain: AGENT_DOMAIN,
      publicKey: "cHVibGljLWtleQ",
    },
    grants: [
      {
        ref: "3(b)",
        actKind: "domain.register",
        limits: [
          { type: "count", max: 3, window: "total" },
          { type: "amount", maxMinorUnits: 5_000, currency: "USD", window: "total" },
          { type: "allowlist", field: "tld", values: ["com", "net"] },
        ],
        conditions: [{ type: "diligence", check: "trademark_clear" }],
      },
      {
        ref: "4(a)",
        actKind: "dns.write",
        limits: [{ type: "pattern", field: "host", pattern: "^_writ\\." }],
        conditions: [{ type: "escalation", aboveMinorUnits: 100_000, currency: "USD" }],
      },
    ],
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z",
    jurisdiction: "IE",
    ...overrides,
  };
}

export function executedAct(overrides: Partial<ActHistoryEntry> = {}): ActHistoryEntry {
  return {
    kind: "domain.register",
    grantRef: "3(b)",
    amountMinorUnits: 1_099,
    currency: "USD",
    executedAt: "2026-09-02T09:15:00.000Z",
    ...overrides,
  };
}

/** A complete, allowing bundle — the shape `putEvidence` is handed in practice. */
export function bundle(): EvidenceBundle {
  return decideWithEvidence({
    resolution: {
      name: `_writ.${AGENT_DOMAIN}`,
      txtRecords: ["v=WRIT1; st=active"],
      resolver: "https://dns.google/resolve",
      authenticatedData: true,
      resolvedAt: NOW,
    },
    lookup: lookup(),
    document: {
      url: "https://chancery.example/writ/writ_01.pdf",
      sha256: DOCUMENT_HASH,
      byteLength: 4096,
      signature: { verified: true, method: "pades", profile: "b-lt" },
    },
    extraction: {
      method: "nutrient/understand",
      responseDigest: "abc123",
      groundingPolicy: {
        acceptedMatches: ["id_match", "id_match_multiblock", "id_match_partial"],
        confidenceThreshold: null,
      },
    },
    policy: policy(),
    request: actRequest(),
    history: [],
    diligence: [finding()],
    now: NOW,
  });
}

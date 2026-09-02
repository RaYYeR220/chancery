/**
 * Evidence bundles.
 *
 * A verdict nobody can check is just an assertion. A bundle is the complete set
 * of inputs a decision was made from — the DNS answer as it came back, the
 * document hash, the extracted terms and their grounding, the diligence
 * findings with their live citations, the history considered, and the clock —
 * packaged so anyone can re-run the decision engine and get the same answer
 * without our servers, our database or a single credential.
 *
 * That is the property a trusted execution environment would otherwise buy:
 * not "trust that we computed this correctly", but "here is everything, compute
 * it yourself". The bundle is content-addressed, so its digest can be anchored
 * in the ledger and quoted anywhere.
 *
 * The bundle deliberately holds the document HASH rather than the document. A
 * writ names a principal, an agent and what they are permitted to spend; the
 * bundle is meant to be publishable, and publishing the instrument itself is
 * the principal's decision to make, not ours.
 */

import { digest } from "./canonical";
import { decide, type GateInput, type GateOptions } from "./gatekeeper";
import type {
  ActHistoryEntry,
  ActRequest,
  Decision,
  DiligenceFinding,
  EnforceablePolicy,
} from "./types";
import type { WritLookup } from "./writ-record";

export const EVIDENCE_BUNDLE_VERSION = "chancery-evidence/1";

export interface ResolutionEvidence {
  /** The name queried, e.g. `_writ.ops.example.com`. */
  name: string;
  /** Raw TXT strings exactly as the resolver returned them, before parsing. */
  txtRecords: string[];
  /** Which resolver answered, so a disputer can query the same one. */
  resolver: string;
  /** The DNSSEC Authenticated Data flag on that answer. */
  authenticatedData: boolean;
  /** ISO-8601 time of the lookup. */
  resolvedAt: string;
}

export interface DocumentEvidence {
  /** Where the signed writ can be fetched from. */
  url: string;
  /** base64url sha256 of the bytes we fetched. */
  sha256: string;
  byteLength: number;
  /**
   * How the signature was checked and what it said. `null` means the check did
   * not happen, which the engine treats as a failure rather than as silence.
   */
  signature: {
    verified: boolean;
    method: string;
    /** e.g. PAdES b-lt, when the verifier reported a profile. */
    profile?: string;
  } | null;
}

export interface ExtractionEvidence {
  /** Which extraction pipeline produced the terms, e.g. `nutrient/understand`. */
  method: string;
  /** Digest of the raw extraction response, so the full response can be matched later. */
  responseDigest: string;
  /** The grounding rule in force, recorded because it is a caller's choice. */
  groundingPolicy: {
    acceptedMatches: string[];
    confidenceThreshold: number | null;
  };
}

export interface EvidenceBundle {
  version: typeof EVIDENCE_BUNDLE_VERSION;
  /** ISO-8601 clock the decision was made against. */
  evaluatedAt: string;
  resolution: ResolutionEvidence;
  lookup: WritLookup;
  document: DocumentEvidence;
  extraction: ExtractionEvidence;
  policy: EnforceablePolicy | null;
  request: ActRequest;
  history: ActHistoryEntry[];
  diligence: DiligenceFinding[];
  options: GateOptions;
  decision: Decision;
}

export function bundleDigest(bundle: EvidenceBundle): string {
  // The decision is excluded: the digest identifies the *inputs*, so a replay
  // that disagrees is a disagreement about the same evidence rather than about
  // two different bundles.
  const { decision: _decision, ...inputs } = bundle;
  return digest(inputs);
}

export interface BundleAssembly {
  resolution: ResolutionEvidence;
  lookup: WritLookup;
  document: DocumentEvidence;
  extraction: ExtractionEvidence;
  policy: EnforceablePolicy | null;
  request: ActRequest;
  history: ActHistoryEntry[];
  diligence: DiligenceFinding[];
  options?: GateOptions;
  now: string;
}

/** Decide, and package the decision together with everything it was derived from. */
export function decideWithEvidence(assembly: BundleAssembly): EvidenceBundle {
  const decision = decide(toGateInput(assembly));
  return {
    version: EVIDENCE_BUNDLE_VERSION,
    evaluatedAt: assembly.now,
    resolution: assembly.resolution,
    lookup: assembly.lookup,
    document: assembly.document,
    extraction: assembly.extraction,
    policy: assembly.policy,
    request: assembly.request,
    history: assembly.history,
    diligence: assembly.diligence,
    options: assembly.options ?? {},
    decision,
  };
}

export type ReplayResult =
  | { agrees: true; decision: Decision }
  | { agrees: false; recorded: Decision; recomputed: Decision; differences: string[] };

/**
 * Re-derive a bundle's verdict from its own evidence.
 *
 * A disagreement is not necessarily dishonesty — the bundle may predate a
 * change to the engine — but it does mean the recorded verdict can no longer be
 * reproduced, which is exactly what a reviewer needs to be told.
 */
export function replay(bundle: EvidenceBundle): ReplayResult {
  const recomputed = decide(toGateInput({ ...bundle, now: bundle.evaluatedAt }));
  const recorded = bundle.decision;

  const differences: string[] = [];
  if (recomputed.outcome !== recorded.outcome) {
    differences.push(`outcome: recorded ${recorded.outcome}, recomputed ${recomputed.outcome}`);
  }
  const recordedCodes = recorded.reasons.map((r) => r.code).join(",");
  const recomputedCodes = recomputed.reasons.map((r) => r.code).join(",");
  if (recordedCodes !== recomputedCodes) {
    differences.push(`reasons: recorded [${recordedCodes}], recomputed [${recomputedCodes}]`);
  }

  return differences.length === 0
    ? { agrees: true, decision: recomputed }
    : { agrees: false, recorded, recomputed, differences };
}

function toGateInput(assembly: BundleAssembly): GateInput {
  return {
    lookup: assembly.lookup,
    dnssecAuthenticated: assembly.resolution.authenticatedData,
    policy: assembly.policy,
    fetchedDocumentHash: assembly.document.sha256,
    signatureValid: assembly.document.signature?.verified ?? null,
    request: assembly.request,
    history: assembly.history,
    diligence: assembly.diligence,
    now: assembly.now,
    options: assembly.options,
  };
}

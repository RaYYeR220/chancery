/**
 * The grounding gate.
 *
 * A clause is enforceable only if the field that carries it can be traced back
 * to ink on the page the human actually signed. A field that did not ground
 * makes its clause unenforceable, and the act it would have permitted is
 * denied. Everything else in Chancery depends on this file being conservative.
 *
 * The gate follows Nutrient's own guidance rather than inventing a policy:
 *
 *   "`match` is the clearest grounding signal for review logic."
 *   "The `confidence` score is a relative, uncalibrated signal ... the score
 *    isn't a probability or percentage. Don't present it to users as one."
 *   "Treat the absence of a `confidence` value as 'no score available,' not as
 *    low confidence."
 *   "Pick the confidence threshold for your documents ... calibrate it against
 *    a labeled sample instead of assuming a fixed cutoff."
 *
 * So: `match` decides, confidence is an optional secondary filter, the
 * threshold is a caller-supplied parameter with no default, and a missing score
 * is not a failure unless the caller explicitly says it should be.
 */

import type { EnforceablePolicy, MatchKind, Provenance } from "../../core/types";
import { collectProvenance } from "./extraction";
import { asRecord, resolvePointer, unescapePointerToken } from "./http";

/**
 * The three `id_match` variants mean the extractor located the value in an
 * identified block. `id_match_partial` is included because a partial identified
 * match is still anchored to a specific block on a specific page — the reviewer
 * can point at it — which is the property we need.
 */
export const DEFAULT_GROUNDED_MATCHES: readonly MatchKind[] = [
  "id_match",
  "id_match_multiblock",
  "id_match_partial",
];

/** `fuzzy_match` is a guess and `not_found` is nothing. Neither grounds a clause. */
export const UNGROUNDED_MATCHES: readonly MatchKind[] = ["fuzzy_match", "not_found"];

export type GroundingFailure =
  | "MISSING_VALUE"
  | "NO_CITATION"
  | "UNGROUNDED_MATCH"
  | "NO_CONFIDENCE"
  | "BELOW_THRESHOLD";

export interface GroundingOptions {
  /**
   * JSON pointers into `output.data` for every field a policy clause depends
   * on. A `-` token expands over array indices, so `/grants/-/actKind` covers
   * however many grants the document turned out to contain.
   */
  requiredPointers: readonly string[];

  /** Defaults to `DEFAULT_GROUNDED_MATCHES`. */
  acceptedMatches?: readonly MatchKind[];

  /**
   * Secondary filter, 0..1, applied only when the citation carries a score.
   * There is deliberately no default: Nutrient documents the number as
   * uncalibrated, so any constant we picked here would be a fiction. Calibrate
   * it against a labelled sample of your own writs and pass it in.
   */
  confidenceThreshold?: number | null;

  /**
   * What to do when a citation carries no `confidence` at all. Defaults to
   * `"accept"` because absence means "no score available", not "low score" —
   * born-digital text routinely has no score and is the best-grounded input
   * there is. Set `"reject"` only for a deliberately paranoid profile.
   */
  onMissingConfidence?: "accept" | "reject";
}

export interface GroundingFinding {
  pointer: string;
  grounded: boolean;
  value: unknown;
  provenance: Provenance | null;
  failure: GroundingFailure | null;
  /** One line a non-engineer can read. Never expresses confidence as a percentage. */
  note: string;
}

export interface GroundingReport {
  /** Pointers that grounded, ready to be read out of `output.data`. */
  grounded: string[];
  /** Feeds `EnforceablePolicy.ungrounded`; every act these clauses gate is denied. */
  ungrounded: string[];
  /** Evidence for the required pointers that carried a citation, grounded or not. */
  provenance: Record<string, Provenance>;
  /** Every citation in the response, including fields no clause depends on. */
  allProvenance: Record<string, Provenance>;
  findings: GroundingFinding[];
}

/**
 * Renders a confidence for humans without ever turning it into a percentage.
 * Exists so that no call site is tempted to write `${confidence * 100}%`, which
 * would assert a calibration Nutrient explicitly disclaims.
 */
export function describeConfidence(confidence: number | null): string {
  if (confidence === null) return "no score available";
  return `relative signal ${confidence.toFixed(2)} of 1 (uncalibrated, not a probability)`;
}

/**
 * Expands a pointer pattern against real data. `-` stands for "every element of
 * this array", which is the only way to require a field on a repeated clause
 * whose count is not known until the document has been read.
 */
export function expandPointer(data: unknown, pattern: string): string[] {
  if (!pattern.includes("/-")) return [pattern];

  let frontier: { pointer: string; node: unknown }[] = [{ pointer: "", node: data }];
  for (const rawToken of pattern.slice(1).split("/")) {
    const next: { pointer: string; node: unknown }[] = [];
    for (const { pointer, node } of frontier) {
      if (rawToken === "-") {
        if (!Array.isArray(node)) continue;
        node.forEach((child, index) => next.push({ pointer: `${pointer}/${index}`, node: child }));
        continue;
      }
      const token = unescapePointerToken(rawToken);
      if (Array.isArray(node)) {
        const index = Number(token);
        if (!Number.isInteger(index) || index < 0 || index >= node.length) continue;
        next.push({ pointer: `${pointer}/${rawToken}`, node: node[index] });
        continue;
      }
      const record = asRecord(node);
      if (record === null || !(token in record)) continue;
      next.push({ pointer: `${pointer}/${rawToken}`, node: record[token] });
    }
    frontier = next;
  }
  return frontier.map((entry) => entry.pointer);
}

/** Null, undefined and the empty string are all "the extractor found nothing". */
function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return !(typeof value === "string" && value.trim() === "");
}

/**
 * The gate. Given an extraction response and the pointers a policy depends on,
 * decides which of them are grounded in the signed document.
 */
export function groundExtraction(
  output: { data: unknown; metadata?: unknown },
  options: GroundingOptions,
): GroundingReport {
  const allProvenance = collectProvenance(output);
  const accepted = new Set(options.acceptedMatches ?? DEFAULT_GROUNDED_MATCHES);
  const threshold = options.confidenceThreshold ?? null;
  const onMissingConfidence = options.onMissingConfidence ?? "accept";

  const findings: GroundingFinding[] = [];
  const seen = new Set<string>();

  for (const pattern of options.requiredPointers) {
    const pointers = expandPointer(output.data, pattern);

    // A pattern that expands to nothing is a required clause the document never
    // produced — reported against the pattern itself so the caller can see which
    // requirement went unmet rather than an index that does not exist.
    if (pointers.length === 0) {
      pushFinding(findings, seen, {
        pointer: pattern,
        grounded: false,
        value: undefined,
        provenance: null,
        failure: "MISSING_VALUE",
        note: "no value at this location in the extracted document",
      });
      continue;
    }

    for (const pointer of pointers) {
      // Two patterns can name the same field; it is one clause either way.
      if (seen.has(pointer)) continue;
      pushFinding(
        findings,
        seen,
        evaluate(pointer, output.data, allProvenance, accepted, threshold, onMissingConfidence),
      );
    }
  }

  const grounded = findings.filter((f) => f.grounded).map((f) => f.pointer);
  const ungrounded = findings.filter((f) => !f.grounded).map((f) => f.pointer);

  const provenance: Record<string, Provenance> = {};
  for (const finding of findings) {
    if (finding.provenance !== null) provenance[finding.pointer] = finding.provenance;
  }

  return { grounded, ungrounded, provenance, allProvenance, findings };
}

function pushFinding(
  findings: GroundingFinding[],
  seen: Set<string>,
  finding: GroundingFinding,
): void {
  if (seen.has(finding.pointer)) return;
  seen.add(finding.pointer);
  findings.push(finding);
}

function evaluate(
  pointer: string,
  data: unknown,
  allProvenance: Record<string, Provenance>,
  accepted: Set<MatchKind>,
  threshold: number | null,
  onMissingConfidence: "accept" | "reject",
): GroundingFinding {
  const value = resolvePointer(data, pointer);
  const provenance = allProvenance[pointer] ?? null;

  if (!hasValue(value)) {
    return {
      pointer,
      grounded: false,
      value,
      provenance,
      failure: "MISSING_VALUE",
      note: "no value at this location in the extracted document",
    };
  }

  if (provenance === null) {
    return {
      pointer,
      grounded: false,
      value,
      provenance: null,
      failure: "NO_CITATION",
      // A value with no citation is a value the extractor produced without
      // showing where it came from, which is exactly what the gate exists to
      // catch — it cannot be pointed at in the document the human signed.
      note: "value has no citation, so it cannot be traced to the signed document",
    };
  }

  if (!accepted.has(provenance.match)) {
    return {
      pointer,
      grounded: false,
      value,
      provenance,
      failure: "UNGROUNDED_MATCH",
      note: `match is \`${provenance.match}\`, which does not identify a block in the document`,
    };
  }

  if (provenance.confidence === null) {
    if (onMissingConfidence === "reject") {
      return {
        pointer,
        grounded: false,
        value,
        provenance,
        failure: "NO_CONFIDENCE",
        note: `match is \`${provenance.match}\` but ${describeConfidence(null)}`,
      };
    }
    return {
      pointer,
      grounded: true,
      value,
      provenance,
      failure: null,
      note: `grounded by \`${provenance.match}\`; ${describeConfidence(null)}`,
    };
  }

  if (threshold !== null && provenance.confidence < threshold) {
    return {
      pointer,
      grounded: false,
      value,
      provenance,
      failure: "BELOW_THRESHOLD",
      note: `${describeConfidence(provenance.confidence)} is below the calibrated threshold ${threshold}`,
    };
  }

  return {
    pointer,
    grounded: true,
    value,
    provenance,
    failure: null,
    note: `grounded by \`${provenance.match}\`; ${describeConfidence(provenance.confidence)}`,
  };
}

/**
 * The two fields `EnforceablePolicy` needs from a grounding run. Typed against
 * the core interface so a drift between this gate and the policy shape is a
 * compile error rather than a runtime surprise.
 */
export function toPolicyFields(
  report: GroundingReport,
): Pick<EnforceablePolicy, "provenance" | "ungrounded"> {
  return { provenance: report.provenance, ungrounded: report.ungrounded };
}

/** True when no required clause failed. A single ungrounded pointer denies the act it gates. */
export function isFullyGrounded(report: GroundingReport): boolean {
  return report.ungrounded.length === 0;
}

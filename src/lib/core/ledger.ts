/**
 * The decision ledger.
 *
 * Every verdict and every executed act is appended to a hash chain. The point
 * is not that the chain is tamper-proof — anyone holding the database can
 * rewrite it end to end — but that it is tamper-*evident* against a witness:
 * publish the head hash anywhere durable and no earlier entry can be altered,
 * removed or reordered without the recomputed head diverging from it.
 *
 * The chain covers denials as well as approvals, deliberately. An audit trail
 * that only records what happened cannot answer the question a regulator
 * actually asks, which is what was attempted and refused.
 */

import { digest } from "./canonical";
import type { ActRequest, Decision } from "./types";

export type LedgerEntryKind =
  | "writ.issued"
  | "writ.anchored"
  | "writ.revoked"
  | "act.requested"
  | "act.decided"
  | "act.executed"
  | "act.failed";

export interface LedgerEntryInput {
  kind: LedgerEntryKind;
  at: string;
  /** Free-form payload; whatever it is, it is hashed canonically. */
  payload: unknown;
}

export interface LedgerEntry extends LedgerEntryInput {
  sequence: number;
  previousHash: string;
  hash: string;
}

/** The hash a chain of length zero links back to. */
export const GENESIS_HASH = "0".repeat(64);

export function appendEntry(
  previous: LedgerEntry | null,
  input: LedgerEntryInput,
): LedgerEntry {
  const previousHash = previous?.hash ?? GENESIS_HASH;
  const sequence = previous ? previous.sequence + 1 : 0;

  // The sequence number is inside the hash, so an entry cannot be silently
  // moved to a different position in the chain.
  const hash = digest({
    sequence,
    previousHash,
    kind: input.kind,
    at: input.at,
    payload: input.payload,
  });

  return { ...input, sequence, previousHash, hash };
}

export interface ChainDefect {
  sequence: number;
  problem: "sequence-gap" | "broken-link" | "hash-mismatch";
  detail: string;
}

/**
 * Recompute the whole chain. Returns every defect rather than the first, so a
 * reviewer sees the extent of the damage instead of one symptom of it.
 */
export function verifyChain(entries: readonly LedgerEntry[]): ChainDefect[] {
  const defects: ChainDefect[] = [];
  let previous: LedgerEntry | null = null;

  for (const entry of entries) {
    const expectedSequence = previous ? previous.sequence + 1 : 0;
    if (entry.sequence !== expectedSequence) {
      defects.push({
        sequence: entry.sequence,
        problem: "sequence-gap",
        detail: `expected sequence ${expectedSequence}`,
      });
    }

    const expectedPrevious = previous?.hash ?? GENESIS_HASH;
    if (entry.previousHash !== expectedPrevious) {
      defects.push({
        sequence: entry.sequence,
        problem: "broken-link",
        detail: `previousHash should be ${expectedPrevious}`,
      });
    }

    const recomputed = digest({
      sequence: entry.sequence,
      previousHash: entry.previousHash,
      kind: entry.kind,
      at: entry.at,
      payload: entry.payload,
    });
    if (recomputed !== entry.hash) {
      defects.push({
        sequence: entry.sequence,
        problem: "hash-mismatch",
        detail: "the entry's contents do not produce its recorded hash",
      });
    }

    previous = entry;
  }

  return defects;
}

export function headHash(entries: readonly LedgerEntry[]): string {
  return entries.length === 0 ? GENESIS_HASH : entries[entries.length - 1].hash;
}

/* ------------------------------------------------------------------ helpers */

export function decisionEntry(decision: Decision, request: ActRequest): LedgerEntryInput {
  return {
    kind: "act.decided",
    at: decision.evaluatedAt,
    payload: {
      outcome: decision.outcome,
      writId: decision.writId,
      documentHash: decision.documentHash,
      // Codes and clause references, not prose: the message wording is allowed
      // to improve over time without invalidating historical hashes.
      reasons: decision.reasons.map((reason) => ({
        code: reason.code,
        clauseRef: reason.clauseRef ?? null,
      })),
      request: { kind: request.kind, fields: request.fields },
    },
  };
}

/**
 * The decision engine.
 *
 * Everything here is a pure function of its input. No network, no clock, no
 * database — `now` and every piece of evidence are passed in. That is what lets
 * a third party re-derive any verdict offline from the published evidence
 * bundle and get the same answer, and it is what makes the whole thing testable
 * without a single credential.
 *
 * Two properties matter more than anything else in this file:
 *
 *   1. It fails closed. Every unknown is a denial. There is no code path where
 *      missing evidence, an unparseable record, an absent confidence score or a
 *      timed-out diligence check produces an ALLOW.
 *
 *   2. It decides at act time, not at issuance. DIF calls the alternative
 *      "governance TOCTOU" — authority checked when the grant was made is not
 *      the authority present when the act runs. So the caller re-resolves DNS,
 *      re-hashes the document and re-runs diligence for every act, and hands
 *      all of it here fresh.
 */

import type {
  ActHistoryEntry,
  ActRequest,
  BBox,
  Decision,
  DecisionReason,
  DenyCode,
  DiligenceFinding,
  EnforceablePolicy,
  Grant,
  Limit,
  Provenance,
} from "./types";
import type { WritLookup } from "./writ-record";

export interface GateOptions {
  /**
   * Accept authority from a DNS answer that was not DNSSEC-validated.
   *
   * Off by default, because without DNSSEC an on-path resolver can strip the
   * revocation tombstone and revocation stops being reliable. It exists because
   * registrar sandboxes do not serve signed zones — but every decision made
   * under it says so in its reasons, so a relaxed verifier can never be
   * mistaken for a strict one after the fact.
   */
  allowUnauthenticatedDns?: boolean;
}

export interface GateInput {
  /** What public DNS says right now. */
  lookup: WritLookup;
  /** Whether the DNS answer carried the AD (Authenticated Data) flag. */
  dnssecAuthenticated: boolean;
  /**
   * Policy re-extracted from the signed document. Null when extraction failed
   * or was never run, which denies — we never fall back to a stored copy,
   * because the stored copy is exactly what an attacker would edit.
   */
  policy: EnforceablePolicy | null;
  /** sha256 (base64url) of the document bytes actually fetched, or null. */
  fetchedDocumentHash: string | null;
  /**
   * Result of verifying the document's cryptographic signature. Null means the
   * check could not be performed, which is treated as failure, not as absence
   * of evidence.
   */
  signatureValid: boolean | null;
  request: ActRequest;
  /** Prior executed acts under this writ, for cumulative limits. */
  history: ActHistoryEntry[];
  diligence: DiligenceFinding[];
  /** ISO-8601. Passed in so a verdict is reproducible. */
  now: string;
  options?: GateOptions;
}

export function decide(input: GateInput): Decision {
  const now = Date.parse(input.now);
  const base = {
    evaluatedAt: input.now,
    evidence: {
      actRequest: input.request,
      historyCount: input.history.length,
      diligence: input.diligence,
    },
  };

  const deny = (
    code: DenyCode,
    message: string,
    citation?: Partial<DecisionReason>,
  ): Decision => ({
    outcome: "deny",
    reasons: [{ code, message, ...citation }],
    writId: input.policy?.writ.id ?? null,
    documentHash: input.policy?.documentHash ?? null,
    ...base,
  });

  if (!Number.isFinite(now)) {
    return deny("INTERNAL_FAIL_CLOSED", `\`now\` is not a valid timestamp: ${input.now}`);
  }

  /* ---------------------------------------------------- the authority exists */

  if (input.lookup.outcome === "absent") {
    return deny(
      "NO_WRIT",
      "No writ is published in DNS for this agent, so it holds no authority to act.",
    );
  }
  if (input.lookup.outcome === "revoked") {
    return deny(
      "WRIT_REVOKED",
      "The principal published a revocation for this agent's writ. All authority under it has ended.",
    );
  }
  const record = input.lookup.record;

  if (!input.dnssecAuthenticated && input.options?.allowUnauthenticatedDns !== true) {
    return deny(
      "NO_WRIT",
      "The DNS answer was not DNSSEC-validated, so a revocation could have been stripped in transit. " +
        "Authority is reported as unverified rather than assumed valid.",
    );
  }

  /* ------------------------------------------ the document is the one signed */

  if (input.fetchedDocumentHash === null) {
    return deny(
      "DOCUMENT_HASH_MISMATCH",
      "The signed writ could not be fetched, so its contents could not be checked against DNS.",
    );
  }
  if (input.fetchedDocumentHash !== record.documentHash) {
    return deny(
      "DOCUMENT_HASH_MISMATCH",
      "The writ document does not match the hash published in DNS. It has been altered since it was signed.",
    );
  }
  if (input.signatureValid !== true) {
    return deny(
      "SIGNATURE_INVALID",
      input.signatureValid === false
        ? "The writ's cryptographic signature does not verify."
        : "The writ's signature could not be verified, which is treated as a failed check.",
    );
  }

  if (input.policy === null) {
    return deny(
      "CLAUSE_UNGROUNDED",
      "The signed writ could not be read back into enforceable terms, so nothing in it can be relied on.",
    );
  }
  const { policy } = input;

  // The hash in DNS binds the record to a document; this binds the extracted
  // terms to that same document, so a policy extracted from some other PDF can
  // never be paired with a valid record.
  if (policy.documentHash !== record.documentHash) {
    return deny(
      "DOCUMENT_HASH_MISMATCH",
      "The extracted terms came from a different document than the one DNS points at.",
    );
  }

  /* ------------------------------------------------------------- it is live */

  if (record.expiresAt * 1000 <= now) {
    return deny("WRIT_EXPIRED", "The writ published in DNS has expired.");
  }
  const effectiveFrom = Date.parse(policy.writ.effectiveFrom);
  const expiresAt = Date.parse(policy.writ.expiresAt);
  if (!Number.isFinite(effectiveFrom) || !Number.isFinite(expiresAt)) {
    return deny(
      "CLAUSE_UNGROUNDED",
      "The writ's effective and expiry dates could not be read as dates.",
    );
  }
  if (now < effectiveFrom) {
    return deny("WRIT_NOT_YET_EFFECTIVE", `This writ takes effect on ${policy.writ.effectiveFrom}.`);
  }
  if (now >= expiresAt) {
    return deny("WRIT_EXPIRED", `This writ expired on ${policy.writ.expiresAt}.`);
  }

  /* -------------------------------------------------------- the act is granted */

  const grantIndex = policy.writ.grants.findIndex((g) => g.actKind === input.request.kind);
  if (grantIndex === -1) {
    return deny(
      "ACT_NOT_GRANTED",
      `The writ grants no authority for ${input.request.kind}.`,
    );
  }
  const grant = policy.writ.grants[grantIndex];
  const grantPointer = `/grants/${grantIndex}`;
  const cite = citation(policy, grantPointer, grant.ref);

  // A clause whose terms did not ground in the signed document is treated as
  // absent, not as permissive. This is the difference between enforcing what
  // the human signed and enforcing what a model thought it read.
  const ungrounded = policy.ungrounded.filter((pointer) => pointer.startsWith(`${grantPointer}/`));
  if (ungrounded.length > 0) {
    return deny(
      "CLAUSE_UNGROUNDED",
      `Clause ${grant.ref} could not be read reliably from the signed document ` +
        `(${ungrounded.length} term${ungrounded.length === 1 ? "" : "s"} did not ground), ` +
        "so it grants nothing.",
      cite,
    );
  }

  /* -------------------------------------------------------------- conditions */

  for (const condition of grant.conditions) {
    if (condition.type === "jurisdiction") {
      if (!condition.allowed.includes(policy.writ.jurisdiction)) {
        return deny(
          "OUT_OF_JURISDICTION",
          `Clause ${grant.ref} applies only in ${condition.allowed.join(", ")}, ` +
            `and this writ is governed by ${policy.writ.jurisdiction}.`,
          cite,
        );
      }
      continue;
    }

    if (condition.type === "escalation") {
      const amount = input.request.amountMinorUnits ?? 0;
      if (amount > condition.aboveMinorUnits) {
        return deny(
          "ESCALATION_REQUIRED",
          `Clause ${grant.ref} requires a fresh human decision above ` +
            `${formatAmount(condition.aboveMinorUnits, condition.currency)}; this act is ` +
            `${formatAmount(amount, input.request.currency ?? condition.currency)}.`,
          cite,
        );
      }
      continue;
    }

    const finding = input.diligence.find((f) => f.check === condition.check);
    if (finding === undefined || finding.verdict === "unknown") {
      return deny(
        "DILIGENCE_UNKNOWN",
        `Clause ${grant.ref} requires the ${humanCheck(condition.check)} check, and it could not ` +
          "be completed. An unfinished check is not a passed check.",
        cite,
      );
    }
    if (finding.verdict === "flagged") {
      return deny(
        "DILIGENCE_FLAGGED",
        `${humanCheck(condition.check)}: ${finding.summary}`,
        cite,
      );
    }
  }

  /* ------------------------------------------------------------------ limits */

  for (const limit of grant.limits) {
    const failure = checkLimit(limit, input, grant, now);
    if (failure) return deny(failure.code, failure.message, cite);
  }

  return {
    outcome: "allow",
    reasons: [
      {
        code: "GRANTED",
        message: `Clause ${grant.ref} of the signed writ permits ${input.request.kind}.`,
        ...cite,
      },
      ...(input.dnssecAuthenticated
        ? []
        : [
            {
              code: "GRANTED" as const,
              message:
                "Authority was accepted from an unauthenticated DNS answer because the verifier " +
                "was configured to allow it. A strict verifier would have denied this.",
            },
          ]),
    ],
    writId: policy.writ.id,
    documentHash: policy.documentHash,
    ...base,
  };
}

/* -------------------------------------------------------------------------- */

interface LimitFailure {
  code: DenyCode;
  message: string;
}

function checkLimit(
  limit: Limit,
  input: GateInput,
  grant: Grant,
  now: number,
): LimitFailure | null {
  switch (limit.type) {
    case "allowlist": {
      const value = input.request.fields[limit.field];
      if (value === undefined || !limit.values.includes(String(value))) {
        return {
          code: "VALUE_NOT_ALLOWLISTED",
          message:
            `Clause ${grant.ref} permits ${limit.field} of ` +
            `${limit.values.join(", ")}; this act requested ${describe(value)}.`,
        };
      }
      return null;
    }

    case "pattern": {
      const value = input.request.fields[limit.field];
      if (value === undefined) {
        return {
          code: "VALUE_PATTERN_MISMATCH",
          message: `Clause ${grant.ref} constrains ${limit.field}, which this act did not supply.`,
        };
      }
      // A malformed pattern in the writ must not become a silent allow.
      let expression: RegExp;
      try {
        expression = new RegExp(limit.pattern);
      } catch {
        return {
          code: "CLAUSE_UNGROUNDED",
          message: `Clause ${grant.ref} carries a constraint on ${limit.field} that cannot be interpreted.`,
        };
      }
      if (!expression.test(String(value))) {
        return {
          code: "VALUE_PATTERN_MISMATCH",
          message:
            `Clause ${grant.ref} requires ${limit.field} to match ${limit.pattern}; ` +
            `this act requested ${describe(value)}.`,
        };
      }
      return null;
    }

    case "count": {
      const used = withinWindow(input.history, grant, limit.window, now).length;
      if (used + 1 > limit.max) {
        return {
          code: "COUNT_LIMIT_EXCEEDED",
          message:
            `Clause ${grant.ref} permits ${limit.max} ${plural(limit.max, "act")} ` +
            `${windowPhrase(limit.window)}, and ${used} ${used === 1 ? "has" : "have"} already been used.`,
        };
      }
      return null;
    }

    case "amount": {
      const prior = withinWindow(input.history, grant, limit.window, now)
        .filter((entry) => entry.currency === limit.currency)
        .reduce((sum, entry) => sum + entry.amountMinorUnits, 0);
      const amount = input.request.amountMinorUnits ?? 0;

      // A priced act in another currency cannot be compared against this cap,
      // and guessing a conversion rate would be inventing evidence.
      if (amount > 0 && input.request.currency !== undefined && input.request.currency !== limit.currency) {
        return {
          code: "AMOUNT_LIMIT_EXCEEDED",
          message:
            `Clause ${grant.ref} caps spend in ${limit.currency}, and this act is priced in ` +
            `${input.request.currency}. The two cannot be compared without inventing a rate.`,
        };
      }
      if (prior + amount > limit.maxMinorUnits) {
        return {
          code: "AMOUNT_LIMIT_EXCEEDED",
          message:
            `Clause ${grant.ref} caps spend at ${formatAmount(limit.maxMinorUnits, limit.currency)} ` +
            `${windowPhrase(limit.window)}. ${formatAmount(prior, limit.currency)} is already committed, ` +
            `and this act would add ${formatAmount(amount, limit.currency)}.`,
        };
      }
      return null;
    }
  }
}

function withinWindow(
  history: readonly ActHistoryEntry[],
  grant: Grant,
  window: "total" | "day" | "month",
  now: number,
): ActHistoryEntry[] {
  const relevant = history.filter(
    (entry) => entry.kind === grant.actKind && entry.grantRef === grant.ref,
  );
  if (window === "total") return relevant;

  const span = window === "day" ? 86_400_000 : 30 * 86_400_000;
  const since = now - span;
  return relevant.filter((entry) => {
    const at = Date.parse(entry.executedAt);
    // An entry with an unreadable timestamp counts against the cap rather than
    // escaping it — the conservative reading of ambiguous history.
    return !Number.isFinite(at) || at >= since;
  });
}

function citation(
  policy: EnforceablePolicy,
  grantPointer: string,
  clauseRef: string,
): Partial<DecisionReason> {
  const provenance = findProvenance(policy, grantPointer);
  return {
    clauseRef,
    ...(provenance?.pageNumber != null ? { pageNumber: provenance.pageNumber } : {}),
    ...(provenance?.bbox != null ? { bbox: provenance.bbox as BBox } : {}),
  };
}

/**
 * Point at the clause in the PDF. The extractor cites individual fields rather
 * than clauses, so take the grant's own citation when it has one and otherwise
 * borrow the first cited field beneath it — anywhere on the right clause beats
 * no page reference at all.
 */
function findProvenance(policy: EnforceablePolicy, grantPointer: string): Provenance | undefined {
  const exact = policy.provenance[grantPointer];
  if (exact) return exact;
  for (const [pointer, provenance] of Object.entries(policy.provenance)) {
    if (pointer.startsWith(`${grantPointer}/`) && provenance.pageNumber != null) {
      return provenance;
    }
  }
  return undefined;
}

function formatAmount(minorUnits: number, currency: string): string {
  return `${(minorUnits / 100).toFixed(2)} ${currency}`;
}

function windowPhrase(window: "total" | "day" | "month"): string {
  return window === "total" ? "in total" : window === "day" ? "per day" : "per month";
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function describe(value: string | number | boolean | undefined): string {
  return value === undefined ? "nothing" : `"${String(value)}"`;
}

function humanCheck(check: string): string {
  return check.replace(/_/g, " ");
}

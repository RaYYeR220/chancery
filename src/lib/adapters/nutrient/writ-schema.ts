/**
 * The extraction schema that pulls a `Writ` back out of the signed PDF.
 *
 * This is what makes the enforced policy provably the policy the human read:
 * the signed document is re-parsed, and only the fields that ground in it
 * become enforceable. So the schema has to be complete enough to carry a writ
 * and small enough to afford.
 *
 * Two constraints shape it.
 *
 * Budget: `understand` mode costs 15 credits per page for `/extraction/extract`
 * against a 50-credit free plan, which is three pages total. The writ is a
 * one-page instrument and this schema is sized for one page.
 *
 * Depth: Nutrient documents a 5-level nesting cap without saying how a level is
 * counted, so `validateExtractionSchema` counts every schema node — an array
 * and its `items` are two. Under that strictest reading, nesting limits and
 * conditions inside each grant would put their scalar fields at level 6. They
 * are therefore hoisted to the root and linked back by `grantRef`, the clause
 * reference as printed. That is also how the document itself reads ("clause
 * 3(a) is limited to five registrations per month"), and a flatter schema
 * extracts more reliably than a deeply nested one.
 *
 * The enums are derived from `core/types` where an array exists, and mirrored
 * through an exhaustive `Record` where one does not, so adding an `ActKind` or
 * a `DiligenceCheck` without teaching the extractor about it is a type error.
 */

import {
  ACT_KINDS,
  type ActKind,
  type Condition,
  type CountLimit,
  type DiligenceCheck,
  type Limit,
} from "../../core/types";
import type { ExtractionSchema, ObjectExtractionSchema } from "./extraction";

function keysOf<T extends string>(record: Record<T, true>): T[] {
  return Object.keys(record) as T[];
}

const LIMIT_TYPES: Record<Limit["type"], true> = {
  count: true,
  amount: true,
  allowlist: true,
  pattern: true,
};

const LIMIT_WINDOWS: Record<CountLimit["window"], true> = {
  total: true,
  day: true,
  month: true,
};

const CONDITION_TYPES: Record<Condition["type"], true> = {
  diligence: true,
  jurisdiction: true,
  escalation: true,
};

const DILIGENCE_CHECKS: Record<DiligenceCheck, true> = {
  trademark_clear: true,
  no_brand_collision: true,
  counterparty_exists: true,
  no_adverse_media: true,
  no_patent_litigation: true,
};

export const WRIT_ACT_KINDS: readonly ActKind[] = ACT_KINDS;

/**
 * Multi-value fields arrive as one delimited string rather than an array,
 * because an array of strings under `limits[]` would cross the nesting cap.
 * Splitting is deliberately strict about blanks so `"com,,"` cannot smuggle an
 * empty entry into an allowlist check.
 */
export const WRIT_LIST_SEPARATOR = ",";

export function splitDelimitedList(value: string | undefined | null): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(WRIT_LIST_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const str = (description: string): ExtractionSchema => ({ type: "string", description });
const int = (description: string): ExtractionSchema => ({ type: "integer", description });

const GRANT_REF = str("Clause reference this applies to, exactly as printed, e.g. 3(b).");

export const WRIT_EXTRACTION_SCHEMA: ObjectExtractionSchema = {
  type: "object",
  properties: {
    principal: {
      type: "object",
      description: "The human granting authority.",
      properties: {
        legalName: str("Full legal name of the principal."),
        email: str("Principal's email address."),
      },
      required: ["legalName"],
    },
    agent: {
      type: "object",
      description: "The AI agent the authority is granted to.",
      properties: {
        label: str("Human-readable name of the agent."),
        domain: str("DNS name the writ is anchored under, e.g. ops.example.com."),
        publicKey: str("Agent's base64url ed25519 public key."),
      },
      required: ["domain", "publicKey"],
    },
    grants: {
      type: "array",
      description: "One entry per numbered clause permitting an irreversible act.",
      items: {
        type: "object",
        properties: {
          ref: str("Clause reference exactly as printed, e.g. 3(b)."),
          actKind: {
            type: "string",
            description: "Which irreversible act the clause permits.",
            enum: [...WRIT_ACT_KINDS],
          },
        },
        required: ["ref", "actKind"],
      },
    },
    limits: {
      type: "array",
      description: "Caps placed on a clause. Fill only the fields the cap's type uses.",
      items: {
        type: "object",
        properties: {
          grantRef: GRANT_REF,
          type: { type: "string", description: "Kind of cap.", enum: keysOf(LIMIT_TYPES) },
          max: int("count: how many times the act may be performed."),
          window: {
            type: "string",
            description: "count/amount: period the cap resets over.",
            enum: keysOf(LIMIT_WINDOWS),
          },
          maxMinorUnits: int("amount: cap in minor units, e.g. cents."),
          currency: str("amount: ISO 4217 code."),
          field: str("allowlist/pattern: the request field constrained."),
          values: str(`allowlist: permitted values, separated by "${WRIT_LIST_SEPARATOR}".`),
          pattern: str("pattern: the regular expression the field must match."),
        },
        required: ["grantRef", "type"],
      },
    },
    conditions: {
      type: "array",
      description: "Checks against the live world a clause requires.",
      items: {
        type: "object",
        properties: {
          grantRef: GRANT_REF,
          type: { type: "string", description: "Kind of condition.", enum: keysOf(CONDITION_TYPES) },
          check: {
            type: "string",
            description: "diligence: which check must come back clear.",
            enum: keysOf(DILIGENCE_CHECKS),
          },
          jurisdictions: str(
            `jurisdiction: permitted codes, separated by "${WRIT_LIST_SEPARATOR}".`,
          ),
          aboveMinorUnits: int("escalation: value above which a human must decide again."),
          currency: str("escalation: ISO 4217 code."),
        },
        required: ["grantRef", "type"],
      },
    },
    effectiveFrom: { type: "string", format: "date", description: "Date the writ takes effect." },
    expiresAt: { type: "string", format: "date", description: "Date the writ expires." },
    jurisdiction: str("Governing jurisdiction of the writ."),
  },
  required: ["principal", "agent", "grants", "effectiveFrom", "expiresAt", "jurisdiction"],
};

/** Passed alongside the schema; short, because it is billed with the page. */
export const WRIT_EXTRACTION_INSTRUCTIONS =
  "This is a signed writ delegating authority to an AI agent. Extract one grant " +
  "per numbered clause permitting an irreversible act, and list its caps and " +
  "conditions separately, each tagged with that clause reference exactly as " +
  "printed. Leave a field out rather than inferring it.";

/* ------------------------------------------------------------- the mirror */

/** The TypeScript shape of `output.data` for `WRIT_EXTRACTION_SCHEMA`. */
export interface WritExtractionLimit {
  grantRef?: string;
  type?: Limit["type"];
  max?: number;
  window?: CountLimit["window"];
  maxMinorUnits?: number;
  currency?: string;
  field?: string;
  values?: string;
  pattern?: string;
}

export interface WritExtractionCondition {
  grantRef?: string;
  type?: Condition["type"];
  check?: DiligenceCheck;
  jurisdictions?: string;
  aboveMinorUnits?: number;
  currency?: string;
}

export interface WritExtractionGrant {
  ref?: string;
  actKind?: ActKind;
}

export interface WritExtraction {
  principal?: { legalName?: string; email?: string };
  agent?: { label?: string; domain?: string; publicKey?: string };
  grants?: WritExtractionGrant[];
  limits?: WritExtractionLimit[];
  conditions?: WritExtractionCondition[];
  effectiveFrom?: string;
  expiresAt?: string;
  jurisdiction?: string;
}

/** Re-attaches a hoisted row to its clause. An unmatched `grantRef` binds to nothing. */
export function limitsForGrant(data: WritExtraction, ref: string): WritExtractionLimit[] {
  return (data.limits ?? []).filter((limit) => limit.grantRef === ref);
}

export function conditionsForGrant(
  data: WritExtraction,
  ref: string,
): WritExtractionCondition[] {
  return (data.conditions ?? []).filter((condition) => condition.grantRef === ref);
}

/* ------------------------------------------------------- required pointers */

/**
 * The fields whose location is known before the document is read. `-` expands
 * over array indices in `groundExtraction`.
 *
 * `principal.email` and `agent.label` are absent on purpose: neither gates an
 * act, and requiring a field the gate does not need only manufactures denials.
 */
export const WRIT_CORE_POINTERS: readonly string[] = [
  "/principal/legalName",
  "/agent/domain",
  "/agent/publicKey",
  "/grants/-/ref",
  "/grants/-/actKind",
  "/effectiveFrom",
  "/expiresAt",
  "/jurisdiction",
];

const LIMIT_VALUE_FIELDS: Record<Limit["type"], readonly string[]> = {
  count: ["max", "window"],
  amount: ["maxMinorUnits", "currency", "window"],
  allowlist: ["field", "values"],
  pattern: ["field", "pattern"],
};

const CONDITION_VALUE_FIELDS: Record<Condition["type"], readonly string[]> = {
  diligence: ["check"],
  jurisdiction: ["jurisdictions"],
  escalation: ["aboveMinorUnits", "currency"],
};

/**
 * Which fields of a limit or condition matter depends on its own `type`, so the
 * requirement set cannot be static — it is derived from what the extractor
 * actually returned. A `count` limit whose `max` did not ground is a cap nobody
 * can enforce, and treating it as merely incomplete would silently widen the
 * grant to unlimited.
 *
 * `grantRef` is always required: a cap that did not ground to a clause is a cap
 * that cannot be attached to one.
 */
export function writRequiredPointers(data: unknown): string[] {
  const pointers = [...WRIT_CORE_POINTERS];
  const writ = (data ?? {}) as WritExtraction;

  collect(pointers, "/limits", writ.limits, LIMIT_VALUE_FIELDS);
  collect(pointers, "/conditions", writ.conditions, CONDITION_VALUE_FIELDS);

  return pointers;
}

function collect<K extends string>(
  pointers: string[],
  base: string,
  rows: { type?: K }[] | undefined,
  table: Record<K, readonly string[]>,
): void {
  if (!Array.isArray(rows)) return;
  rows.forEach((row, index) => {
    pointers.push(`${base}/${index}/grantRef`, `${base}/${index}/type`);
    for (const field of fieldsFor(table, row?.type)) {
      pointers.push(`${base}/${index}/${field}`);
    }
  });
}

function fieldsFor<K extends string>(
  table: Record<K, readonly string[]>,
  key: K | undefined,
): readonly string[] {
  // An unrecognised discriminator has no fields to require; the `.../type`
  // pointer is already required and will fail the gate on its own.
  // `hasOwnProperty`, not `in`: the value comes from a model response, and
  // `"constructor" in table` would otherwise be true.
  if (key === undefined || !Object.prototype.hasOwnProperty.call(table, key)) return [];
  return table[key];
}

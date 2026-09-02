/**
 * Nutrient Data Extraction client — the path that turns a signed writ back into
 * machine-readable policy.
 *
 * Three things here are easy to get wrong and expensive to get wrong:
 *
 *  1. In multipart, `schema` / `parseConfig` / `options` must be NESTED inside
 *     the outer form field literally named `instructions`. Sending them as
 *     sibling form fields fails. Only the JSON+URL variant puts them top-level.
 *
 *  2. `output.metadata` structurally mirrors `output.data`, INCLUDING through
 *     arrays: the citation for `data.grants[0].cap` lives at
 *     `metadata.grants[0].cap`. Walking that mirror in lockstep is the only way
 *     to key provenance by the same JSON pointer the policy uses.
 *
 *  3. The schema dialect is a small subset of JSON Schema. `$ref`, the `*Of`
 *     combinators, numeric ranges and `additionalProperties` are all rejected
 *     server-side, so we reject them here where the error names the exact
 *     pointer instead of costing a round trip.
 */

import type { BBox, MatchKind, Provenance } from "../../core/types";
import {
  appendFile,
  asRecord,
  EMPTY_META,
  isMatchKind,
  joinPointer,
  NutrientError,
  nutrientRequest,
  type FileInput,
  type NutrientClientConfig,
  type NutrientResult,
} from "./http";

/* ------------------------------------------------------------------ schema */

export type ExtractionSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean";

/**
 * The supported keyword set, and nothing else. Anything absent from this
 * interface is absent because the API rejects it.
 */
export interface ExtractionSchema {
  type: ExtractionSchemaType;
  properties?: Record<string, ExtractionSchema>;
  required?: string[];
  items?: ExtractionSchema;
  description?: string;
  /** Strings only. */
  enum?: string[];
  /** The only permitted format value. */
  format?: "date";
}

export interface ObjectExtractionSchema extends ExtractionSchema {
  type: "object";
  properties: Record<string, ExtractionSchema>;
}

/** Documented hard limits. Exceeding any of them is a 400, not a truncation. */
export const SCHEMA_LIMITS = {
  bytes: 32 * 1024,
  fields: 500,
  propertiesPerObject: 50,
  nestingLevels: 5,
  enumValues: 50,
  enumValueChars: 256,
  propertyNameChars: 128,
  descriptionChars: 1024,
} as const;

const ALLOWED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "description",
  "enum",
  "format",
]);

const ALLOWED_TYPES = new Set<string>([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
]);

export type SchemaIssueCode =
  | "ROOT_NOT_OBJECT"
  | "UNSUPPORTED_KEYWORD"
  | "BAD_TYPE"
  | "MISSING_ITEMS"
  | "MISSING_PROPERTIES"
  | "BAD_ENUM"
  | "BAD_FORMAT"
  | "REQUIRED_NOT_DECLARED"
  | "LIMIT_EXCEEDED";

export interface SchemaIssue {
  /** JSON pointer into the schema itself, so the message points at the offender. */
  pointer: string;
  code: SchemaIssueCode;
  message: string;
}

export class ExtractionSchemaError extends NutrientError {
  constructor(readonly issues: SchemaIssue[]) {
    super(
      `invalid extraction schema: ${issues.map((i) => `${i.pointer} ${i.message}`).join("; ")}`,
      EMPTY_META,
    );
    this.name = "ExtractionSchemaError";
  }
}

/**
 * Returns every violation rather than throwing on the first, because a schema
 * is usually authored in one go and a single round of fixes beats five.
 */
export function validateExtractionSchema(schema: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const root = asRecord(schema);

  if (root === null || root.type !== "object") {
    return [
      {
        pointer: "",
        code: "ROOT_NOT_OBJECT",
        message: 'root schema must be `type: "object"` — an array root is a 400',
      },
    ];
  }

  const counters = { fields: 0 };
  walkSchema(root, "", 1, issues, counters);

  if (counters.fields > SCHEMA_LIMITS.fields) {
    issues.push({
      pointer: "",
      code: "LIMIT_EXCEEDED",
      message: `${counters.fields} fields exceeds the ${SCHEMA_LIMITS.fields}-field limit`,
    });
  }

  const bytes = new TextEncoder().encode(JSON.stringify(schema)).length;
  if (bytes > SCHEMA_LIMITS.bytes) {
    issues.push({
      pointer: "",
      code: "LIMIT_EXCEEDED",
      message: `serialised schema is ${bytes} bytes, over the ${SCHEMA_LIMITS.bytes}-byte limit`,
    });
  }

  return issues;
}

/**
 * `depth` counts every schema node, root included, so an array and its `items`
 * are two levels. Nutrient documents "5 nesting levels" without saying how a
 * level is counted; this is the strictest reading, which means a schema that
 * passes here cannot be rejected by a looser server-side rule.
 */
function walkSchema(
  node: Record<string, unknown>,
  pointer: string,
  depth: number,
  issues: SchemaIssue[],
  counters: { fields: number },
): void {
  if (depth > SCHEMA_LIMITS.nestingLevels) {
    issues.push({
      pointer,
      code: "LIMIT_EXCEEDED",
      message: `nesting depth ${depth} exceeds the ${SCHEMA_LIMITS.nestingLevels}-level limit`,
    });
    return;
  }

  for (const keyword of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(keyword)) {
      issues.push({
        pointer: joinPointer(pointer, keyword),
        code: "UNSUPPORTED_KEYWORD",
        message: `\`${keyword}\` is not supported by Nutrient's schema dialect`,
      });
    }
  }

  const type = node.type;
  if (typeof type !== "string" || !ALLOWED_TYPES.has(type)) {
    issues.push({
      pointer: joinPointer(pointer, "type"),
      code: "BAD_TYPE",
      message: `type must be one of ${[...ALLOWED_TYPES].join("|")}, got ${JSON.stringify(type)}`,
    });
  }

  if (node.description !== undefined) {
    const description = node.description;
    if (typeof description !== "string" || description.length > SCHEMA_LIMITS.descriptionChars) {
      issues.push({
        pointer: joinPointer(pointer, "description"),
        code: "LIMIT_EXCEEDED",
        message: `description must be a string of at most ${SCHEMA_LIMITS.descriptionChars} characters`,
      });
    }
  }

  if (node.enum !== undefined) validateEnum(node.enum, type, pointer, issues);
  if (node.format !== undefined && (node.format !== "date" || type !== "string")) {
    issues.push({
      pointer: joinPointer(pointer, "format"),
      code: "BAD_FORMAT",
      message: '`format` is only supported as "date" on a string',
    });
  }

  if (type === "object") {
    const properties = asRecord(node.properties);
    if (properties === null) {
      issues.push({
        pointer: joinPointer(pointer, "properties"),
        code: "MISSING_PROPERTIES",
        message: "an object schema must declare `properties` — schemas are implicitly closed",
      });
      return;
    }

    const names = Object.keys(properties);
    counters.fields += names.length;
    if (names.length > SCHEMA_LIMITS.propertiesPerObject) {
      issues.push({
        pointer: joinPointer(pointer, "properties"),
        code: "LIMIT_EXCEEDED",
        message: `${names.length} properties exceeds the ${SCHEMA_LIMITS.propertiesPerObject}-per-object limit`,
      });
    }

    validateRequired(node.required, names, pointer, issues);

    for (const name of names) {
      const childPointer = joinPointer(joinPointer(pointer, "properties"), name);
      if (name.length > SCHEMA_LIMITS.propertyNameChars) {
        issues.push({
          pointer: childPointer,
          code: "LIMIT_EXCEEDED",
          message: `property name is ${name.length} characters, over the ${SCHEMA_LIMITS.propertyNameChars} limit`,
        });
      }
      const child = asRecord(properties[name]);
      if (child === null) {
        issues.push({ pointer: childPointer, code: "BAD_TYPE", message: "property schema must be an object" });
        continue;
      }
      walkSchema(child, childPointer, depth + 1, issues, counters);
    }
    return;
  }

  if (type === "array") {
    const items = asRecord(node.items);
    if (items === null) {
      issues.push({
        pointer: joinPointer(pointer, "items"),
        code: "MISSING_ITEMS",
        message: "an array schema must declare `items`",
      });
      return;
    }
    walkSchema(items, joinPointer(pointer, "items"), depth + 1, issues, counters);
  }
}

function validateEnum(
  value: unknown,
  type: unknown,
  pointer: string,
  issues: SchemaIssue[],
): void {
  const enumPointer = joinPointer(pointer, "enum");
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ pointer: enumPointer, code: "BAD_ENUM", message: "enum must be a non-empty array" });
    return;
  }
  if (type !== "string") {
    issues.push({ pointer: enumPointer, code: "BAD_ENUM", message: "enum is only supported on strings" });
  }
  if (value.length > SCHEMA_LIMITS.enumValues) {
    issues.push({
      pointer: enumPointer,
      code: "LIMIT_EXCEEDED",
      message: `${value.length} enum values exceeds the ${SCHEMA_LIMITS.enumValues} limit`,
    });
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      issues.push({
        pointer: joinPointer(enumPointer, index),
        code: "BAD_ENUM",
        message: "enum values must be strings",
      });
    } else if (entry.length > SCHEMA_LIMITS.enumValueChars) {
      issues.push({
        pointer: joinPointer(enumPointer, index),
        code: "LIMIT_EXCEEDED",
        message: `enum value is ${entry.length} characters, over the ${SCHEMA_LIMITS.enumValueChars} limit`,
      });
    }
  });
}

function validateRequired(
  required: unknown,
  names: string[],
  pointer: string,
  issues: SchemaIssue[],
): void {
  if (required === undefined) return;
  const requiredPointer = joinPointer(pointer, "required");
  if (!Array.isArray(required)) {
    issues.push({ pointer: requiredPointer, code: "BAD_TYPE", message: "required must be an array" });
    return;
  }
  required.forEach((name, index) => {
    // A closed schema cannot satisfy a required name it never declares, so this
    // is always a typo rather than an intentional open extension point.
    if (typeof name !== "string" || !names.includes(name)) {
      issues.push({
        pointer: joinPointer(requiredPointer, index),
        code: "REQUIRED_NOT_DECLARED",
        message: `required lists ${JSON.stringify(name)}, which is not in properties`,
      });
    }
  });
}

export function assertExtractionSchema(schema: unknown): asserts schema is ObjectExtractionSchema {
  const issues = validateExtractionSchema(schema);
  if (issues.length > 0) throw new ExtractionSchemaError(issues);
}

/* --------------------------------------------------------------- responses */

export type ExtractionMode = "text" | "structure" | "understand" | "agentic";

/**
 * Credits per page. `extract` is the parse cost plus 6, so `understand` — the
 * default and the only mode the docs endorse for key-value work — costs 15 per
 * page. On a 50-credit free plan that is three pages, total. Keep writs short.
 */
export const EXTRACTION_PARSE_CREDITS: Record<ExtractionMode, number> = {
  text: 1,
  structure: 1.5,
  understand: 9,
  agentic: 18,
};

export const EXTRACT_SURCHARGE_CREDITS = 6;

export function extractCreditCost(mode: ExtractionMode, pages: number): number {
  return (EXTRACTION_PARSE_CREDITS[mode] + EXTRACT_SURCHARGE_CREDITS) * pages;
}

export interface ConfidenceComponents {
  probabilityScore?: number;
  marginScore?: number;
  groundingScore?: number;
  formatScore?: number;
  source?: "logprobs+margin" | "logprobs-only" | "no-logprobs";
}

export interface SourceBBox {
  bbox?: number[];
  block_id?: string;
  pageIndex?: number;
  pageNumber?: number;
}

/**
 * One field's grounding record. Every scoring field is optional on purpose:
 * `confidence` is documented as optional, and `recognitionScore` is omitted for
 * born-digital text, for `not_found`, and for VLM-only reads. Absence is not
 * a low score.
 */
export interface Citation {
  match?: MatchKind;
  /** Relative, uncalibrated, 0..1. NOT a probability — never render as a percentage. */
  confidence?: number;
  confidenceComponents?: ConfidenceComponents;
  recognitionScore?: number;
  bbox?: number[];
  pageIndex?: number;
  pageNumber?: number;
  source_bboxes?: SourceBBox[];
}

/**
 * The compile-time shape of `output.metadata` for a given `output.data`: the
 * same tree, with every leaf replaced by a `Citation`, arrays mirrored
 * element-for-element.
 */
export type CitationMirror<T> = T extends readonly (infer E)[]
  ? CitationMirror<E>[]
  : T extends object
    ? { [K in keyof T]?: CitationMirror<T[K]> }
    : Citation;

export interface ExtractedPage {
  pageIndex?: number;
  pageNumber?: number;
  /** When absent, citation coordinates are PDF points rather than page units. */
  width?: number;
  height?: number;
}

export interface ExtractionOutput<T> {
  data: T;
  metadata?: CitationMirror<T>;
  pages?: ExtractedPage[];
}

export interface ExtractionUsage {
  data_extraction_credits?: {
    used?: number;
    remainingCredits?: number;
  };
  pages?: number;
}

export interface ExtractResponse<T> {
  output: ExtractionOutput<T>;
  usage?: ExtractionUsage;
  requestId?: string;
}

export interface ParseResponse {
  output: {
    text?: string;
    pages?: ExtractedPage[];
    [key: string]: unknown;
  };
  usage?: ExtractionUsage;
}

export interface ClassifyPrediction {
  label: string;
  score: number;
}

/** Scores are independent confidences and do NOT sum to 1. */
export interface ClassifyResponse {
  output: {
    classification: {
      label: string;
      score: number;
      predictions?: ClassifyPrediction[];
    };
  };
  usage?: ExtractionUsage;
}

/* ------------------------------------------------------------- mirror walk */

const CITATION_KEYS = new Set([
  "match",
  "confidence",
  "confidenceComponents",
  "recognitionScore",
  "bbox",
  "pageIndex",
  "pageNumber",
  "source_bboxes",
]);

/**
 * A metadata node is a citation, not a nested mirror, when it is a plain object
 * whose keys are all citation keys. Testing for `match` alone is not enough —
 * a field literally named `match` in the extracted data would mirror to a node
 * whose own key set is arbitrary.
 */
export function isCitation(value: unknown): value is Citation {
  const record = asRecord(value);
  if (record === null) return false;
  const keys = Object.keys(record);
  return keys.length > 0 && keys.every((key) => CITATION_KEYS.has(key));
}

/**
 * `[x, y, width, height]` with a top-left origin, matching the rect convention
 * the Processor API documents. If a live response turns out to use
 * `[x0, y0, x1, y1]`, this function is the single place to correct it.
 */
export function bboxFromCitation(citation: Citation): BBox | null {
  const raw = citation.bbox;
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const [x, y, width, height] = raw;
  if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return { x, y, width, height };
}

/**
 * Fails closed: a citation that carries no `match` is recorded as `not_found`
 * rather than assumed good, because the grounding gate reads this field and an
 * optimistic default there would silently enforce an unread clause.
 */
export function citationToProvenance(pointer: string, citation: Citation): Provenance {
  const blockIds = (citation.source_bboxes ?? [])
    .map((source) => source.block_id)
    .filter((id): id is string => typeof id === "string");

  const pageNumber =
    typeof citation.pageNumber === "number"
      ? citation.pageNumber
      : typeof citation.pageIndex === "number"
        ? citation.pageIndex + 1
        : null;

  return {
    pointer,
    match: isMatchKind(citation.match) ? citation.match : "not_found",
    confidence: typeof citation.confidence === "number" ? citation.confidence : null,
    pageNumber,
    bbox: bboxFromCitation(citation),
    blockIds,
  };
}

/**
 * Walks `data` and `metadata` in lockstep and returns provenance keyed by the
 * JSON pointer of the field it describes — the same pointer space
 * `EnforceablePolicy.provenance` and `EnforceablePolicy.ungrounded` use.
 *
 * `data` drives the walk because it is authoritative for structure; the mirror
 * is followed positionally, including through array indices.
 */
export function collectProvenance(output: {
  data: unknown;
  metadata?: unknown;
}): Record<string, Provenance> {
  const out: Record<string, Provenance> = {};
  walkMirror(output.data, output.metadata, "", out);
  return out;
}

/**
 * Structure comes from `data`, never from the shape of the metadata node.
 * Key-set matching alone is not enough to tell a citation from a mirror: a
 * document with a field literally called `match` produces a mirror node whose
 * only key is `match`, which is indistinguishable from a citation. Since a
 * citation only ever describes a leaf, descending wherever `data` has a
 * container settles it.
 */
function walkMirror(
  data: unknown,
  meta: unknown,
  pointer: string,
  out: Record<string, Provenance>,
): void {
  if (Array.isArray(data)) {
    const metaArray = Array.isArray(meta) ? meta : [];
    data.forEach((entry, index) => {
      walkMirror(entry, metaArray[index], joinPointer(pointer, index), out);
    });
    return;
  }

  const record = asRecord(data);
  if (record !== null) {
    const metaRecord = asRecord(meta);
    for (const key of Object.keys(record)) {
      walkMirror(record[key], metaRecord?.[key], joinPointer(pointer, key), out);
    }
    return;
  }

  if (isCitation(meta)) out[pointer] = citationToProvenance(pointer, meta);
}

/* ------------------------------------------------------------------ client */

export interface ExtractInstructions<S = ExtractionSchema> {
  schema: S;
  parseConfig?: { mode?: ExtractionMode };
  options?: { includeCitations?: boolean };
  /** Free-text guidance passed alongside the schema. */
  instructions?: string;
}

export interface ExtractFileRequest<S = ExtractionSchema> extends ExtractInstructions<S> {
  file: FileInput;
  url?: never;
}

export interface ExtractUrlRequest<S = ExtractionSchema> extends ExtractInstructions<S> {
  url: string;
  file?: never;
}

export type ExtractRequest<S = ExtractionSchema> = ExtractFileRequest<S> | ExtractUrlRequest<S>;

export interface ParseRequest {
  file?: FileInput;
  url?: string;
  mode?: ExtractionMode;
}

export interface ClassifyLabel {
  label: string;
  description?: string;
}

export interface ClassifyRequest {
  file?: FileInput;
  url?: string;
  labels: ClassifyLabel[];
  topK?: number;
  textWeight?: number;
  imageWeight?: number;
}

export class ExtractionClient {
  constructor(private readonly config: NutrientClientConfig) {}

  /**
   * `structure` mode is documented as unreliable for forms and key-value work.
   * The default here is `understand` for that reason, and because `extract`
   * without citations would defeat the grounding gate, `includeCitations`
   * defaults on.
   */
  async extract<T, S = ExtractionSchema>(
    request: ExtractRequest<S>,
  ): Promise<NutrientResult<ExtractResponse<T>>> {
    // Bound to a local so the assertion signature narrows a plain reference
    // rather than a generic property of a union-typed request.
    const schema: unknown = request.schema;
    assertExtractionSchema(schema);

    const instructions = {
      schema,
      parseConfig: { mode: request.parseConfig?.mode ?? ("understand" as ExtractionMode) },
      options: { includeCitations: request.options?.includeCitations ?? true },
      ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
    };

    if (request.file !== undefined) {
      const form = new FormData();
      appendFile(form, "file", request.file);
      // Nested, not sibling form fields: separate `schema`/`parseConfig`/
      // `options` fields are silently ignored and the call fails.
      form.append("instructions", JSON.stringify(instructions));
      return nutrientRequest<ExtractResponse<T>>(this.config, {
        method: "POST",
        path: "/extraction/extract",
        body: form,
        expect: "json",
      });
    }

    if (request.url === undefined) {
      throw new NutrientError("extract requires either `file` or `url`", EMPTY_META);
    }

    // In JSON+URL mode the same keys sit top-level alongside `url`.
    return nutrientRequest<ExtractResponse<T>>(this.config, {
      method: "POST",
      path: "/extraction/extract",
      body: JSON.stringify({ url: request.url, ...instructions }),
      expect: "json",
    });
  }

  async parse(request: ParseRequest): Promise<NutrientResult<ParseResponse>> {
    const mode = request.mode ?? "understand";
    if (request.file !== undefined) {
      const form = new FormData();
      appendFile(form, "file", request.file);
      form.append("instructions", JSON.stringify({ mode }));
      return nutrientRequest<ParseResponse>(this.config, {
        method: "POST",
        path: "/extraction/parse",
        body: form,
        expect: "json",
      });
    }
    if (request.url === undefined) {
      throw new NutrientError("parse requires either `file` or `url`", EMPTY_META);
    }
    return nutrientRequest<ParseResponse>(this.config, {
      method: "POST",
      path: "/extraction/parse",
      body: JSON.stringify({ url: request.url, mode }),
      expect: "json",
    });
  }

  /**
   * UNVERIFIED request/response shape — reconstructed from a blog post, the
   * reference page 404s. Flat 1 credit per page, so it is cheap to confirm.
   */
  async classify(request: ClassifyRequest): Promise<NutrientResult<ClassifyResponse>> {
    const instructions = {
      labels: request.labels,
      ...(request.topK === undefined ? {} : { topK: request.topK }),
      ...(request.textWeight === undefined ? {} : { textWeight: request.textWeight }),
      ...(request.imageWeight === undefined ? {} : { imageWeight: request.imageWeight }),
    };

    if (request.file !== undefined) {
      const form = new FormData();
      appendFile(form, "file", request.file);
      form.append("instructions", JSON.stringify(instructions));
      return nutrientRequest<ClassifyResponse>(this.config, {
        method: "POST",
        path: "/extraction/classify",
        body: form,
        expect: "json",
      });
    }
    if (request.url === undefined) {
      throw new NutrientError("classify requires either `file` or `url`", EMPTY_META);
    }
    return nutrientRequest<ClassifyResponse>(this.config, {
      method: "POST",
      path: "/extraction/classify",
      body: JSON.stringify({ url: request.url, instructions }),
      expect: "json",
    });
  }
}

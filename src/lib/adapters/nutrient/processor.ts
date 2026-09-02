/**
 * Nutrient DWS Processor API client.
 *
 * Two things here are load-bearing for Chancery rather than merely convenient:
 *
 *  1. `Idempotency-Key` is derived, never supplied by accident. The key is a
 *     hash of the exact input bytes plus the canonical instructions JSON, so
 *     the same writ pipeline always produces the same key. Nutrient answers a
 *     reused key carrying different work with 409, which turns their replay
 *     guard into our tamper detector — see `IdempotencyConflictError`.
 *
 *  2. The documented action ordering is validated before the request leaves the
 *     process. Getting it wrong is not a 400; it is a silently different
 *     document — flattening before a form is filled loses the values, applying
 *     redactions after signing invalidates the signature. A misordered pipeline
 *     must fail here, loudly, not downstream.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import {
  appendFile,
  appendJson,
  canonicalJson,
  EMPTY_META,
  NutrientError,
  nutrientRequest,
  type FileInput,
  type NutrientClientConfig,
  type NutrientResult,
  toFileBlob,
} from "./http";

/* ------------------------------------------------------------------- parts */

/** Either a multipart field name or a remote URL Nutrient fetches itself. */
export type FileRef = string | { url: string };

/** 0-based, `end` INCLUSIVE, negatives count from the end of the document. */
export interface PageRange {
  start?: number;
  end?: number;
}

export interface FilePart {
  file: FileRef;
  password?: string;
  pages?: PageRange;
}

export interface HtmlPart {
  html: string | { url: string };
  assets?: FileRef[];
  layout?: Record<string, unknown>;
}

export interface NewPagePart {
  page: "new";
  pageCount?: number;
  layout?: Record<string, unknown>;
}

export type BuildPart = FilePart | HtmlPart | NewPagePart;

/* ----------------------------------------------------------------- actions */

/**
 * The `OcrLanguage` enum has 152 members. Naming the ones we plausibly use gives
 * autocomplete without turning an unlisted-but-valid language into a type error.
 */
export type OcrLanguage =
  | "english"
  | "german"
  | "french"
  | "spanish"
  | "italian"
  | "portuguese"
  | "dutch"
  | "polish"
  | (string & {});

export interface ApplyInstantJsonAction {
  type: "applyInstantJson";
  file: FileRef;
}

export interface ApplyXfdfAction {
  type: "applyXfdf";
  file: FileRef;
  richTextEnabled?: boolean;
}

export interface FlattenAction {
  type: "flatten";
  annotationIds?: (string | number)[];
}

export interface OcrAction {
  type: "ocr";
  language: OcrLanguage | OcrLanguage[];
  skipOcrForSearchableDocuments?: boolean;
}

export interface RotateAction {
  type: "rotate";
  rotateBy: 90 | 180 | 270;
}

export type FontStyle = "bold" | "italic";

interface WatermarkBase {
  type: "watermark";
  width: number | string;
  height: number | string;
  top?: number | string;
  right?: number | string;
  bottom?: number | string;
  left?: number | string;
  rotation?: number;
  opacity?: number;
}

export interface TextWatermarkAction extends WatermarkBase {
  text: string;
  /** Must match `^#[0-9a-fA-F]{6}$`; shorthand `#fff` is rejected by the API. */
  fontColor?: string;
  fontFamily?: string;
  fontSize?: number;
  fontStyle?: FontStyle[];
}

export interface ImageWatermarkAction extends WatermarkBase {
  image: FileRef;
}

export type WatermarkAction = TextWatermarkAction | ImageWatermarkAction;

/** The 13 built-in patterns. There is no preset for personal names or account numbers. */
export type RedactionPreset =
  | "credit-card-number"
  | "date"
  | "email-address"
  | "international-phone-number"
  | "ipv4"
  | "ipv6"
  | "mac-address"
  | "north-american-phone-number"
  | "social-security-number"
  | "time"
  | "url"
  | "us-zip-code"
  | "vin";

export interface RedactionAppearance {
  fillColor?: string;
  outlineColor?: string;
  overlayText?: string;
  repeatOverlayText?: boolean;
}

interface RedactionStrategyBase {
  start?: number;
  limit?: number | null;
  includeAnnotations?: boolean;
}

export interface PresetRedactionOptions extends RedactionStrategyBase {
  preset: RedactionPreset;
}

/** `caseSensitive` defaults to TRUE here and FALSE for `text` — Nutrient's inconsistency, not ours. */
export interface RegexRedactionOptions extends RedactionStrategyBase {
  regex: string;
  caseSensitive?: boolean;
}

export interface TextRedactionOptions extends RedactionStrategyBase {
  text: string;
  caseSensitive?: boolean;
}

export type CreateRedactionsAction =
  | {
      type: "createRedactions";
      strategy: "preset";
      strategyOptions: PresetRedactionOptions;
      content?: RedactionAppearance;
    }
  | {
      type: "createRedactions";
      strategy: "regex";
      strategyOptions: RegexRedactionOptions;
      content?: RedactionAppearance;
    }
  | {
      type: "createRedactions";
      strategy: "text" | "word_based";
      strategyOptions: TextRedactionOptions;
      content?: RedactionAppearance;
    };

export interface ApplyRedactionsAction {
  type: "applyRedactions";
}

/** Exactly the 8 documented actions. There is no `sign` action — signing is `/sign`. */
export type BuildAction =
  | ApplyInstantJsonAction
  | ApplyXfdfAction
  | FlattenAction
  | OcrAction
  | RotateAction
  | WatermarkAction
  | CreateRedactionsAction
  | ApplyRedactionsAction;

export type BuildActionType = BuildAction["type"];

/** A plain `Omit` over a discriminated union collapses it; this keeps the arms apart. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/* ------------------------------------------------------------------ output */

export type PdfPermission =
  | "printing"
  | "modification"
  | "extract"
  | "annotations_and_forms"
  | "fill_forms"
  | "extract_accessibility"
  | "assemble"
  | "print_high_quality";

export interface PdfOutput {
  type: "pdf";
  owner_password?: string;
  user_password?: string;
  user_permissions?: PdfPermission[];
  optimize?: {
    grayscaleText?: boolean;
    grayscaleGraphics?: boolean;
    grayscaleImages?: boolean;
    disableImages?: boolean;
    mrcCompression?: boolean;
    imageOptimizationQuality?: number;
    linearize?: boolean;
  };
}

/** The OpenAPI enum stops at `pdfa-3u`; guide prose claiming PDF/A-4 is wrong. */
export type PdfaConformance =
  | "pdfa-1a"
  | "pdfa-1b"
  | "pdfa-2a"
  | "pdfa-2u"
  | "pdfa-2b"
  | "pdfa-3a"
  | "pdfa-3u";

export interface PdfaOutput {
  type: "pdfa";
  conformance?: PdfaConformance;
  /** Both convert text to shapes/rasters and LOSE text — only OCR gets it back. */
  vectorization?: boolean;
  rasterization?: boolean;
}

export interface PdfuaOutput {
  type: "pdfua";
}

export interface ImageOutput {
  type: "image";
  format: "png" | "jpeg" | "jpg" | "webp";
  pages?: PageRange;
  width?: number;
  height?: number;
  dpi?: number;
}

export interface JsonContentOutput {
  type: "json-content";
  plainText?: boolean;
  structuredText?: boolean;
  keyValuePairs?: boolean;
  tables?: boolean;
  language?: OcrLanguage | OcrLanguage[];
}

export interface OfficeOutput {
  type: "docx" | "xlsx" | "pptx";
}

export interface HtmlOutput {
  type: "html";
  layout?: "page" | "reflow";
}

export interface MarkdownOutput {
  type: "markdown";
}

/** Exactly the 8 documented output types. */
export type BuildOutput =
  | PdfOutput
  | PdfaOutput
  | PdfuaOutput
  | ImageOutput
  | JsonContentOutput
  | OfficeOutput
  | HtmlOutput
  | MarkdownOutput;

export interface BuildInstructions {
  parts: BuildPart[];
  actions?: BuildAction[];
  output?: BuildOutput;
}

/* ---------------------------------------------------------------- ordering */

/**
 * The documented pipeline order, as ranks.
 *
 * assemble -> OCR early -> import/fill before flatten -> redact before signing
 * -> optimize/linearize late -> sign last.
 *
 * Parts assemble implicitly at rank 0. Signing is rank `Infinity` by
 * construction: it is a separate endpoint with no action form, so it cannot be
 * expressed out of order in `actions` at all.
 *
 * OCR is first because everything after it operates on text that must already
 * exist. Import/fill precedes flatten because flattening burns the current
 * field values into content — do it early and the imported values are lost.
 * Redaction marks are created and applied before flatten so annotation-backed
 * marks are still annotations when `applyRedactions` looks for them.
 */
export const BUILD_ACTION_STAGE: Record<BuildActionType, number> = {
  ocr: 10,
  applyInstantJson: 20,
  applyXfdf: 20,
  rotate: 30,
  watermark: 30,
  createRedactions: 40,
  applyRedactions: 50,
  flatten: 60,
};

export interface BuildIssue {
  /** JSON pointer into the instructions, mirroring Nutrient's own `failingPaths`. */
  pointer: string;
  code:
    | "NO_PARTS"
    | "ACTION_OUT_OF_ORDER"
    | "UNKNOWN_ACTION"
    | "REDACTIONS_NOT_APPLIED"
    | "BAD_FONT_COLOR"
    | "BAD_OPACITY";
  message: string;
}

export class BuildOrderError extends NutrientError {
  constructor(readonly issues: BuildIssue[]) {
    super(
      `invalid build instructions: ${issues.map((i) => `${i.pointer} ${i.message}`).join("; ")}`,
      EMPTY_META,
    );
    this.name = "BuildOrderError";
  }
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Checked on every `build()` and `analyzeBuild()`, not just when the builder is
 * used, so hand-written instructions get the same guarantee.
 */
export function validateBuildInstructions(instructions: BuildInstructions): BuildIssue[] {
  const issues: BuildIssue[] = [];

  if (!Array.isArray(instructions.parts) || instructions.parts.length === 0) {
    issues.push({ pointer: "/parts", code: "NO_PARTS", message: "at least one part is required" });
  }

  const actions = instructions.actions ?? [];
  let highest = 0;
  let highestType: BuildActionType | null = null;

  actions.forEach((action, index) => {
    const pointer = `/actions/${index}`;
    if (!Object.prototype.hasOwnProperty.call(BUILD_ACTION_STAGE, action.type)) {
      issues.push({
        pointer: `${pointer}/type`,
        code: "UNKNOWN_ACTION",
        message: `\`${String(action.type)}\` is not one of the 8 documented build actions`,
      });
      return;
    }
    const stage = BUILD_ACTION_STAGE[action.type];

    if (stage < highest && highestType !== null) {
      issues.push({
        pointer,
        code: "ACTION_OUT_OF_ORDER",
        message: `${action.type} must run before ${highestType}, not after it`,
      });
    } else {
      highest = stage;
      highestType = action.type;
    }

    if (action.type === "watermark") {
      if ("fontColor" in action && action.fontColor !== undefined && !HEX_COLOR.test(action.fontColor)) {
        issues.push({
          pointer: `${pointer}/fontColor`,
          code: "BAD_FONT_COLOR",
          message: `fontColor must match ^#[0-9a-fA-F]{6}$, got ${action.fontColor}`,
        });
      }
      if (action.opacity !== undefined && (action.opacity < 0 || action.opacity > 1)) {
        issues.push({
          pointer: `${pointer}/opacity`,
          code: "BAD_OPACITY",
          message: "opacity must be within 0..1",
        });
      }
    }
  });

  return issues;
}

export function assertBuildInstructions(instructions: BuildInstructions): void {
  const issues = validateBuildInstructions(instructions);
  if (issues.length > 0) throw new BuildOrderError(issues);
}

/**
 * Signing a document that still carries unapplied redaction marks would publish
 * the very text the marks cover — `createRedactions` is reversible annotation
 * state, not destruction. So "redact before signing" is enforced as a real
 * precondition on the signing path, not as documentation.
 */
export function assertSafeToSign(instructions: BuildInstructions): void {
  const actions = instructions.actions ?? [];
  const marked = actions.some((a) => a.type === "createRedactions");
  const applied = actions.some((a) => a.type === "applyRedactions");
  if (marked && !applied) {
    throw new BuildOrderError([
      {
        pointer: "/actions",
        code: "REDACTIONS_NOT_APPLIED",
        message: "createRedactions without applyRedactions — redact before signing",
      },
    ]);
  }
}

/**
 * Appends actions in documented order and refuses to append one that would land
 * before an action already staged. It rejects rather than silently re-sorting:
 * a reordered pipeline is a different document, and the caller has to know.
 */
export class BuildBuilder {
  private readonly parts: BuildPart[] = [];
  private readonly actions: BuildAction[] = [];
  private output?: BuildOutput;
  private highestStage = 0;
  private highestType: BuildActionType | null = null;

  addPart(part: BuildPart): this {
    if (this.actions.length > 0) {
      throw new BuildOrderError([
        {
          pointer: `/parts/${this.parts.length}`,
          code: "ACTION_OUT_OF_ORDER",
          message: "all parts must be assembled before any action is added",
        },
      ]);
    }
    this.parts.push(part);
    return this;
  }

  addFile(file: FileRef, options: Omit<FilePart, "file"> = {}): this {
    return this.addPart({ file, ...options });
  }

  addHtml(html: HtmlPart["html"], options: Omit<HtmlPart, "html"> = {}): this {
    return this.addPart({ html, ...options });
  }

  addNewPage(options: Omit<NewPagePart, "page"> = {}): this {
    return this.addPart({ page: "new", ...options });
  }

  addAction(action: BuildAction): this {
    const stage = BUILD_ACTION_STAGE[action.type];
    if (this.highestType !== null && stage < this.highestStage) {
      throw new BuildOrderError([
        {
          pointer: `/actions/${this.actions.length}`,
          code: "ACTION_OUT_OF_ORDER",
          message: `${action.type} must run before ${this.highestType}, not after it`,
        },
      ]);
    }
    this.actions.push(action);
    this.highestStage = stage;
    this.highestType = action.type;
    return this;
  }

  ocr(action: Omit<OcrAction, "type">): this {
    return this.addAction({ type: "ocr", ...action });
  }

  applyInstantJson(file: FileRef): this {
    return this.addAction({ type: "applyInstantJson", file });
  }

  applyXfdf(file: FileRef, richTextEnabled?: boolean): this {
    return this.addAction({ type: "applyXfdf", file, ...(richTextEnabled === undefined ? {} : { richTextEnabled }) });
  }

  rotate(rotateBy: RotateAction["rotateBy"]): this {
    return this.addAction({ type: "rotate", rotateBy });
  }

  watermark(action: Omit<TextWatermarkAction, "type"> | Omit<ImageWatermarkAction, "type">): this {
    return this.addAction({ type: "watermark", ...action } as WatermarkAction);
  }

  createRedactions(action: DistributiveOmit<CreateRedactionsAction, "type">): this {
    return this.addAction({ type: "createRedactions", ...action } as CreateRedactionsAction);
  }

  applyRedactions(): this {
    return this.addAction({ type: "applyRedactions" });
  }

  flatten(annotationIds?: (string | number)[]): this {
    return this.addAction({ type: "flatten", ...(annotationIds ? { annotationIds } : {}) });
  }

  outputAs(output: BuildOutput): this {
    this.output = output;
    return this;
  }

  build(): BuildInstructions {
    const instructions: BuildInstructions = {
      parts: [...this.parts],
      ...(this.actions.length > 0 ? { actions: [...this.actions] } : {}),
      ...(this.output ? { output: this.output } : {}),
    };
    assertBuildInstructions(instructions);
    return instructions;
  }
}

export function buildInstructions(): BuildBuilder {
  return new BuildBuilder();
}

/* -------------------------------------------------------- idempotency key */

export const IDEMPOTENCY_KEY_PREFIX = "chancery-build-v1";

/**
 * The key is a pure function of what the request actually does: the bytes of
 * every input, bound to its multipart handle, plus the canonicalised
 * instructions. Recomputing it offline from the evidence bundle reproduces the
 * same string, which is what makes a 409 meaningful — the server saw this key
 * paired with different work.
 *
 * Handles are length-prefixed so `{"ab": x, "": y}` cannot collide with
 * `{"a": bx, "": y}`.
 */
export function deriveIdempotencyKey(
  instructions: BuildInstructions,
  files: Record<string, FileInput> = {},
): string {
  const hash = sha256.create();
  hash.update(utf8ToBytes(`${IDEMPOTENCY_KEY_PREFIX}\n`));

  for (const handle of Object.keys(files).sort()) {
    const { bytes } = toFileBlob(files[handle]);
    hash.update(utf8ToBytes(`file:${handle.length}:${handle}:${bytes.length}\n`));
    hash.update(bytes);
    hash.update(utf8ToBytes("\n"));
  }

  const json = canonicalJson(instructions);
  hash.update(utf8ToBytes(`instructions:${json.length}:${json}`));

  return `${IDEMPOTENCY_KEY_PREFIX}-${bytesToHex(hash.digest())}`;
}

/* -------------------------------------------------------- request payloads */

export interface BuildRequest {
  instructions: BuildInstructions;
  /** Keyed by the multipart field name each `parts[].file` handle refers to. */
  files?: Record<string, FileInput>;
  /**
   * Overrides the derived key. Only for replaying a historical request whose
   * key is on record; deriving is the default precisely so it cannot be skipped.
   */
  idempotencyKey?: string;
}

export interface AnalyzeBuildFeature {
  name?: string;
  unit_cost: number;
  unit_type: "per_use" | "per_output_page";
  units: number;
  /** JSONPath pointers into the submitted instructions. */
  usage?: string[];
}

export interface AnalyzeBuildResult {
  cost: number;
  required_features: Record<string, AnalyzeBuildFeature> | AnalyzeBuildFeature[];
}

export interface SignAppearance {
  mode?: "signatureOnly" | "signatureAndDescription" | "descriptionOnly";
  showWatermark?: boolean;
  showSignDate?: boolean;
  showSigner?: boolean;
  showReason?: boolean;
  showLocation?: boolean;
  showDateTimezone?: boolean;
}

export interface SignPosition {
  pageIndex: number;
  /** `[left, top, width, height]` in PDF points. */
  rect: [number, number, number, number];
}

/**
 * `signatureType` / `cadesLevel` are absent on purpose: DWS forces SHA-256 and
 * PAdES B-LT and does not expose them as request options.
 */
export interface SignData {
  /** Signs an existing field. Setting this AND `position` is an error. */
  formFieldName?: string;
  position?: SignPosition;
  appearance?: SignAppearance;
  flatten?: boolean;
  signatureMetadata?: {
    signerName?: string;
    signatureReason?: string;
    signatureLocation?: string;
  };
}

export interface SignRequest {
  file: FileInput;
  /** Omitting `data` entirely yields an invisible but fully cryptographic signature. */
  data?: SignData;
  image?: FileInput;
  graphicImage?: FileInput;
  password?: string;
}

/**
 * UNVERIFIED shape: `/validate_pdfa` is live but absent from the OpenAPI spec,
 * so the known fields are optional and the raw body is kept. Do not gate on
 * this until it has been hit once with a real key.
 */
export interface PdfaValidationReport {
  conformance?: string;
  valid?: boolean;
  errors?: unknown[];
  [key: string]: unknown;
}

export type TokenScope =
  | "annotations_api"
  | "compression_api"
  | "data_extraction_api"
  | "digital_signatures_api"
  | "document_editor_api"
  | "html_conversion_api"
  | "image_conversion_api"
  | "image_rendering_api"
  | "email_conversion_api"
  | "linearization_api"
  | "ocr_api"
  | "office_conversion_api"
  | "pdfa_api"
  | "pdf_to_office_conversion_api"
  | "redaction_api";

export interface CreateTokenRequest {
  allowedOperations: TokenScope[];
  /** An origin-restricted token requires a matching `Origin` header on use. */
  allowedOrigins?: string[];
  /** Seconds. Defaults to one hour server-side. */
  expirationTime?: number;
}

export interface TokenGrant {
  id: string;
  accessToken: string;
}

export interface AiRedactRequest {
  criteria: string;
  documents: { file: FileRef; pages?: PageRange }[];
  files?: Record<string, FileInput>;
  /** `stage` marks only and is the reviewable intermediate; `apply` destroys content. */
  redactionState?: "stage" | "apply";
  /** 1..10 — a DIFFERENT scale from Data Extraction's 0..1 confidence. */
  confidenceThreshold?: number;
}

/* ------------------------------------------------------------------ client */

export class ProcessorClient {
  constructor(private readonly config: NutrientClientConfig) {}

  /**
   * Returns the produced bytes plus the cost/credit accounting for the call.
   * Throws `IdempotencyConflictError` when the same derived key was previously
   * used for different work.
   */
  async build(request: BuildRequest): Promise<NutrientResult<Uint8Array>> {
    assertBuildInstructions(request.instructions);
    const files = request.files ?? {};
    const key = request.idempotencyKey ?? deriveIdempotencyKey(request.instructions, files);

    return nutrientRequest<Uint8Array>(this.config, {
      method: "POST",
      path: "/build",
      body: buildForm(request.instructions, files),
      expect: "binary",
      idempotencyKey: key,
    });
  }

  /**
   * Free, non-executing dry run: the deterministic execution plan and its cost,
   * with JSONPath pointers back into the submitted instructions. Run this
   * before spending credits.
   */
  async analyzeBuild(request: BuildRequest): Promise<NutrientResult<AnalyzeBuildResult>> {
    assertBuildInstructions(request.instructions);
    return nutrientRequest<AnalyzeBuildResult>(this.config, {
      method: "POST",
      path: "/analyze_build",
      body: buildForm(request.instructions, request.files ?? {}),
      expect: "json",
    });
  }

  /** Marks redactions without destroying anything — the human-review checkpoint. */
  async stageRedactions(
    request: Omit<BuildRequest, "instructions"> & {
      instructions: BuildInstructions;
      redactions: DistributiveOmit<CreateRedactionsAction, "type">[];
    },
  ): Promise<NutrientResult<Uint8Array>> {
    const actions = [
      ...(request.instructions.actions ?? []),
      ...request.redactions.map((r) => ({ type: "createRedactions", ...r }) as CreateRedactionsAction),
    ];
    return this.build({ ...request, instructions: { ...request.instructions, actions } });
  }

  /** Irreversible. Only ever run against a staged document a human has reviewed. */
  async applyStagedRedactions(request: BuildRequest): Promise<NutrientResult<Uint8Array>> {
    const actions = [...(request.instructions.actions ?? []), { type: "applyRedactions" } as const];
    return this.build({ ...request, instructions: { ...request.instructions, actions } });
  }

  /** AI features are disabled on `pdf_test_` keys; max one document per call. */
  async aiRedact(request: AiRedactRequest): Promise<NutrientResult<Uint8Array>> {
    const payload = {
      documents: request.documents,
      criteria: request.criteria,
      redaction_state: request.redactionState ?? "stage",
      ...(request.confidenceThreshold === undefined
        ? {}
        : { options: { confidence: { threshold: request.confidenceThreshold } } }),
    };

    const files = request.files ?? {};
    if (Object.keys(files).length === 0) {
      return nutrientRequest<Uint8Array>(this.config, {
        method: "POST",
        path: "/ai/redact",
        body: JSON.stringify(payload),
        expect: "binary",
      });
    }

    const form = new FormData();
    form.append("instructions", canonicalJson(payload));
    for (const [handle, file] of Object.entries(files)) appendFile(form, handle, file);
    return nutrientRequest<Uint8Array>(this.config, {
      method: "POST",
      path: "/ai/redact",
      body: form,
      expect: "binary",
    });
  }

  /**
   * Signing is last by construction: it takes finished bytes, not a pipeline.
   * Nutrient derives the certificate from the authenticated account — a free
   * plan gets a private TEST certificate, so free-plan output must never be
   * presented as a production signature.
   */
  async sign(request: SignRequest): Promise<NutrientResult<Uint8Array>> {
    if (request.data?.formFieldName !== undefined && request.data.position !== undefined) {
      throw new NutrientError(
        "sign: formFieldName and position are mutually exclusive",
        EMPTY_META,
      );
    }

    const form = new FormData();
    appendFile(form, "file", request.file);
    if (request.data !== undefined) appendJson(form, "data", request.data);
    if (request.image !== undefined) appendFile(form, "image", request.image);
    if (request.graphicImage !== undefined) appendFile(form, "graphicImage", request.graphicImage);

    return nutrientRequest<Uint8Array>(this.config, {
      method: "POST",
      path: "/sign",
      body: form,
      expect: "binary",
      ...(request.password === undefined
        ? {}
        : { headers: { "pspdfkit-pdf-password": request.password } }),
    });
  }

  /** Runs the pipeline then signs the result, refusing to sign unapplied redactions. */
  async buildAndSign(
    request: BuildRequest,
    signOptions: Omit<SignRequest, "file"> = {},
  ): Promise<{ built: NutrientResult<Uint8Array>; signed: NutrientResult<Uint8Array> }> {
    assertSafeToSign(request.instructions);
    const built = await this.build(request);
    const signed = await this.sign({ ...signOptions, file: built.data });
    return { built, signed };
  }

  async validatePdfa(file: FileInput): Promise<NutrientResult<PdfaValidationReport>> {
    const form = new FormData();
    appendFile(form, "file", file);
    return nutrientRequest<PdfaValidationReport>(this.config, {
      method: "POST",
      path: "/validate_pdfa",
      body: form,
      expect: "json",
    });
  }

  /**
   * Scoped, expiring, revocable credentials — the API-key equivalent of a writ.
   * Unlike the account key, which can only be regenerated, these can be revoked.
   */
  async createToken(request: CreateTokenRequest): Promise<NutrientResult<TokenGrant>> {
    return nutrientRequest<TokenGrant>(this.config, {
      method: "POST",
      path: "/tokens",
      body: JSON.stringify(request),
      expect: "json",
    });
  }

  async revokeToken(id: string): Promise<NutrientResult<void>> {
    return nutrientRequest<void>(this.config, {
      method: "DELETE",
      path: "/tokens",
      body: JSON.stringify({ id }),
      expect: "none",
    });
  }
}

/**
 * The multipart shape `/build` documents: ONE field literally named
 * `instructions` holding the JSON, and every other field named after the handle
 * its `parts[].file` refers to.
 */
export function buildForm(
  instructions: BuildInstructions,
  files: Record<string, FileInput>,
): FormData {
  const form = new FormData();
  for (const [handle, file] of Object.entries(files)) {
    if (handle === "instructions") {
      throw new NutrientError(
        "a file handle may not be named `instructions` — it collides with the JSON field",
        EMPTY_META,
      );
    }
    appendFile(form, handle, file);
  }
  form.append("instructions", canonicalJson(instructions));
  return form;
}

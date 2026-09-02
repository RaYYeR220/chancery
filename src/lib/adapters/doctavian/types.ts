/**
 * Wire types for the Doctavian API (api.doctavian.com, OpenAPI 3.0.1, all paths
 * under `/v1/`).
 *
 * Doctavian ships no SDK in any language, so these types are hand-written from
 * the published spec. Where a response field name could not be confirmed
 * against a live call — we have no credentials yet — the type lists the
 * documented name first and the client falls back to the obvious aliases rather
 * than throwing, because a wrong guess about a key name should not look like an
 * outage.
 */

/**
 * The API key is scoped per API *area*: the Documents key answers
 * `401 ApiKeyInvalid` on a Signatures path. Modelling the area as a type rather
 * than as a convention is what stops a documents key reaching a signatures
 * endpoint — see `DoctavianPath` below.
 */
export type DoctavianArea = "documents" | "signatures";

export type DocumentsPath = `/v1/documents/${string}`;
export type SignaturesPath = `/v1/signatures/${string}`;

/**
 * Ties an area to the only path prefix that area's key is valid for. A
 * `/v1/documents/...` literal is not assignable to `SignaturesPath`, so mixing
 * the two is a compile error before it is ever a 401.
 */
export type DoctavianPath<A extends DoctavianArea> = A extends "documents"
  ? DocumentsPath
  : SignaturesPath;

/** Injectable so every test drives a fake and no test touches the network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface DoctavianClientConfig {
  /** Origin only, e.g. `https://api.doctavian.com`. The bare root 404s. */
  baseUrl: string;
  /**
   * OAuth2 access token, or a provider called per request. Doctavian rejects
   * tokens within ~2 minutes of expiry, so a long-lived client needs the
   * provider form to survive its own token's lifetime.
   */
  bearerToken: string | (() => string | Promise<string>);
  documentsApiKey: string;
  signaturesApiKey: string;
  fetchImpl?: FetchLike;
}

/** Billing units the API reports back per generation. */
export interface ConsumptionEntry {
  dimension: string;
  value: number;
}

/**
 * Doctavian nests successful payloads under `result.data`. Responses that come
 * back flat are still accepted, so a shape change downgrades to "unknown key"
 * rather than to a crash.
 */
export interface DoctavianEnvelope<T> {
  result?: { data?: T; message?: string } | null;
  consumption?: ConsumptionEntry[] | null;
}

export type LoadMethod = "Storage";
export type DeliveryMethod = "Storage";

/** Template inputs are real Office files uploaded as-is. No HTML input. */
export type TemplateFileFormat = "docx" | "xlsx" | "pptx";

/** DOCX renders to PDF or DOCX. There is no HTML output at all. */
export type OutputFileFormat = "pdf" | "docx" | "xlsx" | "csv" | "pptx";

/** Default is PdfA3a; only meaningful when the output format is `pdf`. */
export type PdfAConformance =
  | "PdfA1a"
  | "PdfA1b"
  | "PdfA2a"
  | "PdfA2b"
  | "PdfA2u"
  | "PdfA3a"
  | "PdfA3b"
  | "PdfA3u";

export interface DoctavianFile {
  fileName: string;
  bytes: Uint8Array;
  /** Sent as the multipart part's content type; defaults per endpoint. */
  contentType?: string;
}

/** A response the API returns as raw bytes rather than JSON. */
export interface DoctavianBinary {
  bytes: Uint8Array;
  contentType: string | null;
  /** Parsed out of `Content-Disposition` when the server sends one. */
  fileName: string | null;
}

/* ------------------------------------------------------------- documents */

export interface CreateDataSourceInput {
  name: string;
  description?: string;
  loadMethod?: LoadMethod;
}

export interface CreateDataSourceResult {
  dataSourceGuid: string;
}

export interface CreateSolutionInput {
  name: string;
  description?: string;
  /** The `dataSourceGuid` from `createDataSource`. */
  dataGuid: string;
}

export interface CreateSolutionResult {
  documentSolutionGuid: string;
}

/** Both uploads return an id that is used as a `urn` by the generate call. */
export interface UploadResult {
  id: string;
}

export interface TemplateSummary {
  id: string;
  name: string;
  fileFormat?: string;
  documentSolutionGuid?: string;
}

export interface GenerateDocumentInput {
  template: {
    name: string;
    /** The id returned by `uploadTemplate`. */
    urn: string;
    fileFormat: TemplateFileFormat;
    loadMethod: LoadMethod;
  };
  data: {
    /** The id returned by `uploadData`. */
    urn: string;
    loadMethod: LoadMethod;
  };
  document: {
    name: string;
    fileFormat: OutputFileFormat;
    deliveryMethod: DeliveryMethod;
    /** Storage path; `root` unless the tenant uses folders. */
    path: string;
    /** Drives date and number formatting inside the template. */
    locale: string;
    /** IANA zone; without it computed dates drift by a day at the edges. */
    timezone: string;
    pdfAConformance?: PdfAConformance;
  };
}

export interface GenerateDocumentResult {
  /** `result.data.document.urn` — the handle the download call takes. */
  urn: string;
  consumption: ConsumptionEntry[];
}

/* ------------------------------------------------------------ signatures */

/**
 * `digitalsignature` is the AES/QES path and needs a PKI certificate wired
 * through NexU; `signature` is the SES path and needs nothing extra. Picking
 * the wrong one is the difference between an envelope that sends and one that
 * stalls on the signer's certificate.
 */
export type EnvelopeFieldType =
  | "signature"
  | "digitalsignature"
  | "initials"
  | "date"
  | "text"
  | "checkbox";

export interface EnvelopeDocumentInput {
  /** Local handle the fields point at; not an API id. */
  referenceDocumentId: string;
  /** The id returned by `uploadSignatureDocument`. */
  id: string;
  name: string;
}

export interface EnvelopeSignerInput {
  /** Local handle the fields point at; not an API id. */
  referenceSignerId: string;
  name: string;
  email: string;
  /** Only meaningful when the envelope's signing order is sequential. */
  order?: number;
  mfa?: { type: "sms" | "email"; value?: string };
}

export interface EnvelopeFieldInput {
  referenceDocumentId: string;
  referenceSignerId: string;
  type: EnvelopeFieldType;
  /** 1-based. */
  page: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  required?: boolean;
  value?: string;
}

export interface EnvelopeSettingsInput {
  name: string;
  message?: string;
  signingOrder?: "sequential" | "parallel";
  expiresInDays?: number;
  reminderInDays?: number;
}

/**
 * Documents, recipients, fields and envelope settings go up in ONE body; the
 * cross-references are resolved server-side by `referenceDocumentId` and
 * `referenceSignerId`, which is why those are local handles rather than ids.
 */
export interface CreateEnvelopeInput {
  documents: EnvelopeDocumentInput[];
  signers: EnvelopeSignerInput[];
  fields: EnvelopeFieldInput[];
  envelope: EnvelopeSettingsInput;
}

export interface CreateEnvelopeResult {
  envelopeId: string;
}

export interface SendEnvelopeResult {
  envelopeId: string;
  status: string;
}

export interface EnvelopeAuditEvent {
  timestamp: string;
  type: string;
  actor?: string;
  detail?: string;
}

export interface EnvelopeAudit {
  envelopeId: string;
  status: string;
  events: EnvelopeAuditEvent[];
}

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
import type { DoctavianTokenSet } from "./auth";

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

/**
 * How the client re-mints an access token that expired mid-flow. Doctavian's
 * tokens live 3599 seconds, which is shorter than a working session, so this is
 * the difference between a recoverable 401 and a half-completed generation.
 */
export interface DoctavianRefreshConfig {
  refreshToken: string;
  clientId?: string;
  /** Defaults to `${baseUrl}/public/v1/auth/microsoft/token`. */
  tokenUrl?: string;
  scope?: string;
  /**
   * Called with every new token set. Entra rotates the refresh token on use,
   * so a caller that does not persist what it is handed will be unable to
   * refresh again from a new process.
   */
  onRefresh?: (tokens: DoctavianTokenSet) => void | Promise<void>;
  /** Refresh this far ahead of expiry. Defaults to 120s, per the docs' warning. */
  skewMs?: number;
}

export interface DoctavianClientConfig {
  /**
   * Origin only. Omit to take `DOCTAVIAN_BASE_URL`, falling back to the demo
   * tenant — which is a different host from `api.doctavian.com`, not a path on
   * it. The bare root 404s either way.
   */
  baseUrl?: string;
  /**
   * OAuth2 access token, or a provider called per request. Doctavian rejects
   * tokens within ~2 minutes of expiry, so a long-lived client needs either the
   * provider form or `refresh` below to survive its own token's lifetime.
   */
  bearerToken: string | (() => string | Promise<string>);
  documentsApiKey: string;
  signaturesApiKey: string;
  refresh?: DoctavianRefreshConfig;
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

/**
 * `X-Storage-Type` selects the blob container a request reads or writes.
 *
 * The spec marks it required on every upload and download, but the server does
 * not enforce it: an upload without it still answers `201` with a file id, and
 * the failure only surfaces two calls later as `TEMPLATE_READ_FAILED` from
 * generate, because the template was never written where the renderer looks. It
 * is therefore not optional in this client — each endpoint pins its own value.
 */
export type StorageType =
  | "document-template"
  | "document-data"
  | "document-input"
  | "envelope-attachment";

export const STORAGE_TYPE = {
  /** Templates, and anything uploaded via `documents/document/upload`. */
  template: "document-template",
  /** Data payloads, and the container generated documents are delivered to. */
  data: "document-data",
  /** Documents on the signatures side of the API. */
  signatureDocument: "document-input",
  envelopeAttachment: "envelope-attachment",
} as const satisfies Record<string, StorageType>;

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

/**
 * Both uploads answer with `result.data.files[0].id`, and that id is what the
 * generate call takes as a `urn`.
 */
export interface UploadResult {
  id: string;
  fileName?: string;
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

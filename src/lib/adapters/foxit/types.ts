/**
 * Foxit wire types, for two APIs that share a hostname and share nothing else.
 *
 * The one type in here that carries an argument rather than a payload is
 * `ScopedCredentials`. Foxit's fusion gateway authenticates PDF Services and
 * eSign with the same pair of headers, so nothing in the transport can tell the
 * two piles of secret apart. `scope` is the discriminant that lets the type
 * system tell them apart instead: `PdfServicesCredentials` is not assignable to
 * `ESignCredentials`, so the agent-facing constructors cannot be handed a
 * signing key by accident. Re-branding one into the other is possible — it is a
 * structural type, not a nominal one — but it takes a literal, greppable
 * `scope: "esign"` at the call site, which is exactly the act we want to be
 * unable to happen quietly.
 *
 * The second thing worth noticing is `sendNow: true`, typed as the literal.
 * `sendDraftFolder` does not exist on the gateway (0 hits in the spec), so
 * there is no draft that could later be sent: an eSign folder is created and
 * dispatched in the same call or not at all. Typing the flag as `true` makes
 * that a compile error rather than a runtime surprise for anyone who reaches
 * for the two-step gate every other integration in this space uses.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/* ---------------------------------------------------------- credentials */

export interface PdfServicesCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope: "pdf-services";
}

/** Gateway eSign credentials: same header pair, entirely different entitlement. */
export interface ESignCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope: "esign";
}

/**
 * Legacy-host eSign credentials. These come from an eSign account's own API
 * settings and speak OAuth2, not header auth — a different token, a different
 * host, and a different failure convention (see `FoxitESignClient`).
 */
export interface ESignLegacyCredentials {
  readonly accessToken: string | (() => string | Promise<string>);
  readonly scope: "esign-legacy";
}

export function pdfServicesCredentials(
  clientId: string,
  clientSecret: string,
): PdfServicesCredentials {
  return { clientId, clientSecret, scope: "pdf-services" };
}

export function esignCredentials(
  clientId: string,
  clientSecret: string,
): ESignCredentials {
  return { clientId, clientSecret, scope: "esign" };
}

export function esignLegacyCredentials(
  accessToken: string | (() => string | Promise<string>),
): ESignLegacyCredentials {
  return { accessToken, scope: "esign-legacy" };
}

/* ------------------------------------------------------- pdf services */

export interface FoxitDocumentRef {
  documentId: string;
}

export interface FoxitBinary {
  bytes: Uint8Array;
  contentType: string | null;
  fileName: string | null;
}

export interface FoxitFile {
  fileName: string;
  bytes: Uint8Array;
  contentType?: string;
}

export type TaskStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface FoxitTask {
  taskId: string;
  status: TaskStatus;
  /** Set once `status` is COMPLETED; the handle for download or the next step. */
  resultDocumentId: string | null;
  progress: number | null;
  error: string | null;
}

/**
 * The only bridge between the two APIs. A PDF Services `documentId` is not a
 * thing eSign can resolve, and eSign has no upload endpoint at all, so the
 * share link is how a generated draft becomes something an envelope can carry.
 */
export interface ShareLink {
  documentId: string;
  url: string;
  expiresAt: string | null;
}

export type PdfConversionSource = "word" | "excel" | "ppt" | "image" | "html" | "text";
export type PdfConversionTarget = "word" | "excel" | "ppt" | "image" | "html" | "text";

/** DocGen merges a template against values; it is a pure render, nothing is sent. */
export interface DocGenRequest {
  /** base64 of the template file (docx). */
  base64FileString: string;
  documentValues: Record<string, unknown>;
  outputFormat: "pdf" | "docx";
  /** Foxit rejects an unknown key rather than ignoring it, so this stays narrow. */
  password?: string;
}

export interface DocGenResult {
  base64FileString: string;
  bytes: Uint8Array;
}

/* --------------------------------------------------------------- esign */

/**
 * Host and path prefix move together. `na1.foxitesign.foxit.com` with the
 * gateway's `/esign/api/v1` prefix answers 404 with a Tomcat error page — a
 * combination Foxit's own blog publishes — so the two are never separately
 * configurable here.
 */
export type ESignSurface = "gateway" | "legacy";

export interface ESignSurfaceSpec {
  baseUrl: string;
  prefix: string;
}

export type ESignFieldType =
  | "signature"
  | "initial"
  | "text"
  | "date"
  | "checkbox"
  | "radio"
  | "dropdown"
  | "title"
  | "company"
  | "fullName"
  | "email";

/**
 * Coordinates are pixels from the top-left of the page, and
 * `documentNumber`/`pageNumber`/`party` are 1-based. Omitting any required key
 * does not fail the request: the field silently does not appear, and the
 * envelope goes out with nowhere to sign. Every key here is therefore required
 * in the type and re-checked at runtime before the call is made.
 */
export interface ESignField {
  documentNumber: number;
  pageNumber: number;
  party: number;
  type: ESignFieldType;
  x: number;
  y: number;
  width: number;
  height: number;
  required?: boolean;
  name?: string;
  value?: string;
}

export interface ESignSigner {
  emailId: string;
  firstName?: string;
  lastName?: string;
  /** 1-based, and it has to match the `party` on that signer's fields. */
  party?: number;
  signerType?: "signer" | "approver" | "inPersonSigner";
}

export interface CreateFolderRequest {
  folderName: string;
  emailSubject?: string;
  emailContent?: string;
  /**
   * Literal `true`: the gateway has no `sendDraftFolder`, so a folder that is
   * not sent on creation can never be sent at all.
   */
  sendNow: true;
  inputType: "url" | "base64";
  /** `inputType: "url"` — normally exactly one PDF Services share link. */
  fileUrls?: string[];
  /** `inputType: "base64"` — the file bodies, positionally paired with `fileNames`. */
  base64FileString?: string[];
  fileNames?: string[];
  signers: ESignSigner[];
  fields?: ESignField[];
  /** Returns a URL to sign in-page instead of mailing a link and waiting. */
  createEmbeddedSigningSession?: boolean;
  embeddedSignersEmailIds?: string[];
  /** Bind to the AcroForm fields already in the PDF instead of placing coords. */
  processAcroFields?: boolean;
  ccEmailIds?: string[];
  isOrdered?: boolean;
}

export interface EmbeddedSigningSession {
  emailId: string | null;
  /**
   * Points at the legacy host even when the folder was created through the
   * gateway. That is expected, and rewriting the host breaks signing, so this
   * value is passed through byte for byte.
   */
  embeddedSessionURL: string;
}

export interface CreateFolderResponse {
  folderId: string;
  folderName: string | null;
  status: string | null;
  embeddedSigningSessions: EmbeddedSigningSession[];
  /** The raw body, kept because the evidence bundle quotes vendor responses. */
  raw: unknown;
}

export interface FolderStatus {
  folderId: string;
  status: string;
  completed: boolean;
  completedAt: string | null;
  raw: unknown;
}

/**
 * What comes back from a completed folder: one ZIP holding every signed
 * document and the certificate of completion. There is no separate certificate
 * endpoint, so the certificate is found by unpacking, not by a second call.
 */
export interface CompletedFolderContents {
  documents: { fileName: string; bytes: Uint8Array }[];
  certificate: { fileName: string; bytes: Uint8Array } | null;
  /** Every entry name in the archive, so an unexpected layout is diagnosable. */
  entryNames: string[];
}

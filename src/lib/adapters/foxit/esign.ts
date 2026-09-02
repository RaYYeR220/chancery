/**
 * Foxit eSign. The credential in this file is the one no agent ever holds.
 *
 * Four things about eSign shape this client, and each of them is a way to fail
 * silently rather than loudly:
 *
 * 1. **There is no draft.** `sendDraftFolder` does not exist on the gateway —
 *    zero hits in the spec — so the usual "create with sendNow:false, let a
 *    human approve, then send" gate is not available. An envelope is created
 *    and dispatched in one `createfolder` call or it does not exist. That is
 *    not a limitation we worked around; it is the reason the approval moved in
 *    front of the eSign call entirely. Nothing here can be called speculatively,
 *    so nothing here is called before a human has acted.
 *
 * 2. **Two front doors, two failure conventions.** The gateway returns honest
 *    401/400. The legacy host returns **HTTP 200 with `{"result":"error"}`**,
 *    so `response.ok` is not a success signal (see `http.ts`). Host and prefix
 *    also move together: `na1.foxitesign.foxit.com` with the gateway's
 *    `/esign/api/v1` prefix answers a Tomcat 404, a combination Foxit's own
 *    blog publishes. They are therefore one `surface` value here, never two
 *    settings, and a mismatched pair is rejected in the constructor.
 *
 * 3. **A field with a missing required key vanishes.** The request succeeds,
 *    the envelope goes out, and the signer finds nowhere to sign. Since the API
 *    will never tell us, every field is validated before the call — including
 *    that its 1-based `party` matches a signer that actually exists.
 *
 * 4. **Completion is a ZIP.** The signed PDFs and the certificate of completion
 *    come back in one archive; there is no separate certificate endpoint. So
 *    the certificate is found by unpacking, not by a second request.
 */

import JSZip from "jszip";

import { FoxitError, FoxitFieldError, FoxitSurfaceError } from "./errors";
import { FoxitHttp } from "./http";
import type {
  CompletedFolderContents,
  CreateFolderRequest,
  CreateFolderResponse,
  EmbeddedSigningSession,
  ESignCredentials,
  ESignField,
  ESignLegacyCredentials,
  ESignSurface,
  ESignSurfaceSpec,
  FetchLike,
  FolderStatus,
} from "./types";

/**
 * Host and prefix as one value. Splitting them into two options is precisely
 * the mistake that produces a Tomcat 404 against a path that exists.
 */
export const ESIGN_SURFACES: Record<ESignSurface, ESignSurfaceSpec> = {
  gateway: { baseUrl: "https://na1.fusion.foxit.com", prefix: "/esign/api/v1" },
  legacy: { baseUrl: "https://na1.foxitesign.foxit.com", prefix: "/api/v1" },
};

/**
 * Operation names, not full paths, so the surface prefix is applied in exactly
 * one place. `createfolder` is the one confirmed present in the gateway spec;
 * the other two are overridable for the same reason the PDF Services paths are.
 */
export const ESIGN_OPERATIONS = {
  createFolder: "createfolder",
  folderStatus: "getfolderstatus",
  downloadDocuments: "downloadfolderdocuments",
} as const;

export type ESignOperations = typeof ESIGN_OPERATIONS;

/** Every key eSign needs to render a field. Any omission removes the field. */
export const REQUIRED_FIELD_KEYS: readonly (keyof ESignField)[] = [
  "documentNumber",
  "pageNumber",
  "party",
  "type",
  "x",
  "y",
  "width",
  "height",
];

/** eSign spells "done" several ways depending on surface and account age. */
const COMPLETED_STATUSES = new Set([
  "COMPLETED",
  "COMPLETE",
  "EXECUTED",
  "SIGNED",
  "FINISHED",
]);

export type ESignAuth =
  | { surface: "gateway"; credentials: ESignCredentials }
  | { surface: "legacy"; credentials: ESignLegacyCredentials };

export interface FoxitESignOptions {
  auth: ESignAuth;
  /** Overrides the surface's host. The prefix still comes from the surface. */
  baseUrl?: string;
  operations?: Partial<ESignOperations>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export class FoxitESignClient {
  readonly surface: ESignSurface;
  readonly baseUrl: string;
  readonly prefix: string;

  private readonly http: FoxitHttp;
  private readonly operations: ESignOperations;

  constructor(options: FoxitESignOptions) {
    const spec = ESIGN_SURFACES[options.auth.surface];
    this.surface = options.auth.surface;
    this.baseUrl = (options.baseUrl ?? spec.baseUrl).replace(/\/+$/, "");
    this.prefix = spec.prefix;
    assertSurfacePairing(this.surface, this.baseUrl, this.prefix);

    this.operations = { ...ESIGN_OPERATIONS, ...options.operations };
    this.http = new FoxitHttp({
      baseUrl: this.baseUrl,
      headers: headersFor(options.auth),
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      guardPath: (path) => {
        if (!path.startsWith(`${this.prefix}/`)) {
          throw new FoxitSurfaceError(
            `${path} does not belong to the ${this.surface} surface (${this.prefix})`,
            this.surface,
            { path },
          );
        }
      },
    });
  }

  /**
   * The single irreversible call in this codebase's Foxit integration.
   *
   * It mails the signer and cannot be recalled, so it is deliberately the only
   * method here that takes a whole request object: there is no partial form of
   * it to build up incrementally and accidentally fire.
   */
  async createFolder(
    request: CreateFolderRequest,
    signal?: AbortSignal,
  ): Promise<CreateFolderResponse> {
    assertSendableRequest(request);

    const body = await this.http.json<unknown>({
      method: "POST",
      path: this.path(this.operations.createFolder),
      json: request,
      signal,
    });

    const source = readObject(body, "data") ?? body;
    const folderId =
      readString(source, "folderId") ??
      readString(source, "folderid") ??
      readString(source, "id");
    if (folderId === null) {
      throw new FoxitError(
        "createfolder returned no folderId, so the envelope cannot be tracked",
        "MALFORMED_RESPONSE",
        { path: this.path(this.operations.createFolder), body },
      );
    }

    return {
      folderId,
      folderName: readString(source, "folderName"),
      status: readString(source, "status"),
      embeddedSigningSessions: readEmbeddedSessions(source),
      raw: body,
    };
  }

  /**
   * Cheap enough to call from a webhook handler, expensive enough that polling
   * it burns the sandbox's 15 requests a minute. Webhooks are the intended path.
   */
  async getFolderStatus(folderId: string, signal?: AbortSignal): Promise<FolderStatus> {
    const body = await this.http.json<unknown>({
      method: "GET",
      path: this.path(this.operations.folderStatus),
      query: { folderId },
      signal,
    });
    const source = readObject(body, "data") ?? body;
    const status = readString(source, "status") ?? readString(source, "folderStatus") ?? "UNKNOWN";
    return {
      folderId: readString(source, "folderId") ?? folderId,
      status,
      completed: isCompletedStatus(status),
      completedAt:
        readString(source, "completedDate") ??
        readString(source, "completedAt") ??
        readString(source, "lastModifiedDate"),
      raw: body,
    };
  }

  /**
   * Downloads the completion archive and unpacks it.
   *
   * Returning the raw ZIP would push the "which entry is the certificate?"
   * question onto every caller, and getting it wrong means storing the audit
   * trail as the instrument.
   */
  async downloadCompleted(
    folderId: string,
    signal?: AbortSignal,
  ): Promise<CompletedFolderContents> {
    const archive = await this.http.binary({
      method: "GET",
      path: this.path(this.operations.downloadDocuments),
      query: { folderId },
      headers: { accept: "application/zip" },
      signal,
    });
    return unpackCompletedFolder(archive.bytes);
  }

  private path(operation: string): string {
    return `${this.prefix}/${operation}`;
  }
}

/**
 * Rejects the published-but-broken host/prefix combination before it costs
 * anyone an afternoon against a Tomcat error page.
 */
export function assertSurfacePairing(
  surface: ESignSurface,
  baseUrl: string,
  prefix: string,
): void {
  const host = hostOf(baseUrl);
  const looksLikeGateway = host.includes("fusion.");
  const looksLikeLegacy = host.includes("foxitesign.");

  if (looksLikeGateway && prefix !== ESIGN_SURFACES.gateway.prefix) {
    throw new FoxitSurfaceError(
      `${host} is the fusion gateway and only answers ${ESIGN_SURFACES.gateway.prefix}, not ${prefix}`,
      surface,
    );
  }
  if (looksLikeLegacy && prefix !== ESIGN_SURFACES.legacy.prefix) {
    throw new FoxitSurfaceError(
      `${host} is the legacy eSign host and only answers ${ESIGN_SURFACES.legacy.prefix}; ` +
        `${prefix} there returns a Tomcat 404 even though the path exists on the gateway`,
      surface,
    );
  }
}

/**
 * Everything that has to be true before an envelope is worth sending. Each
 * check corresponds to a way eSign accepts the request and then quietly does
 * something useless with it.
 */
export function assertSendableRequest(request: CreateFolderRequest): void {
  if (request.signers.length === 0) {
    throw new FoxitError("an envelope with no signers can never complete", "INVALID_REQUEST");
  }
  if (request.inputType === "url") {
    if ((request.fileUrls ?? []).length === 0) {
      throw new FoxitError(
        'inputType "url" needs at least one entry in fileUrls',
        "INVALID_REQUEST",
      );
    }
  } else {
    const files = request.base64FileString ?? [];
    const names = request.fileNames ?? [];
    if (files.length === 0) {
      throw new FoxitError(
        'inputType "base64" needs at least one entry in base64FileString',
        "INVALID_REQUEST",
      );
    }
    if (files.length !== names.length) {
      throw new FoxitError(
        `base64FileString and fileNames are positional and must be the same length (${files.length} vs ${names.length})`,
        "INVALID_REQUEST",
      );
    }
  }

  if (request.createEmbeddedSigningSession === true) {
    const embedded = request.embeddedSignersEmailIds ?? [];
    if (embedded.length === 0) {
      throw new FoxitError(
        "createEmbeddedSigningSession without embeddedSignersEmailIds returns no session URL",
        "INVALID_REQUEST",
      );
    }
    const signerEmails = new Set(request.signers.map((signer) => signer.emailId.toLowerCase()));
    for (const email of embedded) {
      if (!signerEmails.has(email.toLowerCase())) {
        throw new FoxitError(
          `${email} is listed as an embedded signer but is not one of the signers`,
          "INVALID_REQUEST",
        );
      }
    }
  }

  validateFields(request.fields ?? [], request.signers.length);
}

/**
 * `party` is 1-based and indexes the signer list; a field pointing at a party
 * that does not exist is dropped as silently as one missing a coordinate.
 */
export function validateFields(fields: ESignField[], signerCount: number): void {
  fields.forEach((field, index) => {
    const missing = REQUIRED_FIELD_KEYS.filter((key) => {
      const value = field[key];
      if (value === undefined || value === null) return true;
      return typeof value === "number" ? !Number.isFinite(value) : String(value).length === 0;
    });
    if (missing.length > 0) {
      throw new FoxitFieldError(
        `field ${index} is missing ${missing.join(", ")}; eSign would drop it without an error`,
        index,
        missing as string[],
      );
    }
    for (const key of ["documentNumber", "pageNumber", "party"] as const) {
      if (!Number.isInteger(field[key]) || field[key] < 1) {
        throw new FoxitFieldError(
          `field ${index} has ${key}=${field[key]}; these are 1-based indices, not offsets`,
          index,
          [key],
        );
      }
    }
    if (field.party > signerCount) {
      throw new FoxitFieldError(
        `field ${index} is assigned to party ${field.party} but only ${signerCount} signer(s) were given`,
        index,
        ["party"],
      );
    }
  });
}

export function isCompletedStatus(status: string): boolean {
  return COMPLETED_STATUSES.has(status.trim().toUpperCase());
}

/**
 * Splits the completion archive into the instrument and its certificate.
 *
 * The certificate is matched by name because that is all the archive gives us;
 * anything not matched is treated as a signed document, so an unexpected
 * archive layout produces a document we can still hash rather than a null.
 */
export async function unpackCompletedFolder(
  zipBytes: Uint8Array,
): Promise<CompletedFolderContents> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBytes);
  } catch (cause) {
    throw new FoxitError(
      "the completed-folder download was not a readable ZIP archive",
      "MALFORMED_RESPONSE",
      { cause, body: `${zipBytes.length} bytes` },
    );
  }

  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const documents: { fileName: string; bytes: Uint8Array }[] = [];
  let certificate: { fileName: string; bytes: Uint8Array } | null = null;

  for (const entry of entries) {
    const bytes = await entry.async("uint8array");
    if (certificate === null && CERTIFICATE_NAME.test(entry.name)) {
      certificate = { fileName: entry.name, bytes };
      continue;
    }
    documents.push({ fileName: entry.name, bytes });
  }

  return { documents, certificate, entryNames: entries.map((entry) => entry.name) };
}

const CERTIFICATE_NAME = /certificat|completion|audit[-_ ]?trail/i;

function headersFor(auth: ESignAuth): () => Promise<Record<string, string>> {
  if (auth.surface === "gateway") {
    const { clientId, clientSecret } = auth.credentials;
    if (clientId.length === 0 || clientSecret.length === 0) {
      throw new FoxitError(
        "eSign gateway credentials must carry both client_id and client_secret",
        "INVALID_ARGUMENT",
      );
    }
    return async () => ({ client_id: clientId, client_secret: clientSecret });
  }
  const { accessToken } = auth.credentials;
  return async () => ({
    authorization: `Bearer ${typeof accessToken === "function" ? await accessToken() : accessToken}`,
  });
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Passed through byte for byte. The URL points at the legacy host even when
 * the folder was created through the gateway; rewriting it to the calling host
 * makes signing fail with no error anybody sees.
 */
function readEmbeddedSessions(source: unknown): EmbeddedSigningSession[] {
  const list = isRecord(source) ? source.embeddedSigningSessions : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const url = readString(entry, "embeddedSessionURL") ?? readString(entry, "embeddedSessionUrl");
    if (url === null) return [];
    return [{ emailId: readString(entry, "emailId"), embeddedSessionURL: url }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readObject(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function readString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const found = value[key];
  return typeof found === "string" && found.length > 0 ? found : null;
}

/**
 * `SignatureService`, backed by Foxit.
 *
 * The port it implements has no method that signs, and this implementation
 * cannot add one: Foxit will not produce a signature without a human at the
 * other end of an emailed or embedded session. What this class does is the two
 * things either side of that — hand a person a URL, and collect what they
 * signed.
 *
 * The flow is deliberately not "create a draft, wait for approval, send the
 * draft". That flow is unavailable (`sendDraftFolder` has zero hits in the
 * gateway spec) and it is also the weaker design, because a draft that exists
 * is a thing an agent with credentials could send. Here the whole reversible
 * half runs first — generate, upload, share link — and the envelope simply does
 * not exist until `requestSignature` fires the one `createfolder`.
 *
 * `approvals` is the second gate and it is bound to bytes, not to a workflow
 * step. An approval records the base64url sha256 of the exact PDF a human read;
 * `requestSignature` re-hashes what it was handed and refuses anything else, so
 * editing a single byte of the writ after approval revokes the approval. Pass
 * `null` to run without it — the credential boundary in `agent-surface.ts`
 * still stands — but that has to be written out, because a safety gate that
 * defaults on is a gate nobody knows is there.
 */

import { documentHash } from "../../core/bytes";
import type {
  SignatureService,
  SignedDocument,
  SigningRequest,
  SigningSession,
} from "../../service/ports";

import { FoxitApprovalRequiredError, FoxitError } from "./errors";
import type { FoxitESignClient } from "./esign";
import type { FoxitPdfServicesClient } from "./pdf-services";
import type { CreateFolderRequest, ESignField, ESignSigner } from "./types";

export interface ApprovalRecord {
  /** base64url sha256 of the exact bytes the human read. */
  documentHash: string;
  /** The share link they read them at, reused so the sent file is that file. */
  shareUrl: string;
  approvedBy: string;
  approvedAt: string;
}

export interface ApprovalRegistry {
  find(documentHash: string): Promise<ApprovalRecord | null>;
  /** Only ever used to make a refusal auditable rather than merely a refusal. */
  hashes(): Promise<string[]>;
}

/** Enough of a registry for a demo and for tests; production keeps these in the store. */
export class InMemoryApprovalRegistry implements ApprovalRegistry {
  private readonly records = new Map<string, ApprovalRecord>();

  approve(
    bytes: Uint8Array,
    details: { shareUrl: string; approvedBy: string; approvedAt: string },
  ): ApprovalRecord {
    const record: ApprovalRecord = { documentHash: documentHash(bytes), ...details };
    this.records.set(record.documentHash, record);
    return record;
  }

  async find(hash: string): Promise<ApprovalRecord | null> {
    return this.records.get(hash) ?? null;
  }

  async hashes(): Promise<string[]> {
    return [...this.records.keys()];
  }
}

export interface FoxitSignatureServiceOptions {
  /** Reversible half: upload and share link. Also handed to the agent surface. */
  pdf: FoxitPdfServicesClient;
  /** Irreversible half. Constructing this needs a credential no agent holds. */
  esign: FoxitESignClient;
  /** `null` is an explicit opt-out, not a default. */
  approvals: ApprovalRegistry | null;
  /**
   * Where the signature block goes. Coordinates are pixels from the top-left of
   * the page and the indices are 1-based; the default puts one signature and
   * one date field low on page one of document one.
   */
  fieldsFor?: (request: SigningRequest) => ESignField[];
  /**
   * Foxit does not tell us when an embedded session URL dies, so this is our
   * bound rather than theirs: after it, re-request rather than trusting a stale
   * URL that will fail in a browser with no error we can see.
   */
  sessionTtlMs?: number;
  clock?: () => Date;
  /** Bind the AcroForm fields already in the PDF instead of placing coordinates. */
  useAcroFields?: boolean;
}

export class FoxitSignatureService implements SignatureService {
  private readonly options: FoxitSignatureServiceOptions;
  private readonly clock: () => Date;

  constructor(options: FoxitSignatureServiceOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Sends the writ. This is the moment the envelope starts existing, and there
   * is no earlier moment at which it half-exists.
   */
  async requestSignature(request: SigningRequest): Promise<SigningSession> {
    const hash = documentHash(request.document.bytes);
    const approval = await this.requireApproval(hash);

    // Reuse the approved share link when there is one: re-uploading would put a
    // second copy behind a second URL, and then the thing that gets signed is
    // not literally the thing that was approved.
    const shareUrl = approval?.shareUrl ?? (await this.publishForSigning(request));

    const folder: CreateFolderRequest = {
      folderName: request.subject,
      emailSubject: request.subject,
      sendNow: true,
      inputType: "url",
      fileUrls: [shareUrl],
      signers: [signerFrom(request)],
      createEmbeddedSigningSession: true,
      embeddedSignersEmailIds: [request.signerEmail],
      ...(this.options.useAcroFields === true
        ? { processAcroFields: true }
        : { fields: (this.options.fieldsFor ?? defaultFields)(request) }),
    };

    const created = await this.options.esign.createFolder(folder);
    const session = created.embeddedSigningSessions[0];
    if (session === undefined) {
      throw new FoxitError(
        `folder ${created.folderId} was created but carried no embeddedSigningSessions, so there is no URL to send a human to`,
        "MALFORMED_RESPONSE",
        { body: created.raw },
      );
    }

    return {
      envelopeId: created.folderId,
      // Verbatim. It points at the legacy host even though we called the
      // gateway, and rewriting the host silently breaks signing.
      signingUrl: session.embeddedSessionURL,
      expiresAt: new Date(
        this.clock().getTime() + (this.options.sessionTtlMs ?? 24 * 60 * 60 * 1000),
      ).toISOString(),
    };
  }

  /**
   * Null until a human has actually finished. Returning a half-signed document
   * would let the rest of the engine treat an unexecuted writ as authority.
   */
  async fetchCompleted(envelopeId: string): Promise<SignedDocument | null> {
    const status = await this.options.esign.getFolderStatus(envelopeId);
    if (!status.completed) return null;

    const contents = await this.options.esign.downloadCompleted(envelopeId);
    const signed = contents.documents[0];
    if (signed === undefined) {
      throw new FoxitError(
        `folder ${envelopeId} reported ${status.status} but its archive held no signed document (entries: ${contents.entryNames.join(", ") || "none"})`,
        "MALFORMED_RESPONSE",
      );
    }

    return {
      envelopeId,
      bytes: signed.bytes,
      // The hash the rest of the system anchors in DNS. Taken from the bytes we
      // were handed, never from a field in a vendor response.
      sha256: documentHash(signed.bytes),
      signedAt: status.completedAt ?? this.clock().toISOString(),
      certificate: contents.certificate?.bytes,
    };
  }

  /**
   * Structural, not cryptographic. See `inspectPdfSignature` — we have no
   * verification credential, so this reports what the bytes themselves prove.
   */
  async verifySignature(bytes: Uint8Array): Promise<{
    verified: boolean;
    method: string;
    profile?: string;
  }> {
    return inspectPdfSignature(bytes);
  }

  private async requireApproval(hash: string): Promise<ApprovalRecord | null> {
    const { approvals } = this.options;
    if (approvals === null) return null;

    const record = await approvals.find(hash);
    if (record === null) {
      throw new FoxitApprovalRequiredError(
        `no human approval is on record for document ${hash}; nothing will be sent`,
        hash,
        await approvals.hashes(),
      );
    }
    return record;
  }

  private async publishForSigning(request: SigningRequest): Promise<string> {
    const uploaded = await this.options.pdf.upload({
      fileName: fileNameFor(request),
      bytes: request.document.bytes,
      contentType: request.document.contentType,
    });
    const link = await this.options.pdf.createShareLink(uploaded.documentId);
    return link.url;
  }
}

/**
 * What the bytes themselves can prove about a signature.
 *
 * `verified` means: there is a signature dictionary, and its `/ByteRange`
 * covers the whole file. The second half is the part that matters — a
 * `/ByteRange` that stops short of the end is the classic incremental-update
 * forgery, where content was appended after signing and every naive check still
 * reports "signed".
 *
 * What this deliberately does not claim is that the PKCS#7 blob validates
 * against a trusted chain. That needs a verification service we hold no
 * credential for, and asserting it from a regex would be exactly the kind of
 * comfortable lie this whole codebase exists to avoid.
 */
export function inspectPdfSignature(bytes: Uint8Array): {
  verified: boolean;
  method: string;
  profile?: string;
} {
  const byteRange = readByteRange(bytes);
  const subFilter = readNameAfter(bytes, "/SubFilter");
  const hasSigDict =
    indexOfBytes(bytes, ascii("/Type/Sig")) >= 0 ||
    indexOfBytes(bytes, ascii("/Type /Sig")) >= 0 ||
    subFilter !== null;

  if (byteRange === null || !hasSigDict) {
    return {
      verified: false,
      method: "pdf-signature-dictionary/absent",
      ...(subFilter === null ? {} : { profile: subFilter }),
    };
  }

  const [start, , gapStart, gapLength] = byteRange;
  // A trailing newline after `%%EOF` is normal; anything larger is content the
  // signature does not cover.
  const covered = start === 0 && Math.abs(gapStart + gapLength - bytes.length) <= 2;

  return {
    verified: covered,
    method: covered
      ? "pdf-signature-dictionary/byterange-covers-document"
      : "pdf-signature-dictionary/byterange-leaves-document-uncovered",
    ...(subFilter === null ? {} : { profile: subFilter }),
  };
}

function signerFrom(request: SigningRequest): ESignSigner {
  const parts = request.signerName.trim().split(/\s+/);
  return {
    emailId: request.signerEmail,
    firstName: parts[0] ?? request.signerName,
    lastName: parts.slice(1).join(" ") || undefined,
    party: 1,
    signerType: "signer",
  };
}

/** One signature and one date, low on page one, in pixels from the top-left. */
function defaultFields(): ESignField[] {
  return [
    {
      documentNumber: 1,
      pageNumber: 1,
      party: 1,
      type: "signature",
      x: 72,
      y: 620,
      width: 220,
      height: 44,
      required: true,
      name: "principal_signature",
    },
    {
      documentNumber: 1,
      pageNumber: 1,
      party: 1,
      type: "date",
      x: 320,
      y: 620,
      width: 140,
      height: 44,
      required: true,
      name: "principal_signed_on",
    },
  ];
}

function fileNameFor(request: SigningRequest): string {
  const base = request.subject.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return `${base.length > 0 ? base : "writ"}.pdf`;
}

/* ------------------------------------------------------------ pdf scanning */

const encoder = new TextEncoder();

function ascii(text: string): Uint8Array {
  return encoder.encode(text);
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** `/ByteRange [ a b c d ]`, read as four integers or not at all. */
function readByteRange(bytes: Uint8Array): [number, number, number, number] | null {
  const at = indexOfBytes(bytes, ascii("/ByteRange"));
  if (at < 0) return null;
  const window = decodeAscii(bytes, at, Math.min(at + 160, bytes.length));
  const match = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(window);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

/** The PDF name token after `key`, e.g. `ETSI.CAdES.detached`. */
function readNameAfter(bytes: Uint8Array, key: string): string | null {
  const at = indexOfBytes(bytes, ascii(key));
  if (at < 0) return null;
  const window = decodeAscii(bytes, at, Math.min(at + 80, bytes.length));
  const match = new RegExp(`${key}\\s*/([^\\s/<>\\[\\]()]+)`).exec(window);
  return match === null ? null : match[1];
}

function decodeAscii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

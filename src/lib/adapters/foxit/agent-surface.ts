/**
 * The boundary, made structural.
 *
 * ── The argument ──────────────────────────────────────────────────────────
 *
 * Foxit left signing out of their MCP catalogue and invited entrants to argue
 * about where the line belongs. We think the line is drawn in the wrong place
 * and, more importantly, enforced in the wrong way.
 *
 * **Wrong place: the line is not "signing", it is irreversibility.** "Signing"
 * is a tool category, and categories do not survive contact with a real
 * workflow. Registering a domain is not signing, and it spends money that
 * cannot be refunded. Publishing a document is not signing, and it cannot be
 * unpublished. Meanwhile plenty of eSign surface is perfectly safe: reading a
 * folder's status, downloading a completed envelope, listing templates. Draw
 * the line at the tool category and you gate harmless reads while leaving
 * genuinely irreversible non-signing acts wide open. Draw it at
 * irreversibility — can this act be undone, and does an outside party learn
 * something the moment it happens? — and it lands where the risk actually is.
 * Chancery's `ActKind` enumerates exactly those acts; sending for signature is
 * one entry in it, not the definition of it.
 *
 * **Wrong way: a procedural boundary is a suggestion.** The common design is a
 * privileged agent that has the signing credential and a rule telling it not to
 * use the credential without approval — a system prompt, a tool description, a
 * confirmation step, a policy check before the call. Every one of those lives
 * inside the thing being restrained. A prompt injection, a retry loop, a
 * refactor, or a model that simply reasons its way past the instruction all
 * defeat it, and defeat it silently. The failure mode of a procedural boundary
 * is that it appears to hold right up until it doesn't.
 *
 * So the boundary here is structural. The agent-facing object is not *told* not
 * to sign; it is *unable* to. It holds a `FoxitPdfServicesClient` built from
 * `PdfServicesCredentials`, and:
 *
 *   - Every member of `AgentSurface` is a function. There is no data field on
 *     it at all, so there is no field an eSign credential could sit in — and
 *     that is checked by the compiler, not by review (`AGENT_SURFACE_HOLDS_NO_DATA`).
 *   - No member reaches eSign. The PDF Services client's transport runs
 *     `assertReversiblePath` on every assembled path, so even a caller-supplied
 *     document id crafted to traverse onto `/esign/` is refused before it is
 *     sent.
 *   - The credential types are discriminated (`scope: "pdf-services"` vs
 *     `scope: "esign"`). Handing an eSign secret to this constructor does not
 *     typecheck. It can be forced — TypeScript is structural — but only by
 *     writing `scope: "esign"` at the call site, which is a deliberate,
 *     greppable act rather than a wiring mistake.
 *   - And underneath all of that, the credential itself is not eSign-entitled.
 *     A PDF Services key from developer-api.foxit.com is not an eSign key, so
 *     an agent that bypasses every line above and hand-rolls `fetch` gets a
 *     **401 from Foxit**, not a refusal from us.
 *
 * That last point is the one that makes the argument checkable instead of
 * merely asserted, which is what `proveESignIsUnreachable` is for. It fires a
 * real `createfolder` with no eSign credential and reports what Foxit said. It
 * contains no branch that refuses locally — if it returned a polite refusal of
 * our own, the demo would prove nothing.
 *
 * ── What stays on this side ───────────────────────────────────────────────
 *
 * Note that `createShareLink` is on the agent surface. The share link is the
 * only bridge to eSign, and the agent is allowed to build it, because building
 * a bridge commits nobody: a share link mails no one, binds no one, and can be
 * regenerated or ignored. Only the credential on the far side can cross it, and
 * that credential lives in the backend the human's approval runs through. The
 * agent prepares everything up to the irreversible step and then stops, not
 * because it decided to, but because there is nothing further it can do.
 */

import { FoxitError } from "./errors";
import { ESIGN_OPERATIONS, ESIGN_SURFACES } from "./esign";
import { FoxitPdfServicesClient } from "./pdf-services";
import type {
  DocGenRequest,
  DocGenResult,
  ESignSurface,
  FetchLike,
  FoxitBinary,
  FoxitDocumentRef,
  FoxitFile,
  PdfConversionSource,
  PdfConversionTarget,
  PdfServicesCredentials,
  ShareLink,
} from "./types";

/**
 * Everything an agent may do to a document, and nothing else.
 *
 * Members are functions, deliberately and exhaustively. The PDF Services client
 * lives in a closure rather than on a property, so the surface exposes no
 * handle that could be reached through, and no slot a secret could occupy.
 */
export interface AgentSurface {
  readonly uploadDocument: (file: FoxitFile) => Promise<FoxitDocumentRef>;
  readonly generateDocument: (request: DocGenRequest) => Promise<DocGenResult>;
  readonly convertToPdf: (
    source: PdfConversionSource,
    documentId: string,
  ) => Promise<FoxitDocumentRef>;
  readonly convertFromPdf: (
    target: PdfConversionTarget,
    documentId: string,
  ) => Promise<FoxitDocumentRef>;
  readonly compressDocument: (
    documentId: string,
    level?: "LOW" | "MEDIUM" | "HIGH",
  ) => Promise<FoxitDocumentRef>;
  readonly combineDocuments: (documentIds: string[]) => Promise<FoxitDocumentRef>;
  readonly extractFromDocument: (
    documentId: string,
    kind?: "TEXT" | "IMAGE" | "PAGE",
  ) => Promise<FoxitDocumentRef>;
  readonly downloadDocument: (documentId: string) => Promise<FoxitBinary>;
  /** Reversible: it publishes a URL. Crossing it needs a credential we do not hold. */
  readonly createShareLink: (documentId: string) => Promise<ShareLink>;
}

/* ------------------------------------------------------- compile-time proof */

type EveryMemberIsAFunction<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? true : false;
}[keyof T];

/** `false` the moment anyone adds a data field to `AgentSurface`. */
export type AgentSurfaceHoldsOnlyFunctions =
  [EveryMemberIsAFunction<AgentSurface>] extends [true] ? true : false;

/**
 * Names a credential would plausibly arrive under. Listed so the check below
 * fails on the *shape* of a mistake, not only on a field literally called
 * `esign`.
 */
type CredentialBearingKey =
  | "esign"
  | "eSign"
  | "esignClient"
  | "signatures"
  | "signatureService"
  | "credentials"
  | "clientSecret"
  | "client_secret"
  | "accessToken"
  | "token"
  | "secret"
  | "auth";

export type AgentSurfaceCanReachESign =
  [Extract<keyof AgentSurface, CredentialBearingKey>] extends [never] ? false : true;

/**
 * These two constants are the proof, and they are constants rather than tests
 * so the proof lives in the shipped artefact: adding a `clientSecret` field or
 * an eSign client to `AgentSurface` stops the build, not just the suite.
 */
export const AGENT_SURFACE_HOLDS_NO_DATA: AgentSurfaceHoldsOnlyFunctions = true;
export const AGENT_SURFACE_CANNOT_REACH_ESIGN: AgentSurfaceCanReachESign extends false
  ? true
  : never = true;

/* ---------------------------------------------------------- construction */

export interface AgentSurfaceOptions {
  /** An eSign secret does not typecheck here. That is the whole point. */
  credentials: PdfServicesCredentials;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function createAgentSurface(options: AgentSurfaceOptions): AgentSurface {
  return agentSurfaceFrom(new FoxitPdfServicesClient(options));
}

/**
 * Wraps an existing client, so the signature service and the agent can share
 * one PDF Services connection without the agent ever holding the object — the
 * client is captured by the closures and is unreachable from the returned value.
 */
export function agentSurfaceFrom(pdf: FoxitPdfServicesClient): AgentSurface {
  return Object.freeze({
    uploadDocument: (file: FoxitFile) => pdf.upload(file),
    generateDocument: (request: DocGenRequest) => pdf.generateDocument(request),
    convertToPdf: (source: PdfConversionSource, documentId: string) =>
      pdf.runToDocument(pdf.createPdfFrom(source, documentId)),
    convertFromPdf: (target: PdfConversionTarget, documentId: string) =>
      pdf.runToDocument(pdf.convertPdfTo(target, documentId)),
    compressDocument: (documentId: string, level: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM") =>
      pdf.runToDocument(pdf.compress(documentId, level)),
    combineDocuments: (documentIds: string[]) => pdf.runToDocument(pdf.combine(documentIds)),
    extractFromDocument: (documentId: string, kind: "TEXT" | "IMAGE" | "PAGE" = "TEXT") =>
      pdf.runToDocument(pdf.extract(documentId, kind)),
    downloadDocument: (documentId: string) => pdf.download(documentId),
    createShareLink: (documentId: string) => pdf.createShareLink(documentId),
  });
}

/** Runtime companion to the type-level proof, for the demo and for the suite. */
export function agentSurfaceMembers(surface: AgentSurface): {
  name: string;
  isFunction: boolean;
}[] {
  return Object.keys(surface).map((name) => ({
    name,
    isFunction: typeof (surface as unknown as Record<string, unknown>)[name] === "function",
  }));
}

/* --------------------------------------------------------- refusal proof */

export type RefusalAttempt = "no-credentials" | "pdf-services-credentials";

export type RefusalOutcome =
  /** Foxit answered, and the answer was a refusal. This is the demo working. */
  | "refused-by-foxit"
  /** Foxit answered a non-auth error. Suggestive, but not the proof we wanted. */
  | "other-foxit-error"
  /** Foxit accepted it. The boundary does not hold and we need to know today. */
  | "accepted-by-foxit"
  /** We never got an answer, so nothing is proved either way. */
  | "no-answer";

export interface ESignRefusalProof {
  attempt: RefusalAttempt;
  credentialsSent: "none" | "pdf-services";
  url: string;
  outcome: RefusalOutcome;
  status: number | null;
  /** Verbatim, capped only so a Tomcat page does not fill the terminal. */
  bodyText: string;
  /** The legacy host's 200-with-`{"result":"error"}` convention, when it applies. */
  bodyResult: string | null;
  transportError: string | null;
  at: string;
}

export interface RefusalProbeOptions {
  attempt: RefusalAttempt;
  /** Required for the `pdf-services-credentials` attempt, ignored otherwise. */
  credentials?: PdfServicesCredentials;
  surface?: ESignSurface;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

const BODY_CAP = 600;

/**
 * Fires a real eSign `createfolder` with no eSign credential, and reports what
 * Foxit said.
 *
 * Read the body of this function with the demo in mind: there is no branch that
 * declines locally, no allowlist, no "if (!credentials) throw". It builds the
 * URL, sends the request, and reports the answer. A refusal that came from our
 * own code would be worth nothing as evidence — the claim is that Foxit refuses
 * us, not that we refuse ourselves.
 *
 * It also does not go through `FoxitESignClient`, and could not: constructing
 * that requires an `ESignCredentials`, which is exactly the thing this is
 * demonstrating we do not have.
 */
export async function proveESignIsUnreachable(
  options: RefusalProbeOptions,
): Promise<ESignRefusalProof> {
  const surface = ESIGN_SURFACES[options.surface ?? "gateway"];
  const baseUrl = (options.baseUrl ?? surface.baseUrl).replace(/\/+$/, "");
  const url = `${baseUrl}${surface.prefix}/${ESIGN_OPERATIONS.createFolder}`;
  const at = (options.now ?? (() => new Date()))().toISOString();

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new FoxitError(
      "no fetch implementation available; pass fetchImpl",
      "INVALID_ARGUMENT",
    );
  }

  const credentialsSent = options.attempt === "no-credentials" ? "none" : "pdf-services";
  if (credentialsSent === "pdf-services" && options.credentials === undefined) {
    throw new FoxitError(
      "the pdf-services-credentials attempt needs the agent's own credentials to send",
      "INVALID_ARGUMENT",
    );
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (options.credentials !== undefined && credentialsSent === "pdf-services") {
    // The agent's own key, sent verbatim at eSign. It is not eSign-entitled,
    // which is the second, independent reason this call cannot succeed.
    headers.client_id = options.credentials.clientId;
    headers.client_secret = options.credentials.clientSecret;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      // Well-formed on purpose: a malformed body would earn a 400 that muddles
      // "you are not allowed" with "you typed it wrong".
      body: JSON.stringify({
        folderName: "chancery-boundary-probe",
        sendNow: true,
        inputType: "url",
        fileUrls: ["https://example.invalid/not-a-real-writ.pdf"],
        signers: [{ emailId: "nobody@example.invalid", firstName: "Nobody", party: 1 }],
      }),
      signal: controller.signal,
    });
  } catch (cause) {
    return {
      attempt: options.attempt,
      credentialsSent,
      url,
      outcome: "no-answer",
      status: null,
      bodyText: "",
      bodyResult: null,
      transportError: cause instanceof Error ? cause.message : String(cause),
      at,
    };
  } finally {
    clearTimeout(timer);
  }

  const bodyText = (await response.text()).slice(0, BODY_CAP);
  const bodyResult = resultField(bodyText);

  // Distinguishing "refused" from "got in and then complained" is the whole
  // job of this function, and the two look alike on this API.
  //
  //   401/403                                     refused, plainly
  //   400 + {"allow":false,"reason":"Missing ..."} refused by the gateway
  //   200 + {"result":"error","error_description":"fileNames cannot be empty"}
  //                                               NOT refused — that is a
  //                                               validation complaint, which
  //                                               means authentication passed
  //
  // An earlier version treated any {"result":"error"} as a refusal, and so
  // reported a proof that was not there. The legacy host does report auth
  // failures that way too, so the description has to be read: only an
  // auth-shaped one counts.
  const gatewayRefusal = /"allow"\s*:\s*false/.test(bodyText);
  const authShaped = /credential|unauthori[sz]|authenticat|invalid.{0,12}token|forbidden/i.test(
    bodyText,
  );
  const refused =
    response.status === 401 ||
    response.status === 403 ||
    (response.status === 400 && gatewayRefusal) ||
    (bodyResult === "error" && authShaped);

  // Reaching the endpoint and being told the request is malformed means the
  // caller is inside. That is an accepted call, however unsuccessful.
  const acceptedDespiteError = bodyResult === "error" && !authShaped;

  return {
    attempt: options.attempt,
    credentialsSent,
    url,
    outcome: refused
      ? "refused-by-foxit"
      : response.ok || acceptedDespiteError
        ? "accepted-by-foxit"
        : "other-foxit-error",
    status: response.status,
    bodyText,
    bodyResult,
    transportError: null,
    at,
  };
}

function resultField(bodyText: string): string | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed !== "object" || parsed === null) return null;
    const result = (parsed as Record<string, unknown>).result;
    return typeof result === "string" ? result.toLowerCase() : null;
  } catch {
    return null;
  }
}

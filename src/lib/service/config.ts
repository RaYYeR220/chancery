/**
 * Configuration, read from the environment and reported rather than assumed.
 *
 * The product has to run with zero credentials, which makes exactly one thing
 * dangerous: a missing credential that quietly turns into a weaker check. So
 * this file never invents a value that would loosen anything. `NAMECOM_ENV`
 * defaults to the sandbox because the sandbox spends no money;
 * `CHANCERY_ALLOW_UNAUTHENTICATED_DNS` defaults to false because true is the
 * setting that lets an unvalidated DNS answer grant authority, and a value we
 * cannot parse is not consent to relax it.
 *
 * Three states per service, because two would hide the interesting one:
 *
 *   configured  every variable the port needs is set — the vendor is used
 *   absent      none of them are set — an in-repo stand-in is used, and said so
 *   incomplete  some but not all — the operator meant to configure this and it
 *               will not work, which must never be reported the same way as a
 *               deliberate credential-free run
 *
 * Nothing here ever reads a value into the report. `present: boolean` is the
 * whole of what a status endpoint learns about a secret — not a length, not a
 * masked prefix, which is still a disclosure of a value nobody consented to
 * publish.
 */

/* -------------------------------------------------------------- port names */

export const PORTS = [
  "generator",
  "signatures",
  "extractor",
  "registry",
  "resolver",
  "diligence",
  "store",
] as const;

export type PortName = (typeof PORTS)[number];

/**
 * `misconfigured` is deliberately not a kind of `stand-in`. Both run the
 * stand-in; only one of them is what the operator asked for.
 */
export type PortMode = "live" | "stand-in" | "misconfigured";

/** A variable name and whether it is set. Never the value, in any form. */
export interface EnvVarStatus {
  name: string;
  present: boolean;
}

export interface PortStatus {
  port: PortName;
  /** Who does the work when this port is live. */
  vendor: string;
  role: string;
  mode: PortMode;
  /** The implementation actually wired for this port in this process. */
  implementation: string;
  /** Why it is in that mode, in words an operator can act on. */
  reason: string;
  requires: EnvVarStatus[];
  /** Read when set, but not needed for the port to be live. */
  optional: EnvVarStatus[];
}

export interface StatusReport {
  version: "chancery-status/1";
  /** True when no port is live and none is broken: the credential-free run. */
  standInThroughout: boolean;
  headline: string;
  ports: PortStatus[];
  settings: {
    documentBaseUrl: { value: string; configured: boolean };
    allowUnauthenticatedDns: { value: boolean; configured: boolean; note: string };
  };
  /** Configuration that parsed, but that an operator should know about. */
  warnings: string[];
}

/* ---------------------------------------------------------- service shapes */

export interface DoctavianSettings {
  baseUrl: string | null;
  bearerToken: string;
  documentsApiKey: string;
  /**
   * Empty when `DOCTAVIAN_SIGNATURES_KEY` is unset. The client scopes keys per
   * API area and the writ is generated entirely inside `/v1/documents/`, so a
   * blank signatures key can only fail a call this bridge never makes.
   */
  signaturesApiKey: string;
}

export interface FoxitSettings {
  pdfClientId: string;
  pdfClientSecret: string;
  esignClientId: string;
  esignClientSecret: string;
  esignBaseUrl: string | null;
}

export interface NutrientSettings {
  apiKey: string;
}

export type NameComEnvironmentName = "sandbox" | "production";

export interface NameComSettings {
  environment: NameComEnvironmentName;
  username: string;
  token: string;
}

export interface SerpApiSettings {
  apiKey: string;
}

export interface XanoSettings {
  baseUrl: string;
  token: string;
}

export type ServiceState = "configured" | "absent" | "incomplete";

export interface ServiceResolution<T> {
  state: ServiceState;
  /** Non-null only when `state` is `configured`. */
  value: T | null;
  requires: EnvVarStatus[];
  optional: EnvVarStatus[];
  /** Required names that are unset, for the reason line. */
  missing: string[];
}

export interface ChanceryConfig {
  doctavian: ServiceResolution<DoctavianSettings>;
  foxit: ServiceResolution<FoxitSettings>;
  nutrient: ServiceResolution<NutrientSettings>;
  namecom: ServiceResolution<NameComSettings>;
  serpapi: ServiceResolution<SerpApiSettings>;
  xano: ServiceResolution<XanoSettings>;
  documentBaseUrl: { value: string; configured: boolean };
  allowUnauthenticatedDns: { value: boolean; configured: boolean };
  warnings: string[];
}

export type EnvLike = Record<string, string | undefined>;

/** Nothing serves this, and it reads as a placeholder on purpose. */
export const DEFAULT_DOCUMENT_BASE_URL = "https://chancery.local/w";

/* -------------------------------------------------------------------- read */

export function readConfig(env: EnvLike = process.env): ChanceryConfig {
  const warnings: string[] = [];

  const doctavian = resolve<DoctavianSettings>(
    env,
    ["DOCTAVIAN_BEARER", "DOCTAVIAN_DOCUMENTS_KEY"],
    ["DOCTAVIAN_BASE_URL", "DOCTAVIAN_SIGNATURES_KEY"],
    (get) => ({
      baseUrl: get("DOCTAVIAN_BASE_URL"),
      bearerToken: get("DOCTAVIAN_BEARER") ?? "",
      documentsApiKey: get("DOCTAVIAN_DOCUMENTS_KEY") ?? "",
      signaturesApiKey: get("DOCTAVIAN_SIGNATURES_KEY") ?? "",
    }),
  );

  const foxit = resolve<FoxitSettings>(
    env,
    [
      "FOXIT_CLIENT_ID",
      "FOXIT_CLIENT_SECRET",
      "FOXIT_ESIGN_CLIENT_ID",
      "FOXIT_ESIGN_CLIENT_SECRET",
    ],
    ["FOXIT_ESIGN_BASE_URL"],
    (get) => ({
      pdfClientId: get("FOXIT_CLIENT_ID") ?? "",
      pdfClientSecret: get("FOXIT_CLIENT_SECRET") ?? "",
      esignClientId: get("FOXIT_ESIGN_CLIENT_ID") ?? "",
      esignClientSecret: get("FOXIT_ESIGN_CLIENT_SECRET") ?? "",
      esignBaseUrl: get("FOXIT_ESIGN_BASE_URL"),
    }),
  );

  const nutrient = resolve<NutrientSettings>(env, ["NUTRIENT_API_KEY"], [], (get) => ({
    apiKey: get("NUTRIENT_API_KEY") ?? "",
  }));

  const namecom = resolveNameCom(env, warnings);

  const serpapi = resolve<SerpApiSettings>(env, ["SERPAPI_KEY"], [], (get) => ({
    apiKey: get("SERPAPI_KEY") ?? "",
  }));

  const xano = resolve<XanoSettings>(env, ["XANO_BASE_URL", "XANO_TOKEN"], [], (get) => ({
    baseUrl: get("XANO_BASE_URL") ?? "",
    token: get("XANO_TOKEN") ?? "",
  }));

  return {
    doctavian,
    foxit,
    nutrient,
    namecom,
    serpapi,
    xano,
    documentBaseUrl: readDocumentBaseUrl(env, warnings),
    allowUnauthenticatedDns: readAllowUnauthenticatedDns(env, warnings),
    warnings,
  };
}

function readDocumentBaseUrl(
  env: EnvLike,
  warnings: string[],
): { value: string; configured: boolean } {
  const raw = read(env, "CHANCERY_DOCUMENT_BASE_URL");
  if (raw === null) {
    warnings.push(
      "CHANCERY_DOCUMENT_BASE_URL is unset, so signed writs are advertised under " +
        `${DEFAULT_DOCUMENT_BASE_URL}, which nothing serves. A verifier following the u= tag of ` +
        "a published record would find nothing there.",
    );
    return { value: DEFAULT_DOCUMENT_BASE_URL, configured: false };
  }

  const value = raw.replace(/\/+$/, "");
  // Both of these break anchoring rather than the document: the WRIT1 grammar
  // has no escape for `;`, and `parseWritRecord` refuses a non-https `u=`.
  if (!value.startsWith("https://")) {
    warnings.push(
      `CHANCERY_DOCUMENT_BASE_URL is ${describeScheme(value)}, and a WRIT1 record's u= tag must ` +
        "be an https URL. Anchoring will refuse this rather than publish it.",
    );
  }
  if (value.includes(";")) {
    warnings.push(
      "CHANCERY_DOCUMENT_BASE_URL contains a semicolon, which is the WRIT1 tag separator. " +
        "Anchoring will refuse this rather than publish a record that parses as two tags.",
    );
  }
  return { value, configured: true };
}

function describeScheme(value: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  return scheme === null ? "not a URL" : `an ${scheme[1]} URL`;
}

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

function readAllowUnauthenticatedDns(
  env: EnvLike,
  warnings: string[],
): { value: boolean; configured: boolean } {
  const raw = read(env, "CHANCERY_ALLOW_UNAUTHENTICATED_DNS");
  if (raw === null) return { value: false, configured: false };

  const normalised = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalised)) return { value: true, configured: true };
  if (FALSE_VALUES.has(normalised)) return { value: false, configured: true };

  // The unreadable case resolves to the strict setting on purpose: the only
  // thing this flag can do is let an unvalidated DNS answer grant authority,
  // and a value nobody can parse is not consent to that.
  warnings.push(
    "CHANCERY_ALLOW_UNAUTHENTICATED_DNS could not be read as a boolean, so it is off. " +
      "Authority from a DNS answer that was not DNSSEC-validated is refused.",
  );
  return { value: false, configured: false };
}

function resolveNameCom(env: EnvLike, warnings: string[]): ServiceResolution<NameComSettings> {
  const resolution = resolve<NameComSettings>(
    env,
    ["NAMECOM_USERNAME", "NAMECOM_TOKEN"],
    ["NAMECOM_ENV"],
    (get) => ({
      environment: (get("NAMECOM_ENV")?.trim().toLowerCase() ?? "sandbox") as NameComEnvironmentName,
      username: get("NAMECOM_USERNAME") ?? "",
      token: get("NAMECOM_TOKEN") ?? "",
    }),
  );

  const raw = read(env, "NAMECOM_ENV")?.trim().toLowerCase() ?? null;
  if (raw !== null && raw !== "sandbox" && raw !== "production") {
    // Guessing between "free test credit" and "real money" is not a default
    // anyone should ship, so an unrecognised value takes the registrar offline.
    warnings.push(
      "NAMECOM_ENV names neither sandbox nor production, so the registrar is treated as " +
        "misconfigured. The two differ by whether a registration spends real money.",
    );
    return { ...resolution, state: "incomplete", value: null, missing: ["NAMECOM_ENV"] };
  }
  if (raw === null && resolution.state === "configured") {
    warnings.push(
      "NAMECOM_ENV is unset, so the registrar runs against the sandbox. Sandbox registrations " +
        "are free, and sandbox DNS never resolves publicly, so a writ anchored there cannot be " +
        "verified from outside.",
    );
  }
  return resolution;
}

/* ---------------------------------------------------------------- plumbing */

function read(env: EnvLike, name: string): string | null {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resolve<T>(
  env: EnvLike,
  required: readonly string[],
  optional: readonly string[],
  build: (get: (name: string) => string | null) => T,
): ServiceResolution<T> {
  const get = (name: string) => read(env, name);
  const requires = required.map((name) => ({ name, present: get(name) !== null }));
  const missing = requires.filter((entry) => !entry.present).map((entry) => entry.name);
  const optionalStatus = optional.map((name) => ({ name, present: get(name) !== null }));

  const state: ServiceState =
    missing.length === 0
      ? "configured"
      : missing.length === required.length
        ? "absent"
        : "incomplete";

  return {
    state,
    value: state === "configured" ? build(get) : null,
    requires,
    optional: optionalStatus,
    missing,
  };
}

/* ----------------------------------------------------------- the reporting */

interface PortDescriptor {
  port: PortName;
  vendor: string;
  role: string;
  resolution: ServiceResolution<unknown>;
  liveImplementation: string;
  standInImplementation: string;
  /** Appended to the reason when the port is live. */
  liveNote: string;
  /** Appended to the reason whenever a stand-in is answering. */
  standInNote: string;
}

/**
 * The machine-readable answer to "what is actually answering right now".
 *
 * Derived from the configuration alone, so a status endpoint can produce it
 * without constructing a `Chancery` — and so it cannot drift from what
 * `composeChancery` wires, because both read this.
 */
export function describePorts(config: ChanceryConfig): PortStatus[] {
  const descriptors: PortDescriptor[] = [
    {
      port: "generator",
      vendor: "doctavian",
      role: "Rendering the writ a human reads and signs",
      resolution: config.doctavian,
      liveImplementation: "DoctavianDocumentGenerator",
      standInImplementation: "StandInDocumentDesk",
      liveNote: "The instrument is rendered by Doctavian from the grants the gate enforces.",
      standInNote:
        "The instrument is rendered in process from the same grants the gate enforces. It is " +
        "plain text rather than a generated PDF, and it says so in its own first line.",
    },
    {
      port: "signatures",
      vendor: "foxit",
      role: "The signature ceremony",
      resolution: config.foxit,
      liveImplementation: "FoxitSignatureService",
      standInImplementation: "StandInDocumentDesk",
      liveNote:
        "Credentials are held server-side. No agent-facing path can construct this client.",
      standInNote:
        "Nothing is sent to anyone and nothing is cryptographically signed. The stand-in reports " +
        "its own signature as unverified rather than claiming one it does not have.",
    },
    {
      port: "extractor",
      vendor: "nutrient",
      role: "Reading the signed writ back into enforceable terms",
      resolution: config.nutrient,
      liveImplementation: "NutrientTermsExtractor",
      standInImplementation: "StandInDocumentDesk",
      liveNote:
        "Terms are re-extracted from the signed bytes, and a clause that did not ground in the " +
        "page it came from is treated as absent.",
      standInNote:
        "Terms are read back from the document the stand-in itself rendered, so grounding is " +
        "trivially satisfied and proves nothing about a real extractor.",
    },
    {
      port: "registry",
      vendor: "name.com",
      role: "Registration and the DNS anchor",
      resolution: config.namecom,
      liveImplementation: "NameComDomainRegistry",
      standInImplementation: "StandInDomainRegistry",
      liveNote: "Registrations spend money and DNS writes land in a zone the registrar serves.",
      standInNote:
        "Registrations buy nothing and return an order reference that reads as a stand-in. The " +
        "writ record is published into an in-process zone, not into DNS.",
    },
    {
      port: "resolver",
      vendor: "public DNS",
      role: "Resolving authority from wherever it was published",
      resolution: config.namecom,
      liveImplementation: "DohWritResolver",
      standInImplementation: "StandInWritResolver",
      // DoH needs no credential of its own. What it needs is for the anchor to
      // be somewhere a public resolver can see it, and that is the registrar's
      // job — so this port follows the registrar rather than a key of its own.
      liveNote:
        "DNS-over-HTTPS needs no credential of its own; it follows the registrar because that is " +
        "who published the record. Cloudflare first, Google only on a transport failure, never " +
        "to shop for a friendlier answer.",
      standInNote:
        "The writ record was published into an in-process zone, so it is read back out of that " +
        "same zone rather than from DNS. The answer carries no DNSSEC signature and reports the " +
        "AD flag unset, which denies unless CHANCERY_ALLOW_UNAUTHENTICATED_DNS is on.",
    },
    {
      port: "diligence",
      vendor: "serpapi",
      role: "Checking the act against the live world",
      resolution: config.serpapi,
      liveImplementation: "SerpApiDiligenceService",
      standInImplementation: "StandInDiligenceService",
      liveNote: "A check that times out or fails returns unknown, and unknown denies.",
      standInNote:
        "Every check it is asked to perform returns unknown, because nothing was searched. " +
        "Unknown denies. No check is ever reported clear on the strength of a missing key.",
    },
    {
      port: "store",
      vendor: "xano",
      role: "Registry, act history and the ledger of record",
      resolution: config.xano,
      liveImplementation: "XanoWritStore",
      standInImplementation: "MemoryWritStore",
      liveNote:
        "The free plan allows 10 requests per 20 seconds and does not enforce that limit inside " +
        "Xano's own debugger.",
      standInNote:
        "MemoryWritStore holds the session and builds its hash chain with the same appendEntry " +
        "the backend of record uses, so a chain built here verifies identically. It does not " +
        "survive a restart.",
    },
  ];

  return descriptors.map(toPortStatus);
}

function toPortStatus(descriptor: PortDescriptor): PortStatus {
  const { resolution } = descriptor;
  const mode: PortMode =
    resolution.state === "configured"
      ? "live"
      : resolution.state === "absent"
        ? "stand-in"
        : "misconfigured";

  return {
    port: descriptor.port,
    vendor: descriptor.vendor,
    role: descriptor.role,
    mode,
    implementation:
      mode === "live" ? descriptor.liveImplementation : descriptor.standInImplementation,
    reason: reasonFor(descriptor, mode),
    requires: resolution.requires,
    optional: resolution.optional,
  };
}

function reasonFor(descriptor: PortDescriptor, mode: PortMode): string {
  const { resolution } = descriptor;
  if (mode === "live") return descriptor.liveNote;

  if (mode === "misconfigured") {
    return (
      `${descriptor.vendor} is partly configured: ${list(resolution.missing)} ` +
      `${resolution.missing.length === 1 ? "is" : "are"} unset, so nothing here is a live ` +
      `result. ${descriptor.standInNote}`
    );
  }

  const names = resolution.requires.map((entry) => entry.name);
  return (
    `${list(names)} ${names.length === 1 ? "is" : "are"} unset, so a stand-in is answering. ` +
    descriptor.standInNote
  );
}

function list(names: readonly string[]): string {
  if (names.length === 0) return "nothing";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The whole report, ready to be serialised. It carries variable names and
 * booleans, and nothing else out of the environment.
 */
export function statusReport(config: ChanceryConfig): StatusReport {
  const ports = describePorts(config);
  const live = ports.filter((port) => port.mode === "live");
  const misconfigured = ports.filter((port) => port.mode === "misconfigured");

  return {
    version: "chancery-status/1",
    standInThroughout: live.length === 0 && misconfigured.length === 0,
    headline: headline(ports.length, live.length, misconfigured.length),
    ports,
    settings: {
      documentBaseUrl: config.documentBaseUrl,
      allowUnauthenticatedDns: {
        value: config.allowUnauthenticatedDns.value,
        configured: config.allowUnauthenticatedDns.configured,
        note: config.allowUnauthenticatedDns.value
          ? "Authority is accepted from a DNS answer that was not DNSSEC-validated. Every " +
            "decision made under this says so in its own reasons."
          : "A DNS answer that was not DNSSEC-validated is refused, because a revocation could " +
            "have been stripped in transit.",
      },
    },
    warnings: config.warnings,
  };
}

function headline(total: number, live: number, misconfigured: number): string {
  if (misconfigured > 0) {
    const seams = misconfigured === 1 ? "seam is" : "seams are";
    return `${misconfigured} of ${total} ${seams} partly configured and not live`;
  }
  if (live === 0) return "Stand-in throughout — no credentials configured";
  if (live === total) return "Live throughout — every seam is talking to its vendor";
  return `Mixed — ${live} of ${total} seams are live`;
}

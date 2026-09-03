/**
 * Building a `Chancery` from configuration.
 *
 * One rule governs the whole file: a port is wired to its vendor or to a
 * stand-in, the choice is made once here from the configuration, and the answer
 * is returned alongside the object so the UI can print it and the API can serve
 * it. There is no runtime fallback. A configured vendor that is down stays
 * wired and throws — because a seam that silently degrades to a stand-in on a
 * 500 is exactly how a scripted answer ends up on screen wearing a live label.
 *
 * The credential-free path is a first-class configuration rather than a
 * degraded one, and it fails closed twice on the way through. The stand-in
 * resolver reports the DNSSEC AD flag unset, so authority read out of the
 * in-process zone is refused unless `CHANCERY_ALLOW_UNAUTHENTICATED_DNS` is on;
 * and the stand-in diligence service answers `unknown` to every check, so a
 * clause carrying a diligence condition denies. Both are the same answer a
 * strict verifier would give, and neither is worked around for the sake of a
 * demo that runs further.
 */

import { Chancery, type ChanceryDeps } from "./chancery";
import {
  describePorts,
  readConfig,
  statusReport,
  type ChanceryConfig,
  type EnvLike,
  type PortStatus,
  type StatusReport,
} from "./config";
import {
  createFoxitSignatureService,
  createMemoryWritStore,
  createXanoWritStore,
  DohWritResolver,
  DoctavianDocumentGenerator,
  NameComDomainRegistry,
  NutrientTermsExtractor,
  SerpApiDiligenceService,
  StandInDiligenceService,
  StandInDocumentDesk,
  StandInDomainRegistry,
  StandInWritResolver,
  StandInZone,
} from "./adapters";
import { DoctavianClient } from "../adapters/doctavian";
import { ExtractionClient } from "../adapters/nutrient";
import { NameComClient } from "../adapters/namecom";
import { SerpApiClient } from "../adapters/serpapi";
import type { MemoryWritStore } from "../adapters/xano";

/** Narrow enough that a hand-written fake satisfies every client behind it. */
export type ComposeFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ComposeOptions {
  /** Defaults to `process.env`. */
  env?: EnvLike;
  /** Pre-read configuration, when the caller already has it. Overrides `env`. */
  config?: ChanceryConfig;
  /** Injected so verdicts are reproducible in tests and in replay. */
  clock?: () => string;
  /**
   * Handed to every vendor client that takes one. Present so the live wiring
   * can be exercised against fakes; nothing here reaches the network without it
   * being the real `fetch`.
   */
  fetchImpl?: ComposeFetch;
  /**
   * Complete the stand-in signature as soon as it is requested. Off by default:
   * the ceremony is the one step no software takes, and a stand-in that signs
   * unasked has taken it.
   */
  autoSignStandIn?: boolean;
}

/**
 * The stand-in objects actually wired, so a caller can drive the parts a human
 * would drive. Absent when the port is live.
 */
export interface StandIns {
  desk?: StandInDocumentDesk;
  zone?: StandInZone;
  registry?: StandInDomainRegistry;
  resolver?: StandInWritResolver;
  diligence?: StandInDiligenceService;
  store?: MemoryWritStore;
}

export interface Composition {
  chancery: Chancery;
  deps: ChanceryDeps;
  config: ChanceryConfig;
  /** Per port: live, stand-in or misconfigured, and why. */
  ports: PortStatus[];
  report: StatusReport;
  standIns: StandIns;
}

export function composeChancery(options: ComposeOptions = {}): Composition {
  const config = options.config ?? readConfig(options.env ?? process.env);
  const clock = options.clock ?? (() => new Date().toISOString());
  const fetchImpl = options.fetchImpl;
  const standIns: StandIns = {};

  // One zone and one desk, shared by whichever ports fall back to them, so the
  // record the registry writes is the record the resolver reads.
  const zoneOf = () => (standIns.zone ??= new StandInZone());
  const deskOf = () =>
    (standIns.desk ??= new StandInDocumentDesk({
      clock,
      ...(options.autoSignStandIn === undefined ? {} : { autoSign: options.autoSignStandIn }),
    }));

  const doctavian = config.doctavian.value;
  const generator =
    doctavian === null
      ? deskOf()
      : new DoctavianDocumentGenerator(
          new DoctavianClient({
            ...(doctavian.baseUrl === null ? {} : { baseUrl: doctavian.baseUrl }),
            bearerToken: doctavian.bearerToken,
            documentsApiKey: doctavian.documentsApiKey,
            signaturesApiKey: doctavian.signaturesApiKey,
            ...(fetchImpl === undefined ? {} : { fetchImpl }),
          }),
        );

  const foxit = config.foxit.value;
  const signatures =
    foxit === null
      ? deskOf()
      : createFoxitSignatureService({
          settings: foxit,
          // Explicit, not a default. Chancery's own boundary is the credential:
          // `sendForSignature` is unreachable from any agent-facing path, and
          // there is no surface here that captures a human's approval of exact
          // bytes, so the bytes-bound gate has nothing to check against.
          approvals: null,
          ...(fetchImpl === undefined ? {} : { fetchImpl }),
        });

  const nutrient = config.nutrient.value;
  const extractor =
    nutrient === null
      ? deskOf()
      : new NutrientTermsExtractor(
          new ExtractionClient({
            apiKey: nutrient.apiKey,
            ...(fetchImpl === undefined ? {} : { fetchImpl }),
          }),
        );

  const namecom = config.namecom.value;
  const registry =
    namecom === null
      ? (standIns.registry ??= new StandInDomainRegistry(zoneOf()))
      : new NameComDomainRegistry({
          client: new NameComClient({
            environment: namecom.environment,
            username: namecom.username,
            token: namecom.token,
            ...(fetchImpl === undefined ? {} : { fetchImpl }),
          }),
        });

  // The resolver follows the registrar, because authority has to be read back
  // from wherever it was written. Resolving public DNS for a record that only
  // ever went into an in-process zone is not a strict verifier; it is two halves
  // wired to different worlds, and it answers NO_WRIT for a writ this same
  // process just anchored.
  const resolver =
    namecom === null
      ? (standIns.resolver ??= new StandInWritResolver(zoneOf(), clock))
      : new DohWritResolver({ clock });

  const serpapi = config.serpapi.value;
  const diligence =
    serpapi === null
      ? (standIns.diligence ??= new StandInDiligenceService(reasonForNoDiligence(config)))
      : new SerpApiDiligenceService(
          new SerpApiClient({
            apiKey: serpapi.apiKey,
            ...(fetchImpl === undefined ? {} : { fetchImpl }),
          }),
        );

  const xano = config.xano.value;
  const store =
    xano === null
      ? (standIns.store ??= createMemoryWritStore())
      : createXanoWritStore({
          settings: xano,
          ...(fetchImpl === undefined ? {} : { fetchImpl }),
        });

  const deps: ChanceryDeps = {
    generator,
    signatures,
    extractor,
    registry,
    resolver,
    diligence,
    store,
    clock,
    documentBaseUrl: config.documentBaseUrl.value,
    allowUnauthenticatedDns: config.allowUnauthenticatedDns.value,
  };

  return {
    chancery: new Chancery(deps),
    deps,
    config,
    ports: describePorts(config),
    report: statusReport(config),
    standIns,
  };
}

/**
 * Names the actual reason in the finding a denial will quote, so a principal
 * reading "could not establish this check" is told whether the key is missing
 * or half-present rather than being left to guess.
 */
function reasonForNoDiligence(config: ChanceryConfig): string {
  return config.serpapi.state === "incomplete"
    ? "the diligence provider is only partly configured"
    : "no diligence provider is configured (SERPAPI_KEY is unset)";
}

export { readConfig, statusReport, describePorts } from "./config";
export type {
  ChanceryConfig,
  PortMode,
  PortName,
  PortStatus,
  StatusReport,
} from "./config";

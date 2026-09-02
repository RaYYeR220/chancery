/**
 * The due-diligence engine.
 *
 * Scope asks whether the signed writ permits an act. This asks the other
 * question: does the act still make sense against the world as it is right
 * now? "The writ permits registering three .com domains under $50" is a scope
 * answer. "That particular name is a live USPTO registration held by someone
 * else" is this one, and it denies the act on reality rather than on paperwork.
 *
 * The shape of the module follows from three constraints.
 *
 * Planning is pure and separate from execution. `planProbes` turns a check and
 * a subject into a list of engine requests without touching the network, so a
 * test can assert that the news probe carries no pagination parameters and
 * that a paginated maps probe carries `ll` — the traps that would otherwise
 * only show up as quietly wrong results in production.
 *
 * Deciding is pure and separate from both. Execution produces `SerpApiOutcome`
 * values; `rules.ts` turns those into findings. A captured bundle of raw
 * SerpApi JSON therefore replays to the same verdict, which is what lets a
 * decision be re-derived offline months after the act.
 *
 * Time is bounded at three levels: per probe, per check, and across the whole
 * run. Every level that expires produces `unknown`, and `unknown` denies. A
 * gate in front of an irreversible act must be allowed to be slow or to fail,
 * but never to guess.
 */

import type { DiligenceCheck, DiligenceFinding } from "../../core/types";
import { DILIGENCE_JSON_RESTRICTORS, type SerpApiClient } from "./client";
import {
  extractMapsHandles,
  type SerpApiParams,
} from "./engines";
import { decide, type CheckEvidence } from "./rules";
import type { DiligenceSubject, EngineName, SerpApiOutcome } from "./types";

export interface DiligenceOptions {
  /** Ceiling on one engine call. A slow SERP is not worth an act's latency. */
  perProbeTimeoutMs?: number;
  /** Ceiling on one check, including its dependent follow-up probes. */
  perCheckTimeoutMs?: number;
  /** Ceiling on the whole run. Checks still unfinished at the deadline fail closed. */
  budgetMs?: number;
  now?: () => number;
  /**
   * Apply the per-engine `json_restrictor` projections. Off by default: a
   * projection that omits a key the rules read turns a real answer into
   * `unknown`, and `unknown` denies the act. Opt in once you have checked
   * that the projection covers what the rules consult.
   */
  restrict?: boolean;
  /** Locale for the sweeps; affects which registry and press a SERP surfaces. */
  gl?: string;
  hl?: string;
}

const DEFAULTS = {
  perProbeTimeoutMs: 4_000,
  perCheckTimeoutMs: 6_000,
  budgetMs: 12_000,
} as const;

/**
 * Which engines each check draws on. Exported because "what did you actually
 * look at?" is part of the finding's credibility, and because a test can hold
 * this against the planner so a check cannot lose an engine unnoticed.
 */
export const DILIGENCE_ENGINES: Record<DiligenceCheck, readonly EngineName[]> = {
  trademark_clear: ["google", "google_scholar_case_law"],
  no_brand_collision: ["google_light", "google_ads_transparency_center", "amazon", "google_trends"],
  counterparty_exists: ["google", "google_maps", "google_maps_reviews", "google_finance"],
  no_adverse_media: ["google_news", "google"],
  no_patent_litigation: ["google_patents", "google_scholar_case_law"],
};

/* ------------------------------------------------------------------ queries */

const REGISTRY_SITES = [
  "site:tsdr.uspto.gov",
  "site:tmsearch.uspto.gov",
  "site:trademarks.justia.com",
  "site:euipo.europa.eu",
  "site:branddb.wipo.int",
].join(" OR ");

const CORPORATE_SITES = [
  "site:linkedin.com/company",
  "site:opencorporates.com",
  "site:sec.gov",
  "site:crunchbase.com",
  "site:companieshouse.gov.uk",
].join(" OR ");

function phrase(value: string): string {
  return `"${value.replace(/"/g, "")}"`;
}

function entityName(subject: DiligenceSubject): string {
  return subject.legalName ?? subject.name;
}

/**
 * The first wave of engine requests for a check. Pure: same subject in, same
 * requests out, so the plan itself is reviewable evidence.
 */
export function planProbes(check: DiligenceCheck, subject: DiligenceSubject): SerpApiParams[] {
  switch (check) {
    case "trademark_clear":
      return [
        {
          engine: "google",
          q: `${phrase(subject.name)} trademark (${REGISTRY_SITES})`,
          // No `num`: google dropped it, and asking would return ten results
          // while the caller believed it asked for a hundred.
        },
        {
          engine: "google_scholar_case_law",
          q: `${phrase(subject.name)} trademark opposition infringement`,
        },
      ];

    case "no_brand_collision":
      return [
        { engine: "google_light", q: phrase(subject.name) },
        { engine: "google_ads_transparency_center", text: subject.name, num: 20 },
        { engine: "amazon", k: subject.name },
        { engine: "google_trends", q: subject.name, data_type: "TIMESERIES" },
      ];

    case "counterparty_exists": {
      const probes: SerpApiParams[] = [
        { engine: "google", q: `${phrase(entityName(subject))} (${CORPORATE_SITES})` },
        mapsProbe(subject),
      ];
      const reviews = reviewsProbe(subject);
      if (reviews !== null) probes.push(reviews);
      if (subject.ticker) probes.push({ engine: "google_finance", q: subject.ticker });
      return probes;
    }

    case "no_adverse_media":
      return [
        // google_news takes no pagination parameters at all, so this single
        // response is the entire evidence set for the news leg.
        { engine: "google_news", q: entityName(subject) },
        { engine: "google", q: `${phrase(entityName(subject))} (fraud OR lawsuit OR investigation OR bankruptcy OR sanctions)` },
      ];

    case "no_patent_litigation":
      return [
        // The one parameter that answers the question outright.
        { engine: "google_patents", q: entityName(subject), litigation: "YES", num: 20 },
        { engine: "google_scholar_case_law", q: `${phrase(entityName(subject))} patent infringement` },
      ];
  }
}

function mapsProbe(subject: DiligenceSubject): SerpApiParams {
  if (subject.mapsDataCid !== undefined) {
    // The handle `google` and `google_local` return goes here as `data_cid`.
    // Under `place_id` it would silently resolve to a different place.
    return { engine: "google_maps", type: "place", data_cid: subject.mapsDataCid };
  }
  const q = subject.locality ? `${subject.name} ${subject.locality}` : subject.name;
  return subject.ll !== undefined
    ? { engine: "google_maps", type: "search", q, ll: subject.ll }
    : { engine: "google_maps", type: "search", q };
}

function reviewsProbe(subject: DiligenceSubject): SerpApiParams | null {
  if (subject.mapsDataId !== undefined) {
    return {
      engine: "google_maps_reviews",
      data_id: subject.mapsDataId,
      sort_by: "newestFirst",
      num: 20,
    };
  }
  if (subject.mapsPlaceId !== undefined) {
    return {
      engine: "google_maps_reviews",
      place_id: subject.mapsPlaceId,
      sort_by: "newestFirst",
      num: 20,
    };
  }
  return null;
}

/**
 * The dependent second wave. Reviews cannot be requested until a maps lookup
 * has produced a handle, so this check is a two-step chain rather than a fan
 * of independent calls — and the handle it lifts is the maps-native one, not
 * the `google` place id, which the branded types keep apart.
 */
export function planFollowUpProbes(
  check: DiligenceCheck,
  subject: DiligenceSubject,
  outcomes: readonly SerpApiOutcome[],
): SerpApiParams[] {
  if (check !== "counterparty_exists") return [];
  if (outcomes.some((outcome) => outcome.engine === "google_maps_reviews")) return [];
  const maps = outcomes.find((outcome) => outcome.engine === "google_maps");
  if (maps === undefined || !maps.ok) return [];
  const handles = extractMapsHandles(maps.json);
  const follow = reviewsProbe({
    ...subject,
    ...(handles.dataId !== null ? { mapsDataId: handles.dataId } : {}),
    ...(handles.placeId !== null ? { mapsPlaceId: handles.placeId } : {}),
  });
  return follow === null ? [] : [follow];
}

/* ---------------------------------------------------------------- execution */

function applyOptions(params: SerpApiParams, options: DiligenceOptions): SerpApiParams {
  const restrictor = options.restrict ? DILIGENCE_JSON_RESTRICTORS[params.engine] : undefined;
  const locale = {
    ...(options.gl !== undefined ? { gl: options.gl } : {}),
    ...(options.hl !== undefined ? { hl: options.hl } : {}),
  };
  if (restrictor === undefined && Object.keys(locale).length === 0) return params;
  return {
    ...params,
    ...locale,
    ...(restrictor === undefined ? {} : { json_restrictor: restrictor }),
  } as SerpApiParams;
}

/**
 * Collects the evidence for one check without deciding anything. Split out so
 * a caller can cache raw outcomes and re-decide later — the outcomes are the
 * expensive, perishable half; the verdict is the cheap, reproducible half.
 */
export async function gatherEvidence(
  client: SerpApiClient,
  subject: DiligenceSubject,
  check: DiligenceCheck,
  options: DiligenceOptions = {},
): Promise<CheckEvidence> {
  const timeoutMs = options.perProbeTimeoutMs ?? DEFAULTS.perProbeTimeoutMs;
  const run = (params: SerpApiParams): Promise<SerpApiOutcome> =>
    client.searchSafe(applyOptions(params, options), { timeoutMs });

  const first = await Promise.all(planProbes(check, subject).map(run));
  const follow = planFollowUpProbes(check, subject, first);
  const second = follow.length === 0 ? [] : await Promise.all(follow.map(run));
  return { subject, probes: [...first, ...second] };
}

export async function runDiligenceCheck(
  client: SerpApiClient,
  subject: DiligenceSubject,
  check: DiligenceCheck,
  options: DiligenceOptions = {},
): Promise<DiligenceFinding> {
  const evidence = await gatherEvidence(client, subject, check, options);
  return decide(check, evidence);
}

/**
 * Runs the requested checks concurrently and returns findings in the order
 * asked for. Duplicates in `checks` are collapsed, so a writ that names the
 * same condition under two grants pays for it once.
 */
export async function runDiligence(
  client: SerpApiClient,
  subject: DiligenceSubject,
  checks: readonly DiligenceCheck[],
  options: DiligenceOptions = {},
): Promise<DiligenceFinding[]> {
  const now = options.now ?? (() => Date.now());
  const budgetMs = options.budgetMs ?? DEFAULTS.budgetMs;
  const perCheckMs = options.perCheckTimeoutMs ?? DEFAULTS.perCheckTimeoutMs;
  const startedAt = now();
  const unique = [...new Set(checks)];

  return Promise.all(
    unique.map((check) => {
      const remaining = budgetMs - (now() - startedAt);
      const allowance = Math.max(0, Math.min(perCheckMs, remaining));
      return withDeadline(
        runDiligenceCheck(client, subject, check, options),
        allowance,
        () => timedOutFinding(check, allowance, remaining <= perCheckMs),
      ).catch((error: unknown) => internalFinding(check, error));
    }),
  );
}

/**
 * A rejected check is still a check that has to answer. Diligence code that
 * lets an exception escape hands the caller nothing to fail closed on, so any
 * unexpected throw is converted into `unknown` here rather than propagated.
 */
function internalFinding(check: DiligenceCheck, error: unknown): DiligenceFinding {
  const message = error instanceof Error ? error.message : String(error);
  return {
    check,
    verdict: "unknown",
    summary: `Could not establish this check: the diligence run failed (${message}).`,
    citations: [],
  };
}

function timedOutFinding(
  check: DiligenceCheck,
  allowanceMs: number,
  budgetExhausted: boolean,
): DiligenceFinding {
  const reason = budgetExhausted
    ? `the overall diligence budget was exhausted after ${allowanceMs}ms`
    : `the check exceeded its ${allowanceMs}ms allowance`;
  return {
    check,
    verdict: "unknown",
    summary: `Could not establish this check: ${reason}.`,
    citations: [],
  };
}

/**
 * Races work against a wall clock. The pending work is abandoned rather than
 * cancelled — the per-probe timeout inside the client is what actually aborts
 * the sockets, and this layer only guarantees that the caller gets an answer.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  if (ms <= 0) return Promise.resolve(onTimeout());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

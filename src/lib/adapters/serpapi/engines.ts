/**
 * Engine parameter types and the pagination table.
 *
 * SerpApi's pagination parameters are not uniform across engines, and the
 * mismatches fail *silently*: `num` on `engine=google` is ignored, so you get
 * ten results and believe you asked for a hundred; `start` on `google_news` is
 * ignored, so page two is page one again; `start` on `google_shopping` is
 * ignored the same way. Nothing errors. A diligence check that believes it
 * swept a hundred results when it saw ten is worse than one that failed.
 *
 * So the traps are encoded twice. The parameter unions below mark forbidden
 * parameters as `?: never`, which rejects them at compile time for any object
 * literal. `assertSearchParams` repeats the table at runtime for params built
 * dynamically, and throws before the request is sent rather than returning a
 * plausible-looking wrong answer.
 */

import { asRecord, readString, recordsAt } from "./parse";
import type {
  EngineName,
  GooglePlaceId,
  MapsDataCid,
  MapsDataId,
  MapsPlaceId,
} from "./types";

/** Thrown for a request this process built wrong. Never reaches the network. */
export class SerpApiUsageError extends Error {
  constructor(
    message: string,
    readonly engine: string,
  ) {
    super(message);
    this.name = "SerpApiUsageError";
  }
}

/* ------------------------------------------------------------ common params */

export interface CommonParams {
  /**
   * `md` returns a markdown rendering instead of JSON. It is the cheaper leg
   * when the consumer is a model rather than a rule: no JSON walk, far fewer
   * tokens. Diligence itself stays on JSON, because its verdicts must be
   * derived from named fields, not from prose.
   */
  output?: "json" | "md";
  /**
   * Server-side field projection, e.g. `organic_results[].{title,link}`.
   * Cuts latency and tokens, and cuts them before the wire rather than after.
   */
  json_restrictor?: string;
  no_cache?: boolean;
  hl?: string;
  gl?: string;
  location?: string;
  device?: "desktop" | "mobile" | "tablet";
}

/* -------------------------------------------------------------- per engine */

/**
 * Google killed `num=100`, and SerpApi's `google` engine dropped the parameter
 * with it. `start` is the only pagination handle here, in steps of 10.
 */
export interface GoogleParams extends CommonParams {
  engine: "google";
  q: string;
  start?: number;
  num?: never;
  page?: never;
  tbm?: string;
  tbs?: string;
  safe?: "active" | "off";
  filter?: 0 | 1;
}

/** The reduced-latency sibling of `google`; same `start`-only pagination. */
export interface GoogleLightParams extends CommonParams {
  engine: "google_light";
  q: string;
  start?: number;
  num?: never;
  page?: never;
}

/**
 * `google_news` has no pagination at all — no `start`, no `num`, no `page`.
 * The first response is the entire evidence set, and any rule reading it has
 * to say so rather than imply a sweep it never performed.
 */
export interface GoogleNewsParams extends CommonParams {
  engine: "google_news";
  q?: string;
  topic_token?: string;
  publication_token?: string;
  story_token?: string;
  section_token?: string;
  so?: 0 | 1;
  start?: never;
  num?: never;
  page?: never;
}

/**
 * One of the eleven engines where `num` is documented, and the one engine that
 * answers a due-diligence question in a single flag: `litigation` turns the
 * search into "which of these patents are in dispute".
 */
export interface GooglePatentsParams extends CommonParams {
  engine: "google_patents";
  q: string;
  /**
   * Restricts results to patents with recorded litigation. The exact accepted
   * spelling is not confirmed against a live key, so it is serialised as the
   * lowercase boolean SerpApi uses elsewhere; if it were ever ignored the
   * check degrades to "patents naming this assignee", never to a false clear.
   */
  litigation?: boolean;
  num?: number;
  page?: number;
  sort?: "new" | "old";
  before?: string;
  after?: string;
  assignee?: string;
  inventor?: string;
  status?: "GRANT" | "APPLICATION";
  country?: string;
  start?: never;
}

/**
 * Case law results land in `case_results`, not `organic_results`. A parser
 * that only knows `organic_results` reads this engine as permanently empty,
 * which is exactly the shape of a false `clear`.
 */
export interface GoogleScholarCaseLawParams extends CommonParams {
  engine: "google_scholar_case_law";
  q: string;
  start?: number;
  /** `num` is documented on `google_scholar`, not on the case-law engine. */
  num?: never;
  page?: never;
  as_ylo?: number;
  as_yhi?: number;
  court?: string;
}

interface GoogleMapsBase extends CommonParams {
  engine: "google_maps";
  q?: string;
  type?: "search" | "place";
  /**
   * The `place_id` from `google`/`google_local` belongs here, under this name.
   * `place_id` is deliberately absent from these params; passing one is
   * rejected at runtime with a pointer at `googlePlaceIdToMapsDataCid`.
   */
  data_cid?: MapsDataCid;
  data_id?: MapsDataId;
  google_domain?: string;
  num?: never;
  page?: never;
}

/**
 * Paginating maps without `ll` drifts: the viewport is inferred from the query
 * on page one and then re-inferred per page, so results from different pages
 * describe different places. The union makes `ll` mandatory the moment `start`
 * appears. Step 20, recommended ceiling `start=100`.
 */
export type GoogleMapsParams =
  | (GoogleMapsBase & { start?: never; ll?: string })
  | (GoogleMapsBase & { start: number; ll: string });

/**
 * Takes `data_id` or the maps-native `place_id`. `sort_by=newestFirst` is what
 * makes this a signal rather than a rating: an average hides a collapse, the
 * newest twenty reviews show it.
 */
export interface GoogleMapsReviewsParams extends CommonParams {
  engine: "google_maps_reviews";
  data_id?: MapsDataId;
  place_id?: MapsPlaceId;
  sort_by?: "qualityScore" | "newestFirst" | "ratingHigh" | "ratingLow";
  /** Token-based pagination; `start` is not part of this engine's contract. */
  next_page_token?: string;
  num?: number;
  topic_id?: string;
  start?: never;
  page?: never;
}

export interface GoogleTrendsParams extends CommonParams {
  engine: "google_trends";
  q: string;
  data_type?:
    | "TIMESERIES"
    | "GEO_MAP"
    | "GEO_MAP_0"
    | "RELATED_TOPICS"
    | "RELATED_QUERIES";
  date?: string;
  geo?: string;
  cat?: number;
  tz?: number;
  start?: never;
  num?: never;
  page?: never;
}

/** Another of the eleven engines where `num` is documented. */
export interface GoogleAdsTransparencyCenterParams extends CommonParams {
  engine: "google_ads_transparency_center";
  text?: string;
  advertiser_id?: string;
  creative_id?: string;
  region?: string | number;
  platform?: string;
  political_ads?: boolean;
  num?: number;
  start?: never;
  page?: never;
}

export interface AmazonParams extends CommonParams {
  engine: "amazon";
  k: string;
  amazon_domain?: string;
  page?: number;
  s?: string;
  /** Amazon paginates by page; `num` is not documented here. */
  num?: never;
  start?: never;
}

export interface GoogleFinanceParams extends CommonParams {
  engine: "google_finance";
  q: string;
  window?: "1D" | "5D" | "1M" | "6M" | "YTD" | "1Y" | "5Y" | "MAX";
  start?: never;
  num?: never;
  page?: never;
}

/**
 * Present so the trap is stated rather than discovered. `google_shopping`
 * pagination is broken end to end — `start` is accepted and ignored, every
 * request returns page one — so the client refuses to pretend otherwise.
 */
export interface GoogleShoppingParams extends CommonParams {
  engine: "google_shopping";
  q: string;
  start?: never;
  num?: never;
  page?: never;
}

export type SerpApiParams =
  | GoogleParams
  | GoogleLightParams
  | GoogleNewsParams
  | GooglePatentsParams
  | GoogleScholarCaseLawParams
  | GoogleMapsParams
  | GoogleMapsReviewsParams
  | GoogleTrendsParams
  | GoogleAdsTransparencyCenterParams
  | AmazonParams
  | GoogleFinanceParams
  | GoogleShoppingParams;

/* --------------------------------------------------------- pagination table */

export interface PaginationRules {
  /**
   * `num` is documented on exactly eleven engines. Anywhere else it is
   * accepted and ignored, which is the dangerous half of the behaviour.
   */
  num: "documented" | "undocumented";
  numMax?: number;
  /** `broken` means the parameter is accepted and has no effect. */
  start: "supported" | "unsupported" | "broken";
  page: "supported" | "unsupported";
  /** Step size for `start`, where it works. */
  step?: number;
  maxStart?: number;
  /** Pagination without a viewport returns results for a drifting centre. */
  requiresLlToPaginate?: boolean;
  /** Pagination is by opaque token, so numeric offsets are meaningless. */
  tokenPaginated?: boolean;
}

export const ENGINE_PAGINATION: Record<EngineName, PaginationRules> = {
  google: { num: "undocumented", start: "supported", page: "unsupported", step: 10 },
  google_light: { num: "undocumented", start: "supported", page: "unsupported", step: 10 },
  google_news: { num: "undocumented", start: "unsupported", page: "unsupported" },
  google_patents: { num: "documented", start: "unsupported", page: "supported" },
  google_scholar_case_law: {
    num: "undocumented",
    start: "supported",
    page: "unsupported",
    step: 10,
  },
  google_maps: {
    num: "undocumented",
    start: "supported",
    page: "unsupported",
    step: 20,
    maxStart: 100,
    requiresLlToPaginate: true,
  },
  google_maps_reviews: {
    num: "documented",
    numMax: 20,
    start: "unsupported",
    page: "unsupported",
    tokenPaginated: true,
  },
  google_trends: { num: "undocumented", start: "unsupported", page: "unsupported" },
  google_ads_transparency_center: {
    num: "documented",
    start: "unsupported",
    page: "unsupported",
  },
  amazon: { num: "undocumented", start: "unsupported", page: "supported" },
  google_finance: { num: "undocumented", start: "unsupported", page: "unsupported" },
  google_shopping: { num: "undocumented", start: "broken", page: "unsupported" },
};

const ENGINE_NAMES = new Set<string>(Object.keys(ENGINE_PAGINATION));

export function isEngineName(value: unknown): value is EngineName {
  return typeof value === "string" && ENGINE_NAMES.has(value);
}

/* --------------------------------------------------------------- validation */

/**
 * The runtime half of the pagination contract, for params assembled from data
 * rather than written as a literal. It runs before the request is built, so a
 * misuse surfaces as a thrown `SerpApiUsageError` at the call site instead of
 * a quietly truncated result set three layers away.
 */
export function assertSearchParams(params: SerpApiParams): void {
  const bag = params as unknown as Record<string, unknown>;
  const engine = bag.engine;
  if (!isEngineName(engine)) {
    throw new SerpApiUsageError(`unknown engine ${String(engine)}`, String(engine));
  }
  const rules = ENGINE_PAGINATION[engine];

  if (bag.num !== undefined) {
    if (rules.num === "undocumented") {
      throw new SerpApiUsageError(
        `num is not supported on engine=${engine}; ` +
          (rules.start === "supported"
            ? `paginate with start (step ${rules.step ?? 10}) instead`
            : "this engine returns a single fixed page"),
        engine,
      );
    }
    const num = bag.num;
    if (typeof num !== "number" || !Number.isInteger(num) || num < 1) {
      throw new SerpApiUsageError(`num must be a positive integer on engine=${engine}`, engine);
    }
    if (rules.numMax !== undefined && num > rules.numMax) {
      throw new SerpApiUsageError(
        `num=${num} exceeds the documented maximum of ${rules.numMax} on engine=${engine}`,
        engine,
      );
    }
  }

  if (bag.start !== undefined) {
    if (rules.start === "unsupported") {
      throw new SerpApiUsageError(
        rules.tokenPaginated
          ? `engine=${engine} paginates by next_page_token, not start`
          : `engine=${engine} has no pagination; the first response is all there is`,
        engine,
      );
    }
    if (rules.start === "broken") {
      throw new SerpApiUsageError(
        `start is accepted but ignored on engine=${engine}; every request returns page one, ` +
          "so a paginated sweep here would silently re-read the same results",
        engine,
      );
    }
    const start = bag.start;
    if (typeof start !== "number" || !Number.isInteger(start) || start < 0) {
      throw new SerpApiUsageError(`start must be a non-negative integer on engine=${engine}`, engine);
    }
    if (rules.requiresLlToPaginate && typeof bag.ll !== "string") {
      throw new SerpApiUsageError(
        `engine=${engine} requires ll once start is set, or the viewport drifts between pages`,
        engine,
      );
    }
    if (rules.maxStart !== undefined && start > rules.maxStart) {
      throw new SerpApiUsageError(
        `start=${start} is past the usable ceiling of ${rules.maxStart} on engine=${engine}`,
        engine,
      );
    }
  }

  if (bag.page !== undefined && rules.page === "unsupported") {
    throw new SerpApiUsageError(`page is not supported on engine=${engine}`, engine);
  }

  if (engine === "google_maps" && bag.place_id !== undefined) {
    throw new SerpApiUsageError(
      "engine=google_maps does not take place_id; the handle from google/google_local goes in " +
        "data_cid — convert it with googlePlaceIdToMapsDataCid",
      engine,
    );
  }
}

/* ------------------------------------------------------- place id conversion */

/**
 * The one legal crossing between the two place-handle namespaces. It changes
 * no characters — the whole point is that the *name* of the parameter changes
 * and the value does not, which is precisely why the mistake is invisible
 * without a type to catch it.
 */
export function googlePlaceIdToMapsDataCid(placeId: GooglePlaceId): MapsDataCid {
  return placeId as string as MapsDataCid;
}

/** Brands a `place_id` lifted from a `google` or `google_local` result. */
export function asGooglePlaceId(raw: string): GooglePlaceId {
  return raw as GooglePlaceId;
}

/** Brands a `place_id` lifted from a `google_maps` result. */
export function asMapsPlaceId(raw: string): MapsPlaceId {
  return raw as MapsPlaceId;
}

/** Brands a `data_id` ("0x…:0x…") lifted from a `google_maps` result. */
export function asMapsDataId(raw: string): MapsDataId {
  return raw as MapsDataId;
}

/**
 * Lifts a place handle out of a `google` or `google_local` response. The
 * result is branded as a `GooglePlaceId`, so the only thing a caller can do
 * with it downstream is convert it — which is the point.
 */
export function extractGooglePlaceId(json: unknown): GooglePlaceId | null {
  const candidates = [
    ...recordsAt(json, "local_results"),
    ...recordsAt(asRecord(json)?.local_results, "places"),
    ...recordsAt(json, "organic_results"),
  ];
  for (const record of candidates) {
    const placeId = readString(record, "place_id");
    if (placeId !== null) return asGooglePlaceId(placeId);
  }
  const fromKnowledge = readString(asRecord(json)?.knowledge_graph, "place_id");
  return fromKnowledge === null ? null : asGooglePlaceId(fromKnowledge);
}

/**
 * Lifts the maps-native handles out of a `google_maps` response. These are the
 * only handles `google_maps_reviews` accepts, and they are not the same value as
 * the `google` place id even when they look alike.
 */
export function extractMapsHandles(json: unknown): {
  dataId: MapsDataId | null;
  placeId: MapsPlaceId | null;
} {
  const root = asRecord(json);
  const place =
    asRecord(root?.place_results) ??
    recordsAt(json, "local_results")[0] ??
    null;
  const dataId = readString(place, "data_id");
  const placeId = readString(place, "place_id");
  return {
    dataId: dataId === null ? null : asMapsDataId(dataId),
    placeId: placeId === null ? null : asMapsPlaceId(placeId),
  };
}

/**
 * The SerpApi adapter's public surface.
 *
 * Everything a caller outside this directory needs is here; nothing inside
 * reaches back out except to `core/types`, which is deliberately I/O-free so
 * the decision half of this adapter stays replayable from stored evidence.
 */

export {
  SerpApiClient,
  SerpApiRequestError,
  SERPAPI_JSON_ENDPOINT,
  DILIGENCE_JSON_RESTRICTORS,
  redactUrl,
  type FetchLike,
  type FetchLikeInit,
  type FetchLikeResponse,
  type SerpApiClientOptions,
  type RequestOptions,
} from "./client";

export {
  SerpApiUsageError,
  ENGINE_PAGINATION,
  assertSearchParams,
  isEngineName,
  googlePlaceIdToMapsDataCid,
  asGooglePlaceId,
  asMapsPlaceId,
  asMapsDataId,
  extractGooglePlaceId,
  extractMapsHandles,
  type SerpApiParams,
  type PaginationRules,
  type CommonParams,
  type GoogleParams,
  type GoogleLightParams,
  type GoogleNewsParams,
  type GooglePatentsParams,
  type GoogleScholarCaseLawParams,
  type GoogleMapsParams,
  type GoogleMapsReviewsParams,
  type GoogleTrendsParams,
  type GoogleAdsTransparencyCenterParams,
  type AmazonParams,
  type GoogleFinanceParams,
  type GoogleShoppingParams,
} from "./engines";

export {
  runDiligence,
  runDiligenceCheck,
  gatherEvidence,
  planProbes,
  planFollowUpProbes,
  withDeadline,
  DILIGENCE_ENGINES,
  type DiligenceOptions,
} from "./diligence";

export {
  decide,
  decideTrademarkClear,
  decideNoBrandCollision,
  decideCounterpartyExists,
  decideNoAdverseMedia,
  decideNoPatentLitigation,
  describeFailures,
  usableJson,
  probeFor,
  isBlocking,
  DECIDERS,
  RESULT_KEYS,
  ADVERSE_TERMS,
  type CheckEvidence,
} from "./rules";

export {
  isUsableResponse,
  readApiError,
  toCitations,
  toCitation,
  normalizeText,
  slugify,
  mentions,
  hostOf,
  type Citation,
} from "./parse";

export type {
  DiligenceSubject,
  EngineName,
  SerpApiJson,
  SerpApiOutcome,
  SerpApiErrorKind,
  GooglePlaceId,
  MapsPlaceId,
  MapsDataCid,
  MapsDataId,
} from "./types";

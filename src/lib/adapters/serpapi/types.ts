/**
 * Wire types and evidence carriers for the SerpApi adapter.
 *
 * Two rules shape this file.
 *
 * A SERP response is never modelled as a struct. The same engine returns
 * different blocks for different queries, and any block may be absent, so a
 * response is an opaque JSON object and every read of it goes through the
 * defensive accessors in `parse.ts`. A typed response shape would only move
 * the lie from runtime to compile time.
 *
 * A failed call is a value, not an exception. Diligence has to fail closed,
 * and that is only reliable when "the call failed" travels in the same channel
 * as "the call succeeded and found nothing". Those are different verdicts —
 * `unknown` and `clear` — and an adapter that throws on the first one invites
 * a catch block that quietly turns it into the second.
 */

/** An engine response, before anything has been assumed about its shape. */
export type SerpApiJson = Record<string, unknown>;

/**
 * The engines this client can address. The union is closed on purpose: the
 * pagination table in `engines.ts` has an entry per member, so adding an
 * engine without recording how it paginates does not compile.
 */
export type EngineName =
  | "google"
  | "google_light"
  | "google_news"
  | "google_patents"
  | "google_scholar_case_law"
  | "google_maps"
  | "google_maps_reviews"
  | "google_trends"
  | "google_ads_transparency_center"
  | "amazon"
  | "google_finance"
  | "google_shopping";

/* ------------------------------------------------------------ place handles */

/**
 * Place handles are branded because the same-looking string means different
 * things to different engines.
 *
 * The `place_id` that `google` and `google_local` return is not the `place_id`
 * that `google_maps` accepts — on `google_maps` that value is the `data_cid`
 * parameter. Passed under the wrong name it does not error; it silently
 * resolves to a different place or to nothing, and a diligence check would
 * then clear a business it never actually looked at. The brands make the
 * mistake unrepresentable: the only way to obtain a `MapsDataCid` is to run
 * a `GooglePlaceId` through `googlePlaceIdToMapsDataCid`.
 */
export type GooglePlaceId = string & { readonly __serpapiBrand: "google.place_id" };

/** A `place_id` minted by `google_maps` itself; accepted only by maps engines. */
export type MapsPlaceId = string & { readonly __serpapiBrand: "google_maps.place_id" };

/** The `google`/`google_local` place handle under the name `google_maps` wants. */
export type MapsDataCid = string & { readonly __serpapiBrand: "google_maps.data_cid" };

/** The `data_id` ("0x…:0x…") form, which `google_maps_reviews` also accepts. */
export type MapsDataId = string & { readonly __serpapiBrand: "google_maps.data_id" };

/* ---------------------------------------------------------------- outcomes */

export type SerpApiErrorKind =
  /** The request was malformed by us; it never left the process. */
  | "usage"
  | "http"
  | "network"
  | "timeout"
  /** 200 with a body that is not JSON, or not an object. */
  | "malformed"
  /** 200 with an `error` field or `search_metadata.status = "Error"`. */
  | "api";

/**
 * The result of one engine call. `url` is always the redacted request URL —
 * the api_key is stripped before the value is ever stored or logged, because
 * outcomes are meant to be persisted alongside a decision as evidence.
 */
export type SerpApiOutcome =
  | {
      ok: true;
      engine: EngineName;
      json: SerpApiJson;
      url: string;
      elapsedMs: number;
    }
  | {
      ok: false;
      engine: EngineName;
      kind: SerpApiErrorKind;
      error: string;
      url: string;
      elapsedMs: number;
      status?: number;
    };

/* ----------------------------------------------------------------- subject */

/**
 * What diligence is being run against. Everything except `name` is optional
 * because the caller usually has only a proposed brand at this point — the
 * extra fields sharpen the queries when a writ happens to carry them, and
 * their absence narrows the evidence rather than blocking the run.
 */
export interface DiligenceSubject {
  /** The brand or trading name the act would put into the world. */
  name: string;
  /** The domain the act would register, when the act is a registration. */
  domain?: string;
  /** Registered legal name, when it differs from the trading name. */
  legalName?: string;
  /** ISO 3166-1 alpha-2, used to pick the registry and news locale. */
  country?: string;
  /** Free-text locality for maps lookups, e.g. "Austin, Texas, United States". */
  locality?: string;
  /** Maps viewport, e.g. "@30.2672,-97.7431,14z". Mandatory to paginate maps. */
  ll?: string;
  mapsDataCid?: MapsDataCid;
  mapsPlaceId?: MapsPlaceId;
  mapsDataId?: MapsDataId;
  /** Google Finance handle, e.g. "NWLG:NASDAQ". */
  ticker?: string;
}

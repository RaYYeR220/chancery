/**
 * OAuth2 token handling for Doctavian.
 *
 * Doctavian fronts Microsoft Entra: the access token comes from an
 * authorization-code-with-PKCE flow against the tenant's own token endpoint,
 * and it lives for 3599 seconds. That is shorter than a build session, so a
 * client that cannot refresh will die mid-flow — and it will die at whichever
 * of the six generation calls happens to cross the hour, leaving a datasource
 * and a solution behind and no document. Refresh is therefore part of the
 * client rather than something the caller is expected to remember.
 *
 * The interactive half of the flow (the browser redirect that mints the first
 * refresh token) is deliberately not implemented here: it needs a human at a
 * Microsoft login page, so it happens once, out of band, and the refresh token
 * it yields is what this module consumes.
 */

import { DoctavianApiError } from "./errors";
import type { FetchLike } from "./types";

/** The demo tenant is a different host from `api.doctavian.com`. */
export const DOCTAVIAN_DEMO_BASE_URL = "https://demo.api.doctavian.com";

/** Not under `/v1/` — the auth endpoints sit on their own `/public/v1/` prefix. */
export const DOCTAVIAN_TOKEN_PATH = "/public/v1/auth/microsoft/token";

export const DOCTAVIAN_CLIENT_ID = "11e71170-3499-43f3-b878-7df343f43d37";

export const DOCTAVIAN_SCOPE =
  "api://40728276-52a7-4932-bf32-76737f1fd01a/.default offline_access";

export interface DoctavianTokenSet {
  accessToken: string;
  /** Entra rotates the refresh token on every use; the new one must be kept. */
  refreshToken: string;
  /** Seconds the access token is valid for, as reported by the server. */
  expiresIn: number;
  /** Epoch ms the token stops being usable, derived from `expiresIn`. */
  expiresAt: number;
}

export interface RefreshAccessTokenInput {
  refreshToken: string;
  baseUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  scope?: string;
  fetchImpl?: FetchLike;
}

export function doctavianTokenUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${DOCTAVIAN_TOKEN_PATH}`;
}

/**
 * Exchanges a refresh token for a fresh access token. Form-encoded with the
 * client id in the body — this endpoint takes neither an api key nor a bearer,
 * so it deliberately does not go through the client's request path.
 */
export async function refreshAccessToken(
  input: RefreshAccessTokenInput,
): Promise<DoctavianTokenSet> {
  const url =
    input.tokenUrl ?? doctavianTokenUrl(input.baseUrl ?? DOCTAVIAN_DEMO_BASE_URL);
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: input.clientId ?? DOCTAVIAN_CLIENT_ID,
    refresh_token: input.refreshToken,
    scope: input.scope ?? DOCTAVIAN_SCOPE,
  });

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });

  const text = await response.text();
  const parsed = parseJson(text);
  if (!response.ok) {
    throw new DoctavianApiError({
      message: `Doctavian token refresh failed: ${response.status} ${response.statusText}`,
      status: response.status,
      statusText: response.statusText,
      body: parsed,
      // Auth is neither documents nor signatures, but the error type carries an
      // area; documents is the honest default since that is what refresh unblocks.
      area: "documents",
      path: DOCTAVIAN_TOKEN_PATH,
      method: "POST",
    });
  }

  return readTokenSet(parsed, input.refreshToken);
}

function readTokenSet(parsed: unknown, previousRefresh: string): DoctavianTokenSet {
  const record = isRecord(parsed) ? parsed : {};
  // The token can arrive on the envelope or nested under `result.data`; the auth
  // endpoints are outside the `/v1/` envelope convention, so both are accepted.
  const data = isRecord(record.result) && isRecord(record.result.data)
    ? record.result.data
    : record;

  const accessToken = readString(data, "access_token") ?? readString(data, "accessToken");
  if (!accessToken) {
    throw new DoctavianApiError({
      message: "Doctavian token refresh returned no access_token",
      status: 200,
      statusText: "OK",
      body: redactTokens(parsed),
      area: "documents",
      path: DOCTAVIAN_TOKEN_PATH,
      method: "POST",
    });
  }

  const expiresIn =
    readNumber(data, "expires_in") ?? readNumber(data, "expiresIn") ?? 3599;

  return {
    accessToken,
    // Entra usually rotates the refresh token; keep the old one when it does not.
    refreshToken:
      readString(data, "refresh_token") ??
      readString(data, "refreshToken") ??
      previousRefresh,
    expiresIn,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

/**
 * Anything that reaches a log or an error body has its token-shaped values
 * replaced. A refresh failure is exactly the moment someone pastes the response
 * into a chat window.
 */
export function redactTokens(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = /token|secret|assertion/i.test(key)
      ? "<redacted>"
      : isRecord(entry)
        ? redactTokens(entry)
        : entry;
  }
  return out;
}

function parseJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const found = value[key];
  return typeof found === "string" && found.length > 0 ? found : null;
}

function readNumber(value: Record<string, unknown>, key: string): number | null {
  const found = value[key];
  if (typeof found === "number") return found;
  if (typeof found === "string" && found.trim() !== "" && Number.isFinite(Number(found))) {
    return Number(found);
  }
  return null;
}

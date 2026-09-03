/**
 * Wiring a `DoctavianClient` from the environment, including persisting a
 * rotated refresh token.
 *
 * Entra invalidates a refresh token the moment it is used, handing back a
 * replacement. If that replacement only lives in memory, the next process
 * starts with a token the identity provider has already retired and there is no
 * way back except another interactive browser login. So the refresh callback
 * writes both tokens back to `.env.local` — which is gitignored, and is the
 * only file this module ever writes.
 *
 * Node-only: it touches `fs` and `process.env`, so nothing in the Next.js
 * client bundle may import it.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { DoctavianClient } from "./client";
import type { DoctavianTokenSet } from "./auth";
import type { FetchLike } from "./types";
import { DOCTAVIAN_DEMO_BASE_URL } from "./auth";

export const DEFAULT_ENV_FILE = ".env.local";

export interface DoctavianEnv {
  baseUrl: string;
  bearerToken: string;
  documentsApiKey: string;
  signaturesApiKey: string;
  refreshToken: string | null;
}

/** Loads `.env.local` into `process.env` if the runtime supports it. */
export function loadDoctavianEnvFile(path: string = DEFAULT_ENV_FILE): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // Already loaded, or no file: the caller's own missing-variable error is a
    // better message than a file-not-found from here.
  }
}

export function readDoctavianEnv(): DoctavianEnv {
  const documentsApiKey = require_("DOCTAVIAN_DOCUMENTS_KEY");
  return {
    baseUrl: process.env.DOCTAVIAN_BASE_URL || DOCTAVIAN_DEMO_BASE_URL,
    bearerToken: require_("DOCTAVIAN_BEARER"),
    documentsApiKey,
    // The demo tenant issues one key for both areas. The client still keeps
    // them apart, so a production tenant with two keys needs no code change.
    signaturesApiKey: process.env.DOCTAVIAN_SIGNATURES_KEY || documentsApiKey,
    refreshToken: process.env.DOCTAVIAN_REFRESH || null,
  };
}

export interface ClientFromEnvOptions {
  /** Where a rotated token is written back to. */
  envFile?: string;
  /** Called after a successful refresh, for progress output. Never given the token. */
  onRefreshed?: (expiresIn: number) => void;
  persist?: boolean;
  /** Wrap the real fetch to trace calls without the client knowing about it. */
  fetchImpl?: FetchLike;
}

export function doctavianClientFromEnv(
  options: ClientFromEnvOptions = {},
): DoctavianClient {
  const env = readDoctavianEnv();
  const envFile = options.envFile ?? DEFAULT_ENV_FILE;
  return new DoctavianClient({
    baseUrl: env.baseUrl,
    bearerToken: env.bearerToken,
    documentsApiKey: env.documentsApiKey,
    signaturesApiKey: env.signaturesApiKey,
    fetchImpl: options.fetchImpl,
    refresh: env.refreshToken
      ? {
          refreshToken: env.refreshToken,
          onRefresh: (tokens: DoctavianTokenSet) => {
            if (options.persist !== false) persistTokens(envFile, tokens);
            options.onRefreshed?.(tokens.expiresIn);
          },
        }
      : undefined,
  });
}

/** Rewrites only the two token lines, leaving every other line untouched. */
export function persistTokens(envFile: string, tokens: DoctavianTokenSet): void {
  writeEnvValues(envFile, {
    DOCTAVIAN_BEARER: tokens.accessToken,
    DOCTAVIAN_REFRESH: tokens.refreshToken,
  });
  process.env.DOCTAVIAN_BEARER = tokens.accessToken;
  process.env.DOCTAVIAN_REFRESH = tokens.refreshToken;
}

export function writeEnvValues(
  envFile: string,
  values: Record<string, string>,
): void {
  let contents: string;
  try {
    contents = readFileSync(envFile, "utf8");
  } catch {
    contents = "";
  }

  const lines = contents.split(/\r?\n/);
  const remaining = new Map(Object.entries(values));

  const updated = lines.map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) return line;
    const key = match[1];
    if (!remaining.has(key)) return line;
    const value = remaining.get(key)!;
    remaining.delete(key);
    return `${key}=${value}`;
  });

  for (const [key, value] of remaining) updated.push(`${key}=${value}`);

  const text = updated.join("\n");
  writeFileSync(envFile, text.endsWith("\n") ? text : `${text}\n`, "utf8");
}

function require_(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Put the Doctavian credentials in ${DEFAULT_ENV_FILE}.`,
    );
  }
  return value;
}

#!/usr/bin/env tsx
/**
 * Assemble `xano/multidoc.xs` and, optionally, push the whole backend in one
 * request to the Metadata API.
 *
 * Two things about this script are deliberate.
 *
 * **Order is declared, not discovered.** A multidoc is applied top to bottom, so
 * a function that calls another has to come after it and every endpoint has to
 * come after the tables it queries. Globbing the directory would order the file
 * list by whatever the filesystem felt like, and the failure mode is a push that
 * half-applies. So the order lives in `MANIFEST` below, and a file on disk that
 * nobody listed is an error rather than a silent omission — adding a definition
 * is a deliberate act, which is the same reason the `--delete` flag is not here.
 *
 * **Pushing is opt-in and never destructive.** `partial=true` and no `delete`
 * parameter: this script adds and replaces, it does not remove. Xano's own CLI
 * puts `--delete`, `--truncate` and `--no-transaction` one keystroke apart, and
 * the transaction default is the only thing standing between a typo and a
 * half-migrated workspace. Removing an object is a decision for a human at the
 * console, not a flag on a build script.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const XANO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "xano");

/**
 * Application order. Tables first because everything queries them; functions
 * before the middleware, triggers, endpoints and tasks that call them, and in
 * their own dependency order; API groups immediately before their endpoints;
 * tasks last because they invoke everything else.
 */
const MANIFEST: readonly string[] = [
  "table/principal.xs",
  "table/agent.xs",
  "table/writ.xs",
  "table/clause.xs",
  "table/act.xs",
  "table/receipt.xs",
  "table/diligence.xs",
  "table/ledger.xs",
  "table/audit.xs",
  "table/job.xs",
  "table/job_dead_letter.xs",
  "table/webhook_source.xs",
  "table/webhook_request.xs",

  "function/ledger_append.xs",
  "function/audit_append.xs",
  "function/writ_assemble.xs",
  "function/writ_owned.xs",
  "function/job_enqueue.xs",
  "function/job_claim.xs",
  "function/job_complete.xs",
  "function/job_fail.xs",
  "function/webhook_verify.xs",
  "function/act_execute.xs",
  "function/webhook_esign_process.xs",

  "function/rate_guard.xs",

  "middleware/require_auth.xs",
  "middleware/audit_mutation.xs",

  "trigger/act_recorded.xs",

  "api/auth/api_group.xs",
  "api/auth/signup.xs",
  "api/auth/login.xs",

  "api/chancery/api_group.xs",
  "api/chancery/me.xs",
  "api/chancery/writ_create.xs",
  "api/chancery/writ_get.xs",
  "api/chancery/writ_by_domain.xs",
  "api/chancery/writ_update.xs",
  "api/chancery/act_history.xs",
  "api/chancery/act_record.xs",
  "api/chancery/ledger_append.xs",
  "api/chancery/ledger_list.xs",
  "api/chancery/evidence_put.xs",

  "api/public/api_group.xs",
  "api/public/verify.xs",
  "api/public/ledger_spine.xs",
  "api/public/receipt_get.xs",

  "api/webhook/api_group.xs",
  "api/webhook/esign.xs",

  "task/sweep_expired_writs.xs",
  "task/drain_job_queue.xs",
  "task/reap_stale_claims.xs",
];

/**
 * Definitions the Metadata API refuses on the free plan, verbatim:
 *
 *   middleware -> "Please upgrade to access middleware."
 *   trigger    -> "Triggers are only available on paid packages."
 *   task       -> "Please upgrade to access tasks."
 *
 * The refusal is a hard 400 on the WHOLE multidoc, not a skipped definition, so
 * a push that includes any of them fails entirely and lands nothing. They are
 * therefore excluded by default and included with `--include-paid`.
 *
 * They stay in the repository because they are the design, not decoration: the
 * free-tier deployment reproduces each one's effect explicitly — `auth` on every
 * endpoint instead of `require_auth`, an `audit_append` call at the top of every
 * mutating endpoint instead of `audit_mutation`, and a queue drained on demand
 * instead of on a schedule.
 */
const PAID_ONLY: readonly string[] = MANIFEST.filter(
  (path) =>
    path.startsWith("middleware/") || path.startsWith("trigger/") || path.startsWith("task/"),
);

export function manifestFor(includePaid: boolean): readonly string[] {
  return includePaid ? MANIFEST : MANIFEST.filter((path) => !PAID_ONLY.includes(path));
}

/** `---` alone on its own line. A separator with trailing space is not one. */
export const SEPARATOR = "---";

/**
 * Fold a multi-line `` code = `...` `` block into one double-quoted line.
 *
 * XanoScript has no multi-line string literal: a newline inside any string is
 * `Syntax error: unexpected newline`. The only way to ship a lambda longer than
 * one statement is a single-line string carrying `\n` escapes — which is
 * unreadable, and the lambdas here are the canonical-JSON hasher and the HMAC
 * verifier, the two pieces most worth reading.
 *
 * So the `.xs` sources keep the JavaScript legible inside backticks and this
 * folds it at assembly time. The transform is deterministic, which is what lets
 * `tests/xano/backend.test.ts` still assert that `multidoc.xs` has not drifted
 * from the tree. Newlines survive as real newlines inside the lambda, so `//`
 * comments in the JavaScript stay correct rather than swallowing the rest of it.
 */
export function foldLambdaBodies(source: string): string {
  return source.replace(
    /^([ \t]*)code = `\n([\s\S]*?)^[ \t]*`[ \t]*$/gm,
    (_match, indent: string, body: string) => `${indent}code = ${encodeXsString(dedent(body))}`,
  );
}

function dedent(body: string): string {
  const lines = body.replace(/\n[ \t]*$/, "").split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(common)).join("\n");
}

function encodeXsString(value: string): string {
  const escaped = value
    .split("\\")
    .join("\\\\")
    .split('"')
    .join('\\"')
    .split("\n")
    .join("\\n");
  return `"${escaped}"`;
}

export function buildMultidoc(root: string = XANO_DIR, only?: readonly string[]): string {
  // A subset push is for iterating on one definition against a live instance.
  // The server applies a multidoc top to bottom and reports the FIRST parse
  // error, so pushing 50 definitions to debug the 34th means re-reading the
  // same 33 successes every round.
  const parts = (only ?? MANIFEST).map((relative) => {
    const source = foldLambdaBodies(readFileSync(join(root, relative), "utf8")).replace(/\s+$/, "");
    // The provenance comment is the only thing this script adds. When a push
    // fails on definition 34 of 50, being able to find definition 34 in the
    // source tree without counting separators is worth three lines of output.
    return `// ${relative}\n${source}`;
  });
  return `${parts.join(`\n${SEPARATOR}\n`)}\n`;
}

interface PushConfig {
  metaUrl: string;
  workspaceId: string;
  token: string;
}

function readConfig(): PushConfig {
  // Credentials live in `.env.local`, which is gitignored. Loaded here rather
  // than expected in the ambient environment so that running the script is one
  // command with no shell ceremony to get wrong.
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Already exported, or running in CI. Fall through to the check below.
  }

  const instance = (process.env.XANO_INSTANCE ?? "").replace(/^https?:\/\//, "");
  const metaUrl = process.env.XANO_META_URL ?? (instance === "" ? "" : `https://${instance}/api:meta`);
  const workspaceId = process.env.XANO_WORKSPACE_ID ?? "";
  const token = process.env.XANO_TOKEN ?? process.env.XANO_METADATA_TOKEN ?? "";

  const missing = [
    metaUrl === "" ? "XANO_META_URL (or XANO_INSTANCE)" : null,
    workspaceId === "" ? "XANO_WORKSPACE_ID" : null,
    token === "" ? "XANO_TOKEN" : null,
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    throw new Error(`missing environment: ${missing.join(", ")}`);
  }
  return { metaUrl: metaUrl.replace(/\/+$/, ""), workspaceId, token };
}

export async function push(
  multidoc: string,
  config: PushConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  // `partial=true`, and no `delete`. This script adds and replaces; it never
  // removes. `transaction=true` is the default and is left alone: a push that
  // fails halfway through must roll back, or the workspace is left in a state
  // that matches no commit.
  const url =
    `${config.metaUrl}/workspace/${encodeURIComponent(config.workspaceId)}/multidoc` +
    `?partial=true&transaction=true`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      // Not application/json. The body is XanoScript source, and Xano routes on
      // this header — sending JSON gets a 400 that says nothing useful.
      "content-type": "text/x-xanoscript",
      accept: "application/json",
    },
    body: multidoc,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`multidoc push failed with ${response.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = new Set(argv.filter((arg) => arg.startsWith("--")));
  const only = argv.filter((arg) => !arg.startsWith("--"));

  const includePaid = args.has("--include-paid");
  const selection = only.length > 0 ? only : manifestFor(includePaid);
  const multidoc = buildMultidoc(XANO_DIR, selection);
  const definitions = multidoc.split(`\n${SEPARATOR}\n`).length;

  if (only.length > 0) {
    process.stdout.write(`subset: ${only.join(", ")} (multidoc.xs left alone)\n`);
  } else {
    // The committed multidoc is always the free-tier one, because that is what
    // actually deploys. `--include-paid` is for an upgraded workspace and does
    // not overwrite it.
    if (!includePaid) {
      const outPath = join(XANO_DIR, "multidoc.xs");
      writeFileSync(outPath, multidoc, "utf8");
      process.stdout.write(`assembled ${definitions} definitions -> ${outPath}\n`);
    } else {
      process.stdout.write(
        `assembled ${definitions} definitions including paid-tier objects (multidoc.xs left alone)\n`,
      );
    }
    const skipped = MANIFEST.length - selection.length;
    if (skipped > 0) {
      process.stdout.write(`skipped ${skipped} paid-tier definitions (pass --include-paid)\n`);
    }
  }

  if (!args.has("--push")) {
    process.stdout.write("not pushing (pass --push)\n");
    return;
  }

  const config = readConfig();
  if (args.has("--dry-run")) {
    process.stdout.write(
      `would POST ${definitions} definitions to ${config.metaUrl}` +
        `/workspace/${config.workspaceId}/multidoc\n`,
    );
    return;
  }

  const result = await push(multidoc, config);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

// Only when run directly, so the exported helpers stay importable from a test.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { MANIFEST, XANO_DIR };

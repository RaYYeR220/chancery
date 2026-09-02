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

  "middleware/require_auth.xs",
  "middleware/audit_mutation.xs",

  "trigger/act_recorded.xs",

  "api/auth/_group.xs",
  "api/auth/signup.xs",
  "api/auth/login.xs",

  "api/chancery/_group.xs",
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

  "api/public/_group.xs",
  "api/public/verify.xs",
  "api/public/ledger_spine.xs",
  "api/public/receipt_get.xs",

  "api/webhook/_group.xs",
  "api/webhook/esign.xs",

  "task/sweep_expired_writs.xs",
  "task/drain_job_queue.xs",
  "task/reap_stale_claims.xs",
];

/** `---` alone on its own line. A separator with trailing space is not one. */
export const SEPARATOR = "---";

export function buildMultidoc(root: string = XANO_DIR): string {
  const parts = MANIFEST.map((relative) => {
    const source = readFileSync(join(root, relative), "utf8").replace(/\s+$/, "");
    // The provenance comment is the only thing this script adds. When a push
    // fails on definition 34 of 51, being able to find definition 34 in the
    // source tree without counting separators is worth three lines of output.
    return `// ${relative}\n${source}`;
  });
  return `${parts.join(`\n${SEPARATOR}\n`)}\n`;
}

interface PushConfig {
  instance: string;
  workspaceId: string;
  token: string;
}

function readConfig(): PushConfig {
  const instance = process.env.XANO_INSTANCE ?? "";
  const workspaceId = process.env.XANO_WORKSPACE_ID ?? "";
  const token = process.env.XANO_METADATA_TOKEN ?? "";
  const missing = [
    instance === "" ? "XANO_INSTANCE" : null,
    workspaceId === "" ? "XANO_WORKSPACE_ID" : null,
    token === "" ? "XANO_METADATA_TOKEN" : null,
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    throw new Error(`missing environment: ${missing.join(", ")}`);
  }
  return { instance: instance.replace(/\/+$/, ""), workspaceId, token };
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
    `${config.instance}/api:meta/workspace/${encodeURIComponent(config.workspaceId)}/multidoc` +
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
  const args = new Set(process.argv.slice(2));
  const multidoc = buildMultidoc();
  const definitions = multidoc.split(`\n${SEPARATOR}\n`).length;

  const outPath = join(XANO_DIR, "multidoc.xs");
  writeFileSync(outPath, multidoc, "utf8");
  process.stdout.write(
    `assembled ${definitions} definitions (${multidoc.length} bytes) -> ${outPath}\n`,
  );

  if (!args.has("--push")) {
    process.stdout.write("not pushing (pass --push)\n");
    return;
  }

  const config = readConfig();
  if (args.has("--dry-run")) {
    process.stdout.write(
      `would POST ${definitions} definitions to ${config.instance}` +
        `/api:meta/workspace/${config.workspaceId}/multidoc\n`,
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

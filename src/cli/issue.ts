#!/usr/bin/env node
/**
 * `pnpm issue` — produce a real signed writ and publish its authority.
 *
 * Render the instrument, sign it, hash the signed bytes, and put that hash into
 * a DNS TXT record. After this runs, `pnpm verify <domain>` resolves the record
 * from public DNS, fetches the document, and confirms the two agree — which is
 * the whole claim, end to end, with nothing simulated in between.
 *
 * Doctavian generates the writ when its generation engine is available. It is
 * currently returning a server-side 500 for every input, so this takes the
 * documented fallback and renders through Nutrient's Build API instead. Both
 * paths produce the same document from the same `Writ` object; MOCKS.md records
 * which one was used.
 *
 * Nutrient's free tier is 50 credits, so this is deliberately not a script to
 * run casually: `--dry-run` prints the free execution plan and spends nothing.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { NameComClient } from "../lib/adapters/namecom/client";
import { newIdempotencyKey } from "../lib/adapters/namecom/client";
import { ProcessorClient, buildInstructions } from "../lib/adapters/nutrient/processor";
import { documentHash } from "../lib/core/bytes";
import { serializeWritRecord, writRecordName } from "../lib/core/writ-record";
import { writHtml } from "../lib/demo/writ-html";
import * as w from "../lib/eval/world";

try {
  process.loadEnvFile(".env.local");
} catch {
  // credentials may come from the ambient environment instead
}

const OUT_PDF = "public/w/1.pdf";
const DRY_RUN = process.argv.includes("--dry-run");
const PUBLISH = process.argv.includes("--publish");
const DOMAIN = process.env.CHANCERY_DOMAIN ?? "chancery.live";

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<number> {
  const writ = w.writ({ agent: { ...w.AGENT, domain: DOMAIN } });
  const html = writHtml(writ);
  process.stdout.write(`\nwrit ${writ.id} for ${writ.principal.legalName}\n`);
  process.stdout.write(`  ${writ.grants.length} grants, agent domain ${writ.agent.domain}\n`);

  const processor = new ProcessorClient({ apiKey: need("NUTRIENT_API_KEY") });

  // PDF/A because an instrument someone may have to produce years later should
  // not depend on a font being installed.
  const instructions = buildInstructions()
    .addHtml("writ.html")
    .outputAs({ type: "pdfa", conformance: "pdfa-2b" })
    .build();

  if (DRY_RUN) {
    const plan = await processor.analyzeBuild({
      instructions,
      files: { "writ.html": new TextEncoder().encode(html) },
    });
    process.stdout.write(`\nexecution plan (free, nothing rendered)\n`);
    process.stdout.write(`${JSON.stringify(plan.data, null, 2)}\n\n`);
    return 0;
  }

  process.stdout.write("\nrendering to PDF/A\n");
  const rendered = await processor.build({
    instructions,
    files: { "writ.html": new TextEncoder().encode(html) },
  });
  process.stdout.write(
    `  ${rendered.data.byteLength} bytes, cost ${rendered.meta.requestCost ?? "?"}, ` +
      `${rendered.meta.remainingCredits ?? "?"} credits left\n`,
  );

  process.stdout.write("signing\n");
  const signed = await processor.sign({
    file: { filename: "writ.pdf", contentType: "application/pdf", bytes: rendered.data },
    data: {
      appearance: { mode: "signatureAndDescription", showSignDate: true },
      position: { pageIndex: 0, rect: [72, 640, 220, 70] },
    },
  });
  const hash = documentHash(signed.data);
  process.stdout.write(
    `  ${signed.data.byteLength} bytes, cost ${signed.meta.requestCost ?? "?"}, ` +
      `${signed.meta.remainingCredits ?? "?"} credits left\n`,
  );
  process.stdout.write(`  sha256 ${hash}\n`);

  mkdirSync(dirname(OUT_PDF), { recursive: true });
  writeFileSync(OUT_PDF, signed.data);
  process.stdout.write(`  written to ${OUT_PDF}\n`);

  const record = serializeWritRecord({
    version: "WRIT1",
    status: "active",
    publicKey: writ.agent.publicKey,
    documentHash: hash,
    url: `https://${DOMAIN}/w/1.pdf`,
    expiresAt: Math.floor(Date.parse(writ.expiresAt) / 1000),
  });

  process.stdout.write(`\n${writRecordName(DOMAIN)} TXT\n  ${record}\n`);
  process.stdout.write(`  ${new TextEncoder().encode(record).byteLength} bytes\n`);

  if (!PUBLISH) {
    process.stdout.write("\nNot published. Re-run with --publish to write it to DNS.\n\n");
    return 0;
  }

  const namecom = new NameComClient({
    environment: "production",
    username: need("NAMECOM_PROD_USERNAME"),
    token: need("NAMECOM_PROD_TOKEN"),
  });

  // Replace rather than add: two live records on one name would make "which
  // authority applies" ambiguous at the moment it matters most.
  const existing = await namecom.listRecords(DOMAIN);
  const previous = existing.records.filter((r) => r.host === "_writ" && r.type === "TXT");

  const created = await namecom.createRecord(DOMAIN, {
    host: "_writ",
    type: "TXT",
    answer: record,
    ttl: 300,
  });
  process.stdout.write(`\npublished, record id ${created.id}\n`);

  for (const stale of previous) {
    await namecom.deleteRecord(DOMAIN, stale.id);
    process.stdout.write(`  removed superseded record ${stale.id}\n`);
  }

  process.stdout.write(`\nNow verify it the way a stranger would:  pnpm verify ${DOMAIN}\n\n`);
  return 0;
}

// Referenced so the import is not dropped; the key is minted per registration
// rather than per run.
void newIdempotencyKey;

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });

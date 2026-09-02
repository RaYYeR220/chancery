#!/usr/bin/env node
/**
 * `chancery verify` — the independent verifier.
 *
 * This deliberately imports nothing from the service layer and holds no
 * credentials. It talks to public DNS and fetches a public document, which is
 * the whole claim: an agent's authority is checkable by anyone, without asking
 * us, and a verdict we published can be re-derived by anyone from its evidence
 * bundle.
 *
 * Two modes:
 *
 *   chancery verify ops.example.com          resolve, fetch, hash, explain
 *   chancery verify --bundle decision.json   re-derive a published verdict offline
 *
 * Exit codes are meaningful so this can be a CI check: 0 verified, 1 refused or
 * unverifiable, 2 the tool itself could not run.
 */

import { readFile } from "node:fs/promises";

import { documentHash } from "../lib/core/bytes";
import { replay, type EvidenceBundle } from "../lib/core/evidence";
import {
  joinTxtChunks,
  selectWritRecord,
  writRecordName,
  type WritRecord,
} from "../lib/core/writ-record";

const RESOLVERS = [
  { name: "cloudflare", url: "https://cloudflare-dns.com/dns-query" },
  { name: "google", url: "https://dns.google/resolve" },
];

interface DohAnswer {
  Status: number;
  AD?: boolean;
  Answer?: { name: string; type: number; TTL: number; data: string }[];
}

async function resolveTxt(name: string): Promise<{
  records: string[];
  resolver: string;
  authenticatedData: boolean;
}> {
  const failures: string[] = [];
  for (const resolver of RESOLVERS) {
    try {
      const response = await fetch(`${resolver.url}?name=${encodeURIComponent(name)}&type=TXT`, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        failures.push(`${resolver.name}: HTTP ${response.status}`);
        continue;
      }
      const body = (await response.json()) as DohAnswer;
      const records = (body.Answer ?? [])
        .filter((answer) => answer.type === 16)
        // A resolver may hand back several quoted <=255-byte chunks per record.
        .map((answer) => joinTxtChunks(answer.data.split(/"\s+"/)));
      return {
        records,
        resolver: resolver.name,
        authenticatedData: body.AD === true,
      };
    } catch (error) {
      failures.push(`${resolver.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`no resolver answered (${failures.join("; ")})`);
}

function describeAuthority(record: WritRecord, now: number): string[] {
  const lines: string[] = [];
  const expiresAt = new Date(record.expiresAt * 1000).toISOString();
  lines.push(`  status      ${record.status}`);
  lines.push(`  expires     ${expiresAt}${record.expiresAt * 1000 <= now ? "  (PASSED)" : ""}`);
  lines.push(`  agent key   ${record.publicKey}`);
  lines.push(`  document    ${record.url}`);
  lines.push(`  doc hash    ${record.documentHash}`);
  return lines;
}

async function verifyLive(domain: string): Promise<number> {
  const name = writRecordName(domain);
  process.stdout.write(`Resolving ${name} TXT\n`);

  const answer = await resolveTxt(name);
  process.stdout.write(`  resolver    ${answer.resolver}\n`);
  process.stdout.write(
    `  DNSSEC      ${answer.authenticatedData ? "validated" : "NOT validated"}\n`,
  );
  process.stdout.write(`  records     ${answer.records.length}\n\n`);

  const lookup = selectWritRecord(answer.records);
  if (lookup.outcome === "absent") {
    process.stdout.write("REFUSED  no writ is published here, so this agent holds no authority.\n");
    return 1;
  }
  if (lookup.outcome === "revoked") {
    process.stdout.write("REFUSED  a revocation tombstone is published; all authority has ended.\n");
    for (const line of describeAuthority(lookup.record, Date.now())) process.stdout.write(`${line}\n`);
    return 1;
  }

  const record = lookup.record;
  for (const line of describeAuthority(record, Date.now())) process.stdout.write(`${line}\n`);
  process.stdout.write("\n");

  if (!answer.authenticatedData) {
    process.stdout.write(
      "WARNING  the answer was not DNSSEC-validated, so a revocation could have been stripped\n" +
        "         in transit. A strict verifier treats this authority as unverified.\n\n",
    );
  }

  process.stdout.write(`Fetching ${record.url}\n`);
  const document = await fetch(record.url, { signal: AbortSignal.timeout(15_000) });
  if (!document.ok) {
    process.stdout.write(`REFUSED  the signed writ could not be fetched (HTTP ${document.status}).\n`);
    return 1;
  }
  const bytes = new Uint8Array(await document.arrayBuffer());
  const actual = documentHash(bytes);

  process.stdout.write(`  bytes       ${bytes.byteLength}\n`);
  process.stdout.write(`  sha256      ${actual}\n\n`);

  if (actual !== record.documentHash) {
    process.stdout.write(
      "REFUSED  the document does not match the hash published in DNS.\n" +
        "         It has been altered since it was signed.\n",
    );
    return 1;
  }

  if (record.expiresAt * 1000 <= Date.now()) {
    process.stdout.write("REFUSED  this writ has expired.\n");
    return 1;
  }

  process.stdout.write(
    "VERIFIED the published document is the one this authority was granted by.\n" +
      (answer.authenticatedData
        ? ""
        : "         (accepted without DNSSEC — see the warning above)\n"),
  );
  return answer.authenticatedData ? 0 : 1;
}

async function verifyBundle(path: string): Promise<number> {
  const bundle = JSON.parse(await readFile(path, "utf8")) as EvidenceBundle;
  process.stdout.write(`Replaying ${path}\n`);
  process.stdout.write(`  evaluated   ${bundle.evaluatedAt}\n`);
  process.stdout.write(`  recorded    ${bundle.decision.outcome}\n\n`);

  const result = replay(bundle);
  if (result.agrees) {
    process.stdout.write(
      `VERIFIED the recorded verdict re-derives from its own evidence: ${result.decision.outcome}.\n`,
    );
    for (const reason of result.decision.reasons) {
      process.stdout.write(
        `         ${reason.code}${reason.clauseRef ? ` (clause ${reason.clauseRef})` : ""}: ${reason.message}\n`,
      );
    }
    return 0;
  }

  process.stdout.write("REFUSED  the recorded verdict does not re-derive from its own evidence.\n");
  for (const difference of result.differences) process.stdout.write(`         ${difference}\n`);
  return 1;
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(
      "chancery verify <agent-domain>       check an agent's authority against public DNS\n" +
        "chancery verify --bundle <file.json> re-derive a published verdict offline\n",
    );
    return args.length === 0 ? 2 : 0;
  }

  if (args[0] === "--bundle") {
    if (args[1] === undefined) {
      process.stderr.write("--bundle needs a path\n");
      return 2;
    }
    return verifyBundle(args[1]);
  }
  return verifyLive(args[0]);
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });

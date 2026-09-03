#!/usr/bin/env node
/**
 * `pnpm demo` — the walkthrough, narrated, with real verdicts.
 *
 * Needs no credentials, no network and no server. The acts are decided by the
 * same engine the product uses, against the same writ, carrying history forward
 * the way a live session does — so the refusals here are refusals, not printed
 * strings. If the engine changed, this output would change with it.
 *
 * It exists because a reviewer with four minutes should be able to watch the
 * whole argument happen rather than read a description of it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { bundleDigest, decideWithEvidence } from "../lib/core/evidence";
import { decide } from "../lib/core/gatekeeper";
import { DEMO_SCRIPT, type DemoStep } from "../lib/demo/script";
import { serializeWritRecord } from "../lib/core/writ-record";
import * as w from "../lib/eval/world";
import type { ActHistoryEntry, Decision } from "../lib/core/types";

const RESET = "[0m";
const DIM = "[2m";
const BOLD = "[1m";
const GREEN = "[32m";
const RED = "[31m";
const YELLOW = "[33m";

const colour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const c = (code: string, text: string) => (colour ? `${code}${text}${RESET}` : text);

const VENDOR_LABEL: Record<DemoStep["vendor"], string> = {
  foxit: "Foxit",
  doctavian: "Doctavian",
  nutrient: "Nutrient DWS",
  namecom: "name.com",
  serpapi: "SerpApi",
  xano: "Xano",
  none: "",
};

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

function renderVerdict(decision: Decision): string {
  const lines: string[] = [];
  const allowed = decision.outcome === "allow";
  const badge = allowed ? c(GREEN, "  ALLOW  ") : c(RED, "  DENY   ");
  lines.push(`    ${badge}`);

  for (const reason of decision.reasons) {
    const where =
      reason.clauseRef !== undefined
        ? c(DIM, `  [clause ${reason.clauseRef}${reason.pageNumber !== undefined ? `, page ${reason.pageNumber}` : ""}]`)
        : "";
    lines.push(`${wrap(reason.message, 74, "             ")}${where}`);
  }
  return lines.join("\n");
}

/**
 * Where to write the evidence for each decided step.
 *
 * A bundle is only worth publishing if someone can act on it, so the demo emits
 * real ones rather than describing them: `pnpm verify --bundle <file>` re-derives
 * any of these offline, and disagreement is reported rather than smoothed over.
 */
function evidenceDir(): string | null {
  const flag = process.argv.indexOf("--evidence");
  if (flag === -1) return null;
  return process.argv[flag + 1] ?? "evidence";
}

function main(): number {
  const history: ActHistoryEntry[] = [];
  const outDir = evidenceDir();
  if (outDir) mkdirSync(outDir, { recursive: true });
  let failures = 0;

  process.stdout.write(`\n${c(BOLD, "Chancery")} — power of attorney for AI agents\n`);
  process.stdout.write(
    c(DIM, "Every verdict below is produced by the real decision engine.\n\n"),
  );

  for (const step of DEMO_SCRIPT) {
    const vendor = VENDOR_LABEL[step.vendor];
    process.stdout.write(
      `${c(BOLD, step.id)}${vendor ? c(DIM, `  ${vendor}`) : ""}\n`,
    );
    process.stdout.write(`${wrap(step.narration, 76, "  ")}\n`);
    process.stdout.write(c(DIM, `${wrap(`watch: ${step.watch}`, 76, "  ")}\n`));

    if (step.request !== undefined && step.expect !== undefined) {
      // The two verification steps break the world deliberately; every other
      // act runs against the writ the principal signed at step D-04.
      const broken =
        step.id === "D-12"
          ? { fetchedDocumentHash: "dGFtcGVyZWQtaGFzaC1hZnRlci1lZGl0" }
          : step.id === "D-13"
            ? { lookup: { outcome: "revoked" as const, record: w.record({ status: "revoked" }) } }
            : {};

      const input = w.baseline({
        request: step.request,
        diligence: step.diligence,
        history: [...history],
        ...broken,
      });
      const decision = decide(input);

      process.stdout.write(`\n${renderVerdict(decision)}\n`);

      if (outDir) {
        const bundle = decideWithEvidence({
          resolution: {
            name: `_writ.${w.AGENT.domain}`,
            txtRecords: [serializeWritRecord(w.record())],
            resolver: "https://cloudflare-dns.com/dns-query",
            authenticatedData: true,
            resolvedAt: w.NOW,
          },
          lookup: input.lookup,
          document: {
            url: `https://chancery.dev/w/${w.writ().id}`,
            sha256: input.fetchedDocumentHash ?? w.DOCUMENT_HASH,
            byteLength: 48_120,
            signature: { verified: true, method: "pades", profile: "b-lt" },
          },
          extraction: {
            method: "nutrient/understand",
            responseDigest: "0".repeat(64),
            groundingPolicy: {
              acceptedMatches: ["id_match", "id_match_multiblock", "id_match_partial"],
              confidenceThreshold: null,
            },
          },
          policy: input.policy,
          request: step.request,
          history: [...history],
          diligence: step.diligence ?? [],
          now: w.NOW,
        });
        const file = join(outDir, `${step.id}.json`);
        writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
        process.stdout.write(
          c(DIM, `             evidence ${file}  digest ${bundleDigest(bundle).slice(0, 16)}\n`),
        );
      }

      const matched =
        decision.outcome === step.expect.outcome &&
        decision.reasons.some((r) => r.code === step.expect!.code);
      if (!matched) {
        failures += 1;
        process.stdout.write(
          c(
            YELLOW,
            `    the narration claims ${step.expect.outcome}/${step.expect.code}, ` +
              `the engine said ${decision.outcome}/[${decision.reasons.map((r) => r.code).join(",")}]\n`,
          ),
        );
      }

      // Only an executed act consumes budget. A refusal costs nothing, which is
      // why the fourth registration can be attempted at all.
      if (decision.outcome === "allow") {
        history.push({
          kind: step.request.kind,
          grantRef: decision.reasons[0]?.clauseRef ?? "",
          amountMinorUnits: step.request.amountMinorUnits ?? 0,
          currency: step.request.currency ?? "USD",
          executedAt: w.NOW,
        });
      }
    }

    process.stdout.write("\n");
  }

  process.stdout.write(
    failures === 0
      ? c(DIM, "Every verdict matched what the narration claims.\n\n")
      : c(YELLOW, `${failures} step(s) did not match the narration.\n\n`),
  );
  return failures === 0 ? 0 : 1;
}

process.exit(main());

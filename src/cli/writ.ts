/**
 * Generates a writ against the live Doctavian API, printing each of the six
 * calls.
 *
 *   pnpm writ                 # full run; writes the PDF and the call transcript
 *   pnpm writ --no-verify     # skip the second (DOCX) render
 *   pnpm writ --keep-docx     # also save the DOCX verification render
 *   pnpm writ --trace         # print every request/response as it happens
 *
 * Two things about this script are not incidental.
 *
 * First, it renders twice on purpose. The PDF is the artefact a human signs;
 * the DOCX is the same template and data rendered to a format whose text can be
 * read back programmatically. That is the only way to *prove* the branching and
 * the arithmetic did what the template says, rather than inferring it from a
 * plausible-looking PDF. The trap is silent: a Jexl expression that
 * concatenates instead of adding yields "265000100", not an error.
 *
 * Second, each render re-uploads its own template and data. Uploaded blobs are
 * single-use — the first server-side operation that reads one removes it, even
 * with `remove: "none"` — so a second generate against the same ids fails with
 * FILE_MISSING_FROM_STORAGE. Verified live; documented nowhere.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

import { doctavianClientFromEnv, loadDoctavianEnvFile } from "../lib/adapters/doctavian/env";
import { DoctavianApiError } from "../lib/adapters/doctavian/errors";
import { sampleWrit } from "../lib/adapters/doctavian/sample-writ";
import type {
  DoctavianBinary,
  FetchLike,
  GenerateDocumentResult,
  OutputFileFormat,
} from "../lib/adapters/doctavian/types";
import { buildWritData } from "../lib/adapters/doctavian/writ-data";
import { buildWritTemplateDocx } from "../lib/adapters/doctavian/writ-template";

/**
 * The spec's own examples use a Windows display name for the timezone and an
 * ICU-style underscored locale, not the bare IANA/BCP-47 forms the field names
 * suggest.
 */
const TIMEZONE = "(GMT+00:00) Greenwich Mean Time (Europe/Dublin)";
const LOCALE = "en_IE_EURO";

const SAMPLE_OPTIONS = {
  escalationPercent: 25,
  escalationFloorMinorUnits: 100_000,
  dailyCapMinorUnits: 50_000,
};

function fixturesDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/doctavian");
}

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

let step = 0;
function stepLog(message: string): void {
  step += 1;
  process.stdout.write(`\n[${step}/6] ${message}\n`);
}

interface TranscriptEntry {
  method: string;
  path: string;
  status: number;
  body: unknown;
}
const transcript: TranscriptEntry[] = [];

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  loadDoctavianEnvFile();

  const client = doctavianClientFromEnv({
    onRefreshed: (expiresIn) =>
      say(`      token refreshed, valid ${expiresIn}s, written back to .env.local`),
    fetchImpl: recordingFetch(args.has("--trace")),
  });
  const outDir = fixturesDir();
  await mkdir(outDir, { recursive: true });

  const name = `chancery-writ-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const templateBytes = await buildWritTemplateDocx();
  const data = buildWritData(sampleWrit(), SAMPLE_OPTIONS);
  say(`base URL   ${process.env.DOCTAVIAN_BASE_URL}`);
  say(
    `template   ${templateBytes.length} bytes, ${data.Writ[0].Grants.length} granted act classes`,
  );

  say("\n[0/6] preflight: GET /v1/documents/template/list");
  const templates = await client.listTemplates();
  say(`      ok — ${templates.length} template(s) registered in the tenant`);

  stepLog("POST /v1/documents/datasource/create");
  const { dataSourceGuid } = await client.createDataSource({
    name,
    description: "Chancery writ of delegated authority",
  });
  say(`      dataSourceGuid ${dataSourceGuid}`);

  stepLog("POST /v1/documents/solution/create");
  const { documentSolutionGuid } = await client.createSolution({
    name,
    description: "Chancery writ of delegated authority",
    dataGuid: dataSourceGuid,
  });
  say(`      documentSolutionGuid ${documentSolutionGuid}`);

  stepLog("POST /v1/documents/template/upload  (x-storage-type: document-template)");
  const template = await client.uploadTemplate(
    { fileName: "writ-template.docx", bytes: templateBytes },
    { documentSolutionGuid },
  );
  say(`      template id ${template.id}`);

  stepLog("POST /v1/documents/data/upload  (x-storage-type: document-data)");
  const uploaded = await client.uploadData(data, {
    fileName: "writ-data.json",
    dataSourceGuid,
  });
  say(`      data id ${uploaded.id}`);

  stepLog("POST /v1/documents/document/generate  (sync)");
  const generated = await generate("pdf", template.id, uploaded.id);
  say(`      urn ${generated.urn}`);
  say(`      consumption ${JSON.stringify(generated.consumption)}`);

  stepLog("GET /v1/documents/document/{urn}/download  (x-storage-type: document-data)");
  const pdf = await client.downloadDocument(generated.urn);
  const pdfPath = join(outDir, "writ-generated.pdf");
  await writeFile(pdfPath, pdf.bytes);
  say(`      ${pdf.bytes.length} bytes, ${pdf.contentType ?? "no content-type"}`);
  say(`      saved ${pdfPath}`);
  assertPdf(pdf);

  if (!args.has("--no-verify")) {
    say("\n[verify] re-uploading template and data (blobs are single-use), then");
    say("         rendering the same writ to DOCX so the text can be read back");
    const freshTemplate = await client.uploadTemplate({
      fileName: "writ-template.docx",
      bytes: templateBytes,
    });
    const freshData = await client.uploadData(data, { fileName: "writ-data.json" });
    const rendered = await generate("docx", freshTemplate.id, freshData.id);
    const docx = await client.downloadDocument(rendered.urn);
    if (args.has("--keep-docx")) {
      const docxPath = join(outDir, "writ-generated.docx");
      await writeFile(docxPath, docx.bytes);
      say(`      saved ${docxPath}`);
    }
    verifyRendering(await docxText(docx.bytes));
  }

  say("\ndone.");

  function generate(
    fileFormat: OutputFileFormat,
    templateUrn: string,
    dataUrn: string,
  ): Promise<GenerateDocumentResult> {
    return client.generateDocument({
      template: {
        name: "writ-template.docx",
        urn: templateUrn,
        fileFormat: "docx",
        loadMethod: "Storage",
      },
      data: { urn: dataUrn, loadMethod: "Storage" },
      document: {
        name: `${name}-${fileFormat}`,
        fileFormat,
        deliveryMethod: "Storage",
        path: "root",
        locale: LOCALE,
        timezone: TIMEZONE,
      },
    });
  }
}

/**
 * Records every call, so a run leaves behind evidence that the integration
 * really talked to Doctavian and so the offline tests can replay the real
 * response envelopes. Auth responses are never recorded or printed — the token
 * endpoint's body is the one thing here that must not reach a file or a
 * scrollback buffer.
 */
function recordingFetch(trace: boolean): FetchLike {
  return async (input, init) => {
    const response = await fetch(input, init);
    const path = new URL(input).pathname;
    const method = init.method ?? "GET";
    if (path.includes("/auth/")) {
      if (trace) say(`      trace ${method} ${path} -> ${response.status} <body withheld>`);
      return response;
    }
    const clone = response.clone();
    const contentType = clone.headers.get("content-type") ?? "";
    const body = contentType.includes("json")
      ? redact(await clone.json())
      : `<${contentType || "binary"}>`;
    transcript.push({ method, path, status: response.status, body });
    if (trace) {
      say(
        `      trace ${method} ${path} -> ${response.status} ${JSON.stringify(body).slice(0, 600)}`,
      );
    }
    return response;
  };
}

/** Tenant and user identifiers are not secrets, but they do not belong in a fixture. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = /subscriptionGuid|ownerGuid|lastModifiedUserGuid|userId/i.test(key)
      ? "<redacted>"
      : redact(entry);
  }
  return out;
}

function assertPdf(file: DoctavianBinary): void {
  const header = Buffer.from(file.bytes.subarray(0, 5)).toString("latin1");
  if (header !== "%PDF-") {
    throw new Error(`downloaded file is not a PDF (starts with ${JSON.stringify(header)})`);
  }
  say("      header %PDF- ok");
}

async function docxText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")!.async("string");
  return xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Each check fails the run rather than warning. A writ that prints an
 * inapplicable clause, or a ceiling that is a concatenation rather than a sum,
 * is worse than no writ at all: it is a false statement about what a human
 * authorised.
 */
function verifyRendering(text: string): void {
  const checks: [string, boolean][] = [
    ["no unrendered merge fields left in the document", !text.includes("{!")],
    ["no unrendered mdoc elements left in the document", !text.includes("<mdoc:")],
    ["repeater produced clause 3(a)", text.includes("3(a)")],
    ["repeater produced clause 3(b)", text.includes("3(b)")],
    ["repeater produced clause 3(c)", text.includes("3(c)")],
    ["repeater produced clause 3(d)", text.includes("3(d)")],
    ["nested repeater produced sub-clause 3(a)(iv)", text.includes("3(a)(iv)")],
    ["eIDAS clause rendered for an Irish principal", /eIDAS|910\/2014/.test(text)],
    ["non-EEA fallback clause hidden", !text.includes("satisfies any requirement of writing")],
    ["UK-only clause hidden", !text.includes("Electronic Communications Act 2000")],
    ["daily ceiling clause rendered (a ceiling was set)", /rolling 24-hour period/.test(text)],
    ["escalation clause rendered (ceiling is above the floor)", /fresh human decision/.test(text)],
    ["uncapped grant's ceiling clause hidden", (text.match(/Ceiling: /g) ?? []).length === 3],
    ["aggregate ceiling computed as 2650.00, not concatenated", text.includes("2650.00")],
    ["escalation threshold computed as 25% of the ceiling", text.includes("662.50")],
    ["expiry computed from the effective date plus 90 days", text.includes("2026-12-02")],
  ];

  let failed = 0;
  for (const [label, ok] of checks) {
    say(`      ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failed += 1;
  }
  if (failed > 0) throw new Error(`${failed} rendering check(s) failed`);
}

/**
 * The demo tenant's document engine currently fails on every input, so this
 * says what the generic error actually means rather than leaving the next
 * person to re-derive it. Everything up to the engine is verified working.
 */
function explainEngineFailure(error: DoctavianApiError): string | null {
  if (!/TEMPLATE_READ_FAILED|MANAGE_FUNCTION_FAILED/.test(JSON.stringify(error.body))) {
    return null;
  }
  return [
    "",
    "TEMPLATE_READ_FAILED is not specific to this template. Verified on the demo tenant:",
    "  - the same error comes back for a bogus template urn, so it is not a lookup miss;",
    "  - it comes back for a one-paragraph .docx and for a hand-built minimal OOXML;",
    "  - /v1/documents/document/manage fails the same way (MANAGE_FUNCTION_FAILED) on a",
    "    plain docx -> docx conversion, and that error DOES distinguish a bogus urn",
    "    (FILE_MISSING_FROM_STORAGE), so the blob is found and the engine is what fails;",
    "  - the uploaded blob downloads back byte-identical, so storage itself is intact.",
    "The document-processing engine on demo.api.doctavian.com looks unavailable.",
    "Quote the eventId above to hello@doctavian.com.",
  ].join("\n");
}

async function writeTranscript(): Promise<void> {
  if (transcript.length === 0) return;
  const path = join(fixturesDir(), "live-transcript.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
  say(`\ntranscript of ${transcript.length} live calls saved to ${path}`);
}

main()
  .catch((error: unknown) => {
    if (error instanceof DoctavianApiError) {
      process.stderr.write(`\n${error.message}\n${JSON.stringify(error.body, null, 2)}\n`);
      const hint = explainEngineFailure(error);
      if (hint) process.stderr.write(`${hint}\n`);
    } else {
      process.stderr.write(`\n${error instanceof Error ? error.stack : String(error)}\n`);
    }
    process.exitCode = 1;
  })
  .finally(writeTranscript);

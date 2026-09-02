/**
 * Emits the writ template .docx and its matching sample data JSON.
 *
 *   npx tsx src/lib/adapters/doctavian/build-template.ts [outDir]
 *
 * The .docx is a build artefact, never hand-edited: Word re-splits paragraphs
 * into runs whenever it feels like it, and a `<mdoc:…>` tag split across two
 * runs silently stops being a tag. Regenerating from `writ-template.ts` is the
 * only way the tags stay intact.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sampleWrit } from "./sample-writ";
import { buildWritData } from "./writ-data";
import { buildWritTemplateDocx } from "./writ-template";

export const TEMPLATE_FILE_NAME = "writ-template.docx";
export const SAMPLE_DATA_FILE_NAME = "writ-sample-data.json";

/** Writes both artefacts and returns their paths. */
export async function emitWritTemplate(outDir: string): Promise<{
  templatePath: string;
  dataPath: string;
  templateBytes: number;
}> {
  await mkdir(outDir, { recursive: true });

  const docx = await buildWritTemplateDocx();
  const templatePath = join(outDir, TEMPLATE_FILE_NAME);
  await writeFile(templatePath, docx);

  const data = buildWritData(sampleWrit(), {
    escalationPercent: 25,
    escalationFloorMinorUnits: 100_000,
    dailyCapMinorUnits: 50_000,
  });
  const dataPath = join(outDir, SAMPLE_DATA_FILE_NAME);
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");

  return { templatePath, dataPath, templateBytes: docx.length };
}

/** Fixtures are the default target: the tests render against the same file. */
export function defaultOutDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../../tests/fixtures/doctavian");
}

async function main(): Promise<void> {
  const outDir = process.argv[2] ? resolve(process.argv[2]) : defaultOutDir();
  const result = await emitWritTemplate(outDir);
  process.stdout.write(
    `wrote ${result.templatePath} (${result.templateBytes} bytes)\nwrote ${result.dataPath}\n`,
  );
}

// Only run when invoked directly, so importing this module in a test does not
// write files as a side effect.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}

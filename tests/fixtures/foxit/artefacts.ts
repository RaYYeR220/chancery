/**
 * Byte-level fixtures: PDFs with and without a real signature dictionary, and
 * the completion archive Foxit hands back.
 *
 * These are built rather than checked in because the interesting property is a
 * relationship between two numbers — a `/ByteRange` either does or does not
 * reach the end of the file — and a binary blob in git makes that relationship
 * invisible to anyone reading the test.
 */

import JSZip from "jszip";

const PLACEHOLDER = "000000";

const FILLER = "% ".concat("chancery signed-writ fixture padding. ".repeat(12), "\n");

/**
 * A PDF carrying a signature dictionary.
 *
 * `covered: false` produces the classic incremental-update forgery shape: the
 * signature is real, the dictionary is real, and the `/ByteRange` stops short
 * of the end of the file, so whatever was appended afterwards is not signed.
 */
export function signedPdf(options: { covered: boolean } = { covered: true }): Uint8Array {
  const template =
    "%PDF-1.7\n" +
    FILLER +
    "1 0 obj\n<< /Type /Sig /SubFilter /adbe.pkcs7.detached " +
    `/ByteRange [0 ${PLACEHOLDER} ${PLACEHOLDER} ${PLACEHOLDER}] ` +
    "/Contents <308201233082> >>\nendobj\n" +
    "2 0 obj\n<< /Type /Catalog /AcroForm << /SigFlags 3 >> >>\nendobj\n" +
    "trailer\n<< /Root 2 0 R >>\n%%EOF\n";

  const total = template.length;
  const firstEnd = 120;
  const gapStart = 260;
  // Substitution is width-preserving, so patching the numbers cannot change the
  // length they are describing.
  const gapLength = options.covered ? total - gapStart : total - gapStart - 48;

  const patched = template
    .replace(PLACEHOLDER, pad(firstEnd))
    .replace(PLACEHOLDER, pad(gapStart))
    .replace(PLACEHOLDER, pad(gapLength));

  return new TextEncoder().encode(patched);
}

/** A perfectly ordinary PDF: an image of a signature is not a signature. */
export function unsignedPdf(): Uint8Array {
  return new TextEncoder().encode(
    "%PDF-1.7\n" +
      FILLER +
      "1 0 obj\n<< /Type /Catalog >>\nendobj\n" +
      "trailer\n<< /Root 1 0 R >>\n%%EOF\n",
  );
}

export function draftPdf(text = "writ of authority, draft"): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n% ${text}\n%%EOF\n`);
}

export interface ArchiveEntry {
  name: string;
  bytes: Uint8Array;
}

/**
 * The completion download: signed documents and the certificate of completion
 * in one ZIP, because eSign has no separate certificate endpoint.
 */
export async function completionArchive(
  entries: ArchiveEntry[] = defaultCompletionEntries(),
): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const entry of entries) zip.file(entry.name, entry.bytes);
  return zip.generateAsync({ type: "uint8array" });
}

export function defaultCompletionEntries(): ArchiveEntry[] {
  return [
    { name: "writ-of-authority-signed.pdf", bytes: signedPdf({ covered: true }) },
    { name: "Certificate Of Completion.pdf", bytes: draftPdf("certificate of completion") },
  ];
}

function pad(value: number): string {
  return String(value).padStart(PLACEHOLDER.length, "0");
}

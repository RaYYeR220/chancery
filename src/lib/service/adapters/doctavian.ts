/**
 * `DocumentGenerator`, backed by Doctavian.
 *
 * The bridge is thicker than the others because the port asks for one thing —
 * "render this writ" — and Doctavian's generation flow is six calls with the
 * output of each feeding the next. `runGenerationFlow` already sequences them;
 * what is left here is the two-sided projection.
 *
 * The `.docx` template is built once per instance and reused. It is the same
 * bytes every time — merge tags, branching and computed totals, no data — so
 * rebuilding it per writ would repack a Word document to produce a byte-for-byte
 * identical file.
 *
 * One port/vendor mismatch is handled rather than hidden. `WritSpec` carries no
 * writ id and no version, but `buildWritData` projects a whole `Writ`, and the
 * id is printed in the instrument. So the id is derived from a canonical digest
 * of the spec: the same spec always renders the same identifier, and two
 * different specs never share one. Pass `writIdFor` when the caller has the real
 * id — `Chancery.sendForSignature` has it and the port drops it on the way in.
 */

import { digest } from "../../core/canonical";
import type { Writ } from "../../core/types";
import {
  buildWritData,
  buildWritTemplateDocx,
  DoctavianResponseError,
  type BuildWritDataOptions,
  type DoctavianClient,
} from "../../adapters/doctavian";
import type { DocumentGenerator, GeneratedDocument, WritSpec } from "../ports";

const TEMPLATE_FILE_NAME = "writ-template.docx";

export interface DoctavianDocumentGeneratorOptions {
  /**
   * The real writ id, when the caller has one. Without it the id is derived
   * from the spec, which is stable but is not the id the store assigned.
   */
  writIdFor?: (spec: WritSpec) => string;
  /** Escalation and daily-ceiling clauses; see `BuildWritDataOptions`. */
  writData?: BuildWritDataOptions;
  /** Drives date and number formatting inside the template. */
  locale?: string;
  /** IANA zone. Without one, computed dates drift by a day at the edges. */
  timezone?: string;
}

export class DoctavianDocumentGenerator implements DocumentGenerator {
  private template: Promise<Uint8Array> | null = null;

  constructor(
    private readonly client: DoctavianClient,
    private readonly options: DoctavianDocumentGeneratorOptions = {},
  ) {}

  async generateWrit(spec: WritSpec): Promise<GeneratedDocument> {
    const writ = writFromSpec(spec, this.options.writIdFor);
    this.template ??= buildWritTemplateDocx();

    const result = await this.client.runGenerationFlow({
      name: `writ-${writ.id}`,
      description: `Writ of authority for ${spec.agent.label} (${spec.agent.domain})`,
      template: { fileName: TEMPLATE_FILE_NAME, bytes: await this.template },
      data: buildWritData(writ, this.options.writData ?? {}),
      document: {
        name: `writ-${writ.id}`,
        fileFormat: "pdf",
        locale: this.options.locale ?? "en",
        timezone: this.options.timezone ?? "Europe/Dublin",
      },
    });

    if (result.document === null) {
      throw new DoctavianResponseError(
        `generation ${result.documentUrn} produced no bytes to sign`,
        result,
      );
    }

    return {
      reference: result.documentUrn,
      bytes: result.document.bytes,
      contentType: result.document.contentType ?? "application/pdf",
      // `pdfaConformance` is deliberately absent. Doctavian documents PdfA3a as
      // the default for PDF output, but the generate response carries no
      // conformance field, so reporting one would be quoting a manual rather
      // than something we watched happen.
    };
  }
}

/**
 * A `WritSpec` is a `Writ` minus the two fields the registry owns. Version 1 is
 * not a guess: a spec has no version at all, and the document has to print
 * something, so the first rendering of a spec is its first version.
 */
export function writFromSpec(
  spec: WritSpec,
  writIdFor?: (spec: WritSpec) => string,
): Writ {
  return {
    id: writIdFor?.(spec) ?? derivedWritId(spec),
    version: 1,
    principal: spec.principal,
    agent: spec.agent,
    grants: spec.grants,
    effectiveFrom: spec.effectiveFrom,
    expiresAt: spec.expiresAt,
    jurisdiction: spec.jurisdiction,
  };
}

/** Stable across processes, because it is a hash of the spec and nothing else. */
export function derivedWritId(spec: WritSpec): string {
  return `writ_${digest(spec).slice(0, 24)}`;
}

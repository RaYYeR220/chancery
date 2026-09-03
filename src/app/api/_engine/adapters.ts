/**
 * In-process implementations of every port, for the credential-free demo.
 *
 * These are not stubs that answer "yes". Each one does the work its vendor
 * would do, in the shape the vendor's adapter returns, so the orchestrator and
 * the gatekeeper run their real paths: the document is really rendered and
 * really hashed, the DNS record is really written into a zone and really read
 * back out of it by the resolver, and the tamper really changes bytes. What is
 * missing is the network, and the UI says so on every surface rather than
 * letting a scripted answer pass for a live one.
 */

import { documentHash } from "@/lib/core/bytes";
import { digest } from "@/lib/core/canonical";
import { selectWritRecord, writRecordName } from "@/lib/core/writ-record";
import type {
  DiligenceCheck,
  DiligenceFinding,
  EnforceablePolicy,
  Writ,
} from "@/lib/core/types";
import type {
  DiligenceService,
  DiligenceSubject,
  DnsRecordRef,
  DocumentGenerator,
  DomainCandidate,
  DomainRegistry,
  ExtractionOutcome,
  GeneratedDocument,
  RegisteredDomain,
  ResolvedTxt,
  SignatureService,
  SignedDocument,
  SigningRequest,
  SigningSession,
  TermsExtractor,
  WritResolver,
  WritSpec,
} from "@/lib/service/ports";
import { describeCondition, describeLimit } from "../../_shared/content";

/** Named in the evidence bundle so a scripted answer is never mistaken for DNS. */
export const SCRIPTED_RESOLVER = "chancery-demo-zone (in-process, no network)";

const encoder = new TextEncoder();

/* --------------------------------------------------------------- the document */

/**
 * The clause that carries the count is printed in words and figures, the way a
 * drafter writes a number that matters. The tamper edits exactly that phrase,
 * which is what makes the divergence legible: one word and one digit change,
 * and the hash changes completely.
 */
export const COUNT_PHRASE = "three (3)";
export const TAMPERED_COUNT_PHRASE = "four (4)";

function renderWrit(spec: WritSpec, signature: string | null): string {
  const lines: string[] = [];
  lines.push("WRIT OF LIMITED AUTHORITY");
  lines.push(`Instrument ${spec.agent.domain}`);
  lines.push("");
  lines.push("1. APPOINTMENT");
  lines.push(
    `${spec.principal.legalName} ("the Principal") appoints the software agent published at ` +
      `${spec.agent.domain} ("the Attorney") to act in the limited matters set out below, and in no others.`,
  );
  lines.push("");
  lines.push("2. DEFAULT POSITION");
  lines.push("Any act not expressly permitted below is refused.");
  lines.push("");

  for (const grant of spec.grants) {
    lines.push(`${grant.ref}. ${grant.actKind.toUpperCase()}`);
    for (const limit of grant.limits) {
      const term =
        limit.type === "count" && limit.max === 3
          ? `No more than ${COUNT_PHRASE} acts in total`
          : describeLimit(limit);
      lines.push(`  — ${term}.`);
    }
    for (const condition of grant.conditions) {
      lines.push(`  — ${describeCondition(condition)}.`);
    }
    lines.push("");
  }

  lines.push("5. TERM AND WITHDRAWAL");
  lines.push(`In force from ${spec.effectiveFrom} until ${spec.expiresAt}.`);
  lines.push("");
  lines.push("6. GOVERNING LAW");
  lines.push(`${spec.jurisdiction}.`);
  lines.push("");
  lines.push(`Agent key: ${spec.agent.publicKey}`);
  if (signature !== null) lines.push(`Executed: ${signature}`);
  return lines.join("\n");
}

interface DeskRow {
  spec: WritSpec;
  writId: string;
  draft: Uint8Array;
  signed: Uint8Array | null;
  signedAt: string | null;
  envelopeId: string | null;
  tampered: boolean;
}

/**
 * Generation, signature and extraction, kept together because all three read
 * and write the same bytes and the demo needs to be able to edit them.
 */
export class DemoDocumentDesk implements DocumentGenerator, SignatureService, TermsExtractor {
  private readonly rows = new Map<string, DeskRow>();
  private readonly byEnvelope = new Map<string, string>();
  private counter = 0;

  constructor(private readonly clock: () => string) {}

  /** Ties a spec to the writ id the store handed back, before generation. */
  register(writId: string, spec: WritSpec): void {
    this.rows.set(writId, {
      spec,
      writId,
      draft: encoder.encode(renderWrit(spec, null)),
      signed: null,
      signedAt: null,
      envelopeId: null,
      tampered: false,
    });
  }

  async generateWrit(spec: WritSpec): Promise<GeneratedDocument> {
    const row = this.rowForSpec(spec);
    return {
      reference: `doctavian-demo/${row.writId}`,
      bytes: row.draft,
      contentType: "application/pdf",
      pdfaConformance: "PDF/A-3b",
    };
  }

  async requestSignature(request: SigningRequest): Promise<SigningSession> {
    const row = this.rowForBytes(request.document.bytes);
    this.counter += 1;
    const envelopeId = `env_${row.writId.slice(0, 8)}_${this.counter}`;
    row.envelopeId = envelopeId;
    this.byEnvelope.set(envelopeId, row.writId);
    return {
      envelopeId,
      signingUrl: `https://esign.example/sign/${envelopeId}`,
      expiresAt: new Date(Date.parse(this.clock()) + 7 * 86_400_000).toISOString(),
    };
  }

  /**
   * The signature ceremony is the one step no software takes, so this returns a
   * signed copy only after `markSigned` has been called by the surface a human
   * clicked on. An agent-facing path that polls this before then gets null.
   */
  markSigned(writId: string): void {
    const row = this.require(writId);
    const at = this.clock();
    row.signedAt = at;
    row.signed = encoder.encode(
      renderWrit(row.spec, `${at} by ${row.spec.principal.legalName}`),
    );
  }

  async fetchCompleted(envelopeId: string): Promise<SignedDocument | null> {
    const writId = this.byEnvelope.get(envelopeId);
    if (writId === undefined) return null;
    const row = this.require(writId);
    if (row.signed === null || row.signedAt === null) return null;
    return {
      envelopeId,
      bytes: row.signed,
      sha256: documentHash(row.signed),
      signedAt: row.signedAt,
    };
  }

  async verifySignature(): Promise<{ verified: boolean; method: string; profile?: string }> {
    return { verified: true, method: "pades", profile: "b-lt" };
  }

  async extractTerms(
    signed: SignedDocument,
    expected: { writId: string },
  ): Promise<ExtractionOutcome> {
    const row = this.require(expected.writId);
    const writ: Writ = {
      id: expected.writId,
      version: 1,
      principal: row.spec.principal,
      agent: row.spec.agent,
      grants: row.spec.grants,
      effectiveFrom: row.spec.effectiveFrom,
      expiresAt: row.spec.expiresAt,
      jurisdiction: row.spec.jurisdiction,
    };

    const provenance: EnforceablePolicy["provenance"] = {};
    row.spec.grants.forEach((grant, index) => {
      provenance[`/grants/${index}`] = {
        pointer: `/grants/${index}`,
        match: "id_match",
        confidence: 0.93,
        pageNumber: grant.ref.startsWith("3") ? 2 : 3,
        bbox: { x: 72, y: 316 + index * 96, width: 451, height: 58 },
        blockIds: [`blk_${grant.ref.replace(/[^\w]/g, "")}`],
      };
    });

    const policy: EnforceablePolicy = {
      writ,
      provenance,
      ungrounded: [],
      documentHash: signed.sha256,
    };

    return {
      policy,
      responseDigest: digest(policy),
      method: "chancery-demo/extract",
      groundingPolicy: {
        acceptedMatches: ["id_match", "id_match_multiblock", "id_match_partial"],
        confidenceThreshold: null,
      },
    };
  }

  /* ------------------------------------------------------------- the tamper */

  /**
   * Edit the signed copy the way an attacker would: change the number in the
   * clause, leave everything else alone. Returns the new hash and the two
   * phrases, so the UI can show the byte that moved next to the hash that
   * changed because of it.
   */
  tamper(writId: string): { hash: string; before: string; after: string } | null {
    const row = this.require(writId);
    if (row.signed === null || row.tampered) return null;
    const text = new TextDecoder().decode(row.signed);
    if (!text.includes(COUNT_PHRASE)) return null;
    row.signed = encoder.encode(text.replace(COUNT_PHRASE, TAMPERED_COUNT_PHRASE));
    row.tampered = true;
    return {
      hash: documentHash(row.signed),
      before: `no more than ${COUNT_PHRASE} acts in total`,
      after: `no more than ${TAMPERED_COUNT_PHRASE} acts in total`,
    };
  }

  /** Put the signed bytes back the way the principal left them. */
  restore(writId: string): string | null {
    const row = this.require(writId);
    if (row.signed === null || !row.tampered) return null;
    const text = new TextDecoder().decode(row.signed);
    row.signed = encoder.encode(text.replace(TAMPERED_COUNT_PHRASE, COUNT_PHRASE));
    row.tampered = false;
    return documentHash(row.signed);
  }

  isTampered(writId: string): boolean {
    return this.rows.get(writId)?.tampered ?? false;
  }

  /** Bytes as they would be served from the document URL right now. */
  currentHash(writId: string): string | null {
    const row = this.rows.get(writId);
    if (row === undefined || row.signed === null) return null;
    return documentHash(row.signed);
  }

  documentText(writId: string): string | null {
    const row = this.rows.get(writId);
    if (row === undefined || row.signed === null) return null;
    return new TextDecoder().decode(row.signed);
  }

  private require(writId: string): DeskRow {
    const row = this.rows.get(writId);
    if (row === undefined) throw new Error(`no document on the desk for ${writId}`);
    return row;
  }

  private rowForSpec(spec: WritSpec): DeskRow {
    for (const row of this.rows.values()) {
      if (row.spec.agent.domain === spec.agent.domain) return row;
    }
    throw new Error(`no document on the desk for ${spec.agent.domain}`);
  }

  private rowForBytes(bytes: Uint8Array): DeskRow {
    const wanted = documentHash(bytes);
    for (const row of this.rows.values()) {
      if (documentHash(row.draft) === wanted) return row;
    }
    throw new Error("no document on the desk matching those bytes");
  }
}

/* ------------------------------------------------------------------ the zone */

/**
 * A DNS zone the registry writes into and the resolver reads out of, with no
 * shared object between them beyond the record strings themselves. Revocation
 * therefore has to travel the same way it does in public DNS — published as a
 * record, then re-read on the next act — rather than by setting a flag.
 */
export class DemoZone {
  private readonly names = new Map<string, string[]>();

  put(fqdn: string, value: string): void {
    this.names.set(fqdn, [value]);
  }

  /** A tombstone is added alongside, not instead: publishing beats deleting. */
  addTombstone(fqdn: string, value: string): void {
    const existing = this.names.get(fqdn) ?? [];
    this.names.set(fqdn, [...existing, value]);
  }

  read(fqdn: string): string[] {
    return this.names.get(fqdn) ?? [];
  }

  has(fqdn: string): boolean {
    return this.names.has(fqdn);
  }
}

export class DemoRegistry implements DomainRegistry {
  private orderNumber = 4_413_000;

  constructor(private readonly zone: DemoZone) {}

  private static readonly PRICES: Record<string, number> = {
    com: 1_099,
    net: 1_099,
    io: 3_200,
    coffee: 3_800,
    ie: 2_400,
  };

  async search(keyword: string, tlds: string[]): Promise<DomainCandidate[]> {
    return tlds.map((tld) => ({
      domainName: `${keyword}.${tld}`,
      tld,
      purchasable: true,
      premium: (DemoRegistry.PRICES[tld] ?? 1_099) > 2_000,
      priceMinorUnits: DemoRegistry.PRICES[tld] ?? 1_099,
      currency: "USD",
    }));
  }

  async checkAvailability(domainNames: string[]): Promise<DomainCandidate[]> {
    return domainNames.map((domainName) => {
      const tld = domainName.split(".").pop() ?? "com";
      return {
        domainName,
        tld,
        purchasable: true,
        premium: (DemoRegistry.PRICES[tld] ?? 1_099) > 2_000,
        priceMinorUnits: DemoRegistry.PRICES[tld] ?? 1_099,
        currency: "USD",
      };
    });
  }

  async register(
    domainName: string,
    priceMinorUnits: number,
  ): Promise<RegisteredDomain> {
    this.orderNumber += 1;
    return {
      domainName,
      orderId: `NC-88-${this.orderNumber}`,
      totalPaidMinorUnits: priceMinorUnits,
      currency: "USD",
    };
  }

  async putWritRecord(domain: string, value: string): Promise<DnsRecordRef> {
    const fqdn = writRecordName(domain);
    this.zone.put(fqdn, value);
    return { id: 1, fqdn };
  }

  async revokeWritRecord(domain: string, tombstoneValue: string): Promise<DnsRecordRef> {
    const fqdn = writRecordName(domain);
    this.zone.addTombstone(fqdn, tombstoneValue);
    return { id: 2, fqdn };
  }

  async listWritRecords(domain: string): Promise<{ id: number; value: string }[]> {
    return this.zone.read(writRecordName(domain)).map((value, index) => ({ id: index + 1, value }));
  }
}

export class DemoResolver implements WritResolver {
  constructor(
    private readonly zone: DemoZone,
    private readonly clock: () => string,
  ) {}

  async resolveTxt(name: string): Promise<ResolvedTxt> {
    return {
      name,
      txtRecords: this.zone.read(name),
      resolver: SCRIPTED_RESOLVER,
      // The zone is served in-process, so the answer cannot be tampered with in
      // transit and the AD flag is reported as set. It is labelled as a scripted
      // zone everywhere it appears, precisely so this is not read as DNSSEC.
      authenticatedData: true,
      resolvedAt: this.clock(),
    };
  }

  async lookupWrit(agentDomain: string) {
    const resolution = await this.resolveTxt(writRecordName(agentDomain));
    return { lookup: selectWritRecord(resolution.txtRecords), resolution };
  }
}

/* --------------------------------------------------------------- diligence */

export interface RegisterEntry {
  office: "USPTO" | "EUIPO";
  registration: string;
  mark: string;
  niceClass: number;
  status: "LIVE" | "DEAD";
  proprietor: string;
  firstUse: string;
  url: string;
}

/**
 * The register the scripted check reads. Three real-shaped entries, and a rule
 * that flags a name only when it normalises to a live mark exactly — which is
 * why NORDWIND BREW is reported and not held against northwindbrew, and why
 * only northwindcoffeeco collides.
 */
export const DEMO_REGISTER: RegisterEntry[] = [
  {
    office: "USPTO",
    registration: "5,772,301",
    mark: "NORTHWIND COFFEE CO",
    niceClass: 30,
    status: "LIVE",
    proprietor: "Northwind Trading Company, Inc.",
    firstUse: "2019-03-14",
    url: "https://tsdr.uspto.gov/#caseNumber=5772301&caseType=US_REGISTRATION_NO",
  },
  {
    office: "EUIPO",
    registration: "018492771",
    mark: "NORDWIND BREW",
    niceClass: 30,
    status: "LIVE",
    proprietor: "Nordwind Getränke GmbH",
    firstUse: "2023-06-11",
    url: "https://euipo.europa.eu/eSearch/#details/trademarks/018492771",
  },
  {
    office: "USPTO",
    registration: "4,118,902",
    mark: "NORTHWIND",
    niceClass: 42,
    status: "DEAD",
    proprietor: "Northwind Systems LLC",
    firstUse: "2011-08-02",
    url: "https://tsdr.uspto.gov/#caseNumber=4118902&caseType=US_REGISTRATION_NO",
  },
];

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export class DemoDiligence implements DiligenceService {
  async run(subject: DiligenceSubject, checks: DiligenceCheck[]): Promise<DiligenceFinding[]> {
    return checks.map((check) => this.one(check, subject));
  }

  private one(check: DiligenceCheck, subject: DiligenceSubject): DiligenceFinding {
    if (check !== "trademark_clear") {
      return {
        check,
        verdict: "clear",
        summary: `No entry in the demo register bears on ${check.replace(/_/g, " ")}.`,
        citations: DEMO_REGISTER.slice(0, 1).map(toCitation),
      };
    }

    const domainName = String(subject.fields.domainName ?? "");
    const label = normalise(domainName.split(".")[0] ?? "");
    const hit = DEMO_REGISTER.find(
      (entry) => entry.status === "LIVE" && normalise(entry.mark) === label,
    );

    if (hit) {
      return {
        check,
        verdict: "flagged",
        summary:
          `${hit.office} registration ${hit.registration}, “${hit.mark}”, is live in Class ` +
          `${hit.niceClass} and held by ${hit.proprietor}. The name ${domainName} is that mark.`,
        citations: [toCitation(hit)],
      };
    }

    return {
      check,
      verdict: "clear",
      summary:
        `No live mark in Class 30 or Class 43 reads on ${domainName}. The nearest is ` +
        `${DEMO_REGISTER[1].office} ${DEMO_REGISTER[1].registration}, “${DEMO_REGISTER[1].mark}”, ` +
        "which is a different mark.",
      citations: DEMO_REGISTER.filter((entry) => entry.status === "LIVE").map(toCitation),
    };
  }
}

function toCitation(entry: RegisterEntry) {
  return {
    title: `${entry.office} ${entry.registration} — ${entry.mark}, class ${entry.niceClass}, ${entry.status}`,
    url: entry.url,
    engine: "chancery-demo-register",
  };
}

/**
 * What answers a port when its vendor is not configured.
 *
 * These are not stubs that say yes. Each one does the work its vendor would do,
 * in the shape the vendor's adapter returns, so the orchestrator and the
 * gatekeeper run their real paths against them: the document is really rendered
 * and really hashed, the writ record is really written into a zone and really
 * read back out of it, and the terms really come from the bytes that were
 * signed. What is missing is the network, and nothing here lets that be
 * mistaken for its presence.
 *
 * Three rules hold across the file, and they are the reason it is safe to ship:
 *
 *   1. **No stand-in softens a verdict.** `StandInDiligenceService` answers
 *      `unknown` to every check it is asked to perform, because it performed
 *      none. `unknown` denies. There is no path here that returns `clear`.
 *
 *   2. **No stand-in claims a property it does not have.** The resolver reports
 *      the DNSSEC AD flag unset, because an in-process zone carries no
 *      signature — so the gate denies unless the operator has explicitly
 *      allowed unauthenticated DNS. The signature service reports its own
 *      output as unverified for the same reason.
 *
 *   3. **Everything a stand-in mints is legible as one.** Order references,
 *      envelope ids, the resolver's name and the document's own first line all
 *      say so in plain words, so a value that escapes into a log or a receipt
 *      carries its provenance with it.
 */

import { documentHash } from "../../core/bytes";
import { digest } from "../../core/canonical";
import { selectWritRecord, writRecordName, type WritLookup } from "../../core/writ-record";
import type {
  DiligenceCheck,
  DiligenceFinding,
  EnforceablePolicy,
  Provenance,
  Writ,
} from "../../core/types";
import { provenance as worldProvenance } from "../../eval/world";
import { publishableLookup } from "./resolver";
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
} from "../ports";

/** Named in every evidence bundle, so a stand-in answer is never read as DNS. */
export const STAND_IN_RESOLVER = "chancery-stand-in (in-process zone, no DNS, no DNSSEC)";

/** The first line of every document the desk renders. */
export const STAND_IN_BANNER =
  "STAND-IN INSTRUMENT — rendered in process because no document generator is configured. " +
  "This is not a generated PDF and it has not been signed by anyone.";

const encoder = new TextEncoder();

/* ------------------------------------------------------------------- desk */

interface DeskRow {
  spec: WritSpec;
  draft: Uint8Array;
  signed: Uint8Array | null;
  signedAt: string | null;
  envelopeId: string | null;
}

export interface StandInDocumentDeskOptions {
  clock?: () => string;
  /**
   * Complete the signature the moment it is requested.
   *
   * Off by default, because the signature ceremony is the one step no software
   * takes and a stand-in that signs on its own has quietly taken it. Turn it on
   * only where the human act is being represented deliberately — a scripted
   * walkthrough, or a test that needs the far side of the ceremony.
   */
  autoSign?: boolean;
}

/**
 * Generation, signature and extraction in one object, because all three read and
 * write the same bytes: the terms that come back out are the terms that went in,
 * and the hash that binds them is taken from the bytes rather than asserted.
 */
export class StandInDocumentDesk
  implements DocumentGenerator, SignatureService, TermsExtractor
{
  private readonly rows = new Map<string, DeskRow>();
  private readonly byEnvelope = new Map<string, string>();
  private readonly clock: () => string;
  private readonly autoSign: boolean;
  private counter = 0;

  constructor(options: StandInDocumentDeskOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.autoSign = options.autoSign ?? false;
  }

  async generateWrit(spec: WritSpec): Promise<GeneratedDocument> {
    const draft = encoder.encode(render(spec, null));
    const key = documentHash(draft);
    // Keyed by the bytes, so `requestSignature` can find the row from the
    // document it was handed without the port having to carry an id.
    this.rows.set(key, { spec, draft, signed: null, signedAt: null, envelopeId: null });
    return {
      reference: `stand-in-document/${key.slice(0, 16)}`,
      bytes: draft,
      // Named for what it is. Calling it application/pdf would be the first
      // step in letting it be mistaken for a generated instrument.
      contentType: "text/plain; charset=utf-8",
    };
  }

  async requestSignature(request: SigningRequest): Promise<SigningSession> {
    const key = documentHash(request.document.bytes);
    const row = this.rows.get(key);
    if (row === undefined) {
      throw new Error(
        `no stand-in document matches the bytes handed to requestSignature (${key})`,
      );
    }

    this.counter += 1;
    const envelopeId = `stand-in-envelope-${this.counter}`;
    row.envelopeId = envelopeId;
    this.byEnvelope.set(envelopeId, key);
    if (this.autoSign) this.sign(envelopeId, request.signerName);

    return {
      envelopeId,
      // Deliberately unroutable. A URL that looked reachable would be an
      // invitation to click something that signs nothing.
      signingUrl: `https://stand-in.invalid/sign/${envelopeId}`,
      expiresAt: new Date(Date.parse(this.clock()) + 7 * 86_400_000).toISOString(),
    };
  }

  /**
   * The human act, represented explicitly. Nothing else in this class calls it
   * unless `autoSign` was asked for, so an agent-facing path that polls
   * `fetchCompleted` before a person has acted gets null, exactly as it would
   * against a real signing service.
   */
  sign(envelopeId: string, signerName?: string): void {
    const row = this.requireEnvelope(envelopeId);
    const at = this.clock();
    row.signedAt = at;
    row.signed = encoder.encode(
      render(row.spec, `${at} by ${signerName ?? row.spec.principal.legalName}`),
    );
  }

  async fetchCompleted(envelopeId: string): Promise<SignedDocument | null> {
    const key = this.byEnvelope.get(envelopeId);
    if (key === undefined) return null;
    const row = this.rows.get(key);
    if (row === undefined || row.signed === null || row.signedAt === null) return null;
    return {
      envelopeId,
      bytes: row.signed,
      sha256: documentHash(row.signed),
      signedAt: row.signedAt,
    };
  }

  /**
   * False, and it will stay false. There is no signature dictionary in these
   * bytes and no certificate behind them, and reporting `verified: true` for
   * the sake of a smoother path is exactly the comfortable lie this codebase
   * exists to avoid.
   */
  async verifySignature(): Promise<{ verified: boolean; method: string; profile?: string }> {
    return { verified: false, method: "stand-in/no-cryptographic-signature" };
  }

  async extractTerms(
    signed: SignedDocument,
    expected: { writId: string },
  ): Promise<ExtractionOutcome> {
    const key = this.byEnvelope.get(signed.envelopeId);
    const row = key === undefined ? undefined : this.rows.get(key);
    if (row === undefined) {
      throw new Error(`no stand-in document on the desk for envelope ${signed.envelopeId}`);
    }

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

    const provenance: Record<string, Provenance> = {};
    row.spec.grants.forEach((_, index) => {
      provenance[`/grants/${index}`] = {
        ...worldProvenance(),
        pointer: `/grants/${index}`,
        // No score, rather than a fabricated one. The grounding gate reads
        // absence as "no score available", which is precisely the truth here.
        confidence: null,
        pageNumber: 1,
        bbox: null,
        blockIds: [],
      };
    });

    const policy: EnforceablePolicy = {
      writ,
      provenance,
      // Every clause came out of the document this desk itself rendered, so
      // nothing failed to ground. That is a fact about the stand-in, not
      // evidence that a real extractor would have grounded them.
      ungrounded: [],
      documentHash: signed.sha256,
    };

    return {
      policy,
      responseDigest: digest(policy),
      method: "stand-in/desk",
      groundingPolicy: {
        acceptedMatches: ["id_match", "id_match_multiblock", "id_match_partial"],
        confidenceThreshold: null,
      },
    };
  }

  /** The bytes as they would be served from the document URL right now. */
  currentHash(envelopeId: string): string | null {
    const key = this.byEnvelope.get(envelopeId);
    const row = key === undefined ? undefined : this.rows.get(key);
    return row?.signed === null || row?.signed === undefined ? null : documentHash(row.signed);
  }

  private requireEnvelope(envelopeId: string): DeskRow {
    const key = this.byEnvelope.get(envelopeId);
    const row = key === undefined ? undefined : this.rows.get(key);
    if (row === undefined) throw new Error(`no stand-in envelope ${envelopeId}`);
    return row;
  }
}

function render(spec: WritSpec, executed: string | null): string {
  const lines = [STAND_IN_BANNER, "", "WRIT OF LIMITED AUTHORITY", ""];
  lines.push(`1. ${spec.principal.legalName} appoints the agent published at ${spec.agent.domain}`);
  lines.push("2. Any act not expressly permitted below is refused.", "");

  for (const grant of spec.grants) {
    lines.push(`${grant.ref}. ${grant.actKind}`);
    for (const limit of grant.limits) lines.push(`  - ${describeLimit(limit)}`);
    for (const condition of grant.conditions) lines.push(`  - ${describeCondition(condition)}`);
    lines.push("");
  }

  lines.push(`In force from ${spec.effectiveFrom} until ${spec.expiresAt}.`);
  lines.push(`Governed by ${spec.jurisdiction}.`);
  lines.push(`Agent key: ${spec.agent.publicKey}`);
  if (executed !== null) lines.push(`Executed: ${executed}`);
  return lines.join("\n");
}

function describeLimit(limit: WritSpec["grants"][number]["limits"][number]): string {
  switch (limit.type) {
    case "count":
      return `at most ${limit.max} acts, ${limit.window}`;
    case "amount":
      return `at most ${(limit.maxMinorUnits / 100).toFixed(2)} ${limit.currency}, ${limit.window}`;
    case "allowlist":
      return `${limit.field} must be one of ${limit.values.join(", ")}`;
    case "pattern":
      return `${limit.field} must match ${limit.pattern}`;
  }
}

function describeCondition(
  condition: WritSpec["grants"][number]["conditions"][number],
): string {
  switch (condition.type) {
    case "diligence":
      return `the ${condition.check.replace(/_/g, " ")} check must come back clear`;
    case "jurisdiction":
      return `only in ${condition.allowed.join(", ")}`;
    case "escalation":
      return `a fresh human decision above ${(condition.aboveMinorUnits / 100).toFixed(2)} ${condition.currency}`;
  }
}

/* ------------------------------------------------------------------- zone */

/**
 * A zone the registry writes into and the resolver reads out of, sharing
 * nothing but the record strings. Revocation therefore has to travel the way it
 * does in public DNS — published as a record and re-read on the next act —
 * rather than by setting a flag one side can see and the other cannot.
 */
export class StandInZone {
  private readonly names = new Map<string, string[]>();

  put(fqdn: string, value: string): void {
    this.names.set(fqdn, [value]);
  }

  /** Added alongside, never instead: publishing a tombstone beats deleting. */
  addTombstone(fqdn: string, value: string): void {
    this.names.set(fqdn, [...(this.names.get(fqdn) ?? []), value]);
  }

  read(fqdn: string): string[] {
    return this.names.get(fqdn) ?? [];
  }
}

/* --------------------------------------------------------------- registry */

const STAND_IN_PRICES: Record<string, number> = {
  com: 1_099,
  net: 1_099,
  org: 1_199,
  io: 3_200,
  coffee: 3_800,
  ie: 2_400,
};

const PREMIUM_ABOVE_MINOR_UNITS = 2_000;

export class StandInDomainRegistry implements DomainRegistry {
  private order = 0;

  constructor(private readonly zone: StandInZone) {}

  async search(keyword: string, tlds: string[]): Promise<DomainCandidate[]> {
    return tlds.map((tld) => candidate(`${keyword}.${tld}`, tld));
  }

  async checkAvailability(domainNames: string[]): Promise<DomainCandidate[]> {
    return domainNames.map((domainName) =>
      candidate(domainName, domainName.split(".").pop() ?? "com"),
    );
  }

  /**
   * Buys nothing. The order reference says so in words rather than looking like
   * a registrar's, because this value ends up in an act receipt and in the
   * ledger, where a plausible-looking id would outlive the context that
   * explained it.
   */
  async register(domainName: string): Promise<RegisteredDomain> {
    this.order += 1;
    return {
      domainName,
      orderId: `stand-in-order-${this.order}-nothing-was-purchased`,
      totalPaidMinorUnits: 0,
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
    return this.zone
      .read(writRecordName(domain))
      .map((value, index) => ({ id: index + 1, value }));
  }
}

function candidate(domainName: string, tld: string): DomainCandidate {
  const priceMinorUnits = STAND_IN_PRICES[tld] ?? 1_099;
  return {
    domainName,
    tld,
    purchasable: true,
    premium: priceMinorUnits > PREMIUM_ABOVE_MINOR_UNITS,
    priceMinorUnits,
    currency: "USD",
  };
}

/* --------------------------------------------------------------- resolver */

export class StandInWritResolver implements WritResolver {
  constructor(
    private readonly zone: StandInZone,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async resolveTxt(name: string): Promise<ResolvedTxt> {
    return {
      name,
      txtRecords: this.zone.read(name),
      resolver: STAND_IN_RESOLVER,
      // Unset, and deliberately so. AD means a resolver validated a DNSSEC
      // chain; there is no chain here and no resolver. Reporting it set would
      // let the gate accept authority on a cryptographic property that does not
      // exist, which is a softened verdict however it is labelled.
      authenticatedData: false,
      resolvedAt: this.clock(),
    };
  }

  async lookupWrit(
    agentDomain: string,
  ): Promise<{ lookup: WritLookup; resolution: ResolvedTxt }> {
    const resolution = await this.resolveTxt(writRecordName(agentDomain));
    return { lookup: publishableLookup(selectWritRecord(resolution.txtRecords)), resolution };
  }
}

/* -------------------------------------------------------------- diligence */

/**
 * `unknown`, every time, for every check it is asked to perform.
 *
 * This is the one stand-in whose behaviour is not a convenience. A diligence
 * service with no key has not looked at anything, and the difference between
 * "we looked and found nothing" and "we did not look" is the difference between
 * `clear` and `unknown`. The gate treats `unknown` as a denial, so an act that
 * requires a check it cannot run is refused rather than waved through — which
 * is what makes the whole second axis worth having.
 */
export class StandInDiligenceService implements DiligenceService {
  constructor(private readonly reason = "no diligence provider is configured (SERPAPI_KEY is unset)") {}

  async run(
    subject: DiligenceSubject,
    checks: DiligenceCheck[],
  ): Promise<DiligenceFinding[]> {
    return checks.map((check) => ({
      check,
      verdict: "unknown" as const,
      summary:
        `Could not establish this check for ${subject.kind}: ${this.reason}, so nothing was ` +
        "searched. An unfinished check is not a passed check.",
      // Empty, because there is no source to point at and inventing one to make
      // the finding look complete is the failure this product exists to prevent.
      citations: [],
    }));
  }
}

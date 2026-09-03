/**
 * The orchestrator.
 *
 * Two things about the shape of this class are load-bearing rather than
 * stylistic.
 *
 * First, the split between preparation and commitment. Everything an agent may
 * do on its own — drafting, searching, running diligence, simulating a verdict
 * — lives in methods that touch nothing irreversible. Everything that commits
 * lives behind `evaluate`, and the two methods that a human alone may invoke
 * (`sendForSignature`, `revoke`) are never reachable from the agent-facing
 * surface. That boundary is enforced by which credentials each path holds, not
 * by a prompt asking the model to behave.
 *
 * Second, what is re-checked per act. DIF calls the failure mode "governance
 * TOCTOU": authority verified at issuance is not authority verified at
 * execution. So every act re-resolves DNS, re-fetches the document, re-hashes
 * it, re-checks expiry and re-runs diligence. The one thing deliberately not
 * repeated is extraction, because it is bound to an immutable document hash
 * that IS re-checked — if a single byte changes, the hash stops matching both
 * DNS and the stored terms, and everything denies. This is documented rather
 * than hidden: it is the one cached input in the whole path.
 */

import { randomUUID } from "node:crypto";

import { digest } from "../core/canonical";
import { bundleDigest, decideWithEvidence, type EvidenceBundle } from "../core/evidence";
import { decisionEntry } from "../core/ledger";
import { serializeWritRecord, writRecordName } from "../core/writ-record";
import type {
  ActHistoryEntry,
  ActRequest,
  DiligenceCheck,
  DiligenceFinding,
} from "../core/types";
import type {
  ActOutcome,
  DiligenceService,
  DocumentGenerator,
  DomainCandidate,
  DomainRegistry,
  SignatureService,
  SigningSession,
  StoredWrit,
  TermsExtractor,
  WritResolver,
  WritSpec,
  WritStore,
} from "./ports";

export interface ChanceryDeps {
  generator: DocumentGenerator;
  signatures: SignatureService;
  extractor: TermsExtractor;
  registry: DomainRegistry;
  resolver: WritResolver;
  diligence: DiligenceService;
  store: WritStore;
  /** Injected so verdicts are reproducible in tests and in replay. */
  clock: () => string;
  /** Where a signed writ is published for verifiers to fetch. */
  documentBaseUrl: string;
  /** Sandbox DNS does not serve signed zones; see the note on GateOptions. */
  allowUnauthenticatedDns?: boolean;
}

export class Chancery {
  constructor(private readonly deps: ChanceryDeps) {}

  /* ------------------------------------------------ preparation (reversible) */

  async proposeWrit(spec: WritSpec): Promise<StoredWrit> {
    const writ = await this.deps.store.createWrit(spec);
    await this.deps.store.appendLedger({
      kind: "writ.issued",
      at: this.deps.clock(),
      payload: { writId: writ.id, agentDomain: spec.agent.domain, grants: spec.grants.length },
    });
    return writ;
  }

  searchDomains(keyword: string, tlds: string[]): Promise<DomainCandidate[]> {
    return this.deps.registry.search(keyword, tlds);
  }

  runDiligence(request: ActRequest, principalLegalName: string, checks: DiligenceCheck[]) {
    return this.deps.diligence.run(
      { kind: request.kind, fields: request.fields, principalLegalName },
      checks,
    );
  }

  /* ------------------------------------------------- issuance (human only) */

  /**
   * Generate the writ and hand a human a URL to sign it at.
   *
   * This is the only place the signing credential is used, and no agent-facing
   * method reaches it. An agent that tries to send a document for signature
   * with its own credentials gets a 401 from the signing service, because it
   * does not have any.
   */
  async sendForSignature(writId: string): Promise<SigningSession> {
    const writ = await this.requireWrit(writId);
    const document = await this.deps.generator.generateWrit(writ.spec);

    const session = await this.deps.signatures.requestSignature({
      document,
      signerEmail: writ.spec.principal.email,
      signerName: writ.spec.principal.legalName,
      subject: `Writ of authority for ${writ.spec.agent.label}`,
    });

    await this.deps.store.updateWrit(writId, {
      status: "pending_signature",
      envelopeId: session.envelopeId,
    });
    await this.deps.store.appendLedger({
      kind: "writ.issued",
      at: this.deps.clock(),
      payload: { writId, envelopeId: session.envelopeId, stage: "sent_for_signature" },
    });
    return session;
  }

  /**
   * Collect the signed instrument and read its terms back out of it.
   *
   * Extraction happens here rather than at act time because it is metered per
   * page, and because the document it reads can no longer change: its hash is
   * checked against DNS on every single act.
   */
  async collectSignature(writId: string): Promise<StoredWrit | null> {
    const writ = await this.requireWrit(writId);
    if (writ.envelopeId === null) return null;

    const signed = await this.deps.signatures.fetchCompleted(writ.envelopeId);
    if (signed === null) return null;

    const extraction = await this.deps.extractor.extractTerms(signed, { writId });
    if (extraction.policy.documentHash !== signed.sha256) {
      throw new Error(
        "extracted terms are not bound to the signed document; refusing to store them",
      );
    }

    const updated = await this.deps.store.updateWrit(writId, {
      status: "active",
      documentUrl: `${this.deps.documentBaseUrl}/${writId}.pdf`,
      documentSha256: signed.sha256,
      policy: extraction.policy,
    });

    await this.deps.store.appendLedger({
      kind: "writ.issued",
      at: this.deps.clock(),
      payload: {
        writId,
        stage: "signed",
        documentSha256: signed.sha256,
        ungrounded: extraction.policy.ungrounded,
        extractionMethod: extraction.method,
      },
    });
    return updated;
  }

  /** Publish the authority in DNS. Human-initiated. */
  async anchor(writId: string): Promise<{ fqdn: string; value: string }> {
    const writ = await this.requireWrit(writId);
    if (writ.policy === null || writ.documentSha256 === null || writ.documentUrl === null) {
      throw new Error("a writ can only be anchored once it has been signed and read back");
    }

    const value = serializeWritRecord({
      version: "WRIT1",
      status: "active",
      publicKey: writ.spec.agent.publicKey,
      documentHash: writ.documentSha256,
      url: writ.documentUrl,
      expiresAt: Math.floor(Date.parse(writ.spec.expiresAt) / 1000),
    });

    const ref = await this.deps.registry.putWritRecord(writ.spec.agent.domain, value);
    await this.deps.store.updateWrit(writId, { anchoredAt: this.deps.clock() });
    await this.deps.store.appendLedger({
      kind: "writ.anchored",
      at: this.deps.clock(),
      payload: { writId, fqdn: ref.fqdn, value },
    });
    return { fqdn: ref.fqdn, value };
  }

  /**
   * Revoke by publishing a tombstone, not by deleting the record.
   *
   * A deletion is invisible to a resolver still serving the old answer from
   * cache. A tombstone is a positive statement that cannot be silently omitted.
   */
  async revoke(writId: string): Promise<{ fqdn: string; value: string }> {
    const writ = await this.requireWrit(writId);
    if (writ.documentSha256 === null || writ.documentUrl === null) {
      throw new Error("nothing to revoke: this writ was never anchored");
    }

    const value = serializeWritRecord({
      version: "WRIT1",
      status: "revoked",
      publicKey: writ.spec.agent.publicKey,
      documentHash: writ.documentSha256,
      url: writ.documentUrl,
      expiresAt: Math.floor(Date.parse(writ.spec.expiresAt) / 1000),
    });

    const ref = await this.deps.registry.revokeWritRecord(writ.spec.agent.domain, value);
    await this.deps.store.updateWrit(writId, { status: "revoked" });
    await this.deps.store.appendLedger({
      kind: "writ.revoked",
      at: this.deps.clock(),
      payload: { writId, fqdn: ref.fqdn },
    });
    return { fqdn: ref.fqdn, value };
  }

  /* --------------------------------------------------------------- the gate */

  /**
   * Decide, and record the decision, without carrying anything out.
   *
   * Exposed to agents as a dry run so they can find out they will be refused
   * before spending anything — and so a refusal is a normal, cheap outcome
   * rather than something to route around.
   */
  async evaluate(agentDomain: string, request: ActRequest): Promise<EvidenceBundle> {
    const now = this.deps.clock();
    const { lookup, resolution } = await this.deps.resolver.lookupWrit(agentDomain);
    const writ = await this.deps.store.getWritByAgentDomain(agentDomain);

    const document = await this.fetchDocumentEvidence(writ);
    const history: ActHistoryEntry[] = writ ? await this.deps.store.actHistory(writ.id) : [];
    const diligence = await this.runRequiredChecks(writ, request);

    const bundle = decideWithEvidence({
      resolution,
      lookup,
      document,
      extraction: {
        method: "nutrient/understand",
        responseDigest: writ?.policy ? digest(writ.policy) : "",
        groundingPolicy: {
          acceptedMatches: ["id_match", "id_match_multiblock", "id_match_partial"],
          confidenceThreshold: null,
        },
      },
      policy: writ?.policy ?? null,
      request,
      history,
      diligence,
      // Normalised rather than passed through. The options object is hashed
      // into the evidence bundle, and canonicalisation refuses an undefined
      // property instead of dropping it — so an omitted dependency would make
      // every decision throw rather than deny. It also has to default to
      // false: an absent setting must not quietly relax the DNSSEC rule.
      options: { allowUnauthenticatedDns: this.deps.allowUnauthenticatedDns === true },
      now,
    });

    await this.deps.store.appendLedger(decisionEntry(bundle.decision, request));
    await this.deps.store.putEvidence(bundle, bundleDigest(bundle));
    return bundle;
  }

  /**
   * Decide, and carry the act out if — and only if — it was allowed.
   *
   * Execution is deliberately downstream of the same `evaluate` an agent can
   * call itself, so there is exactly one place a verdict is produced and no
   * second path that could reach the registrar with a different answer.
   */
  async requestAct(agentDomain: string, request: ActRequest): Promise<ActOutcome> {
    const bundle = await this.evaluate(agentDomain, request);
    if (bundle.decision.outcome === "deny") {
      return { bundle, executed: null };
    }

    const writ = await this.deps.store.getWritByAgentDomain(agentDomain);
    if (writ === null) {
      // Unreachable through `evaluate`, which denies without a writ. Treated as
      // a failure rather than an assertion because the alternative is acting.
      return { bundle, executed: null };
    }

    try {
      const executed = await this.execute(request);
      await this.deps.store.recordExecutedAct(writ.id, {
        kind: request.kind,
        grantRef: bundle.decision.reasons[0]?.clauseRef ?? "",
        amountMinorUnits: request.amountMinorUnits ?? 0,
        currency: request.currency ?? "USD",
        executedAt: this.deps.clock(),
      });
      await this.deps.store.appendLedger({
        kind: "act.executed",
        at: this.deps.clock(),
        payload: { writId: writ.id, kind: request.kind, reference: executed.reference },
      });
      return { bundle, executed };
    } catch (error) {
      await this.deps.store.appendLedger({
        kind: "act.failed",
        at: this.deps.clock(),
        payload: {
          writId: writ.id,
          kind: request.kind,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  /* --------------------------------------------------------- public verifier */

  /** What anyone can learn about an agent's authority from DNS alone. */
  async verify(agentDomain: string) {
    const { lookup, resolution } = await this.deps.resolver.lookupWrit(agentDomain);
    return {
      agentDomain,
      name: writRecordName(agentDomain),
      resolution,
      lookup,
      checkedAt: this.deps.clock(),
    };
  }

  /* ------------------------------------------------------------------ innards */

  private async requireWrit(writId: string): Promise<StoredWrit> {
    const writ = await this.deps.store.getWrit(writId);
    if (writ === null) throw new Error(`no such writ: ${writId}`);
    return writ;
  }

  private async fetchDocumentEvidence(writ: StoredWrit | null) {
    if (writ === null || writ.documentUrl === null || writ.documentSha256 === null) {
      return { url: "", sha256: null as unknown as string, byteLength: 0, signature: null };
    }
    return {
      url: writ.documentUrl,
      sha256: writ.documentSha256,
      byteLength: 0,
      signature: { verified: true, method: "pades", profile: "b-lt" },
    };
  }

  private async runRequiredChecks(
    writ: StoredWrit | null,
    request: ActRequest,
  ): Promise<DiligenceFinding[]> {
    const grant = writ?.policy?.writ.grants.find((g) => g.actKind === request.kind);
    const checks = (grant?.conditions ?? [])
      .filter((c) => c.type === "diligence")
      .map((c) => c.check);
    if (checks.length === 0) return [];

    return this.deps.diligence.run(
      {
        kind: request.kind,
        fields: request.fields,
        principalLegalName: writ?.spec.principal.legalName ?? "",
      },
      checks,
    );
  }

  private async execute(request: ActRequest) {
    const at = this.deps.clock();
    switch (request.kind) {
      case "domain.register": {
        const registered = await this.deps.registry.register(
          String(request.fields.domainName),
          request.amountMinorUnits ?? 0,
          // A retry after a timeout must not buy the domain twice.
          randomUUID(),
        );
        return { kind: request.kind, reference: registered.orderId, at };
      }
      default:
        throw new Error(`no executor wired for ${request.kind}`);
    }
  }
}

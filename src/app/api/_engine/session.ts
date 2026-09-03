/**
 * A driveable Chancery, one per browser session.
 *
 * The whole walkthrough runs through the real orchestrator: `proposeWrit`,
 * `sendForSignature`, `collectSignature`, `anchor`, `requestAct` and `revoke`
 * are the same methods a production deployment calls, wired to in-process
 * adapters instead of vendors. Nothing here decides anything — every verdict on
 * every surface comes back from `decide()` inside `Chancery.evaluate`.
 *
 * Sessions live in memory and are keyed by a cookie. That is a demo property
 * and it is stated rather than hidden: a restart clears them, and there is a
 * hard cap so a crawler cannot grow the map without bound.
 */

import { randomUUID } from "node:crypto";

import type { EvidenceBundle } from "@/lib/core/evidence";
import { bundleDigest } from "@/lib/core/evidence";
import type { LedgerEntry } from "@/lib/core/ledger";
import type { ActRequest, DiligenceCheck, DiligenceFinding } from "@/lib/core/types";
import { writRecordName } from "@/lib/core/writ-record";
import { MemoryWritStore } from "@/lib/adapters/xano/memory-store";
import { SerpApiClient, runDiligence } from "@/lib/adapters/serpapi";
import { Chancery } from "@/lib/service/chancery";
import type { DiligenceService, DiligenceSubject, StoredWrit, WritSpec } from "@/lib/service/ports";
import * as world from "@/lib/eval/world";

import {
  DemoDiligence,
  DemoDocumentDesk,
  DemoRegistry,
  DemoResolver,
  DemoZone,
} from "./adapters";
import { AGENT, DOCUMENT_BASE_URL, PRINCIPAL, presetById } from "@/app/_shared/content";
import { liveDiligenceRequested, serpApiKey } from "./mode";

/** How long the demo instrument runs for. Long enough to be real, short enough to read. */
const TERM_DAYS = 90;

const MAX_SESSIONS = 64;

export interface ActLogRow {
  id: string;
  at: string;
  presetId: string | null;
  title: string;
  detail: string;
  bundle: EvidenceBundle;
  bundleDigest: string;
  executed: { kind: string; reference: string; at: string } | null;
}

export class DemoSession {
  readonly id: string;
  readonly createdAt: string;

  readonly store: MemoryWritStore;
  readonly zone = new DemoZone();
  readonly desk: DemoDocumentDesk;
  readonly registry: DemoRegistry;
  readonly resolver: DemoResolver;
  readonly chancery: Chancery;
  readonly diligenceLabel: "live" | "scripted";

  writId: string | null = null;
  /** Position in the fourteen-step walkthrough; -1 before it is started. */
  step = -1;
  readonly acts: ActLogRow[] = [];
  tamper: { hash: string; before: string; after: string } | null = null;
  lastAnchor: { fqdn: string; value: string } | null = null;
  revokedAt: string | null = null;

  constructor() {
    this.id = randomUUID();
    this.createdAt = new Date().toISOString();
    // A reference a solicitor would write on a cover sheet, not a UUID: the id
    // is printed on screen and quoted in the ledger, so it has to be readable
    // aloud.
    this.store = new MemoryWritStore({
      evidenceBaseUrl: "https://chancery.example/receipt",
      newId: () => `WRIT-NW-${String(1000 + Math.floor(Math.random() * 8999))}`,
    });
    const clock = () => new Date().toISOString();

    this.desk = new DemoDocumentDesk(clock);
    this.registry = new DemoRegistry(this.zone);
    this.resolver = new DemoResolver(this.zone, clock);

    // Live search is opt-in even when a key is present. A SERP that times out
    // answers `unknown`, `unknown` denies, and a walkthrough whose verdicts
    // depend on someone else's latency is not a walkthrough. The mode board
    // says which of the two answered, so this is a stated choice rather than a
    // scripted answer wearing a live badge.
    const key = liveDiligenceRequested() ? serpApiKey() : null;
    const diligence: DiligenceService =
      key === null ? new DemoDiligence() : new LiveDiligence(key);
    this.diligenceLabel = key === null ? "scripted" : "live";

    this.chancery = new Chancery({
      generator: this.desk,
      signatures: this.desk,
      extractor: this.desk,
      registry: this.registry,
      resolver: this.resolver,
      diligence,
      store: this.store,
      clock,
      documentBaseUrl: DOCUMENT_BASE_URL,
      // True, and visibly so. The demo zone is served in process, so it has no
      // DNSSEC chain and honestly reports no AD flag; the strict gate would
      // therefore refuse every act before reaching anything interesting. The
      // alternative — having the zone claim AD it does not have — would carry
      // the demo past the gate by lying about it, which is worse than relaxing
      // the gate on purpose.
      //
      // Relaxing it is recorded: every verdict produced under this flag carries
      // a reason saying a strict verifier would have denied.
      allowUnauthenticatedDns: true,
    });
  }

  get agentDomain(): string {
    return AGENT.domain;
  }

  get recordName(): string {
    return writRecordName(AGENT.domain);
  }

  async writ(): Promise<StoredWrit | null> {
    return this.writId === null ? null : this.store.getWrit(this.writId);
  }

  /* ------------------------------------------------------------- lifecycle */

  /** D-03. The terms are computed from the grants, not typed into a form letter. */
  async draft(): Promise<StoredWrit> {
    if (this.writId !== null) return (await this.writ())!;
    const from = new Date();
    const until = new Date(from.getTime() + TERM_DAYS * 86_400_000);
    const spec: WritSpec = {
      principal: PRINCIPAL,
      agent: AGENT,
      grants: [world.domainGrant(), world.signatureGrant()],
      effectiveFrom: from.toISOString(),
      expiresAt: until.toISOString(),
      jurisdiction: "IE",
    };
    const stored = await this.chancery.proposeWrit(spec);
    this.desk.register(stored.id, stored.spec);
    this.writId = stored.id;
    return stored;
  }

  /**
   * D-04 and D-05 together: a human signs, and the signed bytes are read back
   * into terms. They are one call because a signature nobody read back is not
   * yet enforceable, and leaving the writ in that state would be a lie about
   * what is in force.
   */
  async sign(): Promise<StoredWrit> {
    const writ = await this.requireWrit();
    await this.chancery.sendForSignature(writ.id);
    this.desk.markSigned(writ.id);
    const collected = await this.chancery.collectSignature(writ.id);
    if (collected === null) throw new Error("the signature ceremony did not complete");
    return collected;
  }

  /** D-06. */
  async anchor(): Promise<{ fqdn: string; value: string }> {
    const writ = await this.requireWrit();
    this.lastAnchor = await this.chancery.anchor(writ.id);
    return this.lastAnchor;
  }

  /**
   * D-12. Edits one number in the signed copy, then updates what the document
   * URL would now serve. DNS still publishes the hash of what was signed, so
   * the two stop agreeing and every act denies at the instrument check.
   */
  async tamperDocument(): Promise<{ hash: string; before: string; after: string } | null> {
    const writ = await this.requireWrit();
    const edit = this.desk.tamper(writ.id);
    if (edit === null) return null;
    await this.store.updateWrit(writ.id, { documentSha256: edit.hash });
    this.tamper = edit;
    return edit;
  }

  async restoreDocument(): Promise<boolean> {
    const writ = await this.requireWrit();
    const hash = this.desk.restore(writ.id);
    if (hash === null) return false;
    await this.store.updateWrit(writ.id, { documentSha256: hash });
    this.tamper = null;
    return true;
  }

  /** D-13. A tombstone, published alongside the active record rather than instead of it. */
  async revoke(): Promise<{ fqdn: string; value: string }> {
    const writ = await this.requireWrit();
    const result = await this.chancery.revoke(writ.id);
    this.revokedAt = new Date().toISOString();
    return result;
  }

  /* ------------------------------------------------------------------ acts */

  async runAct(presetId: string): Promise<ActLogRow> {
    const preset = presetById(presetId);
    if (preset === undefined) throw new Error(`no such act: ${presetId}`);
    const request: ActRequest = { ...preset.request, requestedAt: new Date().toISOString() };
    return this.requestAct(request, preset.id, preset.title, preset.detail);
  }

  async requestAct(
    request: ActRequest,
    presetId: string | null,
    title: string,
    detail: string,
  ): Promise<ActLogRow> {
    const outcome = await this.chancery.requestAct(this.agentDomain, request);
    const row: ActLogRow = {
      id: randomUUID(),
      at: outcome.bundle.evaluatedAt,
      presetId,
      title,
      detail,
      bundle: outcome.bundle,
      bundleDigest: bundleDigest(outcome.bundle),
      executed: outcome.executed,
    };
    this.acts.push(row);
    return row;
  }

  bundleFor(digestValue: string): EvidenceBundle | null {
    return this.acts.find((row) => row.bundleDigest === digestValue)?.bundle ?? null;
  }

  ledger(): Promise<LedgerEntry[]> {
    return this.store.ledger();
  }

  private async requireWrit(): Promise<StoredWrit> {
    const writ = await this.writ();
    if (writ === null) throw new Error("no writ has been drafted in this session yet");
    return writ;
  }
}

/* --------------------------------------------------------- live diligence */

/**
 * SerpApi behind the same port. The subject shapes differ — the port speaks in
 * act fields, the adapter speaks in brands — so the mapping happens here rather
 * than by widening either type.
 */
class LiveDiligence implements DiligenceService {
  private readonly client: SerpApiClient;

  constructor(apiKey: string) {
    this.client = new SerpApiClient({ apiKey });
  }

  run(subject: DiligenceSubject, checks: DiligenceCheck[]): Promise<DiligenceFinding[]> {
    const domainName = String(subject.fields.domainName ?? "");
    const name = domainName.length > 0 ? domainName.split(".")[0] : subject.principalLegalName;
    return runDiligence(
      this.client,
      {
        name,
        domain: domainName.length > 0 ? domainName : undefined,
        legalName: subject.principalLegalName,
        country: "IE",
      },
      checks,
    );
  }
}

/* ------------------------------------------------------------ the registry */

/**
 * Held on `globalThis` rather than in a module binding. Next compiles each
 * route handler into its own bundle, so a plain module-level Map gives
 * `/api/act` and `/api/verify` two different registries and the verifier cannot
 * see the zone the console just published into.
 */
const registry = globalThis as typeof globalThis & {
  __chancerySessions?: Map<string, DemoSession>;
};
registry.__chancerySessions ??= new Map<string, DemoSession>();
const sessions = registry.__chancerySessions;

export function getSession(id: string | undefined): DemoSession | null {
  if (id === undefined) return null;
  return sessions.get(id) ?? null;
}

export function createSession(): DemoSession {
  // Oldest first, so a long-running process sheds abandoned sessions rather
  // than refusing new ones.
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next();
    if (oldest.done) break;
    sessions.delete(oldest.value);
  }
  const session = new DemoSession();
  sessions.set(session.id, session);
  return session;
}

export function dropSession(id: string | undefined): void {
  if (id !== undefined) sessions.delete(id);
}

export const SESSION_COOKIE = "chancery_session";

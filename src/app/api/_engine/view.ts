/**
 * Turning engine output into something a signage layout can draw.
 *
 * The one rule here: nothing in this file decides anything. A station is marked
 * failed because the `Decision` named a code that belongs to that station, and
 * the sentence under a refusal is `DecisionReason.message` verbatim. If this
 * file ever has to work out whether an act should have been allowed, the
 * boundary has been crossed in the wrong direction.
 */

import type { EvidenceBundle } from "@/lib/core/evidence";
import { headHash } from "@/lib/core/ledger";
import type {
  ActHistoryEntry,
  Decision,
  DiligenceFinding,
  EnforceablePolicy,
  Grant,
} from "@/lib/core/types";
import type { StoredWrit } from "@/lib/service/ports";

import { STATIONS, money } from "@/app/_shared/content";
import type {
  ActView,
  DocumentView,
  GaugeView,
  RecordView,
  SessionView,
  Stage,
  StationState,
  StationView,
  WritView,
} from "@/app/_shared/view";
import { SCRIPTED_RESOLVER } from "./adapters";
import { modeReport } from "./mode";
import type { ActLogRow, DemoSession } from "./session";

/* -------------------------------------------------------------- stations */

/**
 * Where the act stopped. The first reason carries the code — the engine returns
 * at the first failure, so there is exactly one — and each station owns the
 * codes that stop there. An unknown code stops at the grant station, which is
 * the conservative reading: something about the authority did not hold.
 */
function stopIndex(decision: Decision): number {
  if (decision.outcome === "allow") return STATIONS.length;
  const code = decision.reasons[0]?.code ?? "";
  const index = STATIONS.findIndex((station) => station.codes.includes(code));
  return index === -1 ? STATIONS.findIndex((station) => station.id === "grant") : index;
}

function stationState(index: number, stop: number, dark: boolean): StationState {
  if (dark) return "dark";
  if (index < stop) return "cleared";
  if (index === stop) return "failed";
  return "skipped";
}

function shortHash(hash: string | null): string {
  if (hash === null) return "—";
  return hash.length <= 16 ? hash : `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

/** What each station actually compared on this act, read out of the bundle. */
function stationNotes(bundle: EvidenceBundle): Record<string, string> {
  const { lookup, document, policy, request, history, diligence, resolution } = bundle;
  const grant = policy?.writ.grants.find((g) => g.actKind === request.kind);
  const publishedHash = lookup.outcome === "absent" ? null : lookup.record.documentHash;

  const notes: Record<string, string> = {
    record:
      lookup.outcome === "absent"
        ? `No WRIT1 record at ${resolution.name}`
        : lookup.outcome === "revoked"
          ? `A tombstone is published at ${resolution.name}; a tombstone outranks every active record there`
          : `WRIT1 active, answered by ${resolution.resolver}, AD ${resolution.authenticatedData ? "set" : "unset"}`,
    instrument:
      document.sha256 === publishedHash
        ? `Fetched ${shortHash(document.sha256)}, published ${shortHash(publishedHash)} — the same instrument`
        : `Fetched ${shortHash(document.sha256)}, published ${shortHash(publishedHash)} — they disagree`,
    term:
      lookup.outcome === "absent"
        ? "Not reached"
        : `In force until ${new Date(lookup.record.expiresAt * 1000).toISOString().slice(0, 10)}`,
    grant:
      grant === undefined
        ? `No clause grants ${request.kind}`
        : `Clause ${grant.ref} grants ${request.kind}; ${policy?.ungrounded.length ?? 0} terms ungrounded`,
    world: diligence.length === 0 ? "No condition on this clause" : diligenceNote(diligence),
    scope: scopeNote(grant, request.fields),
    budget: grant === undefined ? "Not reached" : budgetNote(grant, history, request.amountMinorUnits ?? 0),
    commit: "Registrar called, receipt minted",
  };
  return notes;
}

function diligenceNote(findings: DiligenceFinding[]): string {
  return findings
    .map((finding) => `${finding.check.replace(/_/g, " ")}: ${finding.verdict}`)
    .join(" · ");
}

function scopeNote(
  grant: Grant | undefined,
  fields: Record<string, string | number | boolean>,
): string {
  if (grant === undefined) return "Not reached";
  const parts: string[] = [];
  for (const limit of grant.limits) {
    if (limit.type === "allowlist") {
      parts.push(`${limit.field} ${String(fields[limit.field] ?? "—")} against ${limit.values.join("/")}`);
    }
    if (limit.type === "pattern") {
      parts.push(`${String(fields[limit.field] ?? "—")} against ${limit.pattern}`);
    }
  }
  return parts.length === 0 ? "No schedule on this clause" : parts.join(" · ");
}

function budgetNote(
  grant: Grant,
  history: ActHistoryEntry[],
  amountMinorUnits: number,
): string {
  const relevant = history.filter((e) => e.kind === grant.actKind && e.grantRef === grant.ref);
  const parts: string[] = [];
  for (const limit of grant.limits) {
    if (limit.type === "count") {
      parts.push(`${relevant.length} of ${limit.max} used, this act makes ${relevant.length + 1}`);
    }
    if (limit.type === "amount") {
      const spent = relevant
        .filter((e) => e.currency === limit.currency)
        .reduce((sum, e) => sum + e.amountMinorUnits, 0);
      parts.push(
        `${money(spent, limit.currency)} committed + ${money(amountMinorUnits, limit.currency)} ` +
          `against ${money(limit.maxMinorUnits, limit.currency)}`,
      );
    }
  }
  return parts.join(" · ");
}

export function stationsFor(bundle: EvidenceBundle): StationView[] {
  const stop = stopIndex(bundle.decision);
  const notes = stationNotes(bundle);
  return STATIONS.map((station, index) => ({
    id: station.id,
    name: station.name,
    short: station.short,
    tests: station.tests,
    clause: station.clause,
    line: station.line,
    state: stationState(index, stop, false),
    note: index <= stop ? (notes[station.id] ?? "") : "",
  }));
}

/* ----------------------------------------------------------------- gauges */

export function gaugesFor(
  policy: EnforceablePolicy | null,
  history: ActHistoryEntry[],
): GaugeView[] {
  if (policy === null) return [];
  const gauges: GaugeView[] = [];

  for (const grant of policy.writ.grants) {
    if (grant.actKind !== "domain.register") continue;
    const relevant = history.filter((e) => e.kind === grant.actKind && e.grantRef === grant.ref);

    for (const limit of grant.limits) {
      if (limit.type === "count") {
        gauges.push({
          id: `${grant.ref}-count`,
          kind: "count",
          label: "Registrations",
          clause: grant.ref,
          used: relevant.length,
          max: limit.max,
          currency: null,
          values: null,
          reading: `${relevant.length} of ${limit.max} used`,
        });
      }
      if (limit.type === "amount") {
        const spent = relevant
          .filter((e) => e.currency === limit.currency)
          .reduce((sum, e) => sum + e.amountMinorUnits, 0);
        gauges.push({
          id: `${grant.ref}-amount`,
          kind: "amount",
          label: "Spend",
          clause: grant.ref,
          used: spent,
          max: limit.maxMinorUnits,
          currency: limit.currency,
          values: null,
          reading: `${money(spent, limit.currency)} of ${money(limit.maxMinorUnits, limit.currency)} committed`,
        });
      }
      if (limit.type === "allowlist") {
        gauges.push({
          id: `${grant.ref}-allowlist`,
          kind: "allowlist",
          label: "Suffixes",
          clause: grant.ref,
          used: null,
          max: null,
          currency: null,
          values: limit.values,
          reading: `Only ${limit.values.map((v) => `.${v}`).join(" and ")}`,
        });
      }
      if (limit.type === "pattern") {
        gauges.push({
          id: `${grant.ref}-pattern`,
          kind: "pattern",
          label: "Name",
          clause: grant.ref,
          used: null,
          max: null,
          currency: null,
          values: [limit.pattern],
          reading: `Must match ${limit.pattern}`,
        });
      }
    }

    for (const condition of grant.conditions) {
      if (condition.type !== "diligence") continue;
      gauges.push({
        id: `${grant.ref}-${condition.check}`,
        kind: "condition",
        label: "Trade mark",
        clause: grant.ref,
        used: null,
        max: null,
        currency: null,
        values: null,
        reading: "Checked against live registers on every act",
      });
    }
  }

  return gauges;
}

/* ------------------------------------------------------------------- acts */

export function actView(row: ActLogRow): ActView {
  const { bundle } = row;
  const stop = stopIndex(bundle.decision);
  const publishedHash = bundle.lookup.outcome === "absent" ? null : bundle.lookup.record.documentHash;
  return {
    id: row.id,
    at: row.at,
    title: row.title,
    detail: row.detail,
    presetId: row.presetId,
    kind: bundle.request.kind,
    fields: bundle.request.fields,
    amountMinorUnits: bundle.request.amountMinorUnits ?? null,
    currency: bundle.request.currency ?? null,
    outcome: bundle.decision.outcome,
    reasons: bundle.decision.reasons,
    stopAt: STATIONS[stop]?.id ?? "commit",
    stations: stationsFor(bundle),
    diligence: bundle.diligence,
    executed: row.executed,
    bundleDigest: row.bundleDigest,
    resolver: bundle.resolution.resolver,
    authenticatedData: bundle.resolution.authenticatedData,
    fetchedHash: bundle.document.sha256 ?? null,
    publishedHash,
  };
}

/* ---------------------------------------------------------------- session */

function stageOf(writ: StoredWrit | null): Stage {
  if (writ === null) return "empty";
  if (writ.status === "revoked") return "revoked";
  if (writ.status === "draft" || writ.status === "pending_signature") return "drafted";
  return writ.anchoredAt === null ? "signed" : "anchored";
}

export async function sessionView(session: DemoSession): Promise<SessionView> {
  const now = new Date().toISOString();
  const writ = await session.writ();
  const stage = stageOf(writ);

  const history = writ === null ? [] : await session.store.actHistory(writ.id);
  const ledger = await session.ledger();

  let record: RecordView | null = null;
  if (writ !== null) {
    const { lookup, resolution } = await session.resolver.lookupWrit(session.agentDomain);
    record = {
      name: resolution.name,
      txtRecords: resolution.txtRecords,
      resolver: resolution.resolver,
      authenticatedData: resolution.authenticatedData,
      resolvedAt: resolution.resolvedAt,
      outcome: lookup.outcome,
      record: lookup.outcome === "absent" ? null : lookup.record,
      scripted: resolution.resolver === SCRIPTED_RESOLVER,
    };
  }

  let document: DocumentView | null = null;
  if (writ !== null && writ.documentSha256 !== null) {
    const publishedHash = record?.record?.documentHash ?? null;
    const currentHash = session.desk.currentHash(writ.id);
    document = {
      url: writ.documentUrl,
      publishedHash,
      currentHash,
      agrees: publishedHash !== null && publishedHash === currentHash,
      edit: session.tamper === null ? null : { before: session.tamper.before, after: session.tamper.after },
    };
  }

  const writView: WritView | null =
    writ === null
      ? null
      : {
          id: writ.id,
          status: writ.status,
          principal: writ.spec.principal,
          agent: writ.spec.agent,
          grants: writ.spec.grants,
          effectiveFrom: writ.spec.effectiveFrom,
          expiresAt: writ.spec.expiresAt,
          jurisdiction: writ.spec.jurisdiction,
          documentUrl: writ.documentUrl,
          documentSha256: writ.documentSha256,
          envelopeId: writ.envelopeId,
          anchoredAt: writ.anchoredAt,
          daysRemaining: Math.floor(
            (Date.parse(writ.spec.expiresAt) - Date.parse(now)) / 86_400_000,
          ),
        };

  return {
    sessionId: session.id,
    now,
    stage,
    mode: modeReport(),
    diligenceSupply: session.diligenceLabel,
    agentDomain: session.agentDomain,
    recordName: session.recordName,
    writ: writView,
    record,
    document,
    gauges: gaugesFor(writ?.policy ?? null, history),
    acts: session.acts.map(actView),
    ledger,
    step: session.step,
    chainHead: headHash(ledger),
  };
}

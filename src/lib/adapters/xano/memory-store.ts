/**
 * An in-memory `WritStore` with the same semantics as the Xano one.
 *
 * This is not a mock standing in for the real thing. It is what makes Chancery
 * runnable with zero credentials — clone, `pnpm test`, drive the whole gate —
 * and that only means anything if it behaves like the backend of record rather
 * than like a convenient lie. So:
 *
 *   - the chain is built with `appendEntry` from `core/ledger.ts`. Not a
 *     reimplementation of it, not a stub that returns a random hash. Entries
 *     written here pass `verifyChain` for the same reason entries written by
 *     Xano do, because it is the same function producing them.
 *   - it raises the same typed errors, from the same module, as the HTTP store.
 *     Code that handles a `NOT_FOUND` or an `IMMUTABLE_FIELD` against one
 *     handles it unchanged against the other.
 *   - it enforces the same refusals: a signed writ's terms are not patchable,
 *     and a revoked writ is terminal.
 *
 * The single asymmetry is stated rather than hidden: there is no authenticated
 * account here, so the `$auth.id` scoping the Xano endpoints perform has nothing
 * to scope against. Pass `principal` to model that case exactly; otherwise the
 * spec's own principal stands.
 */

import { appendEntry, verifyChain, type ChainDefect, type LedgerEntry, type LedgerEntryInput } from "../../core/ledger";
import type { EvidenceBundle } from "../../core/evidence";
import type { ActHistoryEntry, PrincipalRef } from "../../core/types";
import type { StoredWrit, WritSpec, WritStore } from "../../service/ports";
import { XanoError } from "./errors";

export interface MemoryWritStoreOptions {
  /**
   * Stands in for the authenticated account. When set it replaces the spec's
   * principal on create, exactly as the Xano endpoint replaces it with `$auth`.
   */
  principal?: PrincipalRef;
  /** Where a stored receipt would be published. */
  evidenceBaseUrl?: string;
  /** Injected so ids are reproducible in tests. */
  newId?: () => string;
}

interface WritRow {
  writ: StoredWrit;
  /** Creation order, so "the writ for this domain" resolves deterministically. */
  ordinal: number;
}

export class MemoryWritStore implements WritStore {
  private readonly writs = new Map<string, WritRow>();
  private readonly acts = new Map<string, ActHistoryEntry[]>();
  private readonly entries: LedgerEntry[] = [];
  private readonly receipts = new Map<string, EvidenceBundle>();

  private readonly principal: PrincipalRef | null;
  private readonly evidenceBaseUrl: string;
  private readonly newId: () => string;
  private ordinal = 0;

  constructor(options: MemoryWritStoreOptions = {}) {
    this.principal = options.principal ?? null;
    this.evidenceBaseUrl = (options.evidenceBaseUrl ?? "https://chancery.local/receipt").replace(
      /\/+$/,
      "",
    );
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /* ------------------------------------------------------------------- writs */

  async createWrit(spec: WritSpec): Promise<StoredWrit> {
    const id = this.newId();
    const writ: StoredWrit = {
      id,
      status: "draft",
      spec: this.principal === null ? spec : { ...spec, principal: this.principal },
      documentUrl: null,
      documentSha256: null,
      envelopeId: null,
      policy: null,
      anchoredAt: null,
    };
    this.writs.set(id, { writ, ordinal: this.ordinal++ });
    this.acts.set(id, []);
    return clone(writ);
  }

  async getWrit(id: string): Promise<StoredWrit | null> {
    const row = this.writs.get(id);
    return row === undefined ? null : clone(row.writ);
  }

  async getWritByAgentDomain(domain: string): Promise<StoredWrit | null> {
    // Newest first, whatever its status. A revoked writ has to stay findable:
    // the gate needs to see it to answer WRIT_REVOKED rather than NO_WRIT, and
    // those are very different things to tell a principal.
    let best: WritRow | null = null;
    for (const row of this.writs.values()) {
      if (row.writ.spec.agent.domain !== domain) continue;
      if (best === null || row.ordinal > best.ordinal) best = row;
    }
    return best === null ? null : clone(best.writ);
  }

  async updateWrit(id: string, patch: Partial<StoredWrit>): Promise<StoredWrit> {
    if (patch.id !== undefined || patch.spec !== undefined) {
      throw new XanoError(
        "id and spec cannot be patched: the terms of a signed writ are not editable",
        "IMMUTABLE_FIELD",
      );
    }
    const row = this.writs.get(id);
    if (row === undefined) {
      throw new XanoError(`no such writ: ${id}`, "NOT_FOUND");
    }
    // Revocation is terminal. Re-activating a revoked instrument by patch would
    // make the DNS tombstone and the registry disagree about live authority.
    // Raised as FORBIDDEN rather than CONFLICT so that it is the same typed
    // error the HTTP store raises: XanoScript's error types have no `conflict`,
    // so the endpoint answers `accessdenied` and this has to match it.
    if (row.writ.status === "revoked" && patch.status !== undefined && patch.status !== "revoked") {
      throw new XanoError(`writ ${id} is revoked; that is terminal`, "FORBIDDEN");
    }

    const updated: StoredWrit = { ...row.writ };
    if (patch.status !== undefined) updated.status = patch.status;
    if (patch.documentUrl !== undefined) updated.documentUrl = patch.documentUrl;
    if (patch.documentSha256 !== undefined) updated.documentSha256 = patch.documentSha256;
    if (patch.envelopeId !== undefined) updated.envelopeId = patch.envelopeId;
    if (patch.policy !== undefined) updated.policy = patch.policy;
    if (patch.anchoredAt !== undefined) updated.anchoredAt = patch.anchoredAt;

    this.writs.set(id, { writ: updated, ordinal: row.ordinal });
    return clone(updated);
  }

  /* -------------------------------------------------------------------- acts */

  async actHistory(writId: string): Promise<ActHistoryEntry[]> {
    return clone(this.acts.get(writId) ?? []);
  }

  async recordExecutedAct(writId: string, entry: ActHistoryEntry): Promise<void> {
    const existing = this.acts.get(writId);
    if (existing === undefined) {
      throw new XanoError(`no such writ: ${writId}`, "NOT_FOUND");
    }
    existing.push(clone(entry));
  }

  /* ------------------------------------------------------------------ ledger */

  async appendLedger(entry: LedgerEntryInput): Promise<LedgerEntry> {
    const previous = this.entries.length === 0 ? null : this.entries[this.entries.length - 1];
    const appended = appendEntry(previous, entry);
    this.entries.push(appended);
    return clone(appended);
  }

  async ledger(writId?: string): Promise<LedgerEntry[]> {
    const all = this.entries;
    if (writId === undefined) return clone(all);
    return clone(all.filter((entry) => writIdOf(entry.payload) === writId));
  }

  /* ---------------------------------------------------------------- receipts */

  async putEvidence(bundle: EvidenceBundle, bundleDigest: string): Promise<{ url: string }> {
    // Content-addressed, so re-putting the same bundle is a no-op rather than a
    // second receipt with a second URL.
    if (!this.receipts.has(bundleDigest)) {
      this.receipts.set(bundleDigest, clone(bundle));
    }
    return { url: `${this.evidenceBaseUrl}/${bundleDigest}` };
  }

  /* ------------------------------------------------------------- inspection */

  /** Published receipts are readable by anyone; this is the local equivalent. */
  getEvidence(bundleDigest: string): EvidenceBundle | null {
    const bundle = this.receipts.get(bundleDigest);
    return bundle === undefined ? null : clone(bundle);
  }

  /** Recompute the whole chain, the way an outside reviewer would. */
  chainDefects(): ChainDefect[] {
    return verifyChain(this.entries);
  }
}

function writIdOf(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const value = (payload as { writId?: unknown }).writId;
  return typeof value === "string" ? value : undefined;
}

/**
 * Handing out the stored object would let a caller mutate the store by editing
 * what it read — which the HTTP store cannot do, so neither may this one.
 */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * `WritResolver`, backed by public DNS over HTTPS.
 *
 * The bridge is thin and the thinness is the argument: everything that decides
 * *which* record counts already lives in `selectWritRecord`, which is pure and
 * shared with the offline verifier, so a caller who re-derives a verdict from a
 * published bundle runs the same selection this did.
 *
 * `resolvedAt` is the one value invented here, because `TxtLookup` carries no
 * clock. It is taken from the injected clock rather than `Date.now()` so a
 * replayed verdict is reproducible.
 *
 * `TxtLookup.status` — the DNS RCODE — has nowhere to go in `ResolvedTxt` and is
 * dropped. Nothing downstream reads it: an NXDOMAIN and a NOERROR with no TXT
 * both come back as no records, which `selectWritRecord` reports as `absent`,
 * which denies. A resolver that could not answer at all throws instead, so
 * "we could not ask" never arrives here dressed as "nobody published anything".
 */

import { selectWritRecord, writRecordName, type WritLookup } from "../../core/writ-record";
import { DohResolver, type TxtResolver } from "../../dns/resolver";
import type { ResolvedTxt, WritResolver } from "../ports";

export interface DohWritResolverOptions {
  /** Defaults to Cloudflare with a Google fallback for transport failures only. */
  resolver?: TxtResolver;
  clock?: () => string;
}

export class DohWritResolver implements WritResolver {
  private readonly resolver: TxtResolver;
  private readonly clock: () => string;

  constructor(options: DohWritResolverOptions = {}) {
    this.resolver = options.resolver ?? new DohResolver();
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async resolveTxt(name: string): Promise<ResolvedTxt> {
    const answer = await this.resolver.resolveTxt(name);
    return {
      name: answer.name,
      txtRecords: answer.values,
      resolver: answer.resolver,
      // Carried through exactly as it came back. Never defaulted to true.
      authenticatedData: answer.authenticatedData,
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

/**
 * The same lookup, in a shape that can be hashed.
 *
 * `parseWritRecord` sets `signature` to `undefined` on a record that carries no
 * `s=` tag, and `canonicalize` refuses to hash an object with an undefined
 * property rather than silently dropping it — which is the right call, because
 * a hash over quietly-discarded data is worse than an error. But the lookup
 * goes straight into the evidence bundle and the bundle is hashed on every act,
 * so an unsigned record would make `evaluate` throw rather than decide.
 *
 * Omitting the key says exactly what `undefined` said, in a shape RFC 8785 can
 * serialise. It is done at the seam because that is where a vendor answer
 * becomes published evidence.
 */
export function publishableLookup(lookup: WritLookup): WritLookup {
  if (lookup.outcome === "absent") return lookup;

  const { signature, ...rest } = lookup.record;
  const record = signature === undefined ? rest : { ...rest, signature };
  return lookup.outcome === "active"
    ? { outcome: "active", record }
    : { outcome: "revoked", record };
}

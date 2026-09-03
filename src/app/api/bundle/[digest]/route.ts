/**
 * Re-derive a published verdict from its own evidence.
 *
 * `replay` runs the same pure `decide` over the bundle's recorded inputs. A
 * disagreement is not proof of dishonesty — the bundle may predate a change to
 * the engine — but it does mean the recorded verdict can no longer be
 * reproduced, which is exactly what a reviewer needs to be told.
 */

import { NextResponse } from "next/server";

import { replay } from "@/lib/core/evidence";
import type { ReplayView } from "@/app/_shared/view";
import { resolveSession } from "../../_engine/http";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ digest: string }> },
) {
  const { digest } = await context.params;
  const { session } = await resolveSession();
  const bundle = session.bundleFor(digest);

  if (bundle === null) {
    return NextResponse.json(
      { error: `No receipt in this session with digest ${digest}` },
      { status: 404 },
    );
  }

  const result = replay(bundle);
  const view: ReplayView = result.agrees
    ? {
        digest,
        agrees: true,
        differences: [],
        recorded: bundle.decision,
        recomputed: result.decision,
        evaluatedAt: bundle.evaluatedAt,
      }
    : {
        digest,
        agrees: false,
        differences: result.differences,
        recorded: result.recorded,
        recomputed: result.recomputed,
        evaluatedAt: bundle.evaluatedAt,
      };

  return NextResponse.json({ view, bundle });
}

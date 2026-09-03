/**
 * Ask for an irreversible act.
 *
 * This is `Chancery.requestAct`, which decides first and executes only on an
 * allow. The response is the whole session rather than just the verdict,
 * because a verdict changes the budget, the ledger and the chain head, and a
 * surface that redrew only the verdict would be showing stale meters next to a
 * fresh refusal.
 */

import { failure, messageOf, resolveSession, withSession } from "../_engine/http";
import { sessionView } from "../_engine/view";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const presetId = (body as { presetId?: unknown } | null)?.presetId;
  if (typeof presetId !== "string") {
    return failure("presetId is required");
  }

  const resolved = await resolveSession();
  try {
    const row = await resolved.session.runAct(presetId);
    return withSession(
      { act: row.id, ...(await sessionView(resolved.session)) },
      resolved,
    );
  } catch (error) {
    return failure(messageOf(error), 409);
  }
}

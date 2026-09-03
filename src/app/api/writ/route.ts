/**
 * The instrument's lifecycle, in the order a human performs it.
 *
 * Drafting, signing, publishing and withdrawing all run through `Chancery`, so
 * the same guarantees hold here as anywhere else: signing is a step no agent
 * path can reach, and revocation publishes a tombstone rather than deleting a
 * record. `tamper` and `restore` exist for the walkthrough and do exactly what
 * they say — they edit the bytes at the document URL, and nothing else.
 */

import { failure, messageOf, resolveSession, withSession } from "../_engine/http";
import { sessionView } from "../_engine/view";

export const dynamic = "force-dynamic";

const ACTIONS = ["draft", "sign", "anchor", "tamper", "restore", "revoke", "step"] as const;
type Action = (typeof ACTIONS)[number];

function isAction(value: unknown): value is Action {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const action = (body as { action?: unknown } | null)?.action;
  if (!isAction(action)) {
    return failure(`action must be one of ${ACTIONS.join(", ")}`);
  }

  const resolved = await resolveSession();
  const { session } = resolved;

  try {
    switch (action) {
      case "draft":
        await session.draft();
        break;
      case "sign":
        await session.sign();
        break;
      case "anchor":
        await session.anchor();
        break;
      case "tamper":
        await session.tamperDocument();
        break;
      case "restore":
        await session.restoreDocument();
        break;
      case "revoke":
        await session.revoke();
        break;
      case "step": {
        const next = (body as { step?: unknown }).step;
        session.step = typeof next === "number" ? next : session.step;
        break;
      }
    }
  } catch (error) {
    return failure(messageOf(error), 409);
  }

  return withSession(await sessionView(session), resolved);
}

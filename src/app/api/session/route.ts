/** The state of one driveable Chancery: what is in force, and what it has answered. */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { resolveSession, withSession } from "../_engine/http";
import { SESSION_COOKIE, dropSession } from "../_engine/session";
import { sessionView } from "../_engine/view";

export const dynamic = "force-dynamic";

export async function GET() {
  const resolved = await resolveSession();
  return withSession(await sessionView(resolved.session), resolved);
}

/** Start over. The instrument, the zone and the ledger all go with it. */
export async function DELETE() {
  const jar = await cookies();
  dropSession(jar.get(SESSION_COOKIE)?.value);
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}

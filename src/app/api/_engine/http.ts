/**
 * Session plumbing shared by the route handlers.
 *
 * The cookie is the only thing tying a browser to a driveable Chancery, and it
 * is deliberately not an identity: there is no account here, and the public
 * verifier never reads it, because an agent's authority has to be checkable by
 * someone who has never visited this deployment.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { SESSION_COOKIE, createSession, getSession, type DemoSession } from "./session";

export interface Resolved {
  session: DemoSession;
  /** Set when a new session was minted and the cookie has to go back out. */
  fresh: boolean;
}

export async function resolveSession(): Promise<Resolved> {
  const jar = await cookies();
  const existing = getSession(jar.get(SESSION_COOKIE)?.value);
  if (existing !== null) return { session: existing, fresh: false };
  return { session: createSession(), fresh: true };
}

export function withSession<T>(body: T, resolved: Resolved): NextResponse<T> {
  const response = NextResponse.json(body);
  if (resolved.fresh) {
    response.cookies.set(SESSION_COOKIE, resolved.session.id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 6,
    });
  }
  return response;
}

export function failure(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

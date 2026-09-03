#!/usr/bin/env tsx
/**
 * Drive the deployed backend through the real `XanoWritStore`.
 *
 * This is not a unit test — the unit tests run against a fake fetch and prove
 * the client's behaviour. This proves the other half: that the XanoScript in
 * `xano/**` actually answers the shapes the client expects, against a live
 * instance, over the network. A backend that pushes green and returns the wrong
 * envelope is a backend that fails in the demo, and only this catches that.
 *
 * The ledger check is the one that matters. Entries are appended through the
 * API, read back, and re-hashed with `digest` from `core/canonical.ts`. If the
 * canonicaliser lambda running inside Xano disagreed with the TypeScript one by
 * a single character — a key ordering, a `-0`, a number format — this is where
 * it would show, because the recomputed hash would not match the stored one.
 *
 * It also runs long enough to trip the free tier's 10-requests-per-20-seconds
 * cap on purpose, so the retry hint on `XanoRateLimitError` gets exercised for
 * real rather than only against a fixture.
 *
 *   npx tsx scripts/xano-smoke.ts
 */

import { digest } from "../src/lib/core/canonical";
import { XanoRateLimitError, XanoWritStore } from "../src/lib/adapters/xano";
import type { WritSpec } from "../src/lib/service/ports";

const INSTANCE = "https://x8ki-letl-twmt.n7.xano.io";

/**
 * The free tier allows 10 requests per 20 seconds and this script makes more
 * than that, so it WILL be throttled partway through — which is the point.
 *
 * `XanoRateLimitError` carries `retryAfterMs`, and this is the whole reason it
 * does: a caller can wait exactly as long as the window needs and continue,
 * instead of guessing or treating the 429 as a failure. Every other error is
 * rethrown immediately; only the throttle is retried.
 */
async function paced<T>(label: string, call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof XanoRateLimitError)) throw error;
      const wait = error.retryAfterMs + 500;
      process.stdout.write(`  wait ${label} — throttled, ${wait}ms (${error.limit}/${error.windowMs}ms)\n`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw new Error(`${label} never got past the rate limit`);
}

/** Each API group gets its own base, keyed by the group's `canonical`. */
export const BASE_URLS = {
  chancery: `${INSTANCE}/api:chancery`,
  auth: `${INSTANCE}/api:chancery-auth`,
  public: `${INSTANCE}/api:chancery-verify`,
  webhook: `${INSTANCE}/api:chancery-hook`,
};

function ok(label: string, detail = ""): void {
  process.stdout.write(`  ok   ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function main(): Promise<void> {
  const store = new XanoWritStore({
    baseUrl: BASE_URLS.chancery,
    authBaseUrl: BASE_URLS.auth,
    publicBaseUrl: BASE_URLS.public,
    timeoutMs: 30_000,
  });

  // A fresh principal per run: signup is idempotent only in the sense that a
  // repeat is refused, and a smoke test that needs a clean workspace is a smoke
  // test nobody runs twice.
  const stamp = Date.now();
  const email = `smoke+${stamp}@chancery.test`;

  process.stdout.write("auth\n");
  const signed = await paced("signup", () => store.signup({
    legalName: "Northwind Coffee Ltd",
    email,
    password: "correct-horse-battery-7-staple",
  }));
  ok("POST auth/signup", `principal ${signed.principal.id}`);

  store.setToken(null as unknown as string);
  const logged = await paced("login", () => store.login({ email, password: "correct-horse-battery-7-staple" }));
  ok("POST auth/login", `token ${logged.token.slice(0, 12)}…`);

  const me = await paced("me", () => store.me());
  ok("GET me", me.email);

  process.stdout.write("registry\n");
  const domain = `ops-${stamp}.northwind.example`;
  const spec: WritSpec = {
    principal: {
      id: signed.principal.id,
      legalName: signed.principal.legal_name,
      email: signed.principal.email,
      entityVerified: signed.principal.entity_verified,
    },
    agent: {
      id: "agent_01",
      label: "Northwind ops agent",
      domain,
      publicKey: "cHVibGljLWtleQ",
    },
    grants: [
      {
        ref: "3(b)",
        actKind: "domain.register",
        limits: [
          { type: "count", max: 3, window: "total" },
          { type: "amount", maxMinorUnits: 5_000, currency: "USD", window: "total" },
          { type: "allowlist", field: "tld", values: ["com", "net"] },
        ],
        conditions: [{ type: "diligence", check: "trademark_clear" }],
      },
    ],
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z",
    jurisdiction: "IE",
  };

  const created = await paced("createWrit", () => store.createWrit(spec));
  ok("POST writ", `${created.id} (${created.status})`);

  // The round trip that matters: camelCase limit keys are hashed into every
  // receipt, so a mapper that renamed one would invalidate published evidence.
  const limit = created.spec.grants[0].limits[1];
  if (limit.type !== "amount" || limit.maxMinorUnits !== 5_000) {
    throw new Error(`limits did not survive the round trip: ${JSON.stringify(limit)}`);
  }
  ok("limits round-trip verbatim", "maxMinorUnits intact");

  if (created.spec.effectiveFrom !== "2026-09-01T00:00:00.000Z") {
    throw new Error(`timestamp coercion failed: ${created.spec.effectiveFrom}`);
  }
  ok("epoch millis coerced to ISO", created.spec.effectiveFrom);

  const fetched = await paced("getWrit", () => store.getWrit(created.id));
  ok("GET writ/{uid}", fetched?.id ?? "null");

  const byDomain = await paced("byDomain", () => store.getWritByAgentDomain(domain));
  ok("GET writ_by_domain", byDomain?.id ?? "null");

  const missing = await paced("missing", () => store.getWrit("00000000-0000-4000-8000-000000000000"));
  if (missing !== null) throw new Error("a nonexistent writ should read as null");
  ok("missing writ reads as null, not 404");

  const activated = await paced("updateWrit", () => store.updateWrit(created.id, {
    status: "active",
    documentSha256: "Zm9vYmFyLWRvY3VtZW50LWhhc2g",
    documentUrl: "https://chancery.example/writ/1.pdf",
  }));
  ok("PATCH writ/{uid}", activated.status);

  process.stdout.write("acts\n");
  await paced("recordAct", () => store.recordExecutedAct(created.id, {
    kind: "domain.register",
    grantRef: "3(b)",
    amountMinorUnits: 1_099,
    currency: "USD",
    executedAt: "2026-09-02T09:15:00.000Z",
  }));
  const history = await paced("actHistory", () => store.actHistory(created.id));
  ok("POST + GET writ/{uid}/act", `${history.length} executed act(s)`);

  process.stdout.write("ledger\n");
  const first = await paced("ledger#1", () => store.appendLedger({
    kind: "writ.issued",
    at: "2026-09-03T10:00:00.000Z",
    payload: { writId: created.id, agentDomain: domain, grants: 1 },
  }));
  ok("POST ledger #1", `sequence ${first.sequence}`);

  const second = await paced("ledger#2", () => store.appendLedger({
    kind: "act.decided",
    at: "2026-09-03T10:05:00.000Z",
    payload: {
      writId: created.id,
      outcome: "deny",
      reasons: [{ code: "AMOUNT_LIMIT_EXCEEDED", clauseRef: "3(b)" }],
    },
  }));
  ok("POST ledger #2", `sequence ${second.sequence}`);

  if (second.previousHash !== first.hash) {
    throw new Error(`chain is broken: ${second.previousHash} != ${first.hash}`);
  }
  ok("second entry links to the first");

  const mine = await paced("ledgerList", () => store.ledger(created.id));

  // A writ-scoped read is a PROJECTION of the chain, not a chain: its sequence
  // numbers stay global, so `verifyChain` would rightly report a gap. What must
  // hold for every entry individually is that its contents reproduce its hash —
  // and that is the check that proves Xano's canonicaliser lambda agrees with
  // `core/canonical.ts` byte for byte. If they disagreed anywhere, here is where
  // it would surface.
  for (const entry of mine) {
    const recomputed = digest({
      sequence: entry.sequence,
      previousHash: entry.previousHash,
      kind: entry.kind,
      at: entry.at,
      payload: entry.payload,
    });
    if (recomputed !== entry.hash) {
      throw new Error(
        `entry ${entry.sequence}: Xano hashed ${entry.hash}, TypeScript hashes ${recomputed}`,
      );
    }
  }
  ok("GET ledger", `${mine.length} entries, every hash reproduced locally`);

  process.stdout.write("public\n");
  const verification = await paced("verify", () => store.verify(domain));
  ok("GET verify (unauthenticated)", `${verification.status}, head ${verification.ledger.head_hash.slice(0, 12)}…`);

  const spine = await paced("spine", () => store.ledgerSpine());
  ok("GET ledger/spine (unauthenticated)", `${spine.length} links, no payloads`);

  if (spine.some((link) => "payload" in link)) {
    throw new Error("the public spine leaked a payload");
  }
  ok("spine carries no payloads");

  // The whole-chain property, checked the way a stranger would: every entry's
  // `previous_hash` is the hash of the entry before it, and the sequence has no
  // gaps. Payload-free, so it proves linkage without revealing anything.
  for (let i = 1; i < spine.length; i += 1) {
    if (spine[i].previous_hash !== spine[i - 1].hash) {
      throw new Error(`spine breaks between ${spine[i - 1].sequence} and ${spine[i].sequence}`);
    }
    if (spine[i].sequence !== spine[i - 1].sequence + 1) {
      throw new Error(`spine has a gap before sequence ${spine[i].sequence}`);
    }
  }
  ok("spine is unbroken end to end", `${spine.length} links, head ${spine.at(-1)?.hash.slice(0, 12)}…`);

  process.stdout.write("\nall green\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

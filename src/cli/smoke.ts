#!/usr/bin/env node
/**
 * `pnpm smoke` — prove the integrations against the real services.
 *
 * Every check here talks to a live third-party API and reports what actually
 * came back. A check with no credentials configured is reported as **skipped**,
 * never as passed: a green row in this table always means a real response was
 * received, which is the only way the table is worth printing.
 *
 * Metered calls are avoided on purpose. Nutrient's free tier is 50 credits and
 * one page of schema-bound extraction costs 15, so this exercises the free
 * `analyze_build` planner instead — which proves the Build contract without
 * spending anything. SerpApi charges per search, so exactly one is made.
 */

// Node loads this itself; no dependency needed. Absent in CI, which is fine —
// every check then reports as skipped rather than inventing a result.
try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local; checks will skip
}

type Status = "ok" | "fail" | "skip";

interface Check {
  service: string;
  what: string;
  status: Status;
  detail: string;
}

const checks: Check[] = [];

function record(service: string, what: string, status: Status, detail: string): void {
  checks.push({ service, what, status, detail });
  const mark = status === "ok" ? "  ok  " : status === "fail" ? " FAIL " : " skip ";
  process.stdout.write(`[${mark}] ${service.padEnd(12)} ${what.padEnd(38)} ${detail}\n`);
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started };
}

/* ------------------------------------------------------------------ Venice */

async function checkVenice(): Promise<void> {
  const key = process.env.VENICE_API_KEY;
  if (!key) return record("Venice", "chat completion", "skip", "VENICE_API_KEY not set");

  try {
    // GET /models is public — a garbage key returns 200 — so authentication has
    // to be proven against an endpoint that actually costs something.
    const { value, ms } = await timed(async () =>
      fetch(`${process.env.VENICE_BASE_URL ?? "https://api.venice.ai/api/v1"}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: process.env.VENICE_MODEL ?? "gemini-3-8-flash",
          messages: [{ role: "user", content: "Reply with the single word: ready" }],
          max_completion_tokens: 8,
        }),
      }),
    );
    const body = (await value.json()) as {
      choices?: { message?: { content?: string } }[];
      cost?: { usd?: number };
    };
    if (!value.ok) return record("Venice", "chat completion", "fail", `HTTP ${value.status}`);
    const reply = body.choices?.[0]?.message?.content?.trim() ?? "";
    record(
      "Venice",
      "chat completion",
      "ok",
      `${ms}ms, $${(body.cost?.usd ?? 0).toFixed(6)}, said "${reply.slice(0, 20)}"`,
    );
  } catch (error) {
    record("Venice", "chat completion", "fail", message(error));
  }
}

/* ---------------------------------------------------------------- Nutrient */

async function checkNutrient(): Promise<void> {
  const key = process.env.NUTRIENT_API_KEY;
  if (!key) {
    record("Nutrient", "account", "skip", "NUTRIENT_API_KEY not set");
    return;
  }

  try {
    const response = await fetch("https://api.nutrient.io/account/info", {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      record("Nutrient", "account", "fail", `HTTP ${response.status}`);
      return;
    }
    const body = (await response.json()) as {
      usage?: { totalCredits?: string; usedCredits?: string };
      subscriptionType?: string;
    };
    const total = Number(body.usage?.totalCredits ?? 0);
    const used = Number(body.usage?.usedCredits ?? 0);
    record(
      "Nutrient",
      "account",
      "ok",
      `${total - used}/${total} credits left, ${body.subscriptionType ?? "?"} plan`,
    );

    // analyze_build costs nothing and returns the execution plan the Build API
    // would follow — which is exactly the deterministic-preview claim.
    const plan = await fetch("https://api.nutrient.io/analyze_build", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ html: { url: "https://example.com" } }],
        output: { type: "pdfa", conformance: "pdfa-2a" },
      }),
    });
    const planBody = (await plan.json()) as {
      cost?: number;
      required_features?: Record<string, unknown>;
    };
    if (!plan.ok) {
      record("Nutrient", "analyze_build (free planner)", "fail", `HTTP ${plan.status}`);
      return;
    }
    record(
      "Nutrient",
      "analyze_build (free planner)",
      "ok",
      `cost ${planBody.cost ?? "?"} credits, features: ${Object.keys(planBody.required_features ?? {}).join(", ") || "none"}`,
    );
  } catch (error) {
    record("Nutrient", "account", "fail", message(error));
  }
}

/* ----------------------------------------------------------------- SerpApi */

async function checkSerpApi(): Promise<void> {
  const key = process.env.SERPAPI_KEY;
  if (!key) return record("SerpApi", "search", "skip", "SERPAPI_KEY not set");

  try {
    const account = await fetch(`https://serpapi.com/account?api_key=${key}`);
    const info = (await account.json()) as {
      total_searches_left?: number;
      searches_per_month?: number;
    };
    record(
      "SerpApi",
      "account",
      account.ok ? "ok" : "fail",
      `${info.total_searches_left ?? "?"}/${info.searches_per_month ?? "?"} searches left`,
    );

    const { value, ms } = await timed(async () =>
      fetch(
        `https://serpapi.com/search.json?engine=google_patents&q=northwind&litigation=YES&api_key=${key}`,
      ),
    );
    const body = (await value.json()) as { organic_results?: unknown[]; error?: string };
    if (!value.ok || body.error) {
      record("SerpApi", "google_patents (litigation)", "fail", body.error ?? `HTTP ${value.status}`);
      return;
    }
    record(
      "SerpApi",
      "google_patents (litigation)",
      "ok",
      `${ms}ms, ${body.organic_results?.length ?? 0} results`,
    );
  } catch (error) {
    record("SerpApi", "search", "fail", message(error));
  }
}

/* ------------------------------------------------------------------- Foxit */

async function checkFoxit(): Promise<void> {
  const id = process.env.FOXIT_CLIENT_ID;
  const secret = process.env.FOXIT_CLIENT_SECRET;
  const esign = "https://na1.fusion.foxit.com/esign/api/v1/folders/createfolder";

  // This one needs no credentials, because its whole point is not having any.
  // It is the boundary the product argues for, so it is checked first.
  try {
    const anonymous = await fetch(esign, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folderName: "boundary-probe" }),
    });
    const body = (await anonymous.json()) as { allow?: boolean; reason?: string };
    const refused = anonymous.status === 400 || anonymous.status === 401;
    record(
      "Foxit",
      "eSign refuses an unauthenticated caller",
      refused ? "ok" : "fail",
      `HTTP ${anonymous.status}: ${body.reason ?? "(no reason given)"}`,
    );
  } catch (error) {
    record("Foxit", "eSign refuses an unauthenticated caller", "fail", message(error));
  }

  if (!id || !secret) {
    record("Foxit", "eSign accepts the server", "skip", "FOXIT_CLIENT_ID/SECRET not set");
    return;
  }

  try {
    const authed = await fetch(esign, {
      method: "POST",
      headers: { client_id: id, client_secret: secret, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    // The legacy surface answers 200 with an error in the body, so the status
    // alone cannot be trusted here — a validation complaint means we are past
    // authentication, which is what this check is for.
    const body = (await authed.json()) as { result?: string; error_description?: string };
    const pastAuth =
      body.error_description !== undefined && !/credential/i.test(body.error_description);
    record(
      "Foxit",
      "eSign accepts the server",
      pastAuth ? "ok" : "fail",
      `HTTP ${authed.status}: ${body.error_description ?? body.result ?? "?"}`,
    );
  } catch (error) {
    record("Foxit", "eSign accepts the server", "fail", message(error));
  }
}

/* ---------------------------------------------------------------- name.com */

async function checkNameCom(): Promise<void> {
  const user = process.env.NAMECOM_USERNAME;
  const token = process.env.NAMECOM_TOKEN;
  if (!user || !token) return record("name.com", "hello", "skip", "credentials not set");

  const sandbox = process.env.NAMECOM_ENV !== "production";
  const host = sandbox ? "https://api.dev.name.com" : "https://api.name.com";
  const username = sandbox && !user.endsWith("-test") ? `${user}-test` : user;

  try {
    const response = await fetch(`${host}/core/v1/hello`, {
      headers: { authorization: `Basic ${btoa(`${username}:${token}`)}` },
    });
    if (!response.ok) {
      record("name.com", "hello", "fail", `HTTP ${response.status} as ${username} on ${host}`);
      return;
    }
    const body = (await response.json()) as { username?: string; serverName?: string };
    record("name.com", "hello", "ok", `${body.username ?? "?"} on ${body.serverName ?? host}`);
  } catch (error) {
    record("name.com", "hello", "fail", message(error));
  }
}

/* --------------------------------------------------------------------- DNS */

async function checkDns(): Promise<void> {
  try {
    const { value, ms } = await timed(async () =>
      fetch("https://cloudflare-dns.com/dns-query?name=_writ.example.com&type=TXT", {
        headers: { accept: "application/dns-json" },
      }),
    );
    const body = (await value.json()) as { AD?: boolean; Status?: number };
    record(
      "DNS",
      "DoH resolution with DNSSEC flag",
      value.ok ? "ok" : "fail",
      `${ms}ms, AD=${body.AD === true}, status ${body.Status}`,
    );
  } catch (error) {
    record("DNS", "DoH resolution with DNSSEC flag", "fail", message(error));
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<number> {
  process.stdout.write("\nChancery integration smoke test — live calls only\n\n");

  await checkDns();
  await checkVenice();
  await checkNutrient();
  await checkSerpApi();
  await checkFoxit();
  await checkNameCom();

  const failed = checks.filter((c) => c.status === "fail").length;
  const skipped = checks.filter((c) => c.status === "skip").length;
  const passed = checks.filter((c) => c.status === "ok").length;

  process.stdout.write(`\n  ${passed} live, ${failed} failed, ${skipped} skipped for want of a credential\n`);
  if (skipped > 0) {
    process.stdout.write("  A skipped check is not a passing one.\n");
  }
  process.stdout.write("\n");
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${message(error)}\n`);
    process.exit(2);
  });

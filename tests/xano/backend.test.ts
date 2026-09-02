/**
 * Structural checks on the XanoScript backend.
 *
 * We cannot run XanoScript here — there is no instance, and the Developer MCP's
 * validator is a separate tool — so this suite does not claim the stacks
 * execute. What it does claim is the set of properties that a deploy would
 * otherwise let rot silently: that the multidoc is not stale relative to the
 * source tree, that every definition is reachable and uniquely named, that the
 * ledger's schema still holds the columns the hash chain depends on, that no
 * secret has been pasted into a stack, and that the security posture the README
 * asserts to a judge is actually present in the files.
 *
 * The most valuable one is the drift check. `multidoc.xs` is what gets pushed;
 * the tree is what gets read and reviewed. A repository where those two disagree
 * ships something nobody read.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { MANIFEST, SEPARATOR, XANO_DIR, buildMultidoc } from "../../scripts/xano-push";

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".xs")) continue;
      if (entry.name === "multidoc.xs") continue;
      found.push(relative(XANO_DIR, full).split(sep).join("/"));
    }
  };
  walk(XANO_DIR);
  return found.sort();
}

const FILES = sourceFiles();
const SOURCES = new Map(FILES.map((file) => [file, readFileSync(join(XANO_DIR, file), "utf8")]));

function read(file: string): string {
  const source = SOURCES.get(file);
  if (source === undefined) throw new Error(`missing ${file}`);
  return source;
}

/** Strip `//` comments so prose about a rule is never mistaken for the rule. */
function code(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

describe("the multidoc", () => {
  it("lists every source file exactly once", () => {
    expect([...MANIFEST].sort()).toEqual(FILES);
    expect(new Set(MANIFEST).size).toBe(MANIFEST.length);
  });

  it("is not stale relative to the tree", () => {
    // The committed multidoc is what gets pushed. If it drifts from the source
    // files, the workspace runs something nobody reviewed.
    const committed = readFileSync(join(XANO_DIR, "multidoc.xs"), "utf8");
    expect(committed).toBe(buildMultidoc());
  });

  it("separates definitions with `---` alone on its own line", () => {
    const multidoc = buildMultidoc();
    const separators = multidoc.split("\n").filter((line) => line === SEPARATOR);
    expect(separators).toHaveLength(MANIFEST.length - 1);
    // A separator with trailing whitespace is not a separator, and the failure
    // is a parse error hundreds of lines later.
    expect(multidoc).not.toMatch(/^---[ \t]+$/m);
  });

  it("applies tables before anything that queries them, and tasks last", () => {
    const kindOf = (path: string) => path.split("/")[0];
    const order = MANIFEST.map(kindOf);
    const lastTable = order.lastIndexOf("table");
    const firstNonTable = order.findIndex((kind) => kind !== "table");
    expect(lastTable).toBeLessThan(firstNonTable === -1 ? Infinity : firstNonTable);
    expect(order.at(-1)).toBe("task");
  });
});

describe("declarations", () => {
  const DECLARATION =
    /^(table|query|function|middleware|task|table_trigger|apigroup)\s+(\S+)/gm;

  it("gives every object a unique (kind, name)", () => {
    const seen = new Set<string>();
    for (const [file, source] of SOURCES) {
      for (const match of code(source).matchAll(DECLARATION)) {
        // A query is keyed by name AND verb: `writ` is a POST and
        // `writ/{writ_uid}` is both a GET and a PATCH.
        const verb = /verb=([A-Z]+)/.exec(source)?.[1] ?? "";
        const key = `${match[1]} ${match[2]} ${verb}`;
        expect(seen.has(key), `${key} declared twice (${file})`).toBe(false);
        seen.add(key);
      }
    }
  });

  it("declares exactly one object per file", () => {
    for (const [file, source] of SOURCES) {
      expect([...code(source).matchAll(DECLARATION)], file).toHaveLength(1);
    }
  });

  it("declares every table the domain needs", () => {
    const tables = FILES.filter((file) => file.startsWith("table/")).map((file) =>
      /^table\s+(\w+)/m.exec(code(read(file)))?.[1],
    );
    expect(tables).toEqual(
      expect.arrayContaining([
        "principal",
        "agent",
        "writ",
        "clause",
        "act",
        "receipt",
        "diligence",
        "ledger",
      ]),
    );
  });
});

describe("the ledger schema", () => {
  const ledger = code(read("table/ledger.xs"));

  it("holds every column the hash chain is computed from", () => {
    for (const column of ["sequence", "previous_hash", "hash", "kind", "at", "payload"]) {
      expect(ledger, `ledger is missing ${column}`).toContain(column);
    }
  });

  it("keeps `at` as text, because that exact string is inside the hash", () => {
    // A `timestamp` column would reformat it and every earlier entry would stop
    // verifying. This is the single most fragile line in the whole schema.
    expect(ledger).toMatch(/^\s*text at\s*$/m);
    expect(ledger).not.toMatch(/timestamp\s+at\b/);
  });

  it("makes the sequence unique, which is what stops the chain forking", () => {
    expect(ledger).toMatch(/unique".*\{name:\s*"sequence"/s);
  });

  it("enumerates exactly the ledger kinds the domain defines", () => {
    for (const kind of [
      "writ.issued",
      "writ.anchored",
      "writ.revoked",
      "act.requested",
      "act.decided",
      "act.executed",
      "act.failed",
    ]) {
      expect(ledger).toContain(`"${kind}"`);
    }
  });

  it("is written to by one function and no endpoint", () => {
    const writers = [...SOURCES.entries()].filter(
      ([file, source]) => /db\.(add|edit|patch|delete)\s+ledger\b/.test(code(source)) && file !== "function/ledger_append.xs",
    );
    expect(writers.map(([file]) => file)).toEqual([]);
  });
});

describe("security posture", () => {
  it("keeps every secret in an environment variable", () => {
    for (const [file, source] of SOURCES) {
      const body = code(source);
      // Anything that looks like a pasted credential.
      expect(body, `${file} looks like it contains a literal secret`).not.toMatch(
        /(sk_live|sk_test|Bearer\s+[A-Za-z0-9._-]{20,}|AKIA[0-9A-Z]{16})/,
      );
    }
  });

  it("references secrets only through {{ $env.X }}", () => {
    const secretish = /(SECRET|TOKEN|API_KEY|BASIC_AUTH)/;
    for (const [file, source] of SOURCES) {
      for (const line of code(source).split("\n")) {
        if (!secretish.test(line)) continue;
        // Column names that merely NAME an env var are fine; a value is not.
        if (/secret_env/.test(line)) continue;
        expect(line.includes("{{ $env."), `${file}: ${line.trim()}`).toBe(true);
      }
    }
  });

  it("never pairs a wildcard origin with credentials", () => {
    for (const file of FILES.filter((name) => name.endsWith("_group.xs"))) {
      const body = code(read(file));
      const wildcard = /origins\s*=\s*\[[^\]]*"\*"/.test(body);
      const credentials = /credentials\s*=\s*true/.test(body);
      expect(wildcard && credentials, `${file} allows any origin WITH credentials`).toBe(false);
    }
  });

  it("keeps swagger off the authenticated and webhook groups", () => {
    expect(code(read("api/chancery/_group.xs"))).toMatch(/swagger\s*=\s*"private"/);
    expect(code(read("api/auth/_group.xs"))).toMatch(/swagger\s*=\s*"private"/);
    expect(code(read("api/webhook/_group.xs"))).toMatch(/swagger\s*=\s*"disabled"/);
  });

  it("applies centralised auth and audit middleware to the authenticated group", () => {
    const group = code(read("api/chancery/_group.xs"));
    expect(group).toMatch(/middleware\s*=\s*\[[^\]]*"require_auth"/);
    expect(group).toMatch(/middleware\s*=\s*\[[^\]]*"audit_mutation"/);
    expect(group).toMatch(/authentication\s*=\s*\{\s*table\s*=\s*"principal"/);
  });

  it("audits every group that accepts a mutation", () => {
    for (const file of FILES.filter((name) => name.endsWith("_group.xs"))) {
      const body = code(read(file));
      const mutates = /"(POST|PATCH|PUT|DELETE)"/.test(body);
      if (!mutates) continue;
      expect(body, `${file} accepts writes without audit middleware`).toMatch(
        /middleware\s*=\s*\[[^\]]*"audit_mutation"/,
      );
    }
  });

  it("scopes every writ-addressed endpoint through the ownership check", () => {
    // Xano names the most common application-level mistake as trusting an id
    // from the request. `writ_owned` is the single place that check lives, so an
    // endpoint that takes a writ uid and does not call it is the bug.
    const addressed = FILES.filter(
      (file) => file.startsWith("api/chancery/") && /input\s*\{[^}]*writ_uid/s.test(read(file)),
    );
    expect(addressed.length).toBeGreaterThan(0);
    for (const file of addressed) {
      expect(code(read(file)), `${file} takes a writ uid without scoping it`).toContain(
        "function.writ_owned",
      );
    }
  });

  it("rate limits both credential endpoints", () => {
    for (const file of ["api/auth/signup.xs", "api/auth/login.xs"]) {
      expect(code(read(file)), file).toContain("security.rate_limit");
    }
  });

  it("gives login the same answer for both failure modes", () => {
    // Distinguishing them turns the endpoint into a membership oracle over the
    // customer list.
    const login = code(read("api/auth/login.xs"));
    expect([...login.matchAll(/error\s*=\s*"Invalid credentials\."/g)]).toHaveLength(2);
  });

  it("exposes no policy, principal or payload from the public group", () => {
    for (const file of FILES.filter((name) => name.startsWith("api/public/"))) {
      if (file.endsWith("receipt_get.xs")) continue; // a receipt is published on purpose
      const body = code(read(file));
      expect(body, `${file} leaks a policy`).not.toMatch(/\bpolicy\b/);
      expect(body, `${file} leaks a ledger payload`).not.toMatch(/payload:/);
    }
  });
});

describe("the non-CRUD primitives", () => {
  it("has a table trigger on act insert that does not write the chain", () => {
    const trigger = code(read("trigger/act_recorded.xs"));
    expect(trigger).toMatch(/table\s*=\s*"act"/);
    expect(trigger).toMatch(/actions\s*=\s*\[\s*"insert"/);
    // The chain has one writer; a trigger appending inside another statement's
    // transaction could leave a gap or an entry for an act that rolled back.
    expect(trigger).not.toContain("function.ledger_append");
    expect(trigger).toContain("function.job_enqueue");
  });

  it("schedules every task in seconds, never as cron", () => {
    for (const file of FILES.filter((name) => name.startsWith("task/"))) {
      const schedule = /schedule\s*=\s*\[\{([^}]*)\}\]/.exec(code(read(file)))?.[1];
      expect(schedule, file).toBeDefined();
      const freq = /freq:\s*(\d+)/.exec(schedule ?? "")?.[1];
      // `freq: "0 * * * *"` schedules a task every zero seconds.
      expect(freq, `${file} does not set freq to a number of seconds`).toBeDefined();
      expect(Number(freq)).toBeGreaterThan(0);
    }
  });

  it("implements the whole job-retry surface, backoff and dead letter included", () => {
    for (const fn of ["job_enqueue", "job_claim", "job_complete", "job_fail"]) {
      expect(FILES).toContain(`function/${fn}.xs`);
    }
    const fail = code(read("function/job_fail.xs"));
    expect(fail).toContain("job_dead_letter");
    expect(fail).toMatch(/2\|pow:\$attempts/);
    // Full jitter: without it an outage synchronises every retry onto one instant.
    expect(fail).toContain("security.random_number");
  });

  it("leases jobs rather than handing them over, and reaps abandoned leases", () => {
    expect(code(read("function/job_claim.xs"))).toContain("claim_token");
    expect(code(read("function/job_complete.xs"))).toContain("$job.claim_token == $input.claim_token");
    expect(FILES).toContain("task/reap_stale_claims.xs");
  });

  it("verifies webhooks per source, over raw bytes, in constant time", () => {
    const verify = code(read("function/webhook_verify.xs"));
    expect(verify).toContain("raw_body");
    expect(verify).toContain("timingSafeEqual");
    expect(verify).toContain("createHmac");
    expect(verify).toContain("tolerance_seconds");
  });

  it("acknowledges the webhook before it processes it", () => {
    // Cameron Booth's rule, and the opposite of the synchronous pattern on
    // Xano's own webhooks documentation page.
    const inbox = code(read("api/webhook/esign.xs"));
    expect(inbox).toContain("function.job_enqueue");
    expect(inbox).toMatch(/response\s*=\s*\{\s*received:\s*true/);
    // Nothing expensive may run inside the provider's request.
    expect(inbox).not.toContain("api.request");
    // Every delivery is persisted, verified or not.
    expect(inbox).toContain("db.add webhook_request");
    expect(inbox).toContain('status: "replayed"');
  });

  it("computes the chain hash with the same canonical form as the TypeScript", () => {
    const append = code(read("function/ledger_append.xs"));
    expect(append).toContain("Object.keys(value).sort()");
    expect(append).toContain("Object.is(value, -0)");
    expect(append).toContain("createHash('sha256')");
    // The sequence is inside the hash, so an entry cannot be moved.
    expect(append).toMatch(/sequence:\s*\$var\.sequence/);
    // The tail is locked, or two appends fork the chain.
    expect(append).toMatch(/lock\s*=\s*"update"/);
  });
});

describe("endpoint coverage of the WritStore port", () => {
  const queries = new Map<string, string>();
  for (const [file, source] of SOURCES) {
    const match = /^query\s+(\S+)\s+verb=([A-Z]+)/m.exec(code(source));
    if (match !== null) queries.set(`${match[2]} ${match[1]}`, file);
  }

  it("is exactly the endpoints a consumer needs — no more, no fewer", () => {
    // Both directions on purpose. Missing one breaks the client; having a spare
    // one is the "delete endpoints no consumer uses" checklist item, and an
    // endpoint nobody calls is an endpoint nobody is watching.
    expect([...queries.keys()].sort()).toEqual(
      [
        "POST auth/signup",
        "POST auth/login",
        "GET me",
        "POST writ",
        "GET writ/{writ_uid}",
        "GET writ/by_domain",
        "PATCH writ/{writ_uid}",
        "GET writ/{writ_uid}/act",
        "POST writ/{writ_uid}/act",
        "POST ledger",
        "GET ledger",
        "POST evidence",
        "GET verify",
        "GET ledger/spine",
        "GET receipt/{digest}",
        "POST esign",
      ].sort(),
    );
  });

  it("has no endpoint that reads a table without assembling a domain object", () => {
    // The thin-wrapper failure mode: returning a raw row with integer foreign
    // keys instead of the instrument.
    const raw = [...SOURCES.entries()].filter(
      ([file, source]) =>
        file.startsWith("api/chancery/") &&
        /response\s*=\s*\$(writ|rows|clauses)\b/.test(code(source)),
    );
    expect(raw.map(([file]) => file)).toEqual([]);
  });
});

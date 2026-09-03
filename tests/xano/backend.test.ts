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

import { MANIFEST, SEPARATOR, XANO_DIR, buildMultidoc, manifestFor } from "../../scripts/xano-push";

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
    // files, the workspace runs something nobody reviewed. It is the FREE-tier
    // selection, because that is the one that actually deploys.
    const committed = readFileSync(join(XANO_DIR, "multidoc.xs"), "utf8");
    expect(committed).toBe(buildMultidoc(XANO_DIR, manifestFor(false)));
  });

  it("excludes the definitions the free plan refuses", () => {
    // Middleware, triggers and tasks each fail the WHOLE multidoc with a 400 on
    // the free plan, so one of them slipping into the default selection lands
    // nothing at all. Learned the hard way; asserted so it stays learned.
    const free = manifestFor(false);
    expect(free.some((path) => path.startsWith("middleware/"))).toBe(false);
    expect(free.some((path) => path.startsWith("trigger/"))).toBe(false);
    expect(free.some((path) => path.startsWith("task/"))).toBe(false);
    expect(manifestFor(true)).toEqual(MANIFEST);
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
    /^(table|query|function|middleware|task|table_trigger|api_group)\s+(\S+)/gm;

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

  it("references secrets only through $env", () => {
    // `$env.NAME`, not `{{ $env.NAME }}` — the mustache form is the CLI's
    // environment-file syntax, not XanoScript's, and it resolves to a literal
    // string at runtime rather than to the secret.
    const secretish = /(SECRET|API_KEY|BASIC_AUTH)/;
    for (const [file, source] of SOURCES) {
      for (const line of code(source).split("\n")) {
        if (!secretish.test(line)) continue;
        // Column names and comments that merely NAME an env var are fine.
        if (/secret_env|values = /.test(line)) continue;
        expect(line.includes("$env."), `${file}: ${line.trim()}`).toBe(true);
        expect(line.includes("{{"), `${file} uses the mustache form: ${line.trim()}`).toBe(false);
      }
    }
  });

  it("gives every API group an instance-unique canonical", () => {
    // `canonical` routes between WORKSPACES on the instance, not just within
    // ours, so a bare `auth` or `public` is a collision waiting to happen.
    const canonicals = FILES.filter((name) => name.endsWith("api_group.xs")).map(
      (file) => /canonical\s*=\s*"([^"]+)"/.exec(code(read(file)))?.[1],
    );
    expect(canonicals).toHaveLength(4);
    for (const canonical of canonicals) {
      expect(canonical, "every canonical must be namespaced").toMatch(/^chancery/);
    }
    expect(new Set(canonicals).size).toBe(canonicals.length);
  });

  it("requires a token on every endpoint in the authenticated group", () => {
    // Middleware is Essential-only, so the group cannot carry the requirement.
    // Each endpoint declares it instead, and the point of the group existing is
    // that this holds for ALL of its members with no exception to remember.
    const endpoints = FILES.filter(
      (file) => file.startsWith("api/chancery/") && !file.endsWith("api_group.xs"),
    );
    expect(endpoints.length).toBeGreaterThan(0);
    for (const file of endpoints) {
      expect(code(read(file)), `${file} is reachable without a token`).toMatch(
        /auth\s*=\s*"principal"/,
      );
    }
  });

  it("leaves the public and webhook groups with no auth, and no writes in public", () => {
    const endpoints = FILES.filter(
      (name) => name.startsWith("api/public/") && !name.endsWith("api_group.xs"),
    );
    expect(endpoints).toHaveLength(3);
    for (const file of endpoints) {
      const body = code(read(file));
      expect(body, `${file} should be unauthenticated`).not.toMatch(/auth\s*=\s*"/);
      expect(body, `${file} must be read-only`).toMatch(/verb=GET/);
      expect(body, `${file} must not write`).not.toMatch(/db\.(add|edit|patch|del)\b/);
    }
  });

  it("audits every mutating endpoint explicitly", () => {
    // What `audit_mutation` would do if middleware were available on this plan.
    const mutating = FILES.filter(
      (file) => file.startsWith("api/") && /verb=(POST|PATCH|PUT|DELETE)/.test(read(file)),
    );
    expect(mutating.length).toBeGreaterThan(0);
    // Two endpoints are exempt because their own write IS the durable record of
    // the call, and a second row would be noise on the two hottest paths:
    // `POST /ledger` appends a hash-chained entry, and the webhook inbox
    // persists every delivery into `webhook_request` before it does anything.
    const selfRecording = ["api/chancery/ledger_append.xs", "api/webhook/esign.xs"];
    for (const file of mutating) {
      if (selfRecording.includes(file)) continue;
      expect(code(read(file)), `${file} mutates without an audit row`).toContain(
        'function.run "audit_append"',
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
        'function.run "writ_owned"',
      );
    }
  });

  it("rate limits both credential endpoints", () => {
    // `redis.ratelimit` is Essential-only, so this is the audit-table throttle.
    for (const file of ["api/auth/signup.xs", "api/auth/login.xs"]) {
      expect(code(read(file)), file).toContain('function.run "rate_guard"');
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
    expect(trigger).toMatch(/actions\s*=\s*\{insert:\s*true/);
    // The chain has one writer; a trigger appending inside another statement's
    // transaction could leave a gap or an entry for an act that rolled back.
    expect(trigger).not.toContain('function.run "ledger_append"');
    expect(trigger).toContain('function.run "job_enqueue"');
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

  it("verifies webhooks per source, over a canonical body, in constant time", () => {
    const verify = code(read("function/webhook_verify.xs"));
    // XanoScript exposes no raw request body, so the signature base is the
    // canonical form of the parsed payload. The header comment says so at
    // length; this asserts the compromise has not silently been forgotten.
    expect(verify).toContain("canon($input.body)");
    expect(verify).toContain("timingSafeEqual");
    expect(verify).toContain("createHmac");
    expect(verify).toContain("tolerance_seconds");
  });

  it("acknowledges the webhook before it processes it", () => {
    // Cameron Booth's rule, and the opposite of the synchronous pattern on
    // Xano's own webhooks documentation page.
    const inbox = code(read("api/webhook/esign.xs"));
    expect(inbox).toContain('function.run "job_enqueue"');
    expect(inbox).toMatch(/response\s*=\s*\{\s*received:\s*true/);
    // Nothing expensive may run inside the provider's request.
    expect(inbox).not.toContain("api.request");
    // Every delivery is persisted, verified or not.
    expect(inbox).toContain('db.add "webhook_request"');
    expect(inbox).toContain('status: "replayed"');
  });

  it("computes the chain hash with the same canonical form as the TypeScript", () => {
    const append = code(read("function/ledger_append.xs"));
    expect(append).toContain("Object.keys(value).sort()");
    expect(append).toContain("Object.is(value, -0)");
    expect(append).toContain("createHash('sha256')");
    // The sequence is inside the hash, so an entry cannot be moved.
    expect(append).toMatch(/sequence:\s*\$var\.sequence/);
    // The tail is locked, or two appends fork the chain. `lock` is a BOOLEAN —
    // `lock = "update"` parses and then fails at runtime with
    // `Invalid boolean input` naming `param: lock`.
    expect(append).toMatch(/lock\s*=\s*true/);
  });
});

/**
 * Grammar rules that cost real push cycles to discover. Every one of these
 * parses OR fails in a way that is hard to attribute, so they are asserted over
 * the source rather than left to be rediscovered.
 */
describe("XanoScript grammar invariants", () => {
  it("has no comment inside any array literal", () => {
    // `// ...` inside `[ ... ]` fails the whole multidoc with
    // "Invalid kind. Expecting static:object[], got assign:expr".
    for (const [file, source] of SOURCES) {
      let depth = 0;
      source.split("\n").forEach((line, i) => {
        if (line.trimStart().startsWith("//")) {
          expect(depth, `${file}:${i + 1} comments inside an array literal`).toBe(0);
          return;
        }
        let quote: string | null = null;
        for (const ch of line) {
          if (quote !== null) {
            if (ch === quote) quote = null;
            continue;
          }
          if (ch === '"' || ch === "'" || ch === "`") quote = ch;
          else if (ch === "[") depth += 1;
          else if (ch === "]") depth -= 1;
        }
      });
    }
  });

  it("never uses the `default` filter, which does not exist at runtime", () => {
    // It PARSES. It then fails with "Unable to locate func entry: default" the
    // first time the endpoint is actually called — which is the trap: the push
    // is green and the bug ships.
    for (const [file, source] of SOURCES) {
      expect(code(source), `${file} uses |default:`).not.toContain("|default:");
    }
  });

  it("never uses add_secs_to_timestamp, which also does not exist at runtime", () => {
    for (const [file, source] of SOURCES) {
      expect(code(source), file).not.toContain("add_secs_to_timestamp");
    }
  });

  it("keeps every block assignment on its own line", () => {
    // Two assignments on one line is `Syntax error: unexpected newline`, pointed
    // at the enclosing declaration rather than at the offending line.
    const assignment = /\b[a-z_]+ = /g;
    for (const [file, source] of SOURCES) {
      for (const [i, line] of code(source).split("\n").entries()) {
        // Object literals and `where` expressions legitimately contain `=`.
        if (/[{[]/.test(line) || line.includes("==") || line.includes("=>")) continue;
        const count = [...line.matchAll(assignment)].length;
        expect(count, `${file}:${i + 1} has ${count} assignments: ${line.trim()}`).toBeLessThan(2);
      }
    }
  });

  it("gives every function and query an input block", () => {
    // A `function` without one fails with "Missing block: input", even when it
    // takes no arguments.
    for (const [file, source] of SOURCES) {
      const body = code(source);
      if (!/^(function|query)\s/m.test(body)) continue;
      expect(body, `${file} has no input block`).toMatch(/^\s*input \{/m);
    }
  });

  it("keeps the lambda bodies foldable to a single line", () => {
    // XanoScript has no multi-line string. `scripts/xano-push.ts` folds these at
    // assembly time; the fold only works on a ``` code = ` ``` block that opens
    // and closes on its own lines.
    for (const [file, source] of SOURCES) {
      const opens = [...source.matchAll(/^[ \t]*code = `$/gm)].length;
      const total = [...source.matchAll(/^[ \t]*code = /gm)].length;
      expect(opens, `${file} has a lambda the folder cannot handle`).toBe(total);
    }
  });
});

describe("endpoint coverage of the WritStore port", () => {
  const queries = new Map<string, string>();
  for (const [file, source] of SOURCES) {
    const match = /^query\s+"([^"]+)"\s+verb=([A-Z]+)/m.exec(code(source));
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
        "GET writ_by_domain",
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

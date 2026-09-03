# Chancery on Xano

Xano is Chancery's backend of record: the writ registry, the act history, the
published receipts, and the append-only hash chain that every approval **and
every refusal** is written to.

The SaaS tool we are rebuilding is the **approval portal** — the procurement
queue where a human rubber-stamps requests one at a time with no context and no
memory. Chancery inverts it. The human signs one scoped instrument up front; the
machine then decides every subsequent irreversible act against that document and
cites the clause it decided under. This workspace is where the instrument, the
decisions and the evidence live.

**Status: deployed and exercised.** All 45 free-tier definitions push green in
one Metadata API request, and `scripts/xano-smoke.ts` drives the whole surface
end to end through the real TypeScript client.

## Live base URLs

Instance `x8ki-letl-twmt.n7.xano.io`, workspace `168167`. Each API group gets its
own base, keyed by the group's `canonical`.

| Group | Base URL | Auth |
|---|---|---|
| `auth` | `https://x8ki-letl-twmt.n7.xano.io/api:chancery-auth` | none |
| `chancery` | `https://x8ki-letl-twmt.n7.xano.io/api:chancery` | JWT, every endpoint |
| `public` | `https://x8ki-letl-twmt.n7.xano.io/api:chancery-verify` | none, read-only |
| `webhook` | `https://x8ki-letl-twmt.n7.xano.io/api:chancery-hook` | HMAC |

---

## What is in here

51 XanoScript definitions in `xano/**`, concatenated into `multidoc.xs` so the
backend pushes in one request. 45 deploy on the free plan; 6 are gated behind a
paid plan (see below) and are excluded from the default push.

### Tables (13)

| Table | What it holds |
|---|---|
| `principal` | The human who signs. The auth table. |
| `agent` | The machine authority is delegated to, keyed publicly by its DNS name. |
| `writ` | The instrument, its lifecycle status, and the policy extracted from the signed PDF. |
| `clause` | One grant as printed in the document — the clause reference a refusal cites. |
| `act` | Every irreversible act **asked for**, allowed or refused. |
| `receipt` | Published evidence bundles, content-addressed. |
| `diligence` | Live-world checks with the sources their verdicts came from. |
| `ledger` | The hash chain. Unique on `sequence`, one writer only. |
| `audit` | Access log for mutating calls. Deliberately not the ledger. |
| `job` | `job-retry`: the durable queue. |
| `job_dead_letter` | `job-retry`: the dead-letter tier. |
| `webhook_source` | `webhook-inbox`: one row per system allowed to call in. |
| `webhook_request` | `webhook-inbox`: every delivery, verified or not. |

### Endpoints (16)

**`auth`** — `POST auth/signup` · `POST auth/login`

**`chancery`** — every one declares `auth = "principal"`:
`GET me` · `POST writ` · `GET writ/{writ_uid}` · `GET writ_by_domain` ·
`PATCH writ/{writ_uid}` · `GET writ/{writ_uid}/act` · `POST writ/{writ_uid}/act` ·
`POST ledger` · `GET ledger` · `POST evidence`

**`public`** — `GET verify` · `GET ledger/spine` · `GET receipt/{digest}`

**`webhook`** — `POST esign`

### Functions (12)

`ledger_append` · `writ_assemble` · `writ_owned` · `audit_append` · `rate_guard` ·
`job_enqueue` · `job_claim` · `job_complete` · `job_fail` · `webhook_verify` ·
`act_execute` · `webhook_esign_process`

### Paid-tier only (6) — in the repo, not in the free push

`middleware/require_auth` · `middleware/audit_mutation` ·
`trigger/act_recorded` · `task/sweep_expired_writs` · `task/drain_job_queue` ·
`task/reap_stale_claims`

---

## 🔴 What the free plan actually refuses

The Metadata API rejects these with a **400 on the whole multidoc** — not a
skipped definition, the entire push lands nothing:

| Definition | Verbatim error |
|---|---|
| `middleware` | `Please upgrade to access middleware.` |
| `table_trigger` | `Triggers are only available on paid packages.` |
| `task` | `Please upgrade to access tasks.` |
| `redis.*` | Redis is Essential-only, so `redis.ratelimit` is unavailable |

None of this is on the pricing page's feature comparison. Every one of them was
discovered by pushing.

**How the free-tier deployment covers each:**

- **`require_auth`** → `auth = "principal"` is declared on every endpoint in the
  `chancery` group, and a test asserts it holds for all of them. Row scoping is
  `writ_owned`, which is the check that actually matters.
- **`audit_mutation`** → every mutating endpoint calls
  `function.run "audit_append"` as its first statement. A test asserts it.
- **`act_recorded` trigger** → the trigger only maintained derived counters and
  queued execution. Nothing in the decision path reads those counters, so on
  free they stay at zero and the gate is unaffected.
- **`redis.ratelimit`** → `rate_guard` counts recent `audit` rows for one path
  and IP. Weaker than an atomic counter by exactly one race, irrelevant against
  credential harvesting, and it works with no new infrastructure.

---

## The parts that are not CRUD

**The hash chain is assigned server-side and verified client-side, and this is
now proven against the live instance.** `ledger_append` takes the tail under a
row lock inside a transaction, allocates the sequence and previous hash, and
computes the entry hash in a lambda implementing the same RFC 8785 canonical
form as `src/lib/core/canonical.ts`. The client re-hashes what comes back and
refuses an entry it cannot reproduce. `scripts/xano-smoke.ts` appends two
entries, reads them back, and recomputes every hash locally — they match, which
means the canonicaliser running inside Xano and the one in TypeScript agree byte
for byte.

**`job-retry`** (from `github.com/xano-community`) executes allowed acts:
enqueue / claim / complete / fail, unique idempotency key, exponential backoff
with **full jitter**, a lease with a reaper for dead workers, and a separate
dead-letter table that nothing retries out of automatically.

**`webhook-inbox`** (same org) receives the eSign completion callback:
per-source HMAC, constant-time comparison, a timestamp replay window, every
delivery persisted whether it verifies or not, and idempotent handling of the
provider's retries.

**Acknowledge first, process later.** `POST esign` persists, verifies, enqueues
and returns 200. Nothing in that stack fetches a PDF, hashes it or activates a
writ — that is `webhook_esign_process`, run by the queue worker. This follows
Cameron Booth's published rule rather than the synchronous pattern on Xano's own
webhooks documentation page.

**Background tasks use `freq` in SECONDS.** `3600`, `30`, `300` — not cron.

---

## 🔬 What we learned about XanoScript that the docs do not say

Everything below was established by pushing against the live instance. It is the
20% that turns "almost-right" into "production-ready", and it is written down
because none of it is in the published documentation.

### The parser

1. **A comment inside an array literal breaks the parse.** `// ...` anywhere
   between `[` and `]` fails with `Invalid kind. Expecting static:object[], got
   assign:expr`. Comments in the file header and inside `schema { }` and
   `stack { }` are fine. Xano's own docs mention this only for an operation's
   argument block, not for `index = [...]`.
2. **There is no multi-line string, at all.** A newline inside `"..."`,
   `'...'` or `` `...` `` is `Syntax error: unexpected newline`. This makes a
   non-trivial `api.lambda` impossible to write readably, so
   `scripts/xano-push.ts` keeps the JavaScript legible in the `.xs` source and
   folds it into a single double-quoted line with `\n` escapes at assembly time.
   Escapes that work: `\n`, `\"`, `\\`.
3. **One assignment per line.** `db.get "t" { field_name = "id" field_value = 1 }`
   fails with `Missing block: field_value`. Each key goes on its own line.
4. **Every `function` and `query` needs an `input` block**, even an empty one, or
   `Missing block: input`.
5. **Every `table` needs an `index` block**, or `Missing block: index`.
6. **`?` after the type means NULLABLE. `?` after the NAME means OPTIONAL.**
   `text? envelope_id` is a required parameter that may be null — omitting it
   from a request is `Missing param: envelope_id`. Optional-and-nullable is
   `text? envelope_id?`. This is the single most misleading piece of syntax in
   the language.
7. **The error message points at the enclosing declaration, not the line.** A
   parse failure reports `[function "x" {]` and then quotes a 32-character
   fragment. Push definitions in small batches or bisecting is miserable —
   `npx tsx scripts/xano-push.ts --push <file>` exists for exactly this.

### Statements that are not what the docs imply

8. **`var $x = 1` is not valid.** It is `var $x { value = 1 }`, and reassignment
   is `var.update $x { value = ... }`.
9. **`conditional` is a block, not an expression.** It is
   `conditional { if (…) { } elseif (…) { } else { } }` — `elseif` is one word,
   and `then` does not exist.
10. **`foreach` takes an `each as` clause**: `foreach ($list) { each as $item { … } }`.
11. **Calling a function is `function.run "name" { input = {…} } as $r`.** Not
    `function.name`, not `call`.
12. **`security.create_uuid`, not `security.uuid`.** `security.check_password`
    takes `text_password` and `hash_password` — not `password` and `hash`.
13. **`db.del`, not `db.delete`.** Paging is `return = {type: "list", paging: {…}}`
    — there is no `per_page` block. `sort` is an object (`{field: "desc"}`), not
    an array.
14. **`throw` takes `name` and `value`**, not `error_type` and `error`. Error
    types on `precondition` are `inputerror` (not `input`), `accessdenied`,
    `notfound`, `standard`.
15. **`try_catch { try { } catch { } }`** — not `try { } catch { }`.

### Things that parse and then fail at runtime

This is the dangerous category: the push is green and the bug ships.

16. **Unknown filter names parse fine.** `|default:` is in no filter table and
    fails only when the endpoint is first called, with
    `Unable to locate func entry: default`. The real filters are
    `first_notnull` / `first_notempty`. Same for `add_secs_to_timestamp`, which
    the docs list under timestamps and which does not exist at runtime.
17. **`lock` on `db.query` is a BOOLEAN.** `lock = "update"` parses and then
    fails with `Invalid boolean input` naming `param: lock`. It is `lock = true`.
18. **`now` is not a number.** Arithmetic on it is `Not numeric.`; use
    `now|to_ms`.
19. **A `where` clause is compiled to SQL and is NOT short-circuited.**
    `($input.x == null || $db.t.col > $input.x)` still binds null against the
    column and dies with `ParseError: Invalid value for param:"t.col"`. An
    optional filter has to be two `db.query` calls in a `conditional`, or a
    sentinel value resolved into a var beforehand.
20. **`function.run` requires every declared input**, including the optional
    ones, in the `input = {…}` object. Omitting one is `Missing param: x` at
    runtime.
21. **A `uuid` column rejects a non-uuid comparison with a 400**, not an empty
    result: `ParseError: Invalid value for param:"writ.uid"`.

### Routing and platform

22. **A path parameter beats a literal sibling segment.** `GET /writ/by_domain`
    resolved to `writ/{writ_uid}` with `writ_uid = "by_domain"`. There is no way
    to express precedence, so the endpoint is `writ_by_domain` instead. This one
    is silent until the wrong stack runs.
23. **`api_group` is the keyword and `api_group.xs` is the filename** — not
    `apigroup`. `canonical` must be unique across the whole **instance**, not
    the workspace, because Xano routes between workspaces on it.
24. **The group carries no CORS and no middleware list.** Groups take
    `canonical`, `description`, `active`, `tags`, `history`, and
    `swagger = {token: "…"}`. Auth is per-endpoint (`auth = "<table>"`). CORS is
    not expressible in XanoScript at all.
25. **`swagger.token` is stored in plain text and will not take `$env`** —
    `Invalid kind for token - assign:env`. So protecting Swagger from
    XanoScript means committing a credential; we set it in the UI instead.
26. **`$env.NAME` for secrets — not `{{ $env.NAME }}`.** The mustache form is
    the CLI's env-file syntax. Request context is `$env.$remote_ip`,
    `$env.$request_method`, `$env.$request_uri`, `$env.$http_headers`.
27. **There is no raw request body.** No `$http.raw_body`, no equivalent. An
    endpoint only ever sees parsed input, which means a webhook HMAC **cannot**
    be computed over the bytes as they arrived. See the limitation below.
28. **`preferences.allow_push = false` does not block the Metadata API.** That
    flag gates the CLI's sandbox-review flow only. `POST /multidoc` works on the
    free plan with the toggle off.
29. **The free tier's 10-requests-per-20-seconds cap is real and fires quickly.**
    The smoke test trips it every run at around the eleventh call. It returns a
    429 with `ERROR_CODE_TOO_MANY_REQUESTS`, which is why `XanoRateLimitError`
    carries `retryAfterMs`.

---

## 🔴 Known limitation: webhook signatures

XanoScript cannot see the raw request body (#27 above), so the HMAC in
`webhook_verify` is computed over the **RFC 8785 canonical form of the parsed
payload** — the same canonicaliser the ledger hashes with, so there is one
definition of "these bytes" in the system.

That is sound when the sender signs the same canonical form, which Chancery's
own senders do. It is **not** interoperable with a provider that signs its own
raw bytes, and for such a provider the verification has to happen at a proxy in
front of Xano. This is a platform constraint, not a design choice, and it is
stated here rather than papered over.

---

## Pre-launch security checklist

Against <https://docs.xano.com/security/pre-launch-security-checklist>. Every ✅
below is asserted by a test in `tests/xano/backend.test.ts` unless noted.

| Checklist item | Status | How |
|---|---|---|
| No auto-generated endpoints left reachable and unauthenticated | ✅ | There are none. All 16 endpoints are hand-written; none returns a table row. Reads go through `writ_assemble`, which builds the instrument from four tables. A test asserts no endpoint responds with a bare `$writ`/`$rows`. |
| Function stacks filter by `auth.id` rather than trusting IDs from the request | ✅ | `writ_owned` is the single ownership check (`uid == input && principal_id == $auth.id`) and every writ-addressed endpoint calls it — asserted by a test. `POST /writ` takes the principal from `$auth` and **the client does not send one**. `GET /ledger` scopes on `ledger.principal_id`. Another principal's writ reads as absent, not forbidden, so the API is not a membership oracle. |
| Every incoming webhook verifies its signature | ⚠️ | Yes, but over the canonical parsed body rather than raw bytes — see the limitation above. Constant-time comparison, per-source secret from `$env`, timestamp replay window, unknown source fails closed. |
| Centralised middleware for cross-cutting auth and rate-limit rules | ⚠️ | Written (`middleware/require_auth`, `middleware/audit_mutation`) but **not deployable on this plan**. The free-tier equivalent is `auth = "principal"` on every endpoint plus an explicit `audit_append` call, both asserted by tests. |
| Rate limiting on login, signup and other harvest targets | ✅ | `rate_guard` on both credential endpoints — signup 5/15min, login 10/15min, keyed on IP. Both login failure branches return the same message and status. |
| Swagger private or disabled on production API groups | ⚠️ | Set in the workspace UI. XanoScript's only control stores the token in plain text and rejects `$env`, so expressing it here would mean committing a credential. |
| Wildcard CORS replaced with an explicit list | ⚠️ | Not expressible in XanoScript; set in the workspace UI per group. |
| Endpoints not used by any consumer are deleted | ✅ | A test asserts the endpoint set is *exactly* the 16 the client and verifier call — both directions, so a spare endpoint fails the build. |
| Secrets in environment variables, no hardcoded keys | ✅ | `$env.FOXIT_WEBHOOK_SECRET`, `$env.DOCTAVIAN_WEBHOOK_SECRET`, `$env.NAMECOM_BASIC_AUTH`, `$env.CHANCERY_PUBLIC_BASE`. `webhook_source.secret_env` stores the **name** of a variable, never a value. A test greps every file for credential-shaped literals and for the wrong `{{ }}` form. |
| External Access disabled on internal-only endpoints | ✅ | All internal logic is a `function`, which is not externally reachable. |

Two more, not on the list but load-bearing:

- **The terms of a signed writ are not patchable.** `PATCH /writ/{writ_uid}`
  accepts lifecycle fields only — no grants, no dates, no principal. The client
  refuses the same fields, and refuses them again server-side.
- **A receipt's content address is recomputed, not accepted.** A caller that
  could choose its own digest could publish one bundle under the name of
  another.

---

## Environment variables

Set in Workspace Settings → Environment Variables. Referenced as `$env.NAME`.

| Variable | Used by |
|---|---|
| `CHANCERY_PUBLIC_BASE` | the receipt URL `putEvidence` returns |
| `FOXIT_WEBHOOK_SECRET` | `webhook_verify`, source `foxit-esign` |
| `DOCTAVIAN_WEBHOOK_SECRET` | `webhook_verify`, source `doctavian` |
| `NAMECOM_BASIC_AUTH` | `act_execute`, the registrar call |

`webhook_source` needs one seed row per source. Records are not part of a
multidoc; see `deploy.md`.

---

## Verifying it works

```sh
npx tsx scripts/xano-push.ts --push     # deploy
npx tsx scripts/xano-smoke.ts           # exercise it end to end
npx vitest run tests/xano               # 96 tests, no network
```

See [`deploy.md`](./deploy.md).

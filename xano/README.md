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

---

## What is in here

50 XanoScript definitions, laid out the way `xano workspace pull` scaffolds them
and concatenated into `multidoc.xs` so the whole backend pushes in one Metadata
API request.

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

### API groups (4) and endpoints (16)

**`auth`** — swagger private, no authenticated members.
`POST auth/signup` · `POST auth/login`

**`chancery`** — swagger private, JWT required, no unauthenticated members.
`GET me` · `POST writ` · `GET writ/{writ_uid}` · `GET writ/by_domain` ·
`PATCH writ/{writ_uid}` · `GET writ/{writ_uid}/act` · `POST writ/{writ_uid}/act` ·
`POST ledger` · `GET ledger` · `POST evidence`

**`public`** — swagger public, read-only, no writes and no payloads.
`GET verify` · `GET ledger/spine` · `GET receipt/{digest}`

**`webhook`** — swagger disabled, HMAC-authenticated.
`POST esign`

### Functions (11)

`ledger_append` · `writ_assemble` · `writ_owned` · `audit_append` ·
`job_enqueue` · `job_claim` · `job_complete` · `job_fail` · `webhook_verify` ·
`act_execute` · `webhook_esign_process`

### Middleware (2) · Trigger (1) · Tasks (3)

`require_auth` · `audit_mutation` — `act_recorded` (on `act` insert) —
`sweep_expired_writs` (3600s) · `drain_job_queue` (30s) · `reap_stale_claims` (300s)

---

## The parts that are not CRUD

**The hash chain is assigned server-side and verified client-side.**
`ledger_append` takes the tail under a row lock inside a transaction, allocates
the sequence and previous hash, and computes the entry hash in a lambda that
implements the same RFC 8785 canonical form as `src/lib/core/canonical.ts`. The
client re-hashes what came back and refuses an entry it cannot reproduce. A
client that picked its own position would race every other client; a server
whose hash nobody checks is not producing evidence.

**Middleware, not per-endpoint checks.** `require_auth` and `audit_mutation` are
attached to the group. A per-endpoint check is a per-endpoint chance to forget,
and the endpoint somebody adds at 3am is the one that ships unauthenticated.
Both run `exception_policy = "critical"` — a call whose audit row cannot be
written fails, because Chancery fails closed everywhere else and an unrecorded
mutation is worse than a refused one.

**A database trigger on `act` insert** queues execution for an allowed act and
maintains the consumed-budget counters on `writ`. It deliberately does **not**
append to the chain: the chain has one writer, and a trigger appending inside
another statement's transaction could leave a gap or an entry for an act that
rolled back.

**`job-retry`** (from `github.com/xano-community`) executes allowed acts:
enqueue / claim / complete / fail, unique idempotency key, exponential backoff
with **full jitter**, a lease with a reaper for dead workers, and a separate
dead-letter table that nothing retries out of automatically. An act that failed
six times with backoff is not transient, and a machine does not decide on its own
to try an irreversible thing again.

**`webhook-inbox`** (same org) receives the eSign completion callback:
per-source HMAC over the **raw bytes**, constant-time comparison, a timestamp
replay window, every delivery persisted whether it verifies or not, and
idempotent handling of the provider's retries.

**Acknowledge first, process later.** `POST esign` persists, verifies, enqueues
and returns 200. Nothing in that stack fetches a PDF, hashes it or activates a
writ — that is `webhook_esign_process`, run by `drain_job_queue`. This follows
Cameron Booth's published rule rather than the synchronous pattern on Xano's own
webhooks documentation page, because a provider gives a callback seconds before
it marks the endpoint unhealthy, and our processing time should not be bounded by
their patience.

**Background tasks use `freq` in SECONDS.** `3600`, `30`, `300` — not cron.
`freq: "0 * * * *"` schedules a task to run every zero seconds.

---

## Pre-launch security checklist

Against <https://docs.xano.com/security/pre-launch-security-checklist>.

| Checklist item | Status | How |
|---|---|---|
| No auto-generated endpoints left reachable and unauthenticated | ✅ | There are none. Every one of the 16 endpoints is hand-written; none returns a table row. Reads go through `writ_assemble`, which builds the instrument from `writ` + `principal` + `agent` + `clause`. A test asserts no endpoint responds with a bare `$writ`/`$rows`. |
| Function stacks filter by `auth.id` rather than trusting IDs from the request | ✅ | `writ_owned` is the single ownership check (`uid == input && principal_id == $auth.id`) and every writ-addressed endpoint calls it — asserted by a test. `POST /writ` takes the principal from `$auth` and **the client does not send one**. `GET /ledger` scopes on `ledger.principal_id`. A writ belonging to someone else reads as absent, not forbidden, so the API is not a membership oracle. |
| Every incoming webhook verifies its signature | ✅ | `webhook_verify`: per-source secret from `{{ $env.* }}`, HMAC over `$http.raw_body` (never the re-serialised object), `crypto.timingSafeEqual`, and a `tolerance_seconds` replay window. An unknown source resolves to no secret and fails closed. |
| Centralised middleware for cross-cutting auth and rate-limit rules | ✅ | `require_auth` + `audit_mutation` attached at the group level, `exception_policy = "critical"` on both. |
| Rate limiting on login, signup and other harvest targets | ✅ | `security.rate_limit` on both credential endpoints — signup keyed on IP (5/15min), login keyed on **email** (10/15min) so a spray from a rotating IP pool is still caught. Both failure branches of login return the same message and status. |
| Swagger private or disabled on production API groups | ✅ | `chancery` and `auth` private; `webhook` disabled. `public` is public on purpose — the point of a verifier is that strangers can use it. |
| Wildcard CORS replaced with an explicit list | ✅ | `chancery` and `auth` allowlist `{{ $env.CONSOLE_ORIGIN }}` with `credentials = true`. `webhook` has an empty origin list. `public` allows any origin on GET with `credentials = false` and nothing to steal — that combination is what makes an open list safe rather than reckless, and a test asserts no group ever pairs `"*"` with credentials. |
| Endpoints not used by any consumer are deleted | ✅ | Every endpoint maps to a `WritStore` method, the auth exchange, or the public verifier. There is no `GET /principal/{id}`, no `GET /clause`, no list-all-writs. A test asserts the endpoint set covers the port and the port covers the endpoint set. |
| Secrets in environment variables, no hardcoded keys | ✅ | `{{ $env.FOXIT_WEBHOOK_SECRET }}`, `{{ $env.DOCTAVIAN_WEBHOOK_SECRET }}`, `{{ $env.NAMECOM_BASIC_AUTH }}`, `{{ $env.CONSOLE_ORIGIN }}`, `{{ $env.CHANCERY_PUBLIC_BASE }}`. `webhook_source.secret_env` stores the **name** of a variable, never a value. A test greps every file for credential-shaped literals and for any secret-ish line that is not an `$env` reference. |
| External Access disabled on internal-only endpoints | ✅ | All internal logic is a `function`, not an endpoint — functions are not externally reachable. The four groups that are reachable are reachable because a consumer needs them. |

Two more, not on the list but load-bearing here:

- **The terms of a signed writ are not patchable.** `PATCH /writ/{writ_uid}`
  accepts lifecycle fields only — no grants, no dates, no jurisdiction, no
  principal. A product whose claim is "the machine enforces what the human
  signed" cannot expose an endpoint that edits what the human signed. The client
  refuses the same fields, and refuses them again server-side, because a
  client-side check protects nobody.
- **A receipt's content address is recomputed, not accepted.** A caller that
  could choose its own digest could publish one bundle under the name of
  another, and every citation of that address would point at the wrong evidence.

---

## Environment variables

Set in Workspace Settings → Environment Variables, or pushed with
`xano workspace push --env`. None of these has a default and none appears in any
file as a literal.

| Variable | Used by |
|---|---|
| `CONSOLE_ORIGIN` | CORS allowlist for `chancery` and `auth` |
| `CHANCERY_PUBLIC_BASE` | The receipt URL `putEvidence` returns |
| `FOXIT_WEBHOOK_SECRET` | `webhook_verify`, source `foxit-esign` |
| `DOCTAVIAN_WEBHOOK_SECRET` | `webhook_verify`, source `doctavian` |
| `NAMECOM_BASIC_AUTH` | `act_execute`, the registrar call |

`webhook_source` needs one seed row per source (`slug`, `signature_header`,
`delivery_id_header`, `timestamp_header`, `tolerance_seconds`). Records are not
part of the multidoc; see `deploy.md`.

---

## What we have not verified

We have no instance yet, so nothing here has been executed. Stated plainly
because a checklist that quietly includes unverified claims is worse than a
shorter one.

- **XanoScript syntax is unvalidated.** It is written to the shapes in Xano's
  documentation, but no `validate_xanoscript` run and no push has happened. Some
  filter and block names (`security.rate_limit`, `security.random_number`,
  `to_iso8601`, `lock = "update|skip_locked"`, the `apigroup` block, `$http`,
  `$request`, `$new`) are used as documented or as reasonably inferred and will
  need a first-push pass.
- **The `api.request` response envelope shape is undocumented** (`$vendor.result`
  vs `$vendor.response` vs flat). `act_execute` assumes `$vendor.response`;
  resolve it empirically on the first live call.
- **Route precedence between `writ/by_domain` and `writ/{writ_uid}`** is
  assumed to favour the literal segment. Confirm after the first push; if it
  does not, `by_domain` moves to its own prefix.
- **`$env` cannot be indexed by a runtime string**, so `webhook_verify` switches
  on the source slug to reach a literal `{{ $env.X }}`. Adding a source means
  editing that stack, deliberately.
- **The test suite covers the TypeScript client and the structure of these
  files, not their execution.** `tests/xano/backend.test.ts` checks drift,
  uniqueness, the ledger schema, and the security posture asserted above; it
  cannot check that a stack runs.

---

## Deploying

See [`deploy.md`](./deploy.md). The short version: **"Allow Direct Workspace
Push" must be enabled in Workspace Settings**, or every deploy on a paid plan
needs a manual click in the UI.

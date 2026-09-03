# Deploying the Chancery backend

The whole workspace is one Metadata API request. `multidoc.xs` is 45 definitions
concatenated with `---` on its own line between them, in dependency order.

**This is verified working**, against instance `x8ki-letl-twmt.n7.xano.io`,
workspace `168167`, on the **free plan**.

---

## ✅ "Allow Direct Workspace Push" does NOT gate the Metadata API

This is the finding that saved the deploy, and it contradicts what the plan
comparison implies.

`preferences.allow_push` on this workspace is **`false`**, and
`POST /workspace/{id}/multidoc` works anyway. That flag gates the **CLI's**
sandbox-review flow — `xano workspace push` routing through `xano sandbox push`
+ a "Review & Push" click in the UI. It has no bearing on the HTTP Metadata API.

**So we do not need a paid plan to deploy, and we do not need to flip that
toggle.** If you use the CLI instead of this script, you do need it; that is the
only reason to care.

---

## The command

```sh
# Assemble multidoc.xs from the source tree. Writes the file, pushes nothing.
npx tsx scripts/xano-push.ts

# Show what would be sent, and where.
npx tsx scripts/xano-push.ts --push --dry-run

# Deploy.
npx tsx scripts/xano-push.ts --push

# Iterate on one definition without re-reading 44 successes.
npx tsx scripts/xano-push.ts --push function/ledger_append.xs

# On a paid plan, include the middleware, trigger and tasks.
npx tsx scripts/xano-push.ts --push --include-paid
```

Credentials come from `.env.local` (gitignored), loaded by the script itself:

```
XANO_META_URL=https://x8ki-letl-twmt.n7.xano.io/api:meta
XANO_WORKSPACE_ID=168167
XANO_TOKEN=<metadata api token>
```

The request it makes:

```
POST {XANO_META_URL}/workspace/{XANO_WORKSPACE_ID}/multidoc?partial=true&transaction=true
Authorization: Bearer {XANO_TOKEN}
Content-Type: text/x-xanoscript
```

`Content-Type: text/x-xanoscript` is not optional — Xano routes on it, and
`application/json` gets a 400 that explains nothing.

`partial=true` and **no `delete` parameter**: this script adds and replaces, it
never removes. `transaction=true` means a failed push rolls back and lands
nothing, so a bad push is safe to attempt. Removing an object is a decision for a
human at the console, not a flag on a build script.

A successful push returns a `guid_map` — one entry per definition, with the GUID
the server assigned. That is the confirmation; anything else is a failure.

---

## 🔴 What the free plan refuses

These fail the **whole** multidoc with a 400, not just their own definition:

| Definition | Verbatim error |
|---|---|
| `middleware` | `Please upgrade to access middleware.` |
| `table_trigger` | `Triggers are only available on paid packages.` |
| `task` | `Please upgrade to access tasks.` |

`scripts/xano-push.ts` therefore excludes `middleware/`, `trigger/` and `task/`
by default and includes them with `--include-paid`. `multidoc.xs` as committed is
the free-tier selection, because that is the one that actually deploys.

Redis is Essential-only too, so `redis.ratelimit` is unavailable — the throttle
is `function/rate_guard.xs`, which counts recent `audit` rows instead.

---

## Order is declared, not globbed

A multidoc is applied top to bottom. Tables precede everything that queries them,
`ledger_append` precedes the endpoints that call it, and an API group precedes
its endpoints. A directory glob orders files by whatever the filesystem feels
like, and the failure mode is a half-applied push.

The order lives in `MANIFEST` in `scripts/xano-push.ts`, and a `.xs` file nobody
listed is an error rather than a silent omission — `tests/xano/backend.test.ts`
asserts the manifest and the tree are the same set, and that `multidoc.xs` is not
stale relative to the sources.

## Lambda bodies are folded at assembly time

XanoScript has no multi-line string: a newline inside any string literal is
`Syntax error: unexpected newline`. The two lambdas here — the canonical-JSON
hasher and the HMAC verifier — are the code most worth reading, so the `.xs`
sources keep them legible inside backticks and `foldLambdaBodies()` collapses
them into one double-quoted line with `\n` escapes on the way out. The transform
is deterministic, which is what lets the drift test still work.

---

## After a push

1. **Seed `webhook_source`.** Records are not part of a multidoc.

   | slug | signature_header | delivery_id_header | timestamp_header | tolerance_seconds |
   |---|---|---|---|---|
   | `foxit-esign` | `x-foxit-signature` | `x-foxit-delivery-id` | `x-foxit-timestamp` | 300 |

   `secret_env` records **which** environment variable backs the source
   (`FOXIT_WEBHOOK_SECRET`); it never holds the secret. `$env` resolves
   statically, so `webhook_verify` switches on the slug to reach the literal.

2. **Set the environment variables** listed in
   [`README.md`](./README.md#environment-variables). The push succeeds without
   them and every secret-dependent stack fails at runtime, which is a confusing
   way to find out.

3. **Set Swagger visibility and CORS in the UI.** Neither is expressible in
   XanoScript: groups take no CORS block, and `swagger.token` stores a plain-text
   credential and rejects `$env`.

4. **Run the smoke test.**

   ```sh
   npx tsx scripts/xano-smoke.ts
   ```

   It signs up, logs in, drafts a writ, records an act, appends two ledger
   entries, recomputes their hashes locally against `core/canonical.ts`, and
   reads the public verifier and hash spine. It also trips the free tier's
   **10 requests per 20 seconds** cap on purpose and recovers using the
   `retryAfterMs` on `XanoRateLimitError` — that limit does **not** fire inside
   Xano's own debugger, so this is the only way to see it before a judge does.

---

## Rollback

There is none on the free tier: one live branch, no backups, no undo. Branching
and 7-day backups are Essential-only.

What we have instead is this repository. `xano/**` is the source of truth, the
push is idempotent by GUID, and re-running the script restores the workspace to
whatever the tree says. That is why `--delete` is not implemented: a deploy that
can only add and replace can always be re-run; one that can remove cannot be
undone.

---

## Using the Xano CLI instead

Useful for pulling changes made in the UI back into the tree.

```sh
npm install -g @xano/cli
xano profile create chancery -i https://x8ki-letl-twmt.n7.xano.io -t "$XANO_TOKEN" -w 168167 --default
xano workspace pull -d ./xano
xano workspace push -d ./xano --dry-run
xano workspace push -d ./xano --force
```

Three things to know first:

- **The CLI path is the one that needs "Allow Direct Workspace Push."** Without
  it, `push` routes through the sandbox review flow and needs a UI click.
- **Without `--force` the CLI blocks on stdin forever in a non-TTY.**
- **Objects bind by an embedded `guid` line, not by filename.** Renaming files is
  safe; **stripping GUIDs creates duplicate objects.** `--delete`, `--truncate`
  and `--no-transaction` sit one keystroke apart and none is needed here.

The Developer MCP (`npx -y @xano/developer-mcp`) is worth having: it is
read-only and never touches the instance, but it ships the complete XanoScript
reference locally, which is considerably more accurate than the public docs
site. `npm pack @xano/developer-mcp` and read `dist/xanoscript_docs/*.md`
directly if you just want the grammar.

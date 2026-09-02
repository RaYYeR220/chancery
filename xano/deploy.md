# Deploying the Chancery backend

The whole workspace is one Metadata API request. `multidoc.xs` is the 50
definitions in `xano/**`, concatenated with `---` on its own line between them,
in dependency order.

---

## 🔴 Before anything else: enable "Allow Direct Workspace Push"

**Workspace Settings → CLI section → "Allow Direct Workspace Push".**

> When enabled, `xano workspace push` applies changes to this workspace
> immediately, bypassing the standard sandbox review flow.

The default is **counter-intuitive and it is the single biggest time bomb in this
deploy**:

| Plan | Direct push |
|---|---|
| Free | on by default |
| Paid (Essential and up) | **off by default** |

On a paid plan with the toggle off, a push routes through `xano sandbox push` +
`xano sandbox review`, which **requires opening a preview URL and clicking
"Review & Push" in the UI. There is no non-interactive path.** So taking the
Essential coupon *removes* headless deploys until somebody flips this switch.

Xano themselves say to turn it on — it is in the suggested prompt on the Devpost
page. Turn it on first, then never think about it again.

---

## One-time setup

1. **Mint a Metadata API token** — Instance Settings → Metadata API. This is the
   only manual step in the whole pipeline.
   ⚠️ A token grants access to **every workspace in the instance**. Treat it like
   a root credential; it is not scoped to Chancery.
2. **Export the environment:**

   ```sh
   export XANO_INSTANCE=https://x8ki-letl-twmt.n7.xano.io
   export XANO_WORKSPACE_ID=1
   export XANO_METADATA_TOKEN=...        # never committed, never in a .xs file
   ```

3. **Set the workspace's own environment variables** (Settings → Environment
   Variables), listed in [`README.md`](./README.md#environment-variables). The
   push will succeed without them and every secret-dependent stack will fail at
   runtime, which is a confusing way to find out.

---

## Deploy

```sh
# Assemble multidoc.xs from the source tree. Writes the file, pushes nothing.
npx tsx scripts/xano-push.ts

# Show what would be sent, and where.
npx tsx scripts/xano-push.ts --push --dry-run

# Do it.
npx tsx scripts/xano-push.ts --push
```

The request the script makes:

```
POST {XANO_INSTANCE}/api:meta/workspace/{XANO_WORKSPACE_ID}/multidoc?partial=true&transaction=true
Authorization: Bearer {XANO_METADATA_TOKEN}
Content-Type: text/x-xanoscript
```

`Content-Type: text/x-xanoscript` is not optional. Xano routes on it, and sending
`application/json` gets a 400 that explains nothing.

`partial=true` and **no `delete` parameter**: this script adds and replaces, it
never removes. `transaction=true` is the default and is left alone — a push that
fails halfway must roll back, or the workspace ends up in a state that matches no
commit. Removing an object is a decision for a human at the console, not a flag
on a build script.

### Why the order is declared and not globbed

A multidoc is applied top to bottom. Tables have to precede everything that
queries them, `ledger_append` has to precede the endpoints that call it, and an
API group has to precede its endpoints. A directory glob orders files by whatever
the filesystem feels like, and the failure mode is a half-applied push. The order
lives in `MANIFEST` in `scripts/xano-push.ts`, and a `.xs` file that nobody listed
is an error rather than a silent omission — `tests/xano/backend.test.ts` asserts
the manifest and the tree are the same set, and that `multidoc.xs` on disk is not
stale relative to the sources.

---

## After the first push

1. **Seed `webhook_source`.** Records are not part of a multidoc. One row per
   source:

   | slug | signature_header | delivery_id_header | timestamp_header | tolerance_seconds |
   |---|---|---|---|---|
   | `foxit-esign` | `x-foxit-signature` | `x-foxit-delivery-id` | `x-foxit-timestamp` | 300 |

   The `secret_env` column records **which environment variable backs the
   source** (`FOXIT_WEBHOOK_SECRET`). It never holds the secret. `$env` resolves
   statically in XanoScript, so `webhook_verify` switches on the slug to reach a
   literal `{{ $env.X }}`; this column exists so the mapping is visible in the
   data and a rotation is a documented change.

2. **Confirm the tasks are enabled.** All three ship `active = true`. Check
   `freq` reads as seconds in the UI — `3600`, `30`, `300`.

3. **Check route precedence** between `writ/by_domain` and `writ/{writ_uid}`. We
   assume the literal segment wins. If it does not, `by_domain` moves to its own
   prefix and the client's path changes with it.

4. **Resolve the `api.request` envelope shape.** Undocumented, and it differs by
   endpoint: `$vendor.result` vs `$vendor.response` vs flat. `act_execute`
   assumes `$vendor.response`. Return the whole `$vendor` from a scratch endpoint
   once, look at it, and fix it everywhere. Budget five minutes; it applies to
   every vendor call in the workspace.

5. **Test through the real URL, not the debugger.** The free tier's
   **10 requests per 20 seconds** limit does **not** fire inside Xano's own
   debugger. A stack that looks perfect in the UI will start returning
   `ERROR_CODE_TOO_MANY_REQUESTS` the moment two judges open the console at once.
   The TypeScript client raises that as `XanoRateLimitError` with a retry hint
   precisely because it is otherwise invisible.

---

## Rollback

There is none on the free tier: one live branch, no backups, no undo. Branching
and 7-day backups are Essential-only.

What we have instead is this repository. `xano/**` is the source of truth, the
push is idempotent, and re-running the script restores the workspace to whatever
the tree says. That is why `--delete` is not implemented: a deploy that can only
add and replace can always be re-run, and a deploy that can remove cannot be
undone.

---

## Using the Xano CLI instead

The CLI does the same thing with more ceremony, and is useful for pulling changes
made in the UI back into the tree.

```sh
npm install -g @xano/cli
xano profile create chancery -i "$XANO_INSTANCE" -t "$XANO_METADATA_TOKEN" -w "$XANO_WORKSPACE_ID" --default
xano workspace pull -d ./xano
xano workspace push -d ./xano --dry-run
xano workspace push -d ./xano --force
```

Three things to know before running any of it:

- **Without `--force` the CLI blocks on stdin forever in a non-TTY.** In CI, or
  under an agent, it simply hangs.
- **Objects bind by an embedded `guid` line, not by filename.** The server writes
  GUIDs back on push. Renaming files is safe; **stripping GUIDs creates duplicate
  objects.**
- **`--delete`, `--truncate` and `--no-transaction` sit one keystroke apart.**
  Xano wrote agent-directed warnings into the CLI's own help text because of it.
  None of them is needed for this deploy.

The Developer MCP (`npx -y @xano/developer-mcp`) is worth installing for
`validate_xanoscript`, which catches syntax errors before a push cycle is burned.
It is **read-only and never touches the instance** — it cannot deploy anything.

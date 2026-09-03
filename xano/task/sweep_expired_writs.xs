// 💳 PAID TIER. The Metadata API refuses this on free with "Please upgrade to
// access tasks", so `scripts/xano-push.ts` excludes it unless `--include-paid`
// is passed.
//
// Hourly sweep: mark writs whose term has run out. `freq` is SECONDS, not cron.
// 3600 is one hour. Writing `0 * * * *` here schedules a task to run every zero
// seconds, which is a genuinely exciting way to discover a rate limit.
//
// This task does NOT append to the ledger, and that is a considered choice.
// Expiry is not an event that happened; it is a property of a date and a clock.
// The decision engine already denies an expired writ from `expires_at` alone,
// without consulting this column, so a sweep that had not run yet cannot let an
// expired writ through — which is also why losing this task on the free tier
// costs correctness nothing. All it does is materialise the status so the
// console and the registry agree with the engine, and putting a non-event into
// an evidence chain would mean the chain recorded something nobody did.
//
// Revoked writs are skipped: revocation outranks expiry, exactly as the DNS
// tombstone rule has it, and a revoked writ must not be relabelled `expired` as
// though it had merely lapsed.
task "sweep_expired_writs" {
  description = "Materialise writ expiry for the console. Does not touch the chain."

  stack {
    db.query "writ" {
      where = ($db.writ.status == "active" || $db.writ.status == "pending_signature" || $db.writ.status == "draft") && $db.writ.expires_at < now
      sort = {expires_at: "asc"}
      return = {type: "list"}
    } as $lapsed

    foreach ($lapsed) {
      each as $writ {
        db.edit "writ" {
          field_name = "id"
          field_value = $writ.id
          data = {
            status: "expired",
            updated_at: now
          }
        }

        function.run "audit_append" {
          input = {principal_id: $writ.principal_id, method: "TASK", path: "task/sweep_expired_writs", ip: null, vars: {writ_id: $writ.uid}, ledger_sequence: null}
        }
      }
    }
  }

  schedule = [{starts_on: 2026-09-03 00:00:00+0000, freq: 3600}]
}

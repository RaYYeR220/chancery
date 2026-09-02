// Hourly sweep: mark writs whose term has run out.
//
// `freq` is SECONDS, not cron. 3600 is one hour. Writing `0 * * * *` here
// schedules a task to run every zero seconds, which is a genuinely exciting way
// to discover a rate limit.
//
// This task does NOT append to the ledger, and that is a considered choice.
// Expiry is not an event that happened; it is a property of a date and a clock.
// The decision engine already denies an expired writ from `expires_at` alone,
// without consulting this column, so a sweep that had not run yet cannot let an
// expired writ through. All this does is materialise the status so the console
// and the registry agree with the engine — and putting a non-event into an
// evidence chain would mean the chain recorded something nobody did.
//
// Revoked writs are skipped: revocation outranks expiry, exactly as the DNS
// tombstone rule has it, and a revoked writ must not be relabelled `expired` as
// though it had merely lapsed.
task sweep_expired_writs {
  description = "Materialise writ expiry for the console. Does not touch the chain."
  active = true

  stack {
    db.query writ {
      where = (
        ($db.writ.status == "active" || $db.writ.status == "pending_signature" || $db.writ.status == "draft")
        && $db.writ.expires_at < "now"
      )
      sort = [{field: "expires_at", order: "asc"}]
      per_page = 500
    } as $lapsed

    for_each ($lapsed as $writ) {
      db.edit writ {
        field_name = "id"
        field_value = $writ.id
        data = { status: "expired", updated_at: "now" }
      }
      function.audit_append {
        principal_id = $writ.principal_id
        method = "TASK"
        path = "task/sweep_expired_writs"
        vars = { writ_id: $writ.uid, expires_at: $writ.expires_at }
      }
    }
  }

  schedule = [{ starts_on: 2026-09-03 00:00:00+0000, freq: 3600 }]
}

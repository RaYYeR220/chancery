// job-retry: claim.
//
// A claim is a lease, not a handover. The worker stamps its token and the time,
// and `reap_stale_claims` gives the job back if that lease is never released —
// otherwise one worker timing out removes a job from the world permanently,
// which for an act the principal already authorised is the worst outcome
// available: silently nothing happens.
//
// The select and the stamp are in one transaction with a row lock, so two
// workers cannot lease the same job. `run_after <= now` is the whole backoff
// mechanism: a failed job writes its next attempt into the future and simply
// stops matching this query until then.
function job_claim {
  description = "Lease up to `limit` due jobs of one kind."

  input {
    text kind
    int? limit
  }

  stack {
    security.uuid {} as $claim_token

    db.transaction {
      stack {
        db.query job {
          where = (
            $db.job.kind == $input.kind
            && $db.job.status == "pending"
            && $db.job.run_after <= "now"
          )
          sort = [{field: "run_after", order: "asc"}, {field: "id", order: "asc"}]
          per_page = $input.limit|default:10
          lock = "update|skip_locked"
        } as $due

        var $claimed = []
        for_each ($due as $job) {
          db.edit job {
            field_name = "id"
            field_value = $job.id
            data = { status: "claimed", claimed_at: "now", claim_token: $claim_token }
          } as $updated
          var $claimed = $claimed|array_push:$updated
        }
      }
    }
  }

  response = { claim_token: $claim_token, jobs: $claimed }
}

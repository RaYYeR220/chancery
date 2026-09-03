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
function "job_claim" {
  description = "Lease up to `limit` due jobs of one kind."

  input {
    text kind
    int? limit?
  }

  stack {
    security.create_uuid {
    } as $claim_token

    var $claimed {
      value = []
    }

    db.transaction {
      stack {
        db.query "job" {
          where = $db.job.kind == $input.kind && $db.job.status == "pending" && $db.job.run_after <= now
          sort = {run_after: "asc"}
          lock = true
          return = {type: "list", paging: {page: 1, per_page: ($input.limit|first_notnull:10)}}
        } as $due

        foreach ($due) {
          each as $job {
            db.edit "job" {
              field_name = "id"
              field_value = $job.id
              data = {
                status: "claimed",
                claimed_at: now,
                claim_token: $claim_token
              }
            } as $updated

            var.update $claimed {
              value = $claimed|push:$updated
            }
          }
        }
      }
    }
  }

  response = {
    claim_token: $claim_token,
    jobs: $claimed
  }
}

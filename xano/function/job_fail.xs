// job-retry: fail, with exponential backoff and a dead-letter tier.
//
// The backoff is 2^attempts seconds with FULL JITTER — a uniform pick from
// [0, 2^n) rather than the exact power. Without jitter, an upstream outage
// synchronises every failed job onto the same retry instant, and the moment the
// upstream recovers it is hit by the entire backlog at once. That is how a
// retry queue turns one outage into two.
//
// After `max_attempts` the job is copied to `job_dead_letter` and left there.
// Nothing retries out of the dead letter automatically: a registration that has
// failed six times over an hour is not a transient failure, and this product's
// entire posture is that a machine does not decide on its own to try an
// irreversible thing again.
function job_fail {
  description = "Record a failed attempt, back off, or dead-letter."

  input {
    int job_id
    text claim_token
    text error
  }

  stack {
    db.get job { field_name = "id" field_value = $input.job_id } as $job
    precondition ($job != null) { error_type = "notfound" error = "No such job." }
    precondition ($job.claim_token == $input.claim_token) {
      error_type = "accessdenied"
      error = "This lease is no longer held."
    }

    var $attempts = $job.attempts|add:1
    var $log = $job.attempt_log|default:[]|array_push:{
      attempt: $attempts,
      at: "now"|to_iso8601,
      error: $input.error
    }

    conditional ($attempts >= $job.max_attempts) {
      then {
        db.add job_dead_letter {
          data = {
            job_id: $job.id,
            kind: $job.kind,
            idempotency_key: $job.idempotency_key,
            payload: $job.payload,
            attempts: $attempts,
            last_error: $input.error,
            attempt_log: $log
          }
        }
        db.edit job {
          field_name = "id"
          field_value = $job.id
          data = {
            status: "dead",
            attempts: $attempts,
            last_error: $input.error,
            attempt_log: $log,
            claim_token: null
          }
        } as $updated
      }
      else {
        // Full jitter: uniform in [0, 2^attempts) seconds, floored at one second
        // so the first retry is not instant.
        var $ceiling = 2|pow:$attempts
        security.random_number { min = 0 max = $ceiling } as $jitter
        var $delay = $jitter|max:1

        db.edit job {
          field_name = "id"
          field_value = $job.id
          data = {
            status: "pending",
            attempts: $attempts,
            last_error: $input.error,
            attempt_log: $log,
            claim_token: null,
            claimed_at: null,
            run_after: "now"|add_seconds:$delay
          }
        } as $updated
      }
    }
  }

  response = {
    id: $updated.id,
    status: $updated.status,
    attempts: $updated.attempts,
    run_after: $updated.run_after
  }
}

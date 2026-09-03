// 💳 PAID TIER. Excluded from the free-tier push; see `sweep_expired_writs`.
//
// job-retry: return abandoned leases to the queue. Every five minutes — `freq`
// is SECONDS, 300 is five minutes.
//
// Without this, a worker that dies between claiming a job and completing it
// removes that job from the world: it is neither pending nor done, and nothing
// will ever look at it again. For an act a human already authorised, "silently
// nothing happened" is the worst available outcome — worse than failing loudly,
// because nobody finds out.
//
// The reap counts as an attempt. A job that repeatedly kills its worker is a job
// that will keep killing workers, and it needs to reach the dead-letter tier
// rather than cycling forever.
task "reap_stale_claims" {
  description = "Return jobs whose lease expired to pending, counting the attempt."

  stack {
    db.query "job" {
      where = $db.job.status == "claimed" && $db.job.claimed_at < ((now|to_ms) - 600000)
      return = {type: "list"}
    } as $stale

    foreach ($stale) {
      each as $job {
        var $attempts {
          value = $job.attempts + 1
        }

        var $log {
          value = ($job.attempt_log|first_notnull:[])|push:{attempt: $attempts, at: now, error: "lease expired without completion"}
        }

        conditional {
          if ($attempts >= $job.max_attempts) {
            db.add "job_dead_letter" {
              data = {
                job_id: $job.id,
                kind: $job.kind,
                idempotency_key: $job.idempotency_key,
                payload: $job.payload,
                attempts: $attempts,
                last_error: "lease expired without completion",
                attempt_log: $log
              }
            }

            db.edit "job" {
              field_name = "id"
              field_value = $job.id
              data = {
                status: "dead",
                attempts: $attempts,
                attempt_log: $log,
                claim_token: null
              }
            }
          }
          else {
            db.edit "job" {
              field_name = "id"
              field_value = $job.id
              data = {
                status: "pending",
                attempts: $attempts,
                attempt_log: $log,
                claim_token: null,
                claimed_at: null,
                run_after: ((now|to_ms) + ($attempts * 1000))
              }
            }
          }
        }
      }
    }
  }

  schedule = [{starts_on: 2026-09-03 00:00:00+0000, freq: 300}]
}

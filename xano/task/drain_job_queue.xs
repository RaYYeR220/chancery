// 💳 PAID TIER. Excluded from the free-tier push; see `sweep_expired_writs`.
//
// job-retry: the worker. Runs every 30 seconds. `freq` is SECONDS — 30 means
// every thirty seconds, not the 30th minute.
//
// The loop is deliberately bounded — a small batch per tick — rather than
// draining until empty. Xano's community answer to agent-loop timeouts is to
// persist state and continue the workflow across separate runs instead of
// holding a multi-step workflow inside one execution, and a queue worker is the
// same shape: the state is in the table, so a tick that gets cut short loses a
// lease, not a job.
//
// Each job is claimed, dispatched, and then explicitly completed or failed.
// There is no path where a job silently disappears: an unhandled kind is failed
// with a reason and backs off like anything else, so a typo shows up in the
// dead-letter table instead of as an act that never happened.
task "drain_job_queue" {
  description = "Claim and run due jobs: execute allowed acts, process webhooks."

  stack {
    foreach (["act.execute", "webhook.esign"]) {
      each as $kind {
        function.run "job_claim" {
          input = {kind: $kind, limit: 5}
        } as $lease

        foreach ($lease.jobs) {
          each as $job {
            try_catch {
              try {
                conditional {
                  if ($job.kind == "act.execute") {
                    function.run "act_execute" {
                      input = {job: $job}
                    }
                  }
                  elseif ($job.kind == "webhook.esign") {
                    function.run "webhook_esign_process" {
                      input = {job: $job}
                    }
                  }
                  else {
                    throw {
                      name = "NoHandler"
                      value = "No handler for job kind."
                    }
                  }
                }

                function.run "job_complete" {
                  input = {job_id: $job.id, claim_token: $lease.claim_token}
                }
              }
              catch {
                function.run "job_fail" {
                  input = {job_id: $job.id, claim_token: $lease.claim_token, error: ($error.value|first_notnull:"unknown failure")}
                }
              }
            }
          }
        }
      }
    }
  }

  schedule = [{starts_on: 2026-09-03 00:00:00+0000, freq: 30}]
}

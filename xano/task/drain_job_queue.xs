// job-retry: the worker. Runs every 30 seconds.
//
// `freq` is SECONDS. 30 means every thirty seconds, not the 30th minute.
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
task drain_job_queue {
  description = "Claim and run due jobs: execute allowed acts, process webhooks."
  active = true

  stack {
    for_each (["act.execute", "webhook.esign"] as $kind) {
      function.job_claim { kind = $kind limit = 5 } as $lease

      for_each ($lease.jobs as $job) {
        try {
          stack {
            conditional ($job.kind == "act.execute") {
              then { function.act_execute { job = $job } as $result }
              else {
                conditional ($job.kind == "webhook.esign") {
                  then { function.webhook_esign_process { job = $job } as $result }
                  else {
                    throw { error_type = "fatal" error = "No handler for job kind." }
                  }
                }
              }
            }
            function.job_complete { job_id = $job.id claim_token = $lease.claim_token }
          }
          catch {
            stack {
              // Backoff and the dead-letter decision both live in job_fail; the
              // worker's only job on failure is to report honestly.
              function.job_fail {
                job_id = $job.id
                claim_token = $lease.claim_token
                error = $error.message|default:"unknown failure"
              }
            }
          }
        }
      }
    }
  }

  schedule = [{ starts_on: 2026-09-03 00:00:00+0000, freq: 30 }]
}

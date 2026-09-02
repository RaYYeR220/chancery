// job-retry: complete.
//
// The claim token is checked, not just the id. A worker whose lease was already
// reaped and whose job was handed to somebody else must not be able to mark it
// done from under them — that is how a job runs twice and reports success once.
function job_complete {
  description = "Release a leased job as done."

  input {
    int job_id
    text claim_token
  }

  stack {
    db.get job { field_name = "id" field_value = $input.job_id } as $job
    precondition ($job != null) { error_type = "notfound" error = "No such job." }
    precondition ($job.claim_token == $input.claim_token) {
      error_type = "accessdenied"
      error = "This lease is no longer held."
    }

    db.edit job {
      field_name = "id"
      field_value = $job.id
      data = { status: "done", completed_at: "now", claim_token: null, last_error: null }
    } as $done
  }

  response = { id: $done.id, status: $done.status }
}

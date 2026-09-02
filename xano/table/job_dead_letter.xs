// The dead-letter tier.
//
// A job that exhausted its attempts is copied here and left alone. It is a
// separate table rather than a status because these rows are read by a human,
// not by the worker: mixing them into the queue means the thing you most need to
// notice is buried under thousands of completed rows.
//
// Nothing retries out of here automatically. An act that failed six times with
// backoff is not a transient failure, and Chancery's whole posture is that the
// machine does not decide to try an irreversible thing again on its own.
table job_dead_letter {
  schema {
    int id
    timestamp created_at?=now
    int job_id { table = "job" }
    text kind
    text idempotency_key
    json payload
    int attempts
    text last_error
    json attempt_log
    // Set when a human explicitly re-queued it, so the second life is attributable.
    timestamp? replayed_at
    int? replayed_by { table = "principal" }
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
    {type: "btree|unique", field: [{name: "job_id", op: "asc"}]}
  ]
}

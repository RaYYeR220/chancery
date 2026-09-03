// Durable job queue — the `job-retry` module from github.com/xano-community,
// carrying the acts Chancery has already decided it is allowed to commit.
//
// Enqueue, claim, complete, fail. The three columns that make it durable rather
// than decorative:
//
//   idempotency_key  unique. The same act enqueued twice runs once. This is the
//                    difference between a retried registration and two domains.
//   run_after        when the job becomes claimable again. Exponential backoff
//                    writes the future into this column instead of sleeping.
//   claim_token      who holds it. A worker that dies mid-job leaves a stale
//                    claim, and `reap_stale_claims` returns it to the pool —
//                    without it, one crash removes a job from the world.
table job {
  schema {
    int id
    timestamp created_at?=now
    uuid uid
    // "act.execute" | "webhook.esign" | "writ.notify"
    text kind filters=trim
    text idempotency_key filters=trim
    json payload
    enum status?="pending" {
      values = ["pending", "claimed", "done", "failed", "dead"]
    }
    int attempts?=0
    int max_attempts?=6
    timestamp run_after?=now
    timestamp? claimed_at
    text? claim_token
    text? last_error
    timestamp? completed_at
    // Every attempt's error, kept so a dead letter explains itself instead of
    // showing only the last thing that went wrong.
    json? attempt_log
  }

  // The last index is the claim query's exact shape: due, pending, oldest
  // first. (Comments cannot appear inside an array literal, so it is described
  // here rather than beside it.)
  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "uid", op: "asc"}]}
    {type: "btree|unique", field: [{name: "kind", op: "asc"}, {name: "idempotency_key", op: "asc"}]}
    {type: "btree", field: [{name: "status", op: "asc"}, {name: "run_after", op: "asc"}]}
  ]
}

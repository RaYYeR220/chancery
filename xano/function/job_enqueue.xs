// job-retry: enqueue.
//
// Idempotent by construction. The unique index on (kind, idempotency_key) means
// the same act cannot be queued twice, and the function returns the EXISTING job
// rather than raising — a duplicate enqueue is a retry of something that already
// worked, not an error to surface to whoever is retrying.
//
// For an act the key is the act's uid, so the trigger can fire twice (a
// re-delivery, a replayed transaction) and the domain is still bought once.
function "job_enqueue" {
  description = "Enqueue durable work, at most once per idempotency key."

  input {
    text kind
    text idempotency_key
    json payload
    int? max_attempts?
    int? delay_seconds?
  }

  stack {
    db.query "job" {
      where = $db.job.kind == $input.kind && $db.job.idempotency_key == $input.idempotency_key
      return = {type: "single"}
    } as $existing

    var $job {
      value = $existing
    }

    conditional {
      if ($existing == null) {
        security.create_uuid {
        } as $uid

        db.add "job" {
          data = {
            uid: $uid,
            kind: $input.kind,
            idempotency_key: $input.idempotency_key,
            payload: $input.payload,
            status: "pending",
            attempts: 0,
            max_attempts: ($input.max_attempts|first_notnull:6),
            run_after: ((now|to_ms) + (($input.delay_seconds|first_notnull:0) * 1000)),
            attempt_log: []
          }
        } as $created

        var.update $job {
          value = $created
        }
      }
    }
  }

  response = {
    id: $job.id,
    uid: $job.uid,
    status: $job.status,
    created: $existing == null
  }
}

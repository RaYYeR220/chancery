// Database trigger on `act` insert.
//
// It does two things, and it deliberately does not do a third.
//
// It queues execution. An act that was ALLOWED but not yet carried out is
// handed to the durable queue here rather than by whoever wrote the row, so an
// allowed act is executed no matter which path created it — endpoint, task, or a
// human clicking Add Record in the Xano UI. The act's uid is the idempotency
// key, so the same decision cannot buy two domains.
//
// It maintains the consumed-budget counters on `writ`. Those are derived state
// for the console; the decision engine evaluates limits against act rows, never
// against a counter, so a drift here can misinform a dashboard but can never
// widen an authority.
//
// It does NOT append to the ledger. The chain has exactly one writer, and a
// trigger firing inside another statement's transaction would nest chain
// appends inside writes that may still roll back — producing either a gap in
// the sequence or an entry for an act that never existed. The endpoints append
// explicitly, in their own transaction, where the ordering is legible.
table_trigger "act_recorded" {
  table = "act"
  actions = {insert: true, update: false, delete: false, truncate: false}
  active = true
  description = "Queue allowed acts for execution; keep the writ's budget counters honest."

  input {
    json new
    json old
    enum action {
      values = ["insert", "update", "delete", "truncate"]
    }
    text datasource
  }

  stack {
    conditional {
      if ($input.new.outcome == "allow" && $input.new.executed == false) {
        function.run "job_enqueue" {
          input = {kind: "act.execute", idempotency_key: $input.new.uid, payload: {act_id: $input.new.id, act_uid: $input.new.uid, writ_id: $input.new.writ_id, kind: $input.new.kind}, max_attempts: 6, delay_seconds: 0}
        }
      }
    }

    conditional {
      if ($input.new.executed == true) {
        db.get "writ" {
          field_name = "id"
          field_value = $input.new.writ_id
        } as $writ

        conditional {
          if ($writ != null) {
            db.edit "writ" {
              field_name = "id"
              field_value = $writ.id
              data = {
                consumed_count: ($writ.consumed_count + 1),
                consumed_minor_units: ($writ.consumed_minor_units + ($input.new.amount_minor_units|first_notnull:0)),
                updated_at: now
              }
            }
          }
        }
      }
    }
  }
}

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
table_trigger act_recorded {
  table = "act"
  actions = ["insert"]

  stack {
    conditional ($new.outcome == "allow" && $new.executed == false) {
      then {
        function.job_enqueue {
          kind = "act.execute"
          idempotency_key = $new.uid
          payload = { act_id: $new.id, act_uid: $new.uid, writ_id: $new.writ_id, kind: $new.kind }
        }
      }
    }

    conditional ($new.executed == true) {
      then {
        db.get writ { field_name = "id" field_value = $new.writ_id } as $writ
        conditional ($writ != null) {
          then {
            db.edit writ {
              field_name = "id"
              field_value = $writ.id
              data = {
                consumed_count: $writ.consumed_count|add:1,
                consumed_minor_units: $writ.consumed_minor_units|add:($new.amount_minor_units|default:0),
                updated_at: "now"
              }
            }
          }
        }
      }
    }
  }
}

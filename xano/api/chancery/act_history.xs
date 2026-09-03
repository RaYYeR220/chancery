// GET /writ/{writ_uid}/act — actHistory
//
// Executed acts only. Cumulative limits are evaluated against this list, and a
// refusal must not consume the budget it was refused by: if a denied
// registration counted against a three-registration cap, three denials would
// exhaust an authority that was never used.
//
// Ordered oldest first, which is the order a window calculation walks.
query "writ/{writ_uid}/act" verb=GET {
  description = "Executed acts under one writ, for cumulative limits."
  api_group = "chancery"
  auth = "principal"

  input {
    text writ_uid
  }

  stack {
    function.run "writ_owned" {
      input = {writ_uid: $input.writ_uid, required: true}
    } as $writ

    db.query "act" {
      where = $db.act.writ_id == $writ.id && $db.act.executed == true
      sort = {executed_at: "asc"}
      return = {type: "list"}
    } as $rows

    var $history {
      value = []
    }

    foreach ($rows) {
      each as $act {
        var.update $history {
          value = $history|push:{kind: $act.kind, grant_ref: $act.grant_ref, amount_minor_units: $act.amount_minor_units, currency: $act.currency, executed_at: $act.executed_at}
        }
      }
    }
  }

  response = $history
}

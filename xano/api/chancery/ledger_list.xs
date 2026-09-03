// GET /ledger?writ_id= — ledger
//
// The chain is global — one sequence across the whole workspace — but a read is
// not. Entries are returned scoped to the caller, because the payloads name
// domains, amounts and refusal reasons, and one principal's refused registration
// is not another principal's business.
//
// That is why `principal_id` exists on the row. It is denormalised and not
// hashed: it is an index for this query, not evidence. Anyone who wants to
// verify the chain's integrity across principals uses `/ledger/spine` in the
// public group, which returns linkage without payloads.
//
// The filter is TWO queries rather than one with `($uid == null || col == $uid)`.
// A `where` clause compiles to SQL and is not short-circuited in XanoScript, so
// the null branch still binds null against an indexed column and the request
// dies with `ParseError: Invalid value for param`. Branching in the stack is the
// only reliable way to make a filter optional.
query "ledger" verb=GET {
  description = "The caller's ledger entries, oldest first."
  api_group = "chancery"
  auth = "principal"

  input {
    text? writ_id?
  }

  stack {
    var $rows {
      value = []
    }

    conditional {
      if ($input.writ_id != null) {
        function.run "writ_owned" {
          input = {writ_uid: $input.writ_id, required: true}
        } as $writ

        db.query "ledger" {
          where = $db.ledger.principal_id == $auth.id && $db.ledger.writ_id == $writ.uid
          sort = {sequence: "asc"}
          return = {type: "list"}
        } as $scoped

        var.update $rows {
          value = $scoped
        }
      }
      else {
        db.query "ledger" {
          where = $db.ledger.principal_id == $auth.id
          sort = {sequence: "asc"}
          return = {type: "list"}
        } as $all

        var.update $rows {
          value = $all
        }
      }
    }

    var $entries {
      value = []
    }

    foreach ($rows) {
      each as $row {
        var.update $entries {
          value = $entries|push:{sequence: $row.sequence, previous_hash: $row.previous_hash, hash: $row.hash, kind: $row.kind, at: $row.at, payload: $row.payload}
        }
      }
    }
  }

  response = $entries
}

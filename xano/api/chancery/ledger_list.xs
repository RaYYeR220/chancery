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
query ledger verb=GET {
  description = "The caller's ledger entries, oldest first."

  input {
    text? writ_id
    int? after_sequence
    int? per_page
  }

  stack {
    conditional ($input.writ_id != null) {
      then {
        // Verified, not trusted: without this a caller could read any writ's
        // chain by guessing a uid.
        function.writ_owned { writ_uid = $input.writ_id } as $writ
        db.query ledger {
          where = (
            $db.ledger.writ_id == $writ.uid
            && $db.ledger.principal_id == $auth.id
            && $db.ledger.sequence > ($input.after_sequence|default:-1)
          )
          sort = [{field: "sequence", order: "asc"}]
          per_page = $input.per_page|default:250
        } as $rows
      }
      else {
        db.query ledger {
          where = (
            $db.ledger.principal_id == $auth.id
            && $db.ledger.sequence > ($input.after_sequence|default:-1)
          )
          sort = [{field: "sequence", order: "asc"}]
          per_page = $input.per_page|default:250
        } as $rows
      }
    }

    var $entries = []
    for_each ($rows as $row) {
      var $entries = $entries|array_push:{
        sequence: $row.sequence,
        previous_hash: $row.previous_hash,
        hash: $row.hash,
        kind: $row.kind,
        at: $row.at,
        payload: $row.payload
      }
    }
  }

  response = $entries
}

// POST /ledger — appendLedger
//
// The client sends `{ kind, at, payload }` and nothing else. It does not send a
// sequence, a previous hash or a hash, because a client that picked its own
// position would race every other client: two callers reading the same head
// would compute the same next number and one would be rejected by the unique
// index after its payload had already been accepted.
//
// So the chain is assigned here, under the lock `ledger_append` takes, and
// verified on the way back out by the client against the same canonical form.
// Server-assigned and client-verified is the whole claim — an entry the caller
// cannot reproduce is not evidence and the client refuses it.
query ledger verb=POST {
  description = "Append one entry to the tamper-evident chain."

  input {
    enum kind? {
      values = [
        "writ.issued",
        "writ.anchored",
        "writ.revoked",
        "act.requested",
        "act.decided",
        "act.executed",
        "act.failed"
      ]
    }
    text at?
    json payload?
    // Denormalised for scoping only. Verified below rather than trusted: a
    // caller could otherwise file an entry under someone else's writ and make
    // their audit trail say something it should not.
    text? writ_id
  }

  stack {
    conditional ($input.writ_id != null) {
      then {
        function.writ_owned { writ_uid = $input.writ_id } as $writ
        var $writ_uid = $writ.uid
      }
      else { var $writ_uid = null }
    }

    function.ledger_append {
      kind = $input.kind
      at = $input.at
      payload = $input.payload
      writ_id = $writ_uid
      principal_id = $auth.id
    } as $entry
  }

  response = $entry
}

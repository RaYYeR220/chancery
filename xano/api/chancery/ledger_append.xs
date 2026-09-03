// POST /ledger — appendLedger
//
// The client sends `{ kind, at, payload }` and nothing else. It does not send a
// sequence, a previous hash or a hash, because a client that picked its own
// position would race every other client: two callers reading the same head
// would compute the same next number and one would be rejected by the unique
// index after its payload had already been accepted.
//
// So the chain is assigned by `ledger_append`, under the lock it takes, and
// verified on the way back out by the client against the same canonical form.
// Server-assigned and client-verified is the whole claim — an entry the caller
// cannot reproduce is not evidence and the client refuses it.
query "ledger" verb=POST {
  description = "Append one entry to the tamper-evident chain."
  api_group = "chancery"
  auth = "principal"

  input {
    enum kind {
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
    text at
    json payload
    text? writ_id?
  }

  stack {
    var $writ_uid {
      value = null
    }

    conditional {
      if ($input.writ_id != null) {
        function.run "writ_owned" {
          input = {writ_uid: $input.writ_id, required: true}
        } as $writ

        var.update $writ_uid {
          value = $writ.uid
        }
      }
    }

    function.run "ledger_append" {
      input = {kind: $input.kind, at: $input.at, payload: $input.payload, writ_id: $writ_uid, principal_id: $auth.id}
    } as $entry
  }

  response = $entry
}

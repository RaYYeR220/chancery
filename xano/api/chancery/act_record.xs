// POST /writ/{writ_uid}/act — recordExecutedAct
//
// Records an act that has already been carried out. It does not decide anything
// and it cannot: the decision was made against a signed instrument, DNS and live
// diligence, and packaged into a receipt. A second place that could produce a
// verdict is a second place that could produce a different one.
//
// Writing this row fires the `act_recorded` trigger, which is what keeps the
// consumed-budget counters on `writ` honest no matter which path wrote the act —
// this endpoint, the queue worker, or a human in the Xano UI.
query writ/{writ_uid}/act verb=POST {
  description = "Record one executed act against a writ."

  input {
    text writ_uid
    enum kind? {
      values = [
        "domain.register",
        "domain.renew",
        "domain.transfer",
        "dns.write",
        "document.send_for_signature",
        "document.publish"
      ]
    }
    text grant_ref?
    int amount_minor_units?=0
    text currency?="USD"
    timestamp executed_at?
    text? reference
    json? fields
    text? evidence_digest
  }

  stack {
    function.writ_owned { writ_uid = $input.writ_uid } as $writ

    security.uuid {} as $uid
    db.add act {
      data = {
        uid: $uid,
        writ_id: $writ.id,
        kind: $input.kind,
        grant_ref: $input.grant_ref|default:"",
        fields: $input.fields|default:{},
        amount_minor_units: $input.amount_minor_units,
        currency: $input.currency,
        outcome: "allow",
        executed: true,
        reference: $input.reference,
        executed_at: $input.executed_at,
        evidence_digest: $input.evidence_digest
      }
    } as $act
  }

  response = { recorded: true, act_id: $act.uid }
}

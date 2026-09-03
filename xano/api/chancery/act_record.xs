// POST /writ/{writ_uid}/act — recordExecutedAct
//
// Records an act that has already been carried out. It does not decide anything
// and it cannot: the decision was made against a signed instrument, DNS and live
// diligence, and packaged into a receipt. A second place that could produce a
// verdict is a second place that could produce a different one.
//
// On a paid plan, writing this row fires the `act_recorded` trigger, which keeps
// the consumed-budget counters on `writ` honest no matter which path wrote the
// act. Triggers are Essential-only, so on free those counters simply stay at
// zero — nothing in the decision path reads them, so the gate is unaffected.
query "writ/{writ_uid}/act" verb=POST {
  description = "Record one executed act against a writ."
  api_group = "chancery"
  auth = "principal"

  input {
    text writ_uid
    enum kind {
      values = [
        "domain.register",
        "domain.renew",
        "domain.transfer",
        "dns.write",
        "document.send_for_signature",
        "document.publish"
      ]
    }
    text? grant_ref?
    int? amount_minor_units?
    text? currency?
    timestamp executed_at
    text? reference?
    json? fields?
    text? evidence_digest?
  }

  stack {
    function.run "audit_append" {
      input = {principal_id: $auth.id, method: "POST", path: "writ/{writ_uid}/act", ip: $env.$remote_ip, vars: {writ_uid: $input.writ_uid, kind: $input.kind}, ledger_sequence: null}
    }

    function.run "writ_owned" {
      input = {writ_uid: $input.writ_uid, required: true}
    } as $writ

    security.create_uuid {
    } as $uid

    db.add "act" {
      data = {
        uid: $uid,
        writ_id: $writ.id,
        kind: $input.kind,
        grant_ref: ($input.grant_ref|first_notnull:""),
        fields: ($input.fields|first_notnull:{}),
        amount_minor_units: ($input.amount_minor_units|first_notnull:0),
        currency: ($input.currency|first_notnull:"USD"),
        outcome: "allow",
        executed: true,
        reference: $input.reference,
        executed_at: $input.executed_at,
        evidence_digest: $input.evidence_digest
      }
    } as $act
  }

  response = {
    recorded: true,
    act_id: $act.uid
  }
}

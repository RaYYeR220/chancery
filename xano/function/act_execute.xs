// Carry out one act that the gate already allowed. Runs inside the queue worker.
//
// The decision is NOT re-made here. It was made against a signed instrument, DNS
// and live diligence, and packaged into a receipt; re-deciding in the worker
// would mean two places could reach the registrar with two different answers.
// What this does check is that the act row is still `allow` and still
// un-executed, because between the decision and the lease a human may have
// revoked the writ — and a revocation that arrives while a job is queued has to
// win.
//
// The registrar's idempotency key is the act's uid, not a fresh uuid. A timeout
// on a registration is not evidence that nothing was bought, and replaying the
// same key is the only safe way to find out.
function act_execute {
  description = "Execute one allowed act against its vendor, exactly once."

  input {
    json job
  }

  stack {
    db.get act { field_name = "id" field_value = $input.job.payload.act_id } as $act
    precondition ($act != null) { error_type = "notfound" error = "No such act." }

    conditional ($act.executed == true) {
      // Already done. The lease was reaped and re-issued, or the provider
      // retried. Completing quietly is correct: the work exists.
      then { var $reference = $act.reference }
      else {
        db.get writ { field_name = "id" field_value = $act.writ_id } as $writ
        precondition ($writ != null) { error_type = "notfound" error = "No such writ." }

        // Revocation beats a queued job. This is the whole reason execution is
        // deferred through a durable queue rather than done inline.
        precondition ($writ.status == "active") {
          error_type = "accessdenied"
          error = "The writ is no longer active; this act will not be carried out."
        }
        precondition ($act.outcome == "allow") {
          error_type = "accessdenied"
          error = "This act was refused."
        }

        conditional ($act.kind == "domain.register") {
          then {
            api.request {
              url = "https://api.name.com/core/v1/domains"
              method = "POST"
              params = {}
                |set:"domain":{name: $act.fields.domainName}
                |set:"purchasePrice":($act.amount_minor_units|divide:100)
              headers = []
                |array_push:"Content-Type: application/json"
                |array_push:("Authorization: Basic {{ $env.NAMECOM_BASIC_AUTH }}")
                |array_push:("x-idempotency-key: " ~ $act.uid)
              timeout = 30
            } as $vendor

            precondition ($vendor.status >= 200 && $vendor.status < 300) {
              error_type = "fatal"
              error = "Registrar refused the registration."
            }
            var $reference = $vendor.response.order|to_text
          }
          else {
            throw { error_type = "fatal" error = "No executor wired for this act kind." }
          }
        }

        db.edit act {
          field_name = "id"
          field_value = $act.id
          data = { executed: true, reference: $reference, executed_at: "now" }
        }

        function.ledger_append {
          kind = "act.executed"
          at = "now"|to_iso8601
          payload = {
            writId: $writ.uid,
            kind: $act.kind,
            reference: $reference,
            grantRef: $act.grant_ref
          }
          writ_id = $writ.uid
          principal_id = $writ.principal_id
        }
      }
    }
  }

  response = { reference: $reference }
}

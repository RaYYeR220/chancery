// The deferred half of the eSign callback. Runs in the queue worker, never in
// the provider's request.
//
// The inbox endpoint already returned 200 before any of this happened — Cameron
// Booth's rule, "acknowledge first, process later". Everything expensive or
// failable lives here, where a failure means a retry with backoff instead of a
// provider marking the endpoint unhealthy and giving up on the delivery.
//
// The writ is NOT moved to `active` here, and that is the security boundary:
// activation requires the signed PDF to be fetched, hashed, and read back into
// an enforceable policy by the extractor, which happens in the console with the
// signing credential. A webhook body saying "signed" is a claim by a third
// party, and this product does not enforce claims — it enforces documents.
function "webhook_esign_process" {
  description = "Process a verified eSign completion callback out of band."

  input {
    json job
  }

  stack {
    db.get "webhook_request" {
      field_name = "id"
      field_value = $input.job.payload.webhook_request_id
    } as $request

    precondition ($request != null) {
      error_type = "notfound"
      error = "No such webhook request."
    }

    precondition ($request.verified == true) {
      error_type = "accessdenied"
      error = "Refusing to process an unverified delivery."
    }

    var $body {
      value = $request.raw_body|json_decode
    }

    var $envelope_id {
      value = $body.envelopeId|first_notnull:$body.envelope_id
    }

    db.query "writ" {
      where = $db.writ.envelope_id == $envelope_id
      return = {type: "single"}
    } as $writ

    precondition ($writ != null) {
      error_type = "notfound"
      error = "No writ is waiting on that envelope."
    }

    function.run "ledger_append" {
      input = {kind: "writ.issued", at: now, payload: {writId: $writ.uid, stage: "esign_completed", envelopeId: $envelope_id, deliveryId: $request.delivery_id}, writ_id: $writ.uid, principal_id: $writ.principal_id}
    }

    db.edit "webhook_request" {
      field_name = "id"
      field_value = $request.id
      data = {
        status: "processed",
        processed_at: now
      }
    }
  }

  response = {
    writ_id: $writ.uid,
    envelope_id: $envelope_id
  }
}

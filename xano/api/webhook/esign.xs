// POST /esign — the eSign completion callback.
//
// Built to Cameron Booth's rule rather than to the pattern on Xano's own
// webhooks documentation page: **acknowledge first, process later.** Everything
// in this stack is persist, verify, enqueue, return. Nothing here fetches the
// signed PDF, hashes it, extracts terms or activates a writ — that work happens
// in `webhook_esign_process`, run by the queue worker.
//
// The reason is not tidiness. A signing provider gives a callback a few seconds
// before it calls the endpoint unhealthy and starts backing off; a synchronous
// stack that does the real work will eventually exceed that on a slow document
// and the delivery gets abandoned. Returning 200 the moment the request is
// safely on disk decouples our processing time from their patience entirely.
//
// The order inside the stack is also deliberate. The request is persisted BEFORE
// it is verified, so a forged callback claiming a writ was signed leaves a
// record of the attempt — which is exactly the attack this product exists to
// stop, and the evidence is worth more than the row costs.
//
// `raw_body` holds the canonical re-serialisation of the parsed body, not the
// bytes as they arrived: XanoScript exposes no raw-body variable. See
// `webhook_verify` and the README for what that costs and why it is stated
// rather than papered over.
query "esign" verb=POST {
  description = "Accept an eSign completion callback. Persist, verify, queue, 200."
  api_group = "webhook"

  input {
    json body
    text? signature?
    text? delivery_id?
    text? sent_at?
  }

  stack {
    db.get "webhook_source" {
      field_name = "slug"
      field_value = "foxit-esign"
    } as $source

    precondition ($source != null && $source.active == true) {
      error_type = "notfound"
      error = "Unknown webhook source."
    }

    security.create_uuid {
    } as $uid

    db.add "webhook_request" {
      data = {
        uid: $uid,
        source_id: $source.id,
        delivery_id: $input.delivery_id,
        signature: ($input.signature|first_notnull:""),
        verified: false,
        status: "received",
        headers: {content_type: "application/json", delivery_id: $input.delivery_id, sent_at: $input.sent_at},
        raw_body: ($input.body|json_encode)
      }
    } as $request

    function.run "webhook_verify" {
      input = {slug: $source.slug, body: $input.body, signature: ($input.signature|first_notnull:""), timestamp: $input.sent_at, tolerance_seconds: $source.tolerance_seconds, algo: $source.algo}
    } as $check

    conditional {
      if ($check.verified != true) {
        db.edit "webhook_request" {
          field_name = "id"
          field_value = $request.id
          data = {
            status: "rejected",
            error: "signature verification failed"
          }
        }

        throw {
          name = "SignatureError"
          value = "Signature verification failed."
        }
      }
    }

    db.query "webhook_request" {
      where = $db.webhook_request.source_id == $source.id && $db.webhook_request.delivery_id == $input.delivery_id && $db.webhook_request.id != $request.id && $db.webhook_request.verified == true
      return = {type: "exists"}
    } as $replayed

    conditional {
      if ($replayed == true) {
        db.edit "webhook_request" {
          field_name = "id"
          field_value = $request.id
          data = {
            verified: true,
            status: "replayed"
          }
        }
      }
      else {
        function.run "job_enqueue" {
          input = {kind: "webhook.esign", idempotency_key: ($input.delivery_id|first_notnull:$uid), payload: {webhook_request_id: $request.id}, max_attempts: 6, delay_seconds: 0}
        }

        db.edit "webhook_request" {
          field_name = "id"
          field_value = $request.id
          data = {
            verified: true,
            status: "queued"
          }
        }
      }
    }
  }

  response = {
    received: true,
    request_id: $uid
  }
}

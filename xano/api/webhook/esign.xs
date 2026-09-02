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
query esign verb=POST {
  description = "Accept an eSign completion callback. Persist, verify, queue, 200."

  input {
    json body?
  }

  stack {
    db.get webhook_source { field_name = "slug" field_value = "foxit-esign" } as $source
    precondition ($source != null && $source.active == true) {
      error_type = "notfound"
      error = "Unknown webhook source."
    }

    // Raw bytes, never the re-serialised object: re-serialising reorders keys
    // and the HMAC stops matching, which presents as "the provider's signatures
    // are wrong" and costs a day.
    var $raw = $http.raw_body
    var $signature = $http.headers|get:$source.signature_header|default:""
    var $delivery_id = $source.delivery_id_header == null
      ? null
      : $http.headers|get:$source.delivery_id_header
    var $timestamp = $source.timestamp_header == null
      ? null
      : $http.headers|get:$source.timestamp_header

    security.uuid {} as $uid

    // Persisted before verification. See the header note.
    db.add webhook_request {
      data = {
        uid: $uid,
        source_id: $source.id,
        delivery_id: $delivery_id,
        signature: $signature,
        verified: false,
        status: "received",
        // Only the headers that matter. Copying them all would put the
        // provider's own bearer tokens into a table we hand to support.
        headers: {
          signature_header: $source.signature_header,
          delivery_id: $delivery_id,
          timestamp: $timestamp,
          content_type: $http.headers|get:"content-type"
        },
        raw_body: $raw
      }
    } as $request

    function.webhook_verify {
      slug = $source.slug
      raw_body = $raw
      signature = $signature
      timestamp = $timestamp
      tolerance_seconds = $source.tolerance_seconds
      algo = $source.algo
    } as $check

    conditional ($check.verified != true) {
      then {
        db.edit webhook_request {
          field_name = "id"
          field_value = $request.id
          data = { status: "rejected", error: "signature verification failed" }
        }
        throw { error_type = "accessdenied" error = "Signature verification failed." }
      }
    }

    db.edit webhook_request {
      field_name = "id"
      field_value = $request.id
      data = { verified: true }
    }

    // Idempotent replay handling. The provider retries until it sees a 200, so
    // the same delivery WILL arrive more than once — that is correct behaviour
    // on their side, and it has to be a lookup here rather than a second
    // activation of the same envelope.
    conditional ($delivery_id != null) {
      then {
        db.query webhook_request {
          where = (
            $db.webhook_request.source_id == $source.id
            && $db.webhook_request.delivery_id == $delivery_id
            && $db.webhook_request.id != $request.id
            && $db.webhook_request.verified == true
          )
          per_page = 1
        } as $prior
      }
      else { var $prior = [] }
    }

    conditional ($prior|count > 0) {
      then {
        db.edit webhook_request {
          field_name = "id"
          field_value = $request.id
          data = { status: "replayed" }
        }
      }
      else {
        function.job_enqueue {
          kind = "webhook.esign"
          // The provider's delivery id when they send one; ours otherwise. Either
          // way the work runs once.
          idempotency_key = $delivery_id|default:$uid
          payload = { webhook_request_id: $request.id }
        }
        db.edit webhook_request {
          field_name = "id"
          field_value = $request.id
          data = { status: "queued" }
        }
      }
    }
  }

  // 200 with an acknowledgement and nothing else. The provider does not need to
  // know what we will do with it, and telling them shapes a forger's next try.
  response = { received: true, request_id: $uid }
}

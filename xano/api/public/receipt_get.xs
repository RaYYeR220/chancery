// GET /receipt/{digest} — fetch a published evidence bundle.
//
// Public because a receipt nobody outside can fetch is not evidence, it is a
// claim with a URL. This is the address `putEvidence` hands back and the address
// a refusal cites, so anyone told "denied under clause 3(b)" can pull the bundle
// and re-run the decision engine themselves, offline, with no credentials.
//
// The bundle holds the document HASH, never the document. A writ names a
// principal and what they will spend; publishing the instrument is the
// principal's decision, not ours.
query "receipt/{digest}" verb=GET {
  description = "One published evidence bundle, by content address."
  api_group = "public"

  input {
    text digest
  }

  stack {
    db.query "receipt" {
      where = $db.receipt.digest == $input.digest
      return = {type: "single"}
    } as $receipt

    precondition ($receipt != null) {
      error_type = "notfound"
      error = "No such receipt."
    }
  }

  response = {
    digest: $receipt.digest,
    evaluated_at: $receipt.evaluated_at,
    outcome: $receipt.outcome,
    bundle: $receipt.bundle
  }
}

// PATCH /writ/{writ_uid} — updateWrit
//
// The input list is the point of this file. There is no `grants`, no
// `jurisdiction`, no `effective_from`, no `expires_at`, and no principal. The
// terms of a writ are not patchable, full stop — a system whose whole claim is
// "the machine enforces what the human signed" cannot expose an endpoint that
// edits what the human signed. The client refuses the same fields, but a
// client-side check protects nobody, so it is refused here too.
//
// Revocation is terminal. Re-activating a revoked instrument by patch would make
// the DNS tombstone and the registry disagree about live authority, and the
// tombstone is the one a verifier reads.
query writ/{writ_uid} verb=PATCH {
  description = "Advance a writ's lifecycle. Cannot alter its terms."

  input {
    text writ_uid
    enum status? { values = ["draft", "pending_signature", "active", "revoked", "expired"] }
    text? document_url
    text? document_sha256
    text? envelope_id
    json? policy
    timestamp? anchored_at
  }

  stack {
    function.writ_owned { writ_uid = $input.writ_uid } as $writ

    precondition ($writ.status != "revoked" || $input.status == "revoked" || $input.status == null) {
      error_type = "accessdenied"
      error = "This writ is revoked; that is terminal."
    }

    var $data = {}
    conditional ($input.status != null) { then { var $data = $data|set:"status":$input.status } }
    conditional ($input.document_url != null) { then { var $data = $data|set:"document_url":$input.document_url } }
    conditional ($input.document_sha256 != null) { then { var $data = $data|set:"document_sha256":$input.document_sha256 } }
    conditional ($input.envelope_id != null) { then { var $data = $data|set:"envelope_id":$input.envelope_id } }
    conditional ($input.policy != null) { then { var $data = $data|set:"policy":$input.policy } }
    conditional ($input.anchored_at != null) { then { var $data = $data|set:"anchored_at":$input.anchored_at } }

    precondition ($data|count > 0) {
      error_type = "input"
      error = "Nothing to update."
    }

    // A policy may only be attached alongside the hash of the document it was
    // extracted from. Storing terms that are not bound to a specific signed PDF
    // is how an enforced policy stops being provably the one a human read.
    precondition (
      $input.policy == null
      || $input.document_sha256 != null
      || $writ.document_sha256 != null
    ) {
      error_type = "input"
      error = "A policy cannot be stored without the document hash it came from."
    }

    var $data = $data|set:"updated_at":"now"
    db.edit writ { field_name = "id" field_value = $writ.id data = $data }

    function.writ_assemble { writ_id = $writ.id } as $assembled
  }

  response = $assembled
}

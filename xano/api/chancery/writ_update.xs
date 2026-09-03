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
query "writ/{writ_uid}" verb=PATCH {
  description = "Advance a writ's lifecycle. Cannot alter its terms."
  api_group = "chancery"
  auth = "principal"

  input {
    text writ_uid
    enum? status? {
      values = ["draft", "pending_signature", "active", "revoked", "expired"]
    }
    text? document_url?
    text? document_sha256?
    text? envelope_id?
    json? policy?
    timestamp? anchored_at?
  }

  stack {
    function.run "audit_append" {
      input = {principal_id: $auth.id, method: "PATCH", path: "writ/{writ_uid}", ip: $env.$remote_ip, vars: {writ_uid: $input.writ_uid, status: $input.status}, ledger_sequence: null}
    }

    function.run "writ_owned" {
      input = {writ_uid: $input.writ_uid, required: true}
    } as $writ

    precondition ($writ.status != "revoked" || $input.status == null || $input.status == "revoked") {
      error_type = "accessdenied"
      error = "This writ is revoked; that is terminal."
    }

    var $data {
      value = {updated_at: now}
    }

    conditional {
      if ($input.status != null) {
        var.update $data {
          value = $data|set:"status":$input.status
        }
      }
    }
    conditional {
      if ($input.document_url != null) {
        var.update $data {
          value = $data|set:"document_url":$input.document_url
        }
      }
    }
    conditional {
      if ($input.document_sha256 != null) {
        var.update $data {
          value = $data|set:"document_sha256":$input.document_sha256
        }
      }
    }
    conditional {
      if ($input.envelope_id != null) {
        var.update $data {
          value = $data|set:"envelope_id":$input.envelope_id
        }
      }
    }
    conditional {
      if ($input.policy != null) {
        var.update $data {
          value = $data|set:"policy":$input.policy
        }
      }
    }
    conditional {
      if ($input.anchored_at != null) {
        var.update $data {
          value = $data|set:"anchored_at":$input.anchored_at
        }
      }
    }

    precondition (($data|count) > 1) {
      error_type = "inputerror"
      error = "Nothing to update."
    }

    precondition ($input.policy == null || $input.document_sha256 != null || $writ.document_sha256 != null) {
      error_type = "inputerror"
      error = "A policy cannot be stored without the document hash it came from."
    }

    db.patch "writ" {
      field_name = "id"
      field_value = $writ.id
      data = $data
    }

    function.run "writ_assemble" {
      input = {writ_id: $writ.id}
    } as $assembled
  }

  response = $assembled
}

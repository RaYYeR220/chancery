// 💳 PAID TIER. The Metadata API refuses this on the free plan with
// "Please upgrade to access middleware", so `scripts/xano-push.ts` excludes it
// unless `--include-paid` is passed. The free-tier deployment gets the same
// enforcement from `auth = "principal"` on every endpoint in the `chancery`
// group plus `writ_owned` for row scoping — this centralises the check rather
// than adding one.
//
// Centralising it is the point. Xano's pre-launch checklist calls for exactly
// this — "applied centralised middleware for cross-cutting auth" — and the
// reason is that a per-endpoint check is a per-endpoint chance to forget. The
// one endpoint somebody adds at 3am is the one that ships unauthenticated.
//
// It confirms two separate things: that a token resolved, and that the
// principal it names still exists. A deleted account whose JWT has not yet
// expired is still a valid signature over a row that is gone.
middleware "require_auth" {
  description = "Reject a request whose token does not resolve to a live principal."
  exception_policy = "critical"
  response_strategy = "merge"

  input {
    json request_data
  }

  stack {
    precondition ($auth.id != null) {
      error_type = "accessdenied"
      error = "Authentication required."
    }

    db.get "principal" {
      field_name = "id"
      field_value = $auth.id
    } as $principal

    precondition ($principal != null) {
      error_type = "accessdenied"
      error = "Authentication required."
    }
  }

  response = null
}

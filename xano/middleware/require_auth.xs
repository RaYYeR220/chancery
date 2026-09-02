// Centralised authentication. Attached to the `chancery` API group, so every
// endpoint in it is authenticated by the group's configuration rather than by
// each stack remembering to check.
//
// Xano's pre-launch checklist calls for exactly this — "applied centralised
// middleware for cross-cutting auth" — and the reason is that a per-endpoint
// check is a per-endpoint chance to forget. The one endpoint somebody adds at
// 3am is the one that ships unauthenticated.
//
// This runs `pre`, before the stack, and confirms two separate things: that a
// token was presented and resolved, and that the principal it names still
// exists. A deleted account whose JWT has not yet expired is still a valid
// signature over a row that is gone.
middleware require_auth {
  input {
    json vars
    enum type { values = ["pre", "post"] }
  }

  stack {
    conditional ($type == "pre") {
      then {
        precondition ($auth.id != null) {
          error_type = "unauthorized"
          error = "Authentication required."
        }

        db.get principal { field_name = "id" field_value = $auth.id } as $principal
        precondition ($principal != null) {
          error_type = "unauthorized"
          error = "Authentication required."
        }
      }
    }
  }

  response_strategy = "merge"
  // Never silent. A middleware whose failure is swallowed is a middleware that
  // is not enforcing anything.
  exception_policy = "critical"
}

// Append an audit row for every mutating call. Attached to every API group.
//
// Two decisions worth stating.
//
// Reads are not logged. They happen constantly, they prove nothing, and burying
// the twelve state changes of the day under forty thousand GETs is how an audit
// log becomes something nobody reads.
//
// `exception_policy = "critical"`, so a call whose audit row cannot be written
// fails. That is the uncomfortable choice and it is deliberate: Chancery fails
// closed everywhere else — an unavailable diligence check denies the act rather
// than waving it through — and an unrecorded mutation is worse than a refused
// one. The alternative is a system that quietly stops keeping records exactly
// when it is under stress.
//
// This is the access log, not the chain. The ledger records what Chancery
// DECIDED and is published; this records who called what and stays private.
middleware audit_mutation {
  input {
    json vars
    enum type { values = ["pre", "post"] }
  }

  stack {
    // Post, so the row records a call that actually reached its stack, and so a
    // request rejected by `require_auth` is not logged as an attempted mutation
    // by a principal that was never authenticated.
    conditional (
      $type == "post"
      && ($request.method == "POST" || $request.method == "PATCH" || $request.method == "PUT" || $request.method == "DELETE")
    ) {
      then {
        function.audit_append {
          principal_id = $auth.id
          method = $request.method
          path = $request.path
          ip = $request.ip
          // Xano's `password` type is not readable back out of a request var, so
          // signup and login inputs arrive here already redacted.
          vars = $vars
        }
      }
    }
  }

  response_strategy = "merge"
  exception_policy = "critical"
}

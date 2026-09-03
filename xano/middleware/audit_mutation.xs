// 💳 PAID TIER. Excluded from the free-tier push; see `require_auth`. On free
// the same rows are written by an explicit `function.run "audit_append"` at the
// top of every mutating endpoint, which is the identical work without the
// centralisation.
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
middleware "audit_mutation" {
  description = "Append an audit row for every mutating call."
  exception_policy = "critical"
  response_strategy = "merge"

  input {
    json request_data
  }

  stack {
    conditional {
      if ($env.$request_method == "POST" || $env.$request_method == "PATCH" || $env.$request_method == "PUT" || $env.$request_method == "DELETE") {
        function.run "audit_append" {
          input = {principal_id: $auth.id, method: $env.$request_method, path: $env.$request_uri, ip: $env.$remote_ip, vars: $input.request_data, ledger_sequence: null}
        }
      }
    }
  }

  response = null
}

// POST /auth/signup
//
// Rate limited by IP because signup is one of the two obvious harvest targets on
// any backend, and the free tier's own throughput cap is not a security control:
// it is shared across the whole workspace, so a scripted signup flood would take
// the entire product down rather than just being throttled.
//
// The audit row is written by an explicit call rather than by middleware.
// Middleware is an Essential-plan feature — the Metadata API refuses a
// `middleware` definition on free with "Please upgrade to access middleware" —
// so the cross-cutting concern is a function every mutating endpoint calls.
query "auth/signup" verb=POST {
  description = "Create a principal and issue a JWT."
  api_group = "auth"

  input {
    text legal_name filters=trim
    email email filters=trim|lower
    text password filters=min:12
  }

  stack {
    function.run "rate_guard" {
      input = {path: "auth/signup", max: 5, window_seconds: 900}
    }

    function.run "audit_append" {
      input = {principal_id: null, method: "POST", path: "auth/signup", ip: $env.$remote_ip, vars: {email: $input.email}, ledger_sequence: null}
    }

    db.get "principal" {
      field_name = "email"
      field_value = $input.email
    } as $existing

    precondition ($existing == null) {
      error_type = "accessdenied"
      error = "That email already has a Chancery account."
    }

    security.create_uuid {
    } as $uid

    db.add "principal" {
      data = {
        uid: $uid,
        legal_name: $input.legal_name,
        email: $input.email,
        password: $input.password,
        entity_verified: false
      }
    } as $principal

    security.create_auth_token {
      table = "principal"
      id = $principal.id
      extras = {}
      expiration = 86400
    } as $authToken
  }

  response = {
    authToken: $authToken,
    principal: {
      id: $principal.uid,
      legal_name: $principal.legal_name,
      email: $principal.email,
      entity_verified: $principal.entity_verified
    }
  }
}

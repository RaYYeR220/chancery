// POST /auth/login
//
// Both failure branches — no such account, wrong password — return the same
// message and the same status. Distinguishing them turns the endpoint into a
// membership oracle over the customer list, and a principal's email is exactly
// the thing an attacker wants to confirm before phishing a signature out of them.
query "auth/login" verb=POST {
  description = "Exchange credentials for a JWT."
  api_group = "auth"

  input {
    email email filters=trim|lower
    text password
  }

  stack {
    function.run "rate_guard" {
      input = {path: "auth/login", max: 10, window_seconds: 900}
    }

    function.run "audit_append" {
      input = {principal_id: null, method: "POST", path: "auth/login", ip: $env.$remote_ip, vars: {email: $input.email}, ledger_sequence: null}
    }

    db.get "principal" {
      field_name = "email"
      field_value = $input.email
    } as $principal

    precondition ($principal != null) {
      error_type = "accessdenied"
      error = "Invalid credentials."
    }

    security.check_password {
      text_password = $input.password
      hash_password = $principal.password
    } as $valid

    precondition ($valid == true) {
      error_type = "accessdenied"
      error = "Invalid credentials."
    }

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

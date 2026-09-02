// POST /auth/login
//
// Both failure branches — no such account, wrong password — return the same
// message and the same status. Distinguishing them turns the endpoint into a
// membership oracle over the customer list, and a principal's email is exactly
// the thing an attacker wants to confirm before phishing a signature out of them.
//
// Rate limited on the email, not only the IP: an attacker spraying one password
// across many accounts from a rotating pool is the shape this catches.
query auth/login verb=POST {
  description = "Exchange credentials for a JWT."

  input {
    email email? filters=trim|lower
    text password?
  }

  stack {
    security.rate_limit {
      key = ("login:" ~ $input.email)
      max = 10
      ttl = 900
      error = "Too many attempts for that account. Try again later."
    }

    db.get principal { field_name = "email" field_value = $input.email } as $principal
    precondition ($principal != null) {
      error_type = "accessdenied"
      error = "Invalid credentials."
    }

    security.validate_password {
      password = $input.password
      hash = $principal.password
    } as $valid
    precondition ($valid == true) {
      error_type = "accessdenied"
      error = "Invalid credentials."
    }

    security.create_auth_token {
      table = "principal"
      extras = {}
      expiration = 86400
      id = $principal.id
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

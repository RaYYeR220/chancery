// POST /auth/signup
//
// Rate limited by IP because signup is one of the two obvious harvest targets on
// any backend, and the free tier's own throughput cap is not a security control:
// it is shared across the whole workspace, so a scripted signup flood would take
// the entire product down rather than just being throttled.
query auth/signup verb=POST {
  description = "Create a principal and issue a JWT."

  input {
    text legal_name? filters=trim
    email email? filters=trim|lower
    // Length is enforced by the column filter too; stating it here means a bad
    // password is rejected before a row is attempted.
    text password? filters=min:12
  }

  stack {
    security.rate_limit {
      key = ("signup:" ~ $request.ip)
      max = 5
      ttl = 900
      error = "Too many signup attempts. Try again later."
    }

    db.get principal { field_name = "email" field_value = $input.email } as $existing
    precondition ($existing == null) {
      error_type = "accessdenied"
      error = "That email already has a Chancery account."
    }

    security.uuid {} as $uid
    db.add principal {
      data = {
        created_at: "now",
        uid: $uid,
        legal_name: $input.legal_name,
        email: $input.email,
        password: $input.password,
        // Never settable from a request. It becomes true only when the
        // diligence service corroborates the entity against live web data.
        entity_verified: false
      }
    } as $principal

    security.create_auth_token {
      table = "principal"
      extras = {}
      expiration = 86400
      id = $principal.id
    } as $authToken
  }

  // The password column is never in this shape, and neither is the row id.
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

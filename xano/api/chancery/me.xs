// GET /me
//
// Answers only about the token holder. There is no `GET /principal/{id}` in this
// workspace, because there is no reason for one to exist and every reason for it
// not to.
query "me" verb=GET {
  description = "The authenticated principal."
  api_group = "chancery"
  auth = "principal"

  input {
  }

  stack {
    db.get "principal" {
      field_name = "id"
      field_value = $auth.id
    } as $principal

    precondition ($principal != null) {
      error_type = "accessdenied"
      error = "Authentication required."
    }
  }

  response = {
    id: $principal.uid,
    legal_name: $principal.legal_name,
    email: $principal.email,
    entity_verified: $principal.entity_verified
  }
}

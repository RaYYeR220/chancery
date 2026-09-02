// Signup and login only. Deliberately its own group so that the group-level
// authentication requirement on `chancery` does not have to be punched a hole
// in — the two endpoints that legitimately run unauthenticated live somewhere
// that has no authenticated endpoints to leak past.
//
// Swagger is private: an unauthenticated, publicly readable schema of the auth
// surface is a free map for anyone enumerating it.
//
// CORS is an explicit allowlist. A wildcard here would let any page a principal
// happens to have open post their credentials to us and read the token back.
apigroup auth {
  description = "Credential exchange. Two endpoints, both rate limited."
  canonical = "auth"
  swagger = "private"
  external_access = true

  cors = {
    origins = ["{{ $env.CONSOLE_ORIGIN }}"]
    methods = ["POST", "OPTIONS"]
    headers = ["content-type"]
    credentials = false
    max_age = 600
  }

  middleware = ["audit_mutation"]
}

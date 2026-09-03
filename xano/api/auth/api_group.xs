// Signup and login only. Deliberately its own group so that the authentication
// requirement on `chancery` never has to be punched a hole in — an
// unauthenticated endpoint sitting inside an otherwise-authenticated group is
// precisely the mistake Xano's own guidance names as most common.
//
// `canonical` must be unique across the whole INSTANCE, not just this
// workspace, because Xano routes between workspaces on it. Hence the
// `chancery-` prefix on every group here: a bare `auth` would eventually
// collide with somebody else's.
//
// Swagger visibility is not set here on purpose. XanoScript's only control is
// `swagger = {token: "..."}`, and the docs are explicit that the token is
// stored in plain text — committing one would put a credential in git to
// protect a schema. It is set to Private in the workspace UI instead.
api_group "auth" {
  description = "Credential exchange. Two endpoints, both rate limited."
  canonical = "chancery-auth"
  tags = ["chancery", "auth"]
}

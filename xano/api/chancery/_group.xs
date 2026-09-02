// The authenticated surface. Every endpoint in this group requires a JWT, and
// there are no exceptions inside it — the endpoints that legitimately run
// without one live in `auth` and `public`, which is the whole reason those
// groups exist. Xano's own security guidance names the most common
// application-level mistake as "leaving auto-generated endpoints reachable and
// unauthenticated"; a group with no unauthenticated members cannot acquire one
// by accident.
//
// There is no auto-generated CRUD anywhere in this workspace. Every endpoint
// below is hand-written, assembles a domain object rather than returning a row,
// and scopes to `$auth.id` through `writ_owned` rather than trusting the
// identifier in the path.
apigroup chancery {
  description = "Writ registry, act history, ledger and receipts. JWT only."
  canonical = "chancery"
  swagger = "private"
  external_access = true

  authentication = { table = "principal" }

  cors = {
    // Explicit allowlist, not `*`. With credentials enabled a wildcard is not
    // merely loose, it is the browser handing any origin a principal visits the
    // ability to act as them.
    origins = ["{{ $env.CONSOLE_ORIGIN }}"]
    methods = ["GET", "POST", "PATCH", "OPTIONS"]
    headers = ["authorization", "content-type"]
    credentials = true
    max_age = 600
  }

  middleware = ["require_auth", "audit_mutation"]
}

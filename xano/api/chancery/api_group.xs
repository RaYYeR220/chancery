// The authenticated surface. Every endpoint in this group declares
// `auth = "principal"`, and there are no exceptions inside it — the endpoints
// that legitimately run without a token live in `auth` and `public`, which is
// the whole reason those groups exist.
//
// Xano's security guidance names the most common application-level mistake as
// "leaving auto-generated endpoints reachable and unauthenticated". A group
// whose every member declares auth cannot acquire an unauthenticated one by
// accident, and `tests/xano/backend.test.ts` asserts that property over the
// source rather than trusting it.
//
// There is no auto-generated CRUD anywhere in this workspace. Every endpoint is
// hand-written, assembles a domain object rather than returning a row, and
// scopes to `$auth.id` through `writ_owned` rather than trusting the identifier
// in the path.
api_group "chancery" {
  description = "Writ registry, act history, ledger and receipts. JWT only."
  canonical = "chancery"
  tags = ["chancery", "authenticated"]
}

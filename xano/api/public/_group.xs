// Read-only, unauthenticated, and deliberately so.
//
// Authority that only its holder can check is not authority anyone can rely on.
// A counterparty asked to accept that an agent may spend on someone's behalf has
// to be able to verify it without an account here — that is the same reason CAA
// records are public, and it is the reason this group exists.
//
// What it must therefore never expose: the policy, the principal's identity, the
// clause text, or any ledger payload. Everything here is either already public
// (a DNS name, a document hash that is in the TXT record) or a hash.
//
// CORS is open on GET only, because the whole point is that a stranger's page
// can call it. That is not the wildcard the checklist warns about: there are no
// credentials, no cookies, and nothing to steal — `credentials = false` is what
// makes an open origin list safe rather than reckless.
apigroup public {
  description = "Public verifier. No auth, no writes, no payloads."
  canonical = "verify"
  // Public and deliberately documented: the point is that anyone can use it.
  swagger = "public"
  external_access = true

  cors = {
    origins = ["*"]
    methods = ["GET", "OPTIONS"]
    headers = ["content-type"]
    credentials = false
    max_age = 3600
  }

  middleware = []
}

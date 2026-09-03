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
api_group "public" {
  description = "Public verifier. No auth, no writes, no payloads."
  canonical = "chancery-verify"
  tags = ["chancery", "public"]
}

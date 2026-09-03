// Inbound callbacks. Its own group because its trust model is different from
// everything else in the workspace: there is no JWT, the caller is
// authenticated by an HMAC over the request payload, and the only endpoint in
// it writes to one table and returns.
api_group "webhook" {
  description = "webhook-inbox: HMAC-verified, idempotent, persist-then-acknowledge."
  canonical = "chancery-hook"
  tags = ["chancery", "webhook"]
}

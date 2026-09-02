// Inbound callbacks. Its own group because its trust model is different from
// everything else in the workspace: there is no JWT, the caller is authenticated
// by an HMAC over the request bytes, and the only endpoint in it writes to one
// table and returns.
//
// Swagger is disabled outright. A publicly documented webhook endpoint tells an
// attacker exactly what body shape to forge and which header carries the
// signature they need to defeat.
//
// CORS is empty. A webhook is never called from a browser, so any preflight
// arriving here is somebody probing.
apigroup webhook {
  description = "webhook-inbox: HMAC-verified, idempotent, persist-then-acknowledge."
  canonical = "hook"
  swagger = "disabled"
  external_access = true

  cors = {
    origins = []
    methods = ["POST"]
    headers = ["content-type"]
    credentials = false
    max_age = 0
  }

  middleware = ["audit_mutation"]
}

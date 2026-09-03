// A rate limit that works without Redis.
//
// Xano's documented rate limiter is `redis.ratelimit`, and Redis is an
// Essential-plan feature — so on the free tier the pre-launch checklist item
// "add rate limiting to login, signup and other obvious harvest targets" has no
// built-in answer. This is the answer: the `audit` table already records every
// mutating call with its source IP, so counting recent rows for one path from
// one address is a throttle with no new infrastructure.
//
// It is weaker than Redis in exactly one way worth stating: the count is a
// table scan under an index rather than an atomic counter, so two requests that
// arrive in the same millisecond can both read the same count and both pass.
// For credential-harvest defence that is irrelevant — the attacker needs
// thousands of attempts, not two — and it fails closed on the volume that
// actually matters.
function "rate_guard" {
  description = "Refuse a caller that has hit this path too often from one IP."

  input {
    text path
    int max
    int window_seconds
  }

  stack {
    db.query "audit" {
      where = $db.audit.path == $input.path && $db.audit.ip == $env.$remote_ip && $db.audit.created_at > ((now|to_ms) - ($input.window_seconds * 1000))
      return = {type: "count"}
    } as $recent

    precondition ($recent < $input.max) {
      error_type = "accessdenied"
      error = "Too many attempts from this address. Try again shortly."
    }
  }

  response = {
    recent: $recent
  }
}

// webhook-inbox: per-source HMAC verification.
//
// Three things this gets right that a naive version does not.
//
// 1. The digest is computed over the RAW BYTES. Re-serialising the parsed JSON
//    reorders keys, and the signature stops matching for reasons that look like
//    the provider being broken. `$http.raw_body`, never `$input.body`.
// 2. The comparison is constant-time. A `==` on hex strings leaks the position
//    of the first differing byte through timing, which is enough to forge a
//    signature given patience and a fast network.
// 3. A timestamp window is enforced. A correctly signed request from last month
//    is still correctly signed; without a window, one captured delivery can be
//    replayed forever.
//
// The secret is referenced as `{{ $env.X }}` per source. `$env` resolves
// statically, so this is a switch on the slug rather than a lookup keyed by the
// `secret_env` column — the column documents the mapping, this stack performs it.
function webhook_verify {
  description = "Verify an inbound webhook's HMAC signature against its source."

  input {
    text slug
    text raw_body
    text signature
    text? timestamp
    int tolerance_seconds
    enum algo { values = ["sha256", "sha512"] }
  }

  stack {
    conditional ($input.slug == "foxit-esign") {
      then { var $secret = "{{ $env.FOXIT_WEBHOOK_SECRET }}" }
      else {
        conditional ($input.slug == "doctavian") {
          then { var $secret = "{{ $env.DOCTAVIAN_WEBHOOK_SECRET }}" }
          // An unknown source has no secret, so nothing can verify against it.
          // Failing closed here means adding a source is a deliberate edit.
          else { var $secret = null }
        }
      }
    }
    precondition ($secret != null && $secret != "") {
      error_type = "accessdenied"
      error = "Unknown webhook source."
    }

    // Replay window. Skipped only when the provider sends no timestamp at all,
    // in which case the delivery-id uniqueness index is the only replay defence
    // and the source row should say so.
    conditional ($input.timestamp != null) {
      then {
        var $skew = "now"|to_timestamp|subtract:($input.timestamp|to_timestamp)|abs
        precondition ($skew <= ($input.tolerance_seconds|multiply:1000)) {
          error_type = "accessdenied"
          error = "Signature timestamp outside the accepted window."
        }
      }
    }

    api.lambda {
      timeout = 5
      code = `
        const crypto = require('crypto');

        // Providers sign either the body alone or "<timestamp>.<body>". Both
        // candidates are computed and both compared, so adding a provider does
        // not mean editing this stack.
        const secret = $input.secret;
        const body = $input.raw_body;
        const algo = $input.algo;

        const candidates = [body];
        if ($input.timestamp) candidates.push($input.timestamp + '.' + body);

        // Providers also disagree on encoding; strip a scheme prefix and accept
        // hex or base64.
        const received = String($input.signature).replace(/^(sha256=|sha512=|v1=)/, '');
        const receivedBuf = /^[0-9a-f]+$/i.test(received)
          ? Buffer.from(received, 'hex')
          : Buffer.from(received, 'base64');

        for (const candidate of candidates) {
          const expected = crypto.createHmac(algo, secret).update(candidate, 'utf8').digest();
          // timingSafeEqual throws on a length mismatch, which is itself a
          // signal, so the length is checked first and reported as a plain miss.
          if (expected.length === receivedBuf.length && crypto.timingSafeEqual(expected, receivedBuf)) {
            return true;
          }
        }
        return false;
      `
      // The secret is passed as a lambda variable rather than interpolated into
      // the source, so it never appears in a stack dump or a request log.
      vars = { secret: $secret }
    } as $verified
  }

  response = { verified: $verified }
}

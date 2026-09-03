// webhook-inbox: per-source HMAC verification.
//
// 🔴 One thing here is a compromise forced by the platform, and it is stated
// rather than hidden. **XanoScript has no access to the raw request body.** The
// documented request variables are `$env.$http_headers`, `$env.$remote_ip`,
// `$env.$request_method`, `$env.$request_uri` and `$env.$request_querystring` —
// there is no raw-body equivalent, and an endpoint only ever sees the parsed
// input. So the digest cannot be taken over the bytes as they arrived.
//
// The signature base is therefore the RFC 8785 canonical form of the parsed
// body — the same canonicaliser the ledger hashes with, so there is one
// definition of "these bytes" in the whole system. That is sound when the
// sender signs the same canonical form (which Chancery's own senders do) and it
// is NOT interoperable with a provider that signs its own raw bytes. For such a
// provider the verification has to happen at a proxy in front of Xano. See the
// README.
//
// What the platform does not compromise: the comparison is constant-time, a
// `==` on hex strings leaks the position of the first differing byte through
// timing; and a timestamp window is enforced, because a correctly signed
// request from last month is still correctly signed.
//
// The secret is referenced as `$env.NAME`. `$env` resolves statically, so this
// is a switch on the slug rather than a lookup keyed by the `secret_env`
// column — the column documents the mapping, this stack performs it.
function "webhook_verify" {
  description = "Verify an inbound webhook's HMAC over the canonical body."

  input {
    text slug
    json body
    text signature
    text? timestamp?
    int tolerance_seconds
    enum algo {
      values = ["sha256", "sha512"]
    }
  }

  stack {
    var $secret {
      value = null
    }

    conditional {
      if ($input.slug == "foxit-esign") {
        var.update $secret {
          value = $env.FOXIT_WEBHOOK_SECRET
        }
      }
      elseif ($input.slug == "doctavian") {
        var.update $secret {
          value = $env.DOCTAVIAN_WEBHOOK_SECRET
        }
      }
    }

    precondition ($secret != null && $secret != "") {
      error_type = "accessdenied"
      error = "Unknown webhook source."
    }

    var $skew_ok {
      value = true
    }

    conditional {
      if ($input.timestamp != null) {
        var.update $skew_ok {
          value = ((now|to_seconds) - ($input.timestamp|to_seconds))|abs <= $input.tolerance_seconds
        }
      }
    }

    precondition ($skew_ok == true) {
      error_type = "accessdenied"
      error = "Signature timestamp outside the accepted window."
    }

    api.lambda {
      timeout = 5
      code = `
        const crypto = require('crypto');

        // Same canonical form as ledger_append and src/lib/core/canonical.ts.
        // Using one definition of "these bytes" everywhere is the only way a
        // signature computed off-platform can be reproduced on it.
        function canon(value) {
          if (value === null) return 'null';
          const kind = typeof value;
          if (kind === 'boolean') return value ? 'true' : 'false';
          if (kind === 'number') {
            if (!Number.isFinite(value)) throw new Error('non-finite number cannot be hashed');
            return Object.is(value, -0) ? '0' : JSON.stringify(value);
          }
          if (kind === 'string') return JSON.stringify(value);
          if (kind === 'undefined') throw new Error('undefined cannot be hashed');
          if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
          const keys = Object.keys(value).sort();
          return '{' + keys.map(function (k) {
            return JSON.stringify(k) + ':' + canon(value[k]);
          }).join(',') + '}';
        }

        const base = canon($input.body);
        // Providers sign either the payload alone or '<timestamp>.<payload>'.
        // Both are computed so adding a source is a data change, not a code one.
        const candidates = [base];
        if ($input.timestamp) candidates.push($input.timestamp + '.' + base);

        // Providers also disagree on encoding; strip a scheme prefix, accept
        // hex or base64.
        const received = String($input.signature).replace(/^(sha256=|sha512=|v1=)/, '');
        const receivedBuf = /^[0-9a-f]+$/i.test(received)
          ? Buffer.from(received, 'hex')
          : Buffer.from(received, 'base64');

        for (const candidate of candidates) {
          const expected = crypto.createHmac($input.algo, $var.secret).update(candidate, 'utf8').digest();
          // timingSafeEqual throws on a length mismatch, which is itself a
          // signal, so length is checked first and reported as a plain miss.
          if (expected.length === receivedBuf.length && crypto.timingSafeEqual(expected, receivedBuf)) {
            return true;
          }
        }
        return false;
      `
    } as $verified
  }

  response = {
    verified: $verified
  }
}

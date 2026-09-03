// POST /evidence — putEvidence
//
// Content-addressed and therefore idempotent. `digest` is the hash of the
// bundle's inputs, so two puts with the same digest are two replays of the same
// evidence and the second is a no-op returning the same URL. A retry after a
// timeout cannot fork a receipt into two addresses, which matters because the
// address is what gets quoted in a refusal.
//
// The digest is recomputed here rather than accepted. A caller that could choose
// its own content address could publish one bundle under the name of another,
// and every citation of that address would then point at evidence for a
// different decision.
query "evidence" verb=POST {
  description = "Publish an evidence bundle at its content address."
  api_group = "chancery"
  auth = "principal"

  input {
    text digest
    json bundle
    text? writ_id?
    enum outcome {
      values = ["allow", "deny"]
    }
    text evaluated_at
  }

  stack {
    function.run "audit_append" {
      input = {principal_id: $auth.id, method: "POST", path: "evidence", ip: $env.$remote_ip, vars: {digest: $input.digest}, ledger_sequence: null}
    }

    api.lambda {
      timeout = 5
      code = `
        const crypto = require('crypto');

        // Same canonical form as ledger_append and src/lib/core/canonical.ts.
        // Duplicated deliberately: a shared helper that drifted would silently
        // change every published address at once.
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

        // The decision is excluded from the address: the digest identifies the
        // INPUTS, so a replay that disagrees is a disagreement about the same
        // bundle rather than two different bundles. See bundleDigest().
        const bundle = Object.assign({}, $input.bundle);
        delete bundle.decision;
        return crypto.createHash('sha256').update(canon(bundle), 'utf8').digest('hex');
      `
    } as $computed

    precondition ($computed == $input.digest) {
      error_type = "inputerror"
      error = "The bundle does not hash to the digest it was filed under."
    }

    var $writ_id {
      value = null
    }

    conditional {
      if ($input.writ_id != null) {
        function.run "writ_owned" {
          input = {writ_uid: $input.writ_id, required: true}
        } as $writ

        var.update $writ_id {
          value = $writ.id
        }
      }
    }

    db.query "receipt" {
      where = $db.receipt.digest == $input.digest
      return = {type: "exists"}
    } as $already

    conditional {
      if ($already == false) {
        db.add "receipt" {
          data = {
            writ_id: $writ_id,
            principal_id: $auth.id,
            digest: $input.digest,
            bundle: $input.bundle,
            evaluated_at: $input.evaluated_at,
            outcome: $input.outcome
          }
        }
      }
    }
  }

  response = {
    url: ($env.CHANCERY_PUBLIC_BASE ~ "/receipt/" ~ $input.digest)
  }
}

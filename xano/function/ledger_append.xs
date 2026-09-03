// The only writer to `ledger`. Everything that appends to the chain comes
// through here, and nothing else may touch the table.
//
// Why the server assigns the position instead of the client: two callers that
// each read the head and then posted their own sequence would both compute the
// same next number, and one of them would be rejected by the unique index AFTER
// its payload had been accepted. Taking the tail under a row lock inside a
// transaction turns that race into a wait. The client then re-hashes what came
// back against the same canonical form — server-assigned, client-verified — so
// an entry nobody can reproduce is refused at both ends.
//
// The hash is computed in a lambda because XanoScript filters cannot express
// RFC 8785 key ordering, and an ordering that differs from the TypeScript
// canonicaliser by one character makes every entry unverifiable.
function "ledger_append" {
  description = "Append one entry to the tamper-evident chain."

  input {
    enum kind {
      values = [
        "writ.issued",
        "writ.anchored",
        "writ.revoked",
        "act.requested",
        "act.decided",
        "act.executed",
        "act.failed"
      ]
    }
    text at
    json payload
    text? writ_id?
    int? principal_id?
  }

  stack {
    db.transaction {
      stack {
        db.query "ledger" {
          sort = {sequence: "desc"}
          return = {type: "single"}
          lock = true
        } as $previous

        // GENESIS_HASH: 64 hex zeroes is what a chain of length zero links to.
        var $previous_hash {
          value = "0000000000000000000000000000000000000000000000000000000000000000"
        }
        var $sequence {
          value = 0
        }

        conditional {
          if ($previous != null) {
            var.update $previous_hash {
              value = $previous.hash
            }
            var.update $sequence {
              value = $previous.sequence + 1
            }
          }
        }

        api.lambda {
          timeout = 5
          code = `
            const crypto = require('crypto');

            // RFC 8785 in the subset src/lib/core/canonical.ts implements: keys
            // sorted by UTF-16 code unit, no insignificant whitespace, and a
            // hard refusal on values JSON cannot round-trip rather than JSON's
            // silent coercions. A hash over silently-dropped data is worse than
            // an error.
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
                if (value[k] === undefined) throw new Error('undefined property ' + k);
                return JSON.stringify(k) + ':' + canon(value[k]);
              }).join(',') + '}';
            }

            // The sequence is inside the hash, so an entry cannot be silently
            // moved to a different position in the chain.
            const body = {
              sequence: $var.sequence,
              previousHash: $var.previous_hash,
              kind: $input.kind,
              at: $input.at,
              payload: $input.payload
            };
            return crypto.createHash('sha256').update(canon(body), 'utf8').digest('hex');
          `
        } as $hash

        db.add "ledger" {
          data = {
            sequence: $sequence,
            previous_hash: $previous_hash,
            hash: $hash,
            kind: $input.kind,
            at: $input.at,
            payload: $input.payload,
            writ_id: $input.writ_id,
            principal_id: $input.principal_id
          }
        } as $entry
      }
    }
  }

  response = {
    sequence: $entry.sequence,
    previous_hash: $entry.previous_hash,
    hash: $entry.hash,
    kind: $entry.kind,
    at: $entry.at,
    payload: $entry.payload
  }
}

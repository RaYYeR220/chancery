// table/principal.xs
// The human who signs. Chancery's auth table.
//
// `uid` exists because the row id does not leave this workspace. Principal ids
// are printed into the writ and hashed into the evidence bundle, so they are
// published; a sequential integer would tell any reader how many customers
// exist and let them guess their neighbours' identifiers. The uuid is the
// external name, the int stays internal.
table principal {
  auth = true

  schema {
    int id
    timestamp created_at?=now
    uuid uid
    text legal_name filters=trim
    email email filters=trim|lower
    // Xano hashes this column; it is never selectable and never returned.
    password password filters=min:12|minAlpha:1|minDigit:1
    // Set only once the entity has been corroborated against live web data by
    // the diligence service. Never settable from a request body.
    bool entity_verified?=false
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "uid", op: "asc"}]}
    {type: "btree|unique", field: [{name: "email", op: "asc"}]}
  ]
}
---
// table/agent.xs
// The machine the authority is delegated to.
//
// `domain` is the DNS name the writ is anchored under and is therefore the
// public join key: a verifier who knows nothing but `ops.example.com` has to be
// able to reach the writ from it. It is lowercased on the way in because DNS is
// case-insensitive and a writ that only matches one casing is a writ that can be
// evaded by capitalising a letter.
//
// `external_id` is the label the principal chose for their own agent. It grants
// nothing — every authorisation check goes through `principal_id` — so echoing
// it back is not trusting an id from the request.
table agent {
  schema {
    int id
    timestamp created_at?=now
    uuid uid
    int principal_id { table = "principal" }
    text external_id filters=trim
    text label filters=trim
    text domain filters=trim|lower
    // base64url ed25519 public key, as it appears in the `k=` tag of the
    // WRIT1 DNS record.
    text public_key filters=trim
  }

  // (principal_id, domain) is unique: one agent per domain per principal. Two
  // live writs on one name would make "which authority applies" ambiguous at
  // the moment it matters most.
  //
  // The comment lives here rather than beside the entry it describes because
  // XanoScript's parser rejects `//` anywhere inside an array literal.
  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "uid", op: "asc"}]}
    {type: "btree|unique", field: [{name: "principal_id", op: "asc"}, {name: "domain", op: "asc"}]}
    {type: "btree", field: [{name: "domain", op: "asc"}]}
  ]
}
---
// table/writ.xs
// The instrument itself.
//
// `policy` holds the EnforceablePolicy read back out of the SIGNED document by
// the extractor — not the draft, and not a copy of the clause rows. It is stored
// verbatim, with the camelCase keys the domain types define, because it is
// hashed into every evidence bundle: renaming a key on the way through would
// change the digest of the same authority and invalidate published receipts.
//
// `consumed_count` and `consumed_minor_units` are derived state maintained by
// the `act_recorded` trigger. Nothing in the decision path reads them — limits
// are evaluated against act rows, not against a counter that can drift — they
// exist so the console can show a budget without replaying history.
table writ {
  schema {
    int id
    timestamp created_at?=now
    timestamp updated_at?=now
    uuid uid
    int principal_id { table = "principal" }
    int agent_id { table = "agent" }
    int version?=1
    enum status?="draft" {
      values = ["draft", "pending_signature", "active", "revoked", "expired"]
    }
    timestamp effective_from
    timestamp expires_at
    text jurisdiction filters=trim
    text? document_url
    // base64url sha256 of the signed PDF. Re-checked against DNS on every act.
    text? document_sha256
    text? envelope_id
    json? policy
    timestamp? anchored_at
    int consumed_count?=0
    int consumed_minor_units?=0
  }

  // The (status, expires_at) index is the sweep task's exact scan; without it
  // expiry becomes a full table scan every hour forever. (The note sits above
  // the block because XanoScript rejects `//` inside an array literal.)
  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "uid", op: "asc"}]}
    {type: "btree", field: [{name: "principal_id", op: "asc"}]}
    {type: "btree", field: [{name: "status", op: "asc"}, {name: "expires_at", op: "asc"}]}
    {type: "btree", field: [{name: "agent_id", op: "asc"}, {name: "created_at", op: "desc"}]}
  ]
}
---
// table/clause.xs
// One grant, as printed in the signed document.
//
// `ref` is the clause reference a human reads — "3(b)" — and it is what a
// refusal cites. That is the product: the machine does not say "denied", it says
// "denied under clause 3(b), which caps you at three registrations".
//
// `limits` and `conditions` are stored as opaque JSON in exactly the shape the
// domain types define. They are discriminated unions whose keys end up inside a
// hashed evidence bundle; splitting them into columns would mean rebuilding them
// on read, and a rebuild that reorders or renames anything changes the digest.
table clause {
  schema {
    int id
    timestamp created_at?=now
    int writ_id { table = "writ" }
    text ref filters=trim
    enum act_kind {
      values = [
        "domain.register",
        "domain.renew",
        "domain.transfer",
        "dns.write",
        "document.send_for_signature",
        "document.publish"
      ]
    }
    json limits
    json conditions
    // Printed order, so the clauses come back in the order the signer read them.
    int ordinal?=0
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "writ_id", op: "asc"}, {name: "ordinal", op: "asc"}]}
  ]
}
---
// table/act.xs
// Every irreversible act that was ASKED for, allowed or refused.
//
// The refusals are the point. An approvals system that only logs what happened
// cannot answer the question an auditor actually asks, which is what was
// attempted and turned down. So `outcome` is a column, not a filter on which
// rows get written, and `deny_codes` carries the machine-readable reasons.
//
// Only rows with `executed = true` count against a cumulative limit — a denial
// must not consume the budget it was denied by.
table act {
  schema {
    int id
    timestamp created_at?=now
    uuid uid
    int writ_id { table = "writ" }
    enum kind {
      values = [
        "domain.register",
        "domain.renew",
        "domain.transfer",
        "dns.write",
        "document.send_for_signature",
        "document.publish"
      ]
    }
    // The clause that permitted it, or "" when nothing did.
    text grant_ref?=""
    json fields
    int amount_minor_units?=0
    text currency?="USD"
    enum outcome { values = ["allow", "deny"] }
    text[]? deny_codes
    bool executed?=false
    // Vendor handle once the act was actually carried out — an order id, a
    // record id. Absent until then.
    text? reference
    timestamp? executed_at
    // Content address of the evidence bundle this decision was made from.
    text? evidence_digest
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "uid", op: "asc"}]}
    {type: "btree", field: [{name: "writ_id", op: "asc"}, {name: "executed", op: "asc"}, {name: "executed_at", op: "asc"}]}
  ]
}
---
// table/receipt.xs
// A published evidence bundle: everything one decision was derived from.
//
// Content-addressed. `digest` is the hash of the bundle's INPUTS (the decision
// is excluded from it), so two receipts with the same digest are two replays of
// the same evidence and the write is idempotent — a retry after a timeout cannot
// fork a receipt into two URLs.
//
// The bundle holds the document HASH, never the document. A writ names a
// principal and what they will spend; publishing the instrument itself is the
// principal's decision, not ours.
table receipt {
  schema {
    int id
    timestamp created_at?=now
    int? writ_id { table = "writ" }
    int? principal_id { table = "principal" }
    text digest
    json bundle
    text evaluated_at
    enum outcome { values = ["allow", "deny"] }
  }

  // The idempotency of `putEvidence` rests entirely on the unique index over
  // `digest`. (Comments cannot appear inside an array literal.)
  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "digest", op: "asc"}]}
    {type: "btree", field: [{name: "writ_id", op: "asc"}, {name: "created_at", op: "desc"}]}
  ]
}
---
// table/diligence.xs
// A check against the live world, with the sources it was derived from.
//
// `verdict` has three values and only one of them passes. `unknown` is not a
// soft `clear`: a check that could not be completed fails the condition, because
// "we could not find out" is not evidence that there is nothing to find. The
// citations are stored so a disputed refusal can be re-queried by hand.
table diligence {
  schema {
    int id
    timestamp created_at?=now
    int? act_id { table = "act" }
    int? writ_id { table = "writ" }
    enum check {
      values = [
        "trademark_clear",
        "no_brand_collision",
        "counterparty_exists",
        "no_adverse_media",
        "no_patent_litigation"
      ]
    }
    enum verdict { values = ["clear", "flagged", "unknown"] }
    text summary
    // [{ title, url, engine }] exactly as the diligence service returned them.
    json citations
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "act_id", op: "asc"}]}
    {type: "btree", field: [{name: "writ_id", op: "asc"}, {name: "created_at", op: "desc"}]}
  ]
}
---
// table/ledger.xs
// The append-only hash chain. One writer only: the `ledger_append` function.
//
// `at` is TEXT, deliberately, and this is the single most important line in the
// schema. That exact string is inside the hash. A `timestamp` column would
// normalise it — reformat, shift zone, round the millisecond — and every entry
// written before the reformat would stop verifying. The chain is only worth
// having if it can be recomputed byte for byte years later.
//
// `writ_id` and `principal_id` are denormalised out of the payload so a read can
// be scoped to the caller without trusting an id from the request. Neither is
// hashed: they are an index, not evidence.
//
// The unique index on `sequence` is what makes concurrent appends safe. Two
// racing writers that both computed the same next position cannot both land;
// the loser is rolled back with its transaction rather than silently producing
// a fork.
table ledger {
  schema {
    int id
    timestamp created_at?=now
    int sequence
    // 64 hex zeroes for the first entry. See GENESIS_HASH.
    text previous_hash
    text hash
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
    text? writ_id
    int? principal_id { table = "principal" }
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "sequence", op: "asc"}]}
    {type: "btree|unique", field: [{name: "hash", op: "asc"}]}
    {type: "btree", field: [{name: "writ_id", op: "asc"}, {name: "sequence", op: "asc"}]}
    {type: "btree", field: [{name: "principal_id", op: "asc"}, {name: "sequence", op: "asc"}]}
  ]
}
---
// table/audit.xs
// Access log for mutating calls, written by the `audit_mutation` middleware.
//
// Distinct from the ledger on purpose. The ledger records what Chancery
// DECIDED — it is evidence, it is hashed, and it is published. This records who
// called what, which is operational and private. Conflating them would either
// put request metadata inside published receipts or leave mutations
// unattributable; neither is acceptable, so there are two tables.
table audit {
  schema {
    int id
    timestamp created_at?=now
    int? principal_id { table = "principal" }
    text method
    text path
    text? ip
    // Request inputs as the middleware saw them. Password inputs never reach
    // here: Xano's `password` type is not readable back out of a request var.
    json vars
    // Set when the same call also appended to the chain, so an operational
    // record can be tied to the evidence it produced.
    int? ledger_sequence
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "principal_id", op: "asc"}, {name: "created_at", op: "desc"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
  ]
}
---
// table/job.xs
// Durable job queue — the `job-retry` module from github.com/xano-community,
// carrying the acts Chancery has already decided it is allowed to commit.
//
// Enqueue, claim, complete, fail. The three columns that make it durable rather
// than decorative:
//
//   idempotency_key  unique. The same act enqueued twice runs once. This is the
//                    difference between a retried registration and two domains.
//   run_after        when the job becomes claimable again. Exponential backoff
//                    writes the future into this column instead of sleeping.
//   claim_token      who holds it. A worker that dies mid-job leaves a stale
//                    claim, and `reap_stale_claims` returns it to the pool —
//                    without it, one crash removes a job from the world.
table job {
  schema {
    int id
    timestamp created_at?=now
    uuid uid
    // "act.execute" | "webhook.esign" | "writ.notify"
    text kind filters=trim
    text idempotency_key filters=trim
    json payload
    enum status?="pending" {
      values = ["pending", "claimed", "done", "failed", "dead"]
    }
    int attempts?=0
    int max_attempts?=6
    timestamp run_after?=now
    timestamp? claimed_at
    text? claim_token
    text? last_error
    timestamp? completed_at
    // Every attempt's error, kept so a dead letter explains itself instead of
    // showing only the last thing that went wrong.
    json? attempt_log
  }

  // The last index is the claim query's exact shape: due, pending, oldest
  // first. (Comments cannot appear inside an array literal, so it is described
  // here rather than beside it.)
  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "uid", op: "asc"}]}
    {type: "btree|unique", field: [{name: "kind", op: "asc"}, {name: "idempotency_key", op: "asc"}]}
    {type: "btree", field: [{name: "status", op: "asc"}, {name: "run_after", op: "asc"}]}
  ]
}
---
// table/job_dead_letter.xs
// The dead-letter tier.
//
// A job that exhausted its attempts is copied here and left alone. It is a
// separate table rather than a status because these rows are read by a human,
// not by the worker: mixing them into the queue means the thing you most need to
// notice is buried under thousands of completed rows.
//
// Nothing retries out of here automatically. An act that failed six times with
// backoff is not a transient failure, and Chancery's whole posture is that the
// machine does not decide to try an irreversible thing again on its own.
table job_dead_letter {
  schema {
    int id
    timestamp created_at?=now
    int job_id { table = "job" }
    text kind
    text idempotency_key
    json payload
    int attempts
    text last_error
    json attempt_log
    // Set when a human explicitly re-queued it, so the second life is attributable.
    timestamp? replayed_at
    int? replayed_by { table = "principal" }
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
    {type: "btree|unique", field: [{name: "job_id", op: "asc"}]}
  ]
}
---
// table/webhook_source.xs
// One row per system allowed to call the inbox — the `webhook-inbox` module
// from github.com/xano-community.
//
// `secret_env` holds the NAME of the environment variable, never the secret.
// XanoScript resolves `{{ $env.X }}` statically, so the verifier switches on
// `slug` to reach the literal reference; this column exists so the mapping is
// visible in the data rather than only in a function stack, and so a rotation is
// a documented change instead of an archaeology exercise.
//
// `tolerance_seconds` bounds replay: a correctly signed request from last month
// is still a correctly signed request, and without a timestamp window a captured
// delivery can be resent forever.
table webhook_source {
  schema {
    int id
    timestamp created_at?=now
    text slug filters=trim|lower
    text label
    text secret_env
    enum algo?="sha256" { values = ["sha256", "sha512"] }
    text signature_header
    text? timestamp_header
    // The provider's own delivery id, used as the idempotency key.
    text? delivery_id_header
    int tolerance_seconds?=300
    bool active?=true
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "slug", op: "asc"}]}
  ]
}
---
// table/webhook_request.xs
// Every inbound webhook request, verified or not, kept.
//
// Rejected deliveries are stored too. A forged callback claiming a writ was
// signed is exactly the attack this product exists to stop, and the record of
// the attempt is worth more than the disk it costs.
//
// `raw_body` is the bytes as they arrived. The HMAC is computed over those
// bytes; re-serialising the parsed object reorders keys and the digest stops
// matching, which presents as "the provider's signatures are wrong" and wastes
// a day.
table webhook_request {
  schema {
    int id
    timestamp created_at?=now
    uuid uid
    int source_id { table = "webhook_source" }
    text? delivery_id
    text? signature
    bool verified?=false
    enum status?="received" {
      values = ["received", "queued", "processed", "replayed", "rejected"]
    }
    json headers
    text raw_body
    text? error
    timestamp? processed_at
  }

  // Idempotent replay handling lives in the unique (source_id, delivery_id)
  // index: the provider retries until it sees a 200, and that index is what
  // makes the second delivery a lookup instead of a second signature.
  // (Comments cannot appear inside an array literal.)
  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "uid", op: "asc"}]}
    {type: "btree|unique", field: [{name: "source_id", op: "asc"}, {name: "delivery_id", op: "asc"}]}
    {type: "btree", field: [{name: "status", op: "asc"}, {name: "created_at", op: "asc"}]}
  ]
}
---
// function/ledger_append.xs
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
          code = "const crypto = require('crypto');\n\n// RFC 8785 in the subset src/lib/core/canonical.ts implements: keys\n// sorted by UTF-16 code unit, no insignificant whitespace, and a\n// hard refusal on values JSON cannot round-trip rather than JSON's\n// silent coercions. A hash over silently-dropped data is worse than\n// an error.\nfunction canon(value) {\n  if (value === null) return 'null';\n  const kind = typeof value;\n  if (kind === 'boolean') return value ? 'true' : 'false';\n  if (kind === 'number') {\n    if (!Number.isFinite(value)) throw new Error('non-finite number cannot be hashed');\n    return Object.is(value, -0) ? '0' : JSON.stringify(value);\n  }\n  if (kind === 'string') return JSON.stringify(value);\n  if (kind === 'undefined') throw new Error('undefined cannot be hashed');\n  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';\n  const keys = Object.keys(value).sort();\n  return '{' + keys.map(function (k) {\n    if (value[k] === undefined) throw new Error('undefined property ' + k);\n    return JSON.stringify(k) + ':' + canon(value[k]);\n  }).join(',') + '}';\n}\n\n// The sequence is inside the hash, so an entry cannot be silently\n// moved to a different position in the chain.\nconst body = {\n  sequence: $var.sequence,\n  previousHash: $var.previous_hash,\n  kind: $input.kind,\n  at: $input.at,\n  payload: $input.payload\n};\nreturn crypto.createHash('sha256').update(canon(body), 'utf8').digest('hex');"
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
---
// function/audit_append.xs
// Write one access-log row.
//
// Kept as a function rather than inlined so every mutating endpoint records the
// call the same way, and so the task workers — which mutate the same tables
// outside any request — can call it with the same shape.
//
// This would be middleware if middleware were available. It is not: the
// Metadata API rejects a `middleware` definition on the free plan with
// "Please upgrade to access middleware", so the cross-cutting concern is a
// function every mutating endpoint calls explicitly. See the README.
function "audit_append" {
  description = "Record a mutating call against the principal that made it."

  input {
    int? principal_id?
    text method
    text path
    text? ip?
    json? vars?
    int? ledger_sequence?
  }

  stack {
    db.add "audit" {
      data = {
        principal_id: $input.principal_id,
        method: $input.method,
        path: $input.path,
        ip: $input.ip,
        vars: $input.vars,
        ledger_sequence: $input.ledger_sequence
      }
    } as $row
  }

  response = {
    id: $row.id
  }
}
---
// function/writ_assemble.xs
// Build the domain object the API returns, out of the four tables it lives in.
//
// This function is the reason there are no auto-generated CRUD endpoints on
// `writ`. A raw row is not a writ: it has no principal, no agent, no clauses,
// and integer foreign keys that mean nothing outside this workspace. Every read
// path assembles the instrument, so there is exactly one shape a consumer ever
// sees and exactly one place to change it.
//
// Timestamps go out as the raw epoch-millisecond column values rather than
// formatted strings. XanoScript's `format_timestamp` needs escaped literals to
// emit ISO-8601 and every escape is a chance to silently produce a date the
// engine cannot parse; the TypeScript adapter already normalises epoch millis to
// ISO on the way in, so the conversion happens once, in the place that has tests.
function "writ_assemble" {
  description = "Assemble a StoredWrit from writ + principal + agent + clauses."

  input {
    int writ_id
  }

  stack {
    db.get "writ" {
      field_name = "id"
      field_value = $input.writ_id
    } as $writ

    precondition ($writ != null) {
      error_type = "notfound"
      error = "No such writ."
    }

    db.get "principal" {
      field_name = "id"
      field_value = $writ.principal_id
    } as $principal

    db.get "agent" {
      field_name = "id"
      field_value = $writ.agent_id
    } as $agent

    db.query "clause" {
      where = $db.clause.writ_id == $writ.id
      sort = {ordinal: "asc"}
      return = {type: "list"}
    } as $clauses

    var $grants {
      value = []
    }

    foreach ($clauses) {
      each as $clause {
        var.update $grants {
          value = $grants|push:{ref: $clause.ref, act_kind: $clause.act_kind, limits: $clause.limits, conditions: $clause.conditions}
        }
      }
    }
  }

  response = {
    id: $writ.uid,
    status: $writ.status,
    spec: {
      principal: {
        id: $principal.uid,
        legal_name: $principal.legal_name,
        email: $principal.email,
        entity_verified: $principal.entity_verified
      },
      agent: {
        id: $agent.external_id,
        label: $agent.label,
        domain: $agent.domain,
        public_key: $agent.public_key
      },
      grants: $grants,
      effective_from: $writ.effective_from,
      expires_at: $writ.expires_at,
      jurisdiction: $writ.jurisdiction
    },
    document_url: $writ.document_url,
    document_sha256: $writ.document_sha256,
    envelope_id: $writ.envelope_id,
    policy: $writ.policy,
    anchored_at: $writ.anchored_at
  }
}
---
// function/writ_owned.xs
// Resolve a writ uid to a row the CALLER is allowed to touch.
//
// Xano's own security guidance names the failure this prevents as the most
// common application-level mistake: trusting an id that arrived in the request.
// The uid in the path is not an authorisation — the `principal_id == $auth.id`
// clause is. Every authenticated endpoint that names a writ starts here, so
// there is one implementation of the check and no endpoint can forget it.
//
// A writ belonging to someone else is reported as absent, not as forbidden.
// "403" on another principal's uid confirms that the uid exists, which is a
// membership oracle over the whole registry.
function "writ_owned" {
  description = "Look up a writ by uid, scoped to the authenticated principal."

  input {
    text writ_uid
    bool required
  }

  stack {
    db.query "writ" {
      where = $db.writ.uid == $input.writ_uid && $db.writ.principal_id == $auth.id
      return = {type: "single"}
    } as $writ

    precondition ($writ != null || $input.required == false) {
      error_type = "notfound"
      error = "No such writ."
    }
  }

  response = $writ
}
---
// function/job_enqueue.xs
// job-retry: enqueue.
//
// Idempotent by construction. The unique index on (kind, idempotency_key) means
// the same act cannot be queued twice, and the function returns the EXISTING job
// rather than raising — a duplicate enqueue is a retry of something that already
// worked, not an error to surface to whoever is retrying.
//
// For an act the key is the act's uid, so the trigger can fire twice (a
// re-delivery, a replayed transaction) and the domain is still bought once.
function "job_enqueue" {
  description = "Enqueue durable work, at most once per idempotency key."

  input {
    text kind
    text idempotency_key
    json payload
    int? max_attempts?
    int? delay_seconds?
  }

  stack {
    db.query "job" {
      where = $db.job.kind == $input.kind && $db.job.idempotency_key == $input.idempotency_key
      return = {type: "single"}
    } as $existing

    var $job {
      value = $existing
    }

    conditional {
      if ($existing == null) {
        security.create_uuid {
        } as $uid

        db.add "job" {
          data = {
            uid: $uid,
            kind: $input.kind,
            idempotency_key: $input.idempotency_key,
            payload: $input.payload,
            status: "pending",
            attempts: 0,
            max_attempts: ($input.max_attempts|first_notnull:6),
            run_after: ((now|to_ms) + (($input.delay_seconds|first_notnull:0) * 1000)),
            attempt_log: []
          }
        } as $created

        var.update $job {
          value = $created
        }
      }
    }
  }

  response = {
    id: $job.id,
    uid: $job.uid,
    status: $job.status,
    created: $existing == null
  }
}
---
// function/job_claim.xs
// job-retry: claim.
//
// A claim is a lease, not a handover. The worker stamps its token and the time,
// and `reap_stale_claims` gives the job back if that lease is never released —
// otherwise one worker timing out removes a job from the world permanently,
// which for an act the principal already authorised is the worst outcome
// available: silently nothing happens.
//
// The select and the stamp are in one transaction with a row lock, so two
// workers cannot lease the same job. `run_after <= now` is the whole backoff
// mechanism: a failed job writes its next attempt into the future and simply
// stops matching this query until then.
function "job_claim" {
  description = "Lease up to `limit` due jobs of one kind."

  input {
    text kind
    int? limit?
  }

  stack {
    security.create_uuid {
    } as $claim_token

    var $claimed {
      value = []
    }

    db.transaction {
      stack {
        db.query "job" {
          where = $db.job.kind == $input.kind && $db.job.status == "pending" && $db.job.run_after <= now
          sort = {run_after: "asc"}
          lock = true
          return = {type: "list", paging: {page: 1, per_page: ($input.limit|first_notnull:10)}}
        } as $due

        foreach ($due) {
          each as $job {
            db.edit "job" {
              field_name = "id"
              field_value = $job.id
              data = {
                status: "claimed",
                claimed_at: now,
                claim_token: $claim_token
              }
            } as $updated

            var.update $claimed {
              value = $claimed|push:$updated
            }
          }
        }
      }
    }
  }

  response = {
    claim_token: $claim_token,
    jobs: $claimed
  }
}
---
// function/job_complete.xs
// job-retry: complete.
//
// The claim token is checked, not just the id. A worker whose lease was already
// reaped and whose job was handed to somebody else must not be able to mark it
// done from under them — that is how a job runs twice and reports success once.
function "job_complete" {
  description = "Release a leased job as done."

  input {
    int job_id
    text claim_token
  }

  stack {
    db.get "job" {
      field_name = "id"
      field_value = $input.job_id
    } as $job

    precondition ($job != null) {
      error_type = "notfound"
      error = "No such job."
    }

    precondition ($job.claim_token == $input.claim_token) {
      error_type = "accessdenied"
      error = "This lease is no longer held."
    }

    db.edit "job" {
      field_name = "id"
      field_value = $job.id
      data = {
        status: "done",
        completed_at: now,
        claim_token: null,
        last_error: null
      }
    } as $done
  }

  response = {
    id: $done.id,
    status: $done.status
  }
}
---
// function/job_fail.xs
// job-retry: fail, with exponential backoff and a dead-letter tier.
//
// The backoff is 2^attempts seconds with FULL JITTER — a uniform pick from
// [0, 2^n) rather than the exact power. Without jitter, an upstream outage
// synchronises every failed job onto the same retry instant, and the moment the
// upstream recovers it is hit by the entire backlog at once. That is how a
// retry queue turns one outage into two.
//
// After `max_attempts` the job is copied to `job_dead_letter` and left there.
// Nothing retries out of the dead letter automatically: a registration that has
// failed six times over an hour is not a transient failure, and this product's
// entire posture is that a machine does not decide on its own to try an
// irreversible thing again.
function "job_fail" {
  description = "Record a failed attempt, back off, or dead-letter."

  input {
    int job_id
    text claim_token
    text error
  }

  stack {
    db.get "job" {
      field_name = "id"
      field_value = $input.job_id
    } as $job

    precondition ($job != null) {
      error_type = "notfound"
      error = "No such job."
    }

    precondition ($job.claim_token == $input.claim_token) {
      error_type = "accessdenied"
      error = "This lease is no longer held."
    }

    var $attempts {
      value = $job.attempts + 1
    }

    var $log {
      value = ($job.attempt_log|first_notnull:[])|push:{attempt: $attempts, at: now, error: $input.error}
    }

    var $updated {
      value = null
    }

    conditional {
      if ($attempts >= $job.max_attempts) {
        db.add "job_dead_letter" {
          data = {
            job_id: $job.id,
            kind: $job.kind,
            idempotency_key: $job.idempotency_key,
            payload: $job.payload,
            attempts: $attempts,
            last_error: $input.error,
            attempt_log: $log
          }
        }

        db.edit "job" {
          field_name = "id"
          field_value = $job.id
          data = {
            status: "dead",
            attempts: $attempts,
            last_error: $input.error,
            attempt_log: $log,
            claim_token: null
          }
        } as $dead

        var.update $updated {
          value = $dead
        }
      }
      else {
        security.random_number {
          min = 0
          max = (2|pow:$attempts)
        } as $jitter

        db.edit "job" {
          field_name = "id"
          field_value = $job.id
          data = {
            status: "pending",
            attempts: $attempts,
            last_error: $input.error,
            attempt_log: $log,
            claim_token: null,
            claimed_at: null,
            run_after: ((now|to_ms) + (($jitter|num_max:1) * 1000))
          }
        } as $backed_off

        var.update $updated {
          value = $backed_off
        }
      }
    }
  }

  response = {
    id: $updated.id,
    status: $updated.status,
    attempts: $updated.attempts,
    run_after: $updated.run_after
  }
}
---
// function/webhook_verify.xs
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
      code = "const crypto = require('crypto');\n\n// Same canonical form as ledger_append and src/lib/core/canonical.ts.\n// Using one definition of \"these bytes\" everywhere is the only way a\n// signature computed off-platform can be reproduced on it.\nfunction canon(value) {\n  if (value === null) return 'null';\n  const kind = typeof value;\n  if (kind === 'boolean') return value ? 'true' : 'false';\n  if (kind === 'number') {\n    if (!Number.isFinite(value)) throw new Error('non-finite number cannot be hashed');\n    return Object.is(value, -0) ? '0' : JSON.stringify(value);\n  }\n  if (kind === 'string') return JSON.stringify(value);\n  if (kind === 'undefined') throw new Error('undefined cannot be hashed');\n  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';\n  const keys = Object.keys(value).sort();\n  return '{' + keys.map(function (k) {\n    return JSON.stringify(k) + ':' + canon(value[k]);\n  }).join(',') + '}';\n}\n\nconst base = canon($input.body);\n// Providers sign either the payload alone or '<timestamp>.<payload>'.\n// Both are computed so adding a source is a data change, not a code one.\nconst candidates = [base];\nif ($input.timestamp) candidates.push($input.timestamp + '.' + base);\n\n// Providers also disagree on encoding; strip a scheme prefix, accept\n// hex or base64.\nconst received = String($input.signature).replace(/^(sha256=|sha512=|v1=)/, '');\nconst receivedBuf = /^[0-9a-f]+$/i.test(received)\n  ? Buffer.from(received, 'hex')\n  : Buffer.from(received, 'base64');\n\nfor (const candidate of candidates) {\n  const expected = crypto.createHmac($input.algo, $var.secret).update(candidate, 'utf8').digest();\n  // timingSafeEqual throws on a length mismatch, which is itself a\n  // signal, so length is checked first and reported as a plain miss.\n  if (expected.length === receivedBuf.length && crypto.timingSafeEqual(expected, receivedBuf)) {\n    return true;\n  }\n}\nreturn false;"
    } as $verified
  }

  response = {
    verified: $verified
  }
}
---
// function/act_execute.xs
// Carry out one act that the gate already allowed. Runs inside the queue worker.
//
// The decision is NOT re-made here. It was made against a signed instrument, DNS
// and live diligence, and packaged into a receipt; re-deciding in the worker
// would mean two places could reach the registrar with two different answers.
// What this does check is that the act row is still `allow` and still
// un-executed, because between the decision and the lease a human may have
// revoked the writ — and a revocation that arrives while a job is queued has to
// win.
//
// The registrar's idempotency key is the act's uid, not a fresh uuid. A timeout
// on a registration is not evidence that nothing was bought, and replaying the
// same key is the only safe way to find out.
function "act_execute" {
  description = "Execute one allowed act against its vendor, exactly once."

  input {
    json job
  }

  stack {
    db.get "act" {
      field_name = "id"
      field_value = $input.job.payload.act_id
    } as $act

    precondition ($act != null) {
      error_type = "notfound"
      error = "No such act."
    }

    var $reference {
      value = $act.reference
    }

    conditional {
      if ($act.executed == false) {
        db.get "writ" {
          field_name = "id"
          field_value = $act.writ_id
        } as $writ

        precondition ($writ != null) {
          error_type = "notfound"
          error = "No such writ."
        }

        precondition ($writ.status == "active") {
          error_type = "accessdenied"
          error = "The writ is no longer active; this act will not be carried out."
        }

        precondition ($act.outcome == "allow") {
          error_type = "accessdenied"
          error = "This act was refused."
        }

        precondition ($act.kind == "domain.register") {
          error_type = "standard"
          error = "No executor wired for this act kind."
        }

        api.request {
          url = "https://api.name.com/core/v1/domains"
          method = "POST"
          params = {domain: {name: $act.fields.domainName}, purchasePrice: ($act.amount_minor_units / 100)}
          headers = ["Content-Type: application/json", "Authorization: Basic " ~ $env.NAMECOM_BASIC_AUTH, "x-idempotency-key: " ~ $act.uid]
          timeout = 30
        } as $vendor

        precondition ($vendor.response.status >= 200 && $vendor.response.status < 300) {
          error_type = "standard"
          error = "Registrar refused the registration."
        }

        var.update $reference {
          value = $vendor.response.result.order
        }

        db.edit "act" {
          field_name = "id"
          field_value = $act.id
          data = {
            executed: true,
            reference: $reference,
            executed_at: now
          }
        }

        function.run "ledger_append" {
          input = {kind: "act.executed", at: now, payload: {writId: $writ.uid, kind: $act.kind, reference: $reference, grantRef: $act.grant_ref}, writ_id: $writ.uid, principal_id: $writ.principal_id}
        }
      }
    }
  }

  response = {
    reference: $reference
  }
}
---
// function/webhook_esign_process.xs
// The deferred half of the eSign callback. Runs in the queue worker, never in
// the provider's request.
//
// The inbox endpoint already returned 200 before any of this happened — Cameron
// Booth's rule, "acknowledge first, process later". Everything expensive or
// failable lives here, where a failure means a retry with backoff instead of a
// provider marking the endpoint unhealthy and giving up on the delivery.
//
// The writ is NOT moved to `active` here, and that is the security boundary:
// activation requires the signed PDF to be fetched, hashed, and read back into
// an enforceable policy by the extractor, which happens in the console with the
// signing credential. A webhook body saying "signed" is a claim by a third
// party, and this product does not enforce claims — it enforces documents.
function "webhook_esign_process" {
  description = "Process a verified eSign completion callback out of band."

  input {
    json job
  }

  stack {
    db.get "webhook_request" {
      field_name = "id"
      field_value = $input.job.payload.webhook_request_id
    } as $request

    precondition ($request != null) {
      error_type = "notfound"
      error = "No such webhook request."
    }

    precondition ($request.verified == true) {
      error_type = "accessdenied"
      error = "Refusing to process an unverified delivery."
    }

    var $body {
      value = $request.raw_body|json_decode
    }

    var $envelope_id {
      value = $body.envelopeId|first_notnull:$body.envelope_id
    }

    db.query "writ" {
      where = $db.writ.envelope_id == $envelope_id
      return = {type: "single"}
    } as $writ

    precondition ($writ != null) {
      error_type = "notfound"
      error = "No writ is waiting on that envelope."
    }

    function.run "ledger_append" {
      input = {kind: "writ.issued", at: now, payload: {writId: $writ.uid, stage: "esign_completed", envelopeId: $envelope_id, deliveryId: $request.delivery_id}, writ_id: $writ.uid, principal_id: $writ.principal_id}
    }

    db.edit "webhook_request" {
      field_name = "id"
      field_value = $request.id
      data = {
        status: "processed",
        processed_at: now
      }
    }
  }

  response = {
    writ_id: $writ.uid,
    envelope_id: $envelope_id
  }
}
---
// function/rate_guard.xs
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
---
// api/auth/api_group.xs
// Signup and login only. Deliberately its own group so that the authentication
// requirement on `chancery` never has to be punched a hole in — an
// unauthenticated endpoint sitting inside an otherwise-authenticated group is
// precisely the mistake Xano's own guidance names as most common.
//
// `canonical` must be unique across the whole INSTANCE, not just this
// workspace, because Xano routes between workspaces on it. Hence the
// `chancery-` prefix on every group here: a bare `auth` would eventually
// collide with somebody else's.
//
// Swagger visibility is not set here on purpose. XanoScript's only control is
// `swagger = {token: "..."}`, and the docs are explicit that the token is
// stored in plain text — committing one would put a credential in git to
// protect a schema. It is set to Private in the workspace UI instead.
api_group "auth" {
  description = "Credential exchange. Two endpoints, both rate limited."
  canonical = "chancery-auth"
  tags = ["chancery", "auth"]
}
---
// api/auth/signup.xs
// POST /auth/signup
//
// Rate limited by IP because signup is one of the two obvious harvest targets on
// any backend, and the free tier's own throughput cap is not a security control:
// it is shared across the whole workspace, so a scripted signup flood would take
// the entire product down rather than just being throttled.
//
// The audit row is written by an explicit call rather than by middleware.
// Middleware is an Essential-plan feature — the Metadata API refuses a
// `middleware` definition on free with "Please upgrade to access middleware" —
// so the cross-cutting concern is a function every mutating endpoint calls.
query "auth/signup" verb=POST {
  description = "Create a principal and issue a JWT."
  api_group = "auth"

  input {
    text legal_name filters=trim
    email email filters=trim|lower
    text password filters=min:12
  }

  stack {
    function.run "rate_guard" {
      input = {path: "auth/signup", max: 5, window_seconds: 900}
    }

    function.run "audit_append" {
      input = {principal_id: null, method: "POST", path: "auth/signup", ip: $env.$remote_ip, vars: {email: $input.email}, ledger_sequence: null}
    }

    db.get "principal" {
      field_name = "email"
      field_value = $input.email
    } as $existing

    precondition ($existing == null) {
      error_type = "accessdenied"
      error = "That email already has a Chancery account."
    }

    security.create_uuid {
    } as $uid

    db.add "principal" {
      data = {
        uid: $uid,
        legal_name: $input.legal_name,
        email: $input.email,
        password: $input.password,
        entity_verified: false
      }
    } as $principal

    security.create_auth_token {
      table = "principal"
      id = $principal.id
      extras = {}
      expiration = 86400
    } as $authToken
  }

  response = {
    authToken: $authToken,
    principal: {
      id: $principal.uid,
      legal_name: $principal.legal_name,
      email: $principal.email,
      entity_verified: $principal.entity_verified
    }
  }
}
---
// api/auth/login.xs
// POST /auth/login
//
// Both failure branches — no such account, wrong password — return the same
// message and the same status. Distinguishing them turns the endpoint into a
// membership oracle over the customer list, and a principal's email is exactly
// the thing an attacker wants to confirm before phishing a signature out of them.
query "auth/login" verb=POST {
  description = "Exchange credentials for a JWT."
  api_group = "auth"

  input {
    email email filters=trim|lower
    text password
  }

  stack {
    function.run "rate_guard" {
      input = {path: "auth/login", max: 10, window_seconds: 900}
    }

    function.run "audit_append" {
      input = {principal_id: null, method: "POST", path: "auth/login", ip: $env.$remote_ip, vars: {email: $input.email}, ledger_sequence: null}
    }

    db.get "principal" {
      field_name = "email"
      field_value = $input.email
    } as $principal

    precondition ($principal != null) {
      error_type = "accessdenied"
      error = "Invalid credentials."
    }

    security.check_password {
      text_password = $input.password
      hash_password = $principal.password
    } as $valid

    precondition ($valid == true) {
      error_type = "accessdenied"
      error = "Invalid credentials."
    }

    security.create_auth_token {
      table = "principal"
      id = $principal.id
      extras = {}
      expiration = 86400
    } as $authToken
  }

  response = {
    authToken: $authToken,
    principal: {
      id: $principal.uid,
      legal_name: $principal.legal_name,
      email: $principal.email,
      entity_verified: $principal.entity_verified
    }
  }
}
---
// api/chancery/api_group.xs
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
---
// api/chancery/me.xs
// GET /me
//
// Answers only about the token holder. There is no `GET /principal/{id}` in this
// workspace, because there is no reason for one to exist and every reason for it
// not to.
query "me" verb=GET {
  description = "The authenticated principal."
  api_group = "chancery"
  auth = "principal"

  input {
  }

  stack {
    db.get "principal" {
      field_name = "id"
      field_value = $auth.id
    } as $principal

    precondition ($principal != null) {
      error_type = "accessdenied"
      error = "Authentication required."
    }
  }

  response = {
    id: $principal.uid,
    legal_name: $principal.legal_name,
    email: $principal.email,
    entity_verified: $principal.entity_verified
  }
}
---
// api/chancery/writ_create.xs
// POST /writ — createWrit
//
// The principal is read from `$auth.id` and the body cannot name one. That is
// not a convenience: a body that could name a principal is a body that could
// name somebody else's, and the writ is the document that says who is on the
// hook for what an agent spends.
//
// The agent is upserted by (principal, domain). Re-drafting a writ for an agent
// that already exists must not fork it into a second identity, because the
// public join key a verifier uses is the DNS name and two agent rows on one name
// makes "which authority applies" ambiguous at the worst possible moment.
//
// Clauses are inserted, never merged. A writ is drafted whole and then signed
// whole; there is no partial amendment path anywhere in this API.
query "writ" verb=POST {
  description = "Draft a writ. Returns the assembled instrument, status `draft`."
  api_group = "chancery"
  auth = "principal"

  input {
    text agent_external_id filters=trim
    text agent_label filters=trim
    text agent_domain filters=trim|lower
    text agent_public_key filters=trim
    timestamp effective_from
    timestamp expires_at
    text jurisdiction filters=trim
    json grants
  }

  stack {
    function.run "audit_append" {
      input = {principal_id: $auth.id, method: "POST", path: "writ", ip: $env.$remote_ip, vars: {agent_domain: $input.agent_domain}, ledger_sequence: null}
    }

    precondition ($input.expires_at > $input.effective_from) {
      error_type = "inputerror"
      error = "A writ cannot expire before it takes effect."
    }

    precondition (($input.grants|count) > 0) {
      error_type = "inputerror"
      error = "A writ that grants nothing is not a writ."
    }

    db.query "agent" {
      where = $db.agent.principal_id == $auth.id && $db.agent.domain == $input.agent_domain
      return = {type: "single"}
    } as $agent

    conditional {
      if ($agent == null) {
        security.create_uuid {
        } as $agent_uid

        db.add "agent" {
          data = {
            uid: $agent_uid,
            principal_id: $auth.id,
            external_id: $input.agent_external_id,
            label: $input.agent_label,
            domain: $input.agent_domain,
            public_key: $input.agent_public_key
          }
        } as $created_agent

        var.update $agent {
          value = $created_agent
        }
      }
    }

    security.create_uuid {
    } as $writ_uid

    db.add "writ" {
      data = {
        uid: $writ_uid,
        principal_id: $auth.id,
        agent_id: $agent.id,
        version: 1,
        status: "draft",
        effective_from: $input.effective_from,
        expires_at: $input.expires_at,
        jurisdiction: $input.jurisdiction
      }
    } as $writ

    var $ordinal {
      value = 0
    }

    foreach ($input.grants) {
      each as $grant {
        db.add "clause" {
          data = {
            writ_id: $writ.id,
            ref: $grant.ref,
            act_kind: $grant.act_kind,
            limits: $grant.limits,
            conditions: $grant.conditions,
            ordinal: $ordinal
          }
        }

        var.update $ordinal {
          value = $ordinal + 1
        }
      }
    }

    function.run "writ_assemble" {
      input = {writ_id: $writ.id}
    } as $assembled
  }

  response = $assembled
}
---
// api/chancery/writ_get.xs
// GET /writ/{writ_uid} — getWrit
//
// Answers 200 with `null` when there is no such writ, rather than 404. Xano also
// answers 404 for a path that does not route, and "you called the wrong URL"
// must not be indistinguishable from "this principal has no such writ" — the
// client would map one to `null` and swallow the other.
//
// A writ belonging to another principal is also `null`, not 403. Returning
// "forbidden" would confirm the uid exists, which is a membership oracle over
// the whole registry.
query "writ/{writ_uid}" verb=GET {
  description = "One assembled writ, scoped to the caller."
  api_group = "chancery"
  auth = "principal"

  input {
    text writ_uid
  }

  stack {
    function.run "writ_owned" {
      input = {writ_uid: $input.writ_uid, required: false}
    } as $writ

    var $assembled {
      value = null
    }

    conditional {
      if ($writ != null) {
        function.run "writ_assemble" {
          input = {writ_id: $writ.id}
        } as $found

        var.update $assembled {
          value = $found
        }
      }
    }
  }

  response = $assembled
}
---
// api/chancery/writ_by_domain.xs
// GET /writ_by_domain?domain= — getWritByAgentDomain
//
// This is the lookup the gate makes on every single act, so its resolution rule
// is load-bearing: **newest first, whatever the status.**
//
// Not "newest active". A revoked writ has to stay findable, because the gate
// needs to answer WRIT_REVOKED rather than NO_WRIT, and those are very different
// things to tell a principal — one says "your authority was withdrawn", the
// other says "you never had any", and only the first is true.
//
// The name is `writ_by_domain`, not `writ/by_domain`, and that is not a style
// choice. Xano matches `writ/{writ_uid}` FIRST — a literal segment does not beat
// a path parameter — so `GET /writ/by_domain` resolved to the by-uid endpoint
// with `writ_uid = "by_domain"`, which then failed comparing a non-uuid against
// the `uuid` column: `ParseError: Invalid value for param "writ.uid"`. Keeping
// the two off a shared prefix is the only reliable fix.
query "writ_by_domain" verb=GET {
  description = "The current writ for an agent domain, scoped to the caller."
  api_group = "chancery"
  auth = "principal"

  input {
    text domain filters=trim|lower
  }

  stack {
    db.query "writ" {
      join = {
        agent: {
          table: "agent",
          type: "inner",
          where: $db.agent.id == $db.writ.agent_id
        }
      }
      where = $db.agent.domain == $input.domain && $db.writ.principal_id == $auth.id
      sort = {created_at: "desc"}
      return = {type: "single"}
    } as $writ

    var $assembled {
      value = null
    }

    conditional {
      if ($writ != null) {
        function.run "writ_assemble" {
          input = {writ_id: $writ.id}
        } as $found

        var.update $assembled {
          value = $found
        }
      }
    }
  }

  response = $assembled
}
---
// api/chancery/writ_update.xs
// PATCH /writ/{writ_uid} — updateWrit
//
// The input list is the point of this file. There is no `grants`, no
// `jurisdiction`, no `effective_from`, no `expires_at`, and no principal. The
// terms of a writ are not patchable, full stop — a system whose whole claim is
// "the machine enforces what the human signed" cannot expose an endpoint that
// edits what the human signed. The client refuses the same fields, but a
// client-side check protects nobody, so it is refused here too.
//
// Revocation is terminal. Re-activating a revoked instrument by patch would make
// the DNS tombstone and the registry disagree about live authority, and the
// tombstone is the one a verifier reads.
query "writ/{writ_uid}" verb=PATCH {
  description = "Advance a writ's lifecycle. Cannot alter its terms."
  api_group = "chancery"
  auth = "principal"

  input {
    text writ_uid
    enum? status? {
      values = ["draft", "pending_signature", "active", "revoked", "expired"]
    }
    text? document_url?
    text? document_sha256?
    text? envelope_id?
    json? policy?
    timestamp? anchored_at?
  }

  stack {
    function.run "audit_append" {
      input = {principal_id: $auth.id, method: "PATCH", path: "writ/{writ_uid}", ip: $env.$remote_ip, vars: {writ_uid: $input.writ_uid, status: $input.status}, ledger_sequence: null}
    }

    function.run "writ_owned" {
      input = {writ_uid: $input.writ_uid, required: true}
    } as $writ

    precondition ($writ.status != "revoked" || $input.status == null || $input.status == "revoked") {
      error_type = "accessdenied"
      error = "This writ is revoked; that is terminal."
    }

    var $data {
      value = {updated_at: now}
    }

    conditional {
      if ($input.status != null) {
        var.update $data {
          value = $data|set:"status":$input.status
        }
      }
    }
    conditional {
      if ($input.document_url != null) {
        var.update $data {
          value = $data|set:"document_url":$input.document_url
        }
      }
    }
    conditional {
      if ($input.document_sha256 != null) {
        var.update $data {
          value = $data|set:"document_sha256":$input.document_sha256
        }
      }
    }
    conditional {
      if ($input.envelope_id != null) {
        var.update $data {
          value = $data|set:"envelope_id":$input.envelope_id
        }
      }
    }
    conditional {
      if ($input.policy != null) {
        var.update $data {
          value = $data|set:"policy":$input.policy
        }
      }
    }
    conditional {
      if ($input.anchored_at != null) {
        var.update $data {
          value = $data|set:"anchored_at":$input.anchored_at
        }
      }
    }

    precondition (($data|count) > 1) {
      error_type = "inputerror"
      error = "Nothing to update."
    }

    precondition ($input.policy == null || $input.document_sha256 != null || $writ.document_sha256 != null) {
      error_type = "inputerror"
      error = "A policy cannot be stored without the document hash it came from."
    }

    db.patch "writ" {
      field_name = "id"
      field_value = $writ.id
      data = $data
    }

    function.run "writ_assemble" {
      input = {writ_id: $writ.id}
    } as $assembled
  }

  response = $assembled
}
---
// api/chancery/act_history.xs
// GET /writ/{writ_uid}/act — actHistory
//
// Executed acts only. Cumulative limits are evaluated against this list, and a
// refusal must not consume the budget it was refused by: if a denied
// registration counted against a three-registration cap, three denials would
// exhaust an authority that was never used.
//
// Ordered oldest first, which is the order a window calculation walks.
query "writ/{writ_uid}/act" verb=GET {
  description = "Executed acts under one writ, for cumulative limits."
  api_group = "chancery"
  auth = "principal"

  input {
    text writ_uid
  }

  stack {
    function.run "writ_owned" {
      input = {writ_uid: $input.writ_uid, required: true}
    } as $writ

    db.query "act" {
      where = $db.act.writ_id == $writ.id && $db.act.executed == true
      sort = {executed_at: "asc"}
      return = {type: "list"}
    } as $rows

    var $history {
      value = []
    }

    foreach ($rows) {
      each as $act {
        var.update $history {
          value = $history|push:{kind: $act.kind, grant_ref: $act.grant_ref, amount_minor_units: $act.amount_minor_units, currency: $act.currency, executed_at: $act.executed_at}
        }
      }
    }
  }

  response = $history
}
---
// api/chancery/act_record.xs
// POST /writ/{writ_uid}/act — recordExecutedAct
//
// Records an act that has already been carried out. It does not decide anything
// and it cannot: the decision was made against a signed instrument, DNS and live
// diligence, and packaged into a receipt. A second place that could produce a
// verdict is a second place that could produce a different one.
//
// On a paid plan, writing this row fires the `act_recorded` trigger, which keeps
// the consumed-budget counters on `writ` honest no matter which path wrote the
// act. Triggers are Essential-only, so on free those counters simply stay at
// zero — nothing in the decision path reads them, so the gate is unaffected.
query "writ/{writ_uid}/act" verb=POST {
  description = "Record one executed act against a writ."
  api_group = "chancery"
  auth = "principal"

  input {
    text writ_uid
    enum kind {
      values = [
        "domain.register",
        "domain.renew",
        "domain.transfer",
        "dns.write",
        "document.send_for_signature",
        "document.publish"
      ]
    }
    text? grant_ref?
    int? amount_minor_units?
    text? currency?
    timestamp executed_at
    text? reference?
    json? fields?
    text? evidence_digest?
  }

  stack {
    function.run "audit_append" {
      input = {principal_id: $auth.id, method: "POST", path: "writ/{writ_uid}/act", ip: $env.$remote_ip, vars: {writ_uid: $input.writ_uid, kind: $input.kind}, ledger_sequence: null}
    }

    function.run "writ_owned" {
      input = {writ_uid: $input.writ_uid, required: true}
    } as $writ

    security.create_uuid {
    } as $uid

    db.add "act" {
      data = {
        uid: $uid,
        writ_id: $writ.id,
        kind: $input.kind,
        grant_ref: ($input.grant_ref|first_notnull:""),
        fields: ($input.fields|first_notnull:{}),
        amount_minor_units: ($input.amount_minor_units|first_notnull:0),
        currency: ($input.currency|first_notnull:"USD"),
        outcome: "allow",
        executed: true,
        reference: $input.reference,
        executed_at: $input.executed_at,
        evidence_digest: $input.evidence_digest
      }
    } as $act
  }

  response = {
    recorded: true,
    act_id: $act.uid
  }
}
---
// api/chancery/ledger_append.xs
// POST /ledger — appendLedger
//
// The client sends `{ kind, at, payload }` and nothing else. It does not send a
// sequence, a previous hash or a hash, because a client that picked its own
// position would race every other client: two callers reading the same head
// would compute the same next number and one would be rejected by the unique
// index after its payload had already been accepted.
//
// So the chain is assigned by `ledger_append`, under the lock it takes, and
// verified on the way back out by the client against the same canonical form.
// Server-assigned and client-verified is the whole claim — an entry the caller
// cannot reproduce is not evidence and the client refuses it.
query "ledger" verb=POST {
  description = "Append one entry to the tamper-evident chain."
  api_group = "chancery"
  auth = "principal"

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
  }

  stack {
    var $writ_uid {
      value = null
    }

    conditional {
      if ($input.writ_id != null) {
        function.run "writ_owned" {
          input = {writ_uid: $input.writ_id, required: true}
        } as $writ

        var.update $writ_uid {
          value = $writ.uid
        }
      }
    }

    function.run "ledger_append" {
      input = {kind: $input.kind, at: $input.at, payload: $input.payload, writ_id: $writ_uid, principal_id: $auth.id}
    } as $entry
  }

  response = $entry
}
---
// api/chancery/ledger_list.xs
// GET /ledger?writ_id= — ledger
//
// The chain is global — one sequence across the whole workspace — but a read is
// not. Entries are returned scoped to the caller, because the payloads name
// domains, amounts and refusal reasons, and one principal's refused registration
// is not another principal's business.
//
// That is why `principal_id` exists on the row. It is denormalised and not
// hashed: it is an index for this query, not evidence. Anyone who wants to
// verify the chain's integrity across principals uses `/ledger/spine` in the
// public group, which returns linkage without payloads.
//
// The filter is TWO queries rather than one with `($uid == null || col == $uid)`.
// A `where` clause compiles to SQL and is not short-circuited in XanoScript, so
// the null branch still binds null against an indexed column and the request
// dies with `ParseError: Invalid value for param`. Branching in the stack is the
// only reliable way to make a filter optional.
query "ledger" verb=GET {
  description = "The caller's ledger entries, oldest first."
  api_group = "chancery"
  auth = "principal"

  input {
    text? writ_id?
  }

  stack {
    var $rows {
      value = []
    }

    conditional {
      if ($input.writ_id != null) {
        function.run "writ_owned" {
          input = {writ_uid: $input.writ_id, required: true}
        } as $writ

        db.query "ledger" {
          where = $db.ledger.principal_id == $auth.id && $db.ledger.writ_id == $writ.uid
          sort = {sequence: "asc"}
          return = {type: "list"}
        } as $scoped

        var.update $rows {
          value = $scoped
        }
      }
      else {
        db.query "ledger" {
          where = $db.ledger.principal_id == $auth.id
          sort = {sequence: "asc"}
          return = {type: "list"}
        } as $all

        var.update $rows {
          value = $all
        }
      }
    }

    var $entries {
      value = []
    }

    foreach ($rows) {
      each as $row {
        var.update $entries {
          value = $entries|push:{sequence: $row.sequence, previous_hash: $row.previous_hash, hash: $row.hash, kind: $row.kind, at: $row.at, payload: $row.payload}
        }
      }
    }
  }

  response = $entries
}
---
// api/chancery/evidence_put.xs
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
      code = "const crypto = require('crypto');\n\n// Same canonical form as ledger_append and src/lib/core/canonical.ts.\n// Duplicated deliberately: a shared helper that drifted would silently\n// change every published address at once.\nfunction canon(value) {\n  if (value === null) return 'null';\n  const kind = typeof value;\n  if (kind === 'boolean') return value ? 'true' : 'false';\n  if (kind === 'number') {\n    if (!Number.isFinite(value)) throw new Error('non-finite number cannot be hashed');\n    return Object.is(value, -0) ? '0' : JSON.stringify(value);\n  }\n  if (kind === 'string') return JSON.stringify(value);\n  if (kind === 'undefined') throw new Error('undefined cannot be hashed');\n  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';\n  const keys = Object.keys(value).sort();\n  return '{' + keys.map(function (k) {\n    return JSON.stringify(k) + ':' + canon(value[k]);\n  }).join(',') + '}';\n}\n\n// The decision is excluded from the address: the digest identifies the\n// INPUTS, so a replay that disagrees is a disagreement about the same\n// bundle rather than two different bundles. See bundleDigest().\nconst bundle = Object.assign({}, $input.bundle);\ndelete bundle.decision;\nreturn crypto.createHash('sha256').update(canon(bundle), 'utf8').digest('hex');"
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
---
// api/public/api_group.xs
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
---
// api/public/verify.xs
// GET /verify?domain= — the public verifier.
//
// What a stranger can learn about an agent's authority, and no more: whether a
// writ exists, whether it is live, the hash of the document behind it, where
// that document can be fetched, and when it lapses. All of that is already in
// the WRIT1 TXT record; this endpoint exists so a verifier can cross-check the
// registry against DNS and notice when they disagree.
//
// What it deliberately does not return: the policy, the clauses, the principal,
// the agent's label, or any act. A verifier needs to know THAT an agent is
// authorised, not what for — the instrument itself is the principal's to publish.
//
// The ledger head is included because it is the witness value. Publish it
// anywhere durable and no earlier entry can be altered, removed or reordered
// without the recomputed head diverging from what was published.
query "verify" verb=GET {
  description = "Public authority check for one agent domain."
  api_group = "public"

  input {
    text domain filters=trim|lower
  }

  stack {
    db.query "writ" {
      join = {
        agent: {
          table: "agent",
          type: "inner",
          where: $db.agent.id == $db.writ.agent_id
        }
      }
      where = $db.agent.domain == $input.domain
      sort = {created_at: "desc"}
      return = {type: "single"}
    } as $writ

    db.query "ledger" {
      sort = {sequence: "desc"}
      return = {type: "single"}
    } as $head

    var $ledger {
      value = {length: 0, head_hash: "0000000000000000000000000000000000000000000000000000000000000000"}
    }

    conditional {
      if ($head != null) {
        var.update $ledger {
          value = {length: ($head.sequence + 1), head_hash: $head.hash}
        }
      }
    }

    var $summary {
      value = {status: null, document_sha256: null, document_url: null, expires_at: null, anchored_at: null}
    }

    conditional {
      if ($writ != null) {
        var.update $summary {
          value = {status: $writ.status, document_sha256: $writ.document_sha256, document_url: $writ.document_url, expires_at: $writ.expires_at, anchored_at: $writ.anchored_at}
        }
      }
    }
  }

  response = {
    agent_domain: $input.domain,
    status: $summary.status,
    document_sha256: $summary.document_sha256,
    document_url: $summary.document_url,
    expires_at: $summary.expires_at,
    anchored_at: $summary.anchored_at,
    ledger: $ledger
  }
}
---
// api/public/ledger_spine.xs
// GET /ledger/spine?from=&to= — the chain's linkage, without its contents.
//
// Sequence, previous hash, hash, kind and time. No payloads. That is enough for
// anyone to confirm that every entry links to the one before it and that the
// head they were told about is the head of an unbroken chain — and not enough to
// learn what any of it was about.
//
// This is the shape the tamper-evidence argument actually rests on. The chain is
// not tamper-PROOF; anyone holding the database can rewrite it end to end. It is
// tamper-EVIDENT against a witness: publish the head, and no earlier entry can
// be altered, removed or reordered without the spine failing to reproduce it.
//
// The bounds are resolved into sentinel vars before the query rather than tested
// for null inside the `where`. A `where` clause compiles to SQL and is not
// short-circuited, so `($input.to == null || col <= $input.to)` still binds null
// against an int column and fails with `ParseError: Invalid value for param`.
query "ledger/spine" verb=GET {
  description = "Public hash spine. Linkage only, no payloads."
  api_group = "public"

  input {
    int? from?
    int? to?
  }

  stack {
    var $from {
      value = 0
    }
    var $to {
      value = 9007199254740991
    }

    conditional {
      if ($input.from != null) {
        var.update $from {
          value = $input.from
        }
      }
    }
    conditional {
      if ($input.to != null) {
        var.update $to {
          value = $input.to
        }
      }
    }

    db.query "ledger" {
      where = $db.ledger.sequence >= $from && $db.ledger.sequence <= $to
      sort = {sequence: "asc"}
      return = {type: "list"}
    } as $rows

    var $spine {
      value = []
    }

    foreach ($rows) {
      each as $row {
        var.update $spine {
          value = $spine|push:{sequence: $row.sequence, previous_hash: $row.previous_hash, hash: $row.hash, kind: $row.kind, at: $row.at}
        }
      }
    }
  }

  response = $spine
}
---
// api/public/receipt_get.xs
// GET /receipt/{digest} — fetch a published evidence bundle.
//
// Public because a receipt nobody outside can fetch is not evidence, it is a
// claim with a URL. This is the address `putEvidence` hands back and the address
// a refusal cites, so anyone told "denied under clause 3(b)" can pull the bundle
// and re-run the decision engine themselves, offline, with no credentials.
//
// The bundle holds the document HASH, never the document. A writ names a
// principal and what they will spend; publishing the instrument is the
// principal's decision, not ours.
query "receipt/{digest}" verb=GET {
  description = "One published evidence bundle, by content address."
  api_group = "public"

  input {
    text digest
  }

  stack {
    db.query "receipt" {
      where = $db.receipt.digest == $input.digest
      return = {type: "single"}
    } as $receipt

    precondition ($receipt != null) {
      error_type = "notfound"
      error = "No such receipt."
    }
  }

  response = {
    digest: $receipt.digest,
    evaluated_at: $receipt.evaluated_at,
    outcome: $receipt.outcome,
    bundle: $receipt.bundle
  }
}
---
// api/webhook/api_group.xs
// Inbound callbacks. Its own group because its trust model is different from
// everything else in the workspace: there is no JWT, the caller is
// authenticated by an HMAC over the request payload, and the only endpoint in
// it writes to one table and returns.
api_group "webhook" {
  description = "webhook-inbox: HMAC-verified, idempotent, persist-then-acknowledge."
  canonical = "chancery-hook"
  tags = ["chancery", "webhook"]
}
---
// api/webhook/esign.xs
// POST /esign — the eSign completion callback.
//
// Built to Cameron Booth's rule rather than to the pattern on Xano's own
// webhooks documentation page: **acknowledge first, process later.** Everything
// in this stack is persist, verify, enqueue, return. Nothing here fetches the
// signed PDF, hashes it, extracts terms or activates a writ — that work happens
// in `webhook_esign_process`, run by the queue worker.
//
// The reason is not tidiness. A signing provider gives a callback a few seconds
// before it calls the endpoint unhealthy and starts backing off; a synchronous
// stack that does the real work will eventually exceed that on a slow document
// and the delivery gets abandoned. Returning 200 the moment the request is
// safely on disk decouples our processing time from their patience entirely.
//
// The order inside the stack is also deliberate. The request is persisted BEFORE
// it is verified, so a forged callback claiming a writ was signed leaves a
// record of the attempt — which is exactly the attack this product exists to
// stop, and the evidence is worth more than the row costs.
//
// `raw_body` holds the canonical re-serialisation of the parsed body, not the
// bytes as they arrived: XanoScript exposes no raw-body variable. See
// `webhook_verify` and the README for what that costs and why it is stated
// rather than papered over.
query "esign" verb=POST {
  description = "Accept an eSign completion callback. Persist, verify, queue, 200."
  api_group = "webhook"

  input {
    json body
    text? signature?
    text? delivery_id?
    text? sent_at?
  }

  stack {
    db.get "webhook_source" {
      field_name = "slug"
      field_value = "foxit-esign"
    } as $source

    precondition ($source != null && $source.active == true) {
      error_type = "notfound"
      error = "Unknown webhook source."
    }

    security.create_uuid {
    } as $uid

    db.add "webhook_request" {
      data = {
        uid: $uid,
        source_id: $source.id,
        delivery_id: $input.delivery_id,
        signature: ($input.signature|first_notnull:""),
        verified: false,
        status: "received",
        headers: {content_type: "application/json", delivery_id: $input.delivery_id, sent_at: $input.sent_at},
        raw_body: ($input.body|json_encode)
      }
    } as $request

    function.run "webhook_verify" {
      input = {slug: $source.slug, body: $input.body, signature: ($input.signature|first_notnull:""), timestamp: $input.sent_at, tolerance_seconds: $source.tolerance_seconds, algo: $source.algo}
    } as $check

    conditional {
      if ($check.verified != true) {
        db.edit "webhook_request" {
          field_name = "id"
          field_value = $request.id
          data = {
            status: "rejected",
            error: "signature verification failed"
          }
        }

        throw {
          name = "SignatureError"
          value = "Signature verification failed."
        }
      }
    }

    db.query "webhook_request" {
      where = $db.webhook_request.source_id == $source.id && $db.webhook_request.delivery_id == $input.delivery_id && $db.webhook_request.id != $request.id && $db.webhook_request.verified == true
      return = {type: "exists"}
    } as $replayed

    conditional {
      if ($replayed == true) {
        db.edit "webhook_request" {
          field_name = "id"
          field_value = $request.id
          data = {
            verified: true,
            status: "replayed"
          }
        }
      }
      else {
        function.run "job_enqueue" {
          input = {kind: "webhook.esign", idempotency_key: ($input.delivery_id|first_notnull:$uid), payload: {webhook_request_id: $request.id}, max_attempts: 6, delay_seconds: 0}
        }

        db.edit "webhook_request" {
          field_name = "id"
          field_value = $request.id
          data = {
            verified: true,
            status: "queued"
          }
        }
      }
    }
  }

  response = {
    received: true,
    request_id: $uid
  }
}

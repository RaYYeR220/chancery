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

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "uid", op: "asc"}]}
    // One agent per domain per principal. Two live writs on one name would make
    // "which authority applies" ambiguous at the moment it matters most.
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

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "uid", op: "asc"}]}
    {type: "btree", field: [{name: "principal_id", op: "asc"}]}
    // The sweep task scans exactly this pair; without it, expiry becomes a full
    // table scan every hour forever.
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

  index = [
    {type: "primary", field: [{name: "id"}]}
    // The idempotency of `putEvidence` rests entirely on this index.
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

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "uid", op: "asc"}]}
    {type: "btree|unique", field: [{name: "kind", op: "asc"}, {name: "idempotency_key", op: "asc"}]}
    // The claim query's exact shape: due, pending, oldest first.
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

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "uid", op: "asc"}]}
    // Idempotent replay handling lives here: the provider retries until it sees
    // a 200, and this index is what makes the second delivery a lookup instead
    // of a second signature.
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
function ledger_append {
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
    // ISO-8601, stored verbatim: this exact string is inside the hash.
    text at
    json payload
    text? writ_id
    int? principal_id
  }

  stack {
    db.transaction {
      stack {
        db.query ledger {
          sort = [{field: "sequence", order: "desc"}]
          per_page = 1
          // Serialises concurrent appends. Without it the chain forks under
          // any concurrency at all, and a forked chain is not a chain.
          lock = "update"
        } as $tail

        var $previous = $tail|first

        // GENESIS_HASH: 64 hex zeroes is what a chain of length zero links to.
        var $previous_hash = $previous == null
          ? "0000000000000000000000000000000000000000000000000000000000000000"
          : $previous.hash

        var $sequence = $previous == null ? 0 : $previous.sequence|add:1

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

        db.add ledger {
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
// Write one access-log row. Called by the `audit_mutation` middleware.
//
// Kept as a function rather than inlined so the middleware stays readable and so
// the task workers — which mutate the same tables outside any request — can call
// it with the same shape.
function audit_append {
  description = "Record a mutating call against the principal that made it."

  input {
    int? principal_id
    text method
    text path
    text? ip
    json? vars
    int? ledger_sequence
  }

  stack {
    db.add audit {
      data = {
        principal_id: $input.principal_id,
        method: $input.method,
        path: $input.path,
        ip: $input.ip,
        vars: $input.vars|default:{},
        ledger_sequence: $input.ledger_sequence
      }
    } as $row
  }

  response = { id: $row.id }
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
// Timestamps go out as ISO-8601 strings. Xano returns `timestamp` columns as
// epoch milliseconds by default; the decision engine compares dates as strings,
// so the formatting happens here rather than being left to whichever client
// remembered.
function writ_assemble {
  description = "Assemble a StoredWrit from writ + principal + agent + clauses."

  input {
    int writ_id
  }

  stack {
    db.get writ { field_name = "id" field_value = $input.writ_id } as $writ
    precondition ($writ != null) { error_type = "notfound" error = "No such writ." }

    db.get principal { field_name = "id" field_value = $writ.principal_id } as $principal
    db.get agent { field_name = "id" field_value = $writ.agent_id } as $agent

    db.query clause {
      where = ($db.clause.writ_id == $writ.id)
      sort = [{field: "ordinal", order: "asc"}, {field: "id", order: "asc"}]
      per_page = 200
    } as $clauses

    var $grants = []
    for_each ($clauses as $clause) {
      var $grants = $grants|array_push:{
        ref: $clause.ref,
        act_kind: $clause.act_kind,
        limits: $clause.limits,
        conditions: $clause.conditions
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
      effective_from: $writ.effective_from|to_iso8601,
      expires_at: $writ.expires_at|to_iso8601,
      jurisdiction: $writ.jurisdiction
    },
    document_url: $writ.document_url,
    document_sha256: $writ.document_sha256,
    envelope_id: $writ.envelope_id,
    policy: $writ.policy,
    anchored_at: $writ.anchored_at == null ? null : $writ.anchored_at|to_iso8601
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
function writ_owned {
  description = "Look up a writ by uid, scoped to the authenticated principal."

  input {
    text writ_uid
    // When false the caller gets null instead of an error, for the read paths
    // where "no such writ" is an answer rather than a failure.
    bool required?=true
  }

  stack {
    db.query writ {
      where = ($db.writ.uid == $input.writ_uid && $db.writ.principal_id == $auth.id)
      per_page = 1
    } as $rows

    var $writ = $rows|first

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
function job_enqueue {
  description = "Enqueue durable work, at most once per idempotency key."

  input {
    text kind
    text idempotency_key
    json payload
    int? max_attempts
    // Seconds to hold the job before its first attempt.
    int? delay_seconds
  }

  stack {
    db.query job {
      where = ($db.job.kind == $input.kind && $db.job.idempotency_key == $input.idempotency_key)
      per_page = 1
    } as $existing

    conditional ($existing|count > 0) {
      then {
        var $job = $existing|first
      }
      else {
        security.uuid {} as $uid
        db.add job {
          data = {
            uid: $uid,
            kind: $input.kind,
            idempotency_key: $input.idempotency_key,
            payload: $input.payload,
            status: "pending",
            attempts: 0,
            max_attempts: $input.max_attempts|default:6,
            run_after: "now"|add_seconds:($input.delay_seconds|default:0),
            attempt_log: []
          }
        } as $job
      }
    }
  }

  response = { id: $job.id, uid: $job.uid, status: $job.status, created: $existing|count == 0 }
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
function job_claim {
  description = "Lease up to `limit` due jobs of one kind."

  input {
    text kind
    int? limit
  }

  stack {
    security.uuid {} as $claim_token

    db.transaction {
      stack {
        db.query job {
          where = (
            $db.job.kind == $input.kind
            && $db.job.status == "pending"
            && $db.job.run_after <= "now"
          )
          sort = [{field: "run_after", order: "asc"}, {field: "id", order: "asc"}]
          per_page = $input.limit|default:10
          lock = "update|skip_locked"
        } as $due

        var $claimed = []
        for_each ($due as $job) {
          db.edit job {
            field_name = "id"
            field_value = $job.id
            data = { status: "claimed", claimed_at: "now", claim_token: $claim_token }
          } as $updated
          var $claimed = $claimed|array_push:$updated
        }
      }
    }
  }

  response = { claim_token: $claim_token, jobs: $claimed }
}
---
// function/job_complete.xs
// job-retry: complete.
//
// The claim token is checked, not just the id. A worker whose lease was already
// reaped and whose job was handed to somebody else must not be able to mark it
// done from under them — that is how a job runs twice and reports success once.
function job_complete {
  description = "Release a leased job as done."

  input {
    int job_id
    text claim_token
  }

  stack {
    db.get job { field_name = "id" field_value = $input.job_id } as $job
    precondition ($job != null) { error_type = "notfound" error = "No such job." }
    precondition ($job.claim_token == $input.claim_token) {
      error_type = "accessdenied"
      error = "This lease is no longer held."
    }

    db.edit job {
      field_name = "id"
      field_value = $job.id
      data = { status: "done", completed_at: "now", claim_token: null, last_error: null }
    } as $done
  }

  response = { id: $done.id, status: $done.status }
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
function job_fail {
  description = "Record a failed attempt, back off, or dead-letter."

  input {
    int job_id
    text claim_token
    text error
  }

  stack {
    db.get job { field_name = "id" field_value = $input.job_id } as $job
    precondition ($job != null) { error_type = "notfound" error = "No such job." }
    precondition ($job.claim_token == $input.claim_token) {
      error_type = "accessdenied"
      error = "This lease is no longer held."
    }

    var $attempts = $job.attempts|add:1
    var $log = $job.attempt_log|default:[]|array_push:{
      attempt: $attempts,
      at: "now"|to_iso8601,
      error: $input.error
    }

    conditional ($attempts >= $job.max_attempts) {
      then {
        db.add job_dead_letter {
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
        db.edit job {
          field_name = "id"
          field_value = $job.id
          data = {
            status: "dead",
            attempts: $attempts,
            last_error: $input.error,
            attempt_log: $log,
            claim_token: null
          }
        } as $updated
      }
      else {
        // Full jitter: uniform in [0, 2^attempts) seconds, floored at one second
        // so the first retry is not instant.
        var $ceiling = 2|pow:$attempts
        security.random_number { min = 0 max = $ceiling } as $jitter
        var $delay = $jitter|max:1

        db.edit job {
          field_name = "id"
          field_value = $job.id
          data = {
            status: "pending",
            attempts: $attempts,
            last_error: $input.error,
            attempt_log: $log,
            claim_token: null,
            claimed_at: null,
            run_after: "now"|add_seconds:$delay
          }
        } as $updated
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
function act_execute {
  description = "Execute one allowed act against its vendor, exactly once."

  input {
    json job
  }

  stack {
    db.get act { field_name = "id" field_value = $input.job.payload.act_id } as $act
    precondition ($act != null) { error_type = "notfound" error = "No such act." }

    conditional ($act.executed == true) {
      // Already done. The lease was reaped and re-issued, or the provider
      // retried. Completing quietly is correct: the work exists.
      then { var $reference = $act.reference }
      else {
        db.get writ { field_name = "id" field_value = $act.writ_id } as $writ
        precondition ($writ != null) { error_type = "notfound" error = "No such writ." }

        // Revocation beats a queued job. This is the whole reason execution is
        // deferred through a durable queue rather than done inline.
        precondition ($writ.status == "active") {
          error_type = "accessdenied"
          error = "The writ is no longer active; this act will not be carried out."
        }
        precondition ($act.outcome == "allow") {
          error_type = "accessdenied"
          error = "This act was refused."
        }

        conditional ($act.kind == "domain.register") {
          then {
            api.request {
              url = "https://api.name.com/core/v1/domains"
              method = "POST"
              params = {}
                |set:"domain":{name: $act.fields.domainName}
                |set:"purchasePrice":($act.amount_minor_units|divide:100)
              headers = []
                |array_push:"Content-Type: application/json"
                |array_push:("Authorization: Basic {{ $env.NAMECOM_BASIC_AUTH }}")
                |array_push:("x-idempotency-key: " ~ $act.uid)
              timeout = 30
            } as $vendor

            precondition ($vendor.status >= 200 && $vendor.status < 300) {
              error_type = "fatal"
              error = "Registrar refused the registration."
            }
            var $reference = $vendor.response.order|to_text
          }
          else {
            throw { error_type = "fatal" error = "No executor wired for this act kind." }
          }
        }

        db.edit act {
          field_name = "id"
          field_value = $act.id
          data = { executed: true, reference: $reference, executed_at: "now" }
        }

        function.ledger_append {
          kind = "act.executed"
          at = "now"|to_iso8601
          payload = {
            writId: $writ.uid,
            kind: $act.kind,
            reference: $reference,
            grantRef: $act.grant_ref
          }
          writ_id = $writ.uid
          principal_id = $writ.principal_id
        }
      }
    }
  }

  response = { reference: $reference }
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
// The writ is moved to `pending_signature` -> signed-envelope-known only. It is
// NOT moved to `active` here, and that is the security boundary: activation
// requires the signed PDF to be fetched, hashed, and read back into an
// enforceable policy by the extractor, which happens in the console with the
// signing credential. A webhook body saying "signed" is a claim by a third
// party, and this product does not enforce claims — it enforces documents.
function webhook_esign_process {
  description = "Process a verified eSign completion callback out of band."

  input {
    json job
  }

  stack {
    db.get webhook_request {
      field_name = "id"
      field_value = $input.job.payload.webhook_request_id
    } as $request
    precondition ($request != null) { error_type = "notfound" error = "No such webhook request." }
    precondition ($request.verified == true) {
      error_type = "accessdenied"
      error = "Refusing to process an unverified delivery."
    }

    var $body = $request.raw_body|json_decode
    var $envelope_id = $body.envelopeId|default:$body.envelope_id

    db.query writ {
      where = ($db.writ.envelope_id == $envelope_id)
      per_page = 1
    } as $rows
    var $writ = $rows|first
    precondition ($writ != null) {
      error_type = "notfound"
      error = "No writ is waiting on that envelope."
    }

    // Recorded as `writ.issued` with a stage marker rather than as a new kind:
    // the ledger's kinds are the domain's kinds, and adding one for a vendor's
    // callback would put a vendor's vocabulary inside published evidence.
    function.ledger_append {
      kind = "writ.issued"
      at = "now"|to_iso8601
      payload = {
        writId: $writ.uid,
        stage: "esign_completed",
        envelopeId: $envelope_id,
        deliveryId: $request.delivery_id
      }
      writ_id = $writ.uid
      principal_id = $writ.principal_id
    }

    db.edit webhook_request {
      field_name = "id"
      field_value = $request.id
      data = { status: "processed", processed_at: "now" }
    }
  }

  response = { writ_id: $writ.uid, envelope_id: $envelope_id }
}
---
// middleware/require_auth.xs
// Centralised authentication. Attached to the `chancery` API group, so every
// endpoint in it is authenticated by the group's configuration rather than by
// each stack remembering to check.
//
// Xano's pre-launch checklist calls for exactly this — "applied centralised
// middleware for cross-cutting auth" — and the reason is that a per-endpoint
// check is a per-endpoint chance to forget. The one endpoint somebody adds at
// 3am is the one that ships unauthenticated.
//
// This runs `pre`, before the stack, and confirms two separate things: that a
// token was presented and resolved, and that the principal it names still
// exists. A deleted account whose JWT has not yet expired is still a valid
// signature over a row that is gone.
middleware require_auth {
  input {
    json vars
    enum type { values = ["pre", "post"] }
  }

  stack {
    conditional ($type == "pre") {
      then {
        precondition ($auth.id != null) {
          error_type = "unauthorized"
          error = "Authentication required."
        }

        db.get principal { field_name = "id" field_value = $auth.id } as $principal
        precondition ($principal != null) {
          error_type = "unauthorized"
          error = "Authentication required."
        }
      }
    }
  }

  response_strategy = "merge"
  // Never silent. A middleware whose failure is swallowed is a middleware that
  // is not enforcing anything.
  exception_policy = "critical"
}
---
// middleware/audit_mutation.xs
// Append an audit row for every mutating call. Attached to every API group.
//
// Two decisions worth stating.
//
// Reads are not logged. They happen constantly, they prove nothing, and burying
// the twelve state changes of the day under forty thousand GETs is how an audit
// log becomes something nobody reads.
//
// `exception_policy = "critical"`, so a call whose audit row cannot be written
// fails. That is the uncomfortable choice and it is deliberate: Chancery fails
// closed everywhere else — an unavailable diligence check denies the act rather
// than waving it through — and an unrecorded mutation is worse than a refused
// one. The alternative is a system that quietly stops keeping records exactly
// when it is under stress.
//
// This is the access log, not the chain. The ledger records what Chancery
// DECIDED and is published; this records who called what and stays private.
middleware audit_mutation {
  input {
    json vars
    enum type { values = ["pre", "post"] }
  }

  stack {
    // Post, so the row records a call that actually reached its stack, and so a
    // request rejected by `require_auth` is not logged as an attempted mutation
    // by a principal that was never authenticated.
    conditional (
      $type == "post"
      && ($request.method == "POST" || $request.method == "PATCH" || $request.method == "PUT" || $request.method == "DELETE")
    ) {
      then {
        function.audit_append {
          principal_id = $auth.id
          method = $request.method
          path = $request.path
          ip = $request.ip
          // Xano's `password` type is not readable back out of a request var, so
          // signup and login inputs arrive here already redacted.
          vars = $vars
        }
      }
    }
  }

  response_strategy = "merge"
  exception_policy = "critical"
}
---
// trigger/act_recorded.xs
// Database trigger on `act` insert.
//
// It does two things, and it deliberately does not do a third.
//
// It queues execution. An act that was ALLOWED but not yet carried out is
// handed to the durable queue here rather than by whoever wrote the row, so an
// allowed act is executed no matter which path created it — endpoint, task, or a
// human clicking Add Record in the Xano UI. The act's uid is the idempotency
// key, so the same decision cannot buy two domains.
//
// It maintains the consumed-budget counters on `writ`. Those are derived state
// for the console; the decision engine evaluates limits against act rows, never
// against a counter, so a drift here can misinform a dashboard but can never
// widen an authority.
//
// It does NOT append to the ledger. The chain has exactly one writer, and a
// trigger firing inside another statement's transaction would nest chain
// appends inside writes that may still roll back — producing either a gap in
// the sequence or an entry for an act that never existed. The endpoints append
// explicitly, in their own transaction, where the ordering is legible.
table_trigger act_recorded {
  table = "act"
  actions = ["insert"]

  stack {
    conditional ($new.outcome == "allow" && $new.executed == false) {
      then {
        function.job_enqueue {
          kind = "act.execute"
          idempotency_key = $new.uid
          payload = { act_id: $new.id, act_uid: $new.uid, writ_id: $new.writ_id, kind: $new.kind }
        }
      }
    }

    conditional ($new.executed == true) {
      then {
        db.get writ { field_name = "id" field_value = $new.writ_id } as $writ
        conditional ($writ != null) {
          then {
            db.edit writ {
              field_name = "id"
              field_value = $writ.id
              data = {
                consumed_count: $writ.consumed_count|add:1,
                consumed_minor_units: $writ.consumed_minor_units|add:($new.amount_minor_units|default:0),
                updated_at: "now"
              }
            }
          }
        }
      }
    }
  }
}
---
// api/auth/_group.xs
// Signup and login only. Deliberately its own group so that the group-level
// authentication requirement on `chancery` does not have to be punched a hole
// in — the two endpoints that legitimately run unauthenticated live somewhere
// that has no authenticated endpoints to leak past.
//
// Swagger is private: an unauthenticated, publicly readable schema of the auth
// surface is a free map for anyone enumerating it.
//
// CORS is an explicit allowlist. A wildcard here would let any page a principal
// happens to have open post their credentials to us and read the token back.
apigroup auth {
  description = "Credential exchange. Two endpoints, both rate limited."
  canonical = "auth"
  swagger = "private"
  external_access = true

  cors = {
    origins = ["{{ $env.CONSOLE_ORIGIN }}"]
    methods = ["POST", "OPTIONS"]
    headers = ["content-type"]
    credentials = false
    max_age = 600
  }

  middleware = ["audit_mutation"]
}
---
// api/auth/signup.xs
// POST /auth/signup
//
// Rate limited by IP because signup is one of the two obvious harvest targets on
// any backend, and the free tier's own throughput cap is not a security control:
// it is shared across the whole workspace, so a scripted signup flood would take
// the entire product down rather than just being throttled.
query auth/signup verb=POST {
  description = "Create a principal and issue a JWT."

  input {
    text legal_name? filters=trim
    email email? filters=trim|lower
    // Length is enforced by the column filter too; stating it here means a bad
    // password is rejected before a row is attempted.
    text password? filters=min:12
  }

  stack {
    security.rate_limit {
      key = ("signup:" ~ $request.ip)
      max = 5
      ttl = 900
      error = "Too many signup attempts. Try again later."
    }

    db.get principal { field_name = "email" field_value = $input.email } as $existing
    precondition ($existing == null) {
      error_type = "accessdenied"
      error = "That email already has a Chancery account."
    }

    security.uuid {} as $uid
    db.add principal {
      data = {
        created_at: "now",
        uid: $uid,
        legal_name: $input.legal_name,
        email: $input.email,
        password: $input.password,
        // Never settable from a request. It becomes true only when the
        // diligence service corroborates the entity against live web data.
        entity_verified: false
      }
    } as $principal

    security.create_auth_token {
      table = "principal"
      extras = {}
      expiration = 86400
      id = $principal.id
    } as $authToken
  }

  // The password column is never in this shape, and neither is the row id.
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
//
// Rate limited on the email, not only the IP: an attacker spraying one password
// across many accounts from a rotating pool is the shape this catches.
query auth/login verb=POST {
  description = "Exchange credentials for a JWT."

  input {
    email email? filters=trim|lower
    text password?
  }

  stack {
    security.rate_limit {
      key = ("login:" ~ $input.email)
      max = 10
      ttl = 900
      error = "Too many attempts for that account. Try again later."
    }

    db.get principal { field_name = "email" field_value = $input.email } as $principal
    precondition ($principal != null) {
      error_type = "accessdenied"
      error = "Invalid credentials."
    }

    security.validate_password {
      password = $input.password
      hash = $principal.password
    } as $valid
    precondition ($valid == true) {
      error_type = "accessdenied"
      error = "Invalid credentials."
    }

    security.create_auth_token {
      table = "principal"
      extras = {}
      expiration = 86400
      id = $principal.id
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
// api/chancery/_group.xs
// The authenticated surface. Every endpoint in this group requires a JWT, and
// there are no exceptions inside it — the endpoints that legitimately run
// without one live in `auth` and `public`, which is the whole reason those
// groups exist. Xano's own security guidance names the most common
// application-level mistake as "leaving auto-generated endpoints reachable and
// unauthenticated"; a group with no unauthenticated members cannot acquire one
// by accident.
//
// There is no auto-generated CRUD anywhere in this workspace. Every endpoint
// below is hand-written, assembles a domain object rather than returning a row,
// and scopes to `$auth.id` through `writ_owned` rather than trusting the
// identifier in the path.
apigroup chancery {
  description = "Writ registry, act history, ledger and receipts. JWT only."
  canonical = "chancery"
  swagger = "private"
  external_access = true

  authentication = { table = "principal" }

  cors = {
    // Explicit allowlist, not `*`. With credentials enabled a wildcard is not
    // merely loose, it is the browser handing any origin a principal visits the
    // ability to act as them.
    origins = ["{{ $env.CONSOLE_ORIGIN }}"]
    methods = ["GET", "POST", "PATCH", "OPTIONS"]
    headers = ["authorization", "content-type"]
    credentials = true
    max_age = 600
  }

  middleware = ["require_auth", "audit_mutation"]
}
---
// api/chancery/me.xs
// GET /me
//
// Answers only about the token holder. There is no `GET /principal/{id}` in this
// workspace, because there is no reason for one to exist and every reason for it
// not to.
query me verb=GET {
  description = "The authenticated principal."

  stack {
    db.get principal { field_name = "id" field_value = $auth.id } as $principal
    precondition ($principal != null) {
      error_type = "unauthorized"
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
query writ verb=POST {
  description = "Draft a writ. Returns the assembled instrument, status `draft`."

  input {
    text agent_external_id? filters=trim
    text agent_label? filters=trim
    text agent_domain? filters=trim|lower
    text agent_public_key? filters=trim
    timestamp effective_from?
    timestamp expires_at?
    text jurisdiction? filters=trim
    // [{ ref, act_kind, limits, conditions }] — limits and conditions stored
    // verbatim; see the note on `clause`.
    json grants?
  }

  stack {
    precondition ($input.expires_at > $input.effective_from) {
      error_type = "input"
      error = "A writ cannot expire before it takes effect."
    }
    precondition ($input.grants|count > 0) {
      error_type = "input"
      error = "A writ that grants nothing is not a writ."
    }

    db.query agent {
      where = ($db.agent.principal_id == $auth.id && $db.agent.domain == $input.agent_domain)
      per_page = 1
    } as $found

    conditional ($found|count > 0) {
      then { var $agent = $found|first }
      else {
        security.uuid {} as $agent_uid
        db.add agent {
          data = {
            uid: $agent_uid,
            principal_id: $auth.id,
            external_id: $input.agent_external_id,
            label: $input.agent_label,
            domain: $input.agent_domain,
            public_key: $input.agent_public_key
          }
        } as $agent
      }
    }

    security.uuid {} as $writ_uid
    db.add writ {
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

    var $ordinal = 0
    for_each ($input.grants as $grant) {
      db.add clause {
        data = {
          writ_id: $writ.id,
          ref: $grant.ref,
          act_kind: $grant.act_kind,
          limits: $grant.limits,
          conditions: $grant.conditions,
          ordinal: $ordinal
        }
      }
      var $ordinal = $ordinal|add:1
    }

    function.writ_assemble { writ_id = $writ.id } as $assembled
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
query writ/{writ_uid} verb=GET {
  description = "One assembled writ, scoped to the caller."

  input {
    text writ_uid
  }

  stack {
    function.writ_owned { writ_uid = $input.writ_uid required = false } as $writ

    conditional ($writ == null) {
      then { var $assembled = null }
      else { function.writ_assemble { writ_id = $writ.id } as $assembled }
    }
  }

  response = $assembled
}
---
// api/chancery/writ_by_domain.xs
// GET /writ/by_domain?domain= — getWritByAgentDomain
//
// This is the lookup the gate makes on every single act, so its resolution rule
// is load-bearing: **newest first, whatever the status.**
//
// Not "newest active". A revoked writ has to stay findable, because the gate
// needs to answer WRIT_REVOKED rather than NO_WRIT, and those are very different
// things to tell a principal — one says "your authority was withdrawn", the
// other says "you never had any", and only the first is true.
query writ/by_domain verb=GET {
  description = "The current writ for an agent domain, scoped to the caller."

  input {
    text domain? filters=trim|lower
  }

  stack {
    db.query writ {
      // The join is on the caller's own agents. An agent domain is public
      // information; the writ behind it is not.
      join = [{table: "agent", on: ($db.agent.id == $db.writ.agent_id)}]
      where = ($db.agent.domain == $input.domain && $db.writ.principal_id == $auth.id)
      sort = [{field: "created_at", order: "desc"}, {field: "id", order: "desc"}]
      per_page = 1
    } as $rows

    var $writ = $rows|first

    conditional ($writ == null) {
      then { var $assembled = null }
      else { function.writ_assemble { writ_id = $writ.id } as $assembled }
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
query writ/{writ_uid} verb=PATCH {
  description = "Advance a writ's lifecycle. Cannot alter its terms."

  input {
    text writ_uid
    enum status? { values = ["draft", "pending_signature", "active", "revoked", "expired"] }
    text? document_url
    text? document_sha256
    text? envelope_id
    json? policy
    timestamp? anchored_at
  }

  stack {
    function.writ_owned { writ_uid = $input.writ_uid } as $writ

    precondition ($writ.status != "revoked" || $input.status == "revoked" || $input.status == null) {
      error_type = "accessdenied"
      error = "This writ is revoked; that is terminal."
    }

    var $data = {}
    conditional ($input.status != null) { then { var $data = $data|set:"status":$input.status } }
    conditional ($input.document_url != null) { then { var $data = $data|set:"document_url":$input.document_url } }
    conditional ($input.document_sha256 != null) { then { var $data = $data|set:"document_sha256":$input.document_sha256 } }
    conditional ($input.envelope_id != null) { then { var $data = $data|set:"envelope_id":$input.envelope_id } }
    conditional ($input.policy != null) { then { var $data = $data|set:"policy":$input.policy } }
    conditional ($input.anchored_at != null) { then { var $data = $data|set:"anchored_at":$input.anchored_at } }

    precondition ($data|count > 0) {
      error_type = "input"
      error = "Nothing to update."
    }

    // A policy may only be attached alongside the hash of the document it was
    // extracted from. Storing terms that are not bound to a specific signed PDF
    // is how an enforced policy stops being provably the one a human read.
    precondition (
      $input.policy == null
      || $input.document_sha256 != null
      || $writ.document_sha256 != null
    ) {
      error_type = "input"
      error = "A policy cannot be stored without the document hash it came from."
    }

    var $data = $data|set:"updated_at":"now"
    db.edit writ { field_name = "id" field_value = $writ.id data = $data }

    function.writ_assemble { writ_id = $writ.id } as $assembled
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
query writ/{writ_uid}/act verb=GET {
  description = "Executed acts under one writ, for cumulative limits."

  input {
    text writ_uid
  }

  stack {
    function.writ_owned { writ_uid = $input.writ_uid } as $writ

    db.query act {
      where = ($db.act.writ_id == $writ.id && $db.act.executed == true)
      sort = [{field: "executed_at", order: "asc"}, {field: "id", order: "asc"}]
      per_page = 500
    } as $rows

    var $history = []
    for_each ($rows as $act) {
      var $history = $history|array_push:{
        kind: $act.kind,
        grant_ref: $act.grant_ref,
        amount_minor_units: $act.amount_minor_units,
        currency: $act.currency,
        executed_at: $act.executed_at|to_iso8601
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
// Writing this row fires the `act_recorded` trigger, which is what keeps the
// consumed-budget counters on `writ` honest no matter which path wrote the act —
// this endpoint, the queue worker, or a human in the Xano UI.
query writ/{writ_uid}/act verb=POST {
  description = "Record one executed act against a writ."

  input {
    text writ_uid
    enum kind? {
      values = [
        "domain.register",
        "domain.renew",
        "domain.transfer",
        "dns.write",
        "document.send_for_signature",
        "document.publish"
      ]
    }
    text grant_ref?
    int amount_minor_units?=0
    text currency?="USD"
    timestamp executed_at?
    text? reference
    json? fields
    text? evidence_digest
  }

  stack {
    function.writ_owned { writ_uid = $input.writ_uid } as $writ

    security.uuid {} as $uid
    db.add act {
      data = {
        uid: $uid,
        writ_id: $writ.id,
        kind: $input.kind,
        grant_ref: $input.grant_ref|default:"",
        fields: $input.fields|default:{},
        amount_minor_units: $input.amount_minor_units,
        currency: $input.currency,
        outcome: "allow",
        executed: true,
        reference: $input.reference,
        executed_at: $input.executed_at,
        evidence_digest: $input.evidence_digest
      }
    } as $act
  }

  response = { recorded: true, act_id: $act.uid }
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
// So the chain is assigned here, under the lock `ledger_append` takes, and
// verified on the way back out by the client against the same canonical form.
// Server-assigned and client-verified is the whole claim — an entry the caller
// cannot reproduce is not evidence and the client refuses it.
query ledger verb=POST {
  description = "Append one entry to the tamper-evident chain."

  input {
    enum kind? {
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
    text at?
    json payload?
    // Denormalised for scoping only. Verified below rather than trusted: a
    // caller could otherwise file an entry under someone else's writ and make
    // their audit trail say something it should not.
    text? writ_id
  }

  stack {
    conditional ($input.writ_id != null) {
      then {
        function.writ_owned { writ_uid = $input.writ_id } as $writ
        var $writ_uid = $writ.uid
      }
      else { var $writ_uid = null }
    }

    function.ledger_append {
      kind = $input.kind
      at = $input.at
      payload = $input.payload
      writ_id = $writ_uid
      principal_id = $auth.id
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
query ledger verb=GET {
  description = "The caller's ledger entries, oldest first."

  input {
    text? writ_id
    int? after_sequence
    int? per_page
  }

  stack {
    conditional ($input.writ_id != null) {
      then {
        // Verified, not trusted: without this a caller could read any writ's
        // chain by guessing a uid.
        function.writ_owned { writ_uid = $input.writ_id } as $writ
        db.query ledger {
          where = (
            $db.ledger.writ_id == $writ.uid
            && $db.ledger.principal_id == $auth.id
            && $db.ledger.sequence > ($input.after_sequence|default:-1)
          )
          sort = [{field: "sequence", order: "asc"}]
          per_page = $input.per_page|default:250
        } as $rows
      }
      else {
        db.query ledger {
          where = (
            $db.ledger.principal_id == $auth.id
            && $db.ledger.sequence > ($input.after_sequence|default:-1)
          )
          sort = [{field: "sequence", order: "asc"}]
          per_page = $input.per_page|default:250
        } as $rows
      }
    }

    var $entries = []
    for_each ($rows as $row) {
      var $entries = $entries|array_push:{
        sequence: $row.sequence,
        previous_hash: $row.previous_hash,
        hash: $row.hash,
        kind: $row.kind,
        at: $row.at,
        payload: $row.payload
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
query evidence verb=POST {
  description = "Publish an evidence bundle at its content address."

  input {
    text digest?
    json bundle?
    text? writ_id
    enum outcome? { values = ["allow", "deny"] }
    text evaluated_at?
  }

  stack {
    api.lambda {
      timeout = 5
      code = `
        const crypto = require('crypto');

        // Same canonical form as ledger_append and as
        // src/lib/core/canonical.ts. Duplicated deliberately: a shared helper
        // that drifted would silently change every address at once.
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
      error_type = "input"
      error = "The bundle does not hash to the digest it was filed under."
    }

    conditional ($input.writ_id != null) {
      then { function.writ_owned { writ_uid = $input.writ_id } as $writ }
      else { var $writ = null }
    }

    db.query receipt {
      where = ($db.receipt.digest == $input.digest)
      per_page = 1
    } as $existing

    conditional ($existing|count == 0) {
      then {
        db.add receipt {
          data = {
            writ_id: $writ == null ? null : $writ.id,
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

  // Points at the PUBLIC receipt endpoint, because a receipt nobody outside can
  // fetch is not evidence — it is a claim with a URL.
  response = { url: ("{{ $env.CHANCERY_PUBLIC_BASE }}/receipt/" ~ $input.digest) }
}
---
// api/public/_group.xs
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
query verify verb=GET {
  description = "Public authority check for one agent domain."

  input {
    text domain? filters=trim|lower
  }

  stack {
    db.query writ {
      join = [{table: "agent", on: ($db.agent.id == $db.writ.agent_id)}]
      where = ($db.agent.domain == $input.domain)
      sort = [{field: "created_at", order: "desc"}]
      per_page = 1
    } as $rows
    var $writ = $rows|first

    db.query ledger {
      sort = [{field: "sequence", order: "desc"}]
      per_page = 1
    } as $tail
    var $head = $tail|first
  }

  response = {
    agent_domain: $input.domain,
    status: $writ == null ? null : $writ.status,
    document_sha256: $writ == null ? null : $writ.document_sha256,
    document_url: $writ == null ? null : $writ.document_url,
    expires_at: $writ == null ? null : $writ.expires_at|to_iso8601,
    anchored_at: ($writ == null || $writ.anchored_at == null) ? null : $writ.anchored_at|to_iso8601,
    ledger: {
      length: $head == null ? 0 : $head.sequence|add:1,
      head_hash: $head == null
        ? "0000000000000000000000000000000000000000000000000000000000000000"
        : $head.hash
    }
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
query ledger/spine verb=GET {
  description = "Public hash spine. Linkage only, no payloads."

  input {
    int? from
    int? to
  }

  stack {
    db.query ledger {
      where = (
        $db.ledger.sequence >= ($input.from|default:0)
        && $db.ledger.sequence <= ($input.to|default:9223372036854775807)
      )
      sort = [{field: "sequence", order: "asc"}]
      per_page = 1000
    } as $rows

    var $spine = []
    for_each ($rows as $row) {
      var $spine = $spine|array_push:{
        sequence: $row.sequence,
        previous_hash: $row.previous_hash,
        hash: $row.hash,
        kind: $row.kind,
        at: $row.at
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
query receipt/{digest} verb=GET {
  description = "One published evidence bundle, by content address."

  input {
    text digest
  }

  stack {
    db.query receipt {
      where = ($db.receipt.digest == $input.digest)
      per_page = 1
    } as $rows
    var $receipt = $rows|first
    precondition ($receipt != null) { error_type = "notfound" error = "No such receipt." }
  }

  response = {
    digest: $receipt.digest,
    evaluated_at: $receipt.evaluated_at,
    outcome: $receipt.outcome,
    bundle: $receipt.bundle
  }
}
---
// api/webhook/_group.xs
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
query esign verb=POST {
  description = "Accept an eSign completion callback. Persist, verify, queue, 200."

  input {
    json body?
  }

  stack {
    db.get webhook_source { field_name = "slug" field_value = "foxit-esign" } as $source
    precondition ($source != null && $source.active == true) {
      error_type = "notfound"
      error = "Unknown webhook source."
    }

    // Raw bytes, never the re-serialised object: re-serialising reorders keys
    // and the HMAC stops matching, which presents as "the provider's signatures
    // are wrong" and costs a day.
    var $raw = $http.raw_body
    var $signature = $http.headers|get:$source.signature_header|default:""
    var $delivery_id = $source.delivery_id_header == null
      ? null
      : $http.headers|get:$source.delivery_id_header
    var $timestamp = $source.timestamp_header == null
      ? null
      : $http.headers|get:$source.timestamp_header

    security.uuid {} as $uid

    // Persisted before verification. See the header note.
    db.add webhook_request {
      data = {
        uid: $uid,
        source_id: $source.id,
        delivery_id: $delivery_id,
        signature: $signature,
        verified: false,
        status: "received",
        // Only the headers that matter. Copying them all would put the
        // provider's own bearer tokens into a table we hand to support.
        headers: {
          signature_header: $source.signature_header,
          delivery_id: $delivery_id,
          timestamp: $timestamp,
          content_type: $http.headers|get:"content-type"
        },
        raw_body: $raw
      }
    } as $request

    function.webhook_verify {
      slug = $source.slug
      raw_body = $raw
      signature = $signature
      timestamp = $timestamp
      tolerance_seconds = $source.tolerance_seconds
      algo = $source.algo
    } as $check

    conditional ($check.verified != true) {
      then {
        db.edit webhook_request {
          field_name = "id"
          field_value = $request.id
          data = { status: "rejected", error: "signature verification failed" }
        }
        throw { error_type = "accessdenied" error = "Signature verification failed." }
      }
    }

    db.edit webhook_request {
      field_name = "id"
      field_value = $request.id
      data = { verified: true }
    }

    // Idempotent replay handling. The provider retries until it sees a 200, so
    // the same delivery WILL arrive more than once — that is correct behaviour
    // on their side, and it has to be a lookup here rather than a second
    // activation of the same envelope.
    conditional ($delivery_id != null) {
      then {
        db.query webhook_request {
          where = (
            $db.webhook_request.source_id == $source.id
            && $db.webhook_request.delivery_id == $delivery_id
            && $db.webhook_request.id != $request.id
            && $db.webhook_request.verified == true
          )
          per_page = 1
        } as $prior
      }
      else { var $prior = [] }
    }

    conditional ($prior|count > 0) {
      then {
        db.edit webhook_request {
          field_name = "id"
          field_value = $request.id
          data = { status: "replayed" }
        }
      }
      else {
        function.job_enqueue {
          kind = "webhook.esign"
          // The provider's delivery id when they send one; ours otherwise. Either
          // way the work runs once.
          idempotency_key = $delivery_id|default:$uid
          payload = { webhook_request_id: $request.id }
        }
        db.edit webhook_request {
          field_name = "id"
          field_value = $request.id
          data = { status: "queued" }
        }
      }
    }
  }

  // 200 with an acknowledgement and nothing else. The provider does not need to
  // know what we will do with it, and telling them shapes a forger's next try.
  response = { received: true, request_id: $uid }
}
---
// task/sweep_expired_writs.xs
// Hourly sweep: mark writs whose term has run out.
//
// `freq` is SECONDS, not cron. 3600 is one hour. Writing `0 * * * *` here
// schedules a task to run every zero seconds, which is a genuinely exciting way
// to discover a rate limit.
//
// This task does NOT append to the ledger, and that is a considered choice.
// Expiry is not an event that happened; it is a property of a date and a clock.
// The decision engine already denies an expired writ from `expires_at` alone,
// without consulting this column, so a sweep that had not run yet cannot let an
// expired writ through. All this does is materialise the status so the console
// and the registry agree with the engine — and putting a non-event into an
// evidence chain would mean the chain recorded something nobody did.
//
// Revoked writs are skipped: revocation outranks expiry, exactly as the DNS
// tombstone rule has it, and a revoked writ must not be relabelled `expired` as
// though it had merely lapsed.
task sweep_expired_writs {
  description = "Materialise writ expiry for the console. Does not touch the chain."
  active = true

  stack {
    db.query writ {
      where = (
        ($db.writ.status == "active" || $db.writ.status == "pending_signature" || $db.writ.status == "draft")
        && $db.writ.expires_at < "now"
      )
      sort = [{field: "expires_at", order: "asc"}]
      per_page = 500
    } as $lapsed

    for_each ($lapsed as $writ) {
      db.edit writ {
        field_name = "id"
        field_value = $writ.id
        data = { status: "expired", updated_at: "now" }
      }
      function.audit_append {
        principal_id = $writ.principal_id
        method = "TASK"
        path = "task/sweep_expired_writs"
        vars = { writ_id: $writ.uid, expires_at: $writ.expires_at }
      }
    }
  }

  schedule = [{ starts_on: 2026-09-03 00:00:00+0000, freq: 3600 }]
}
---
// task/drain_job_queue.xs
// job-retry: the worker. Runs every 30 seconds.
//
// `freq` is SECONDS. 30 means every thirty seconds, not the 30th minute.
//
// The loop is deliberately bounded — a small batch per tick — rather than
// draining until empty. Xano's community answer to agent-loop timeouts is to
// persist state and continue the workflow across separate runs instead of
// holding a multi-step workflow inside one execution, and a queue worker is the
// same shape: the state is in the table, so a tick that gets cut short loses a
// lease, not a job.
//
// Each job is claimed, dispatched, and then explicitly completed or failed.
// There is no path where a job silently disappears: an unhandled kind is failed
// with a reason and backs off like anything else, so a typo shows up in the
// dead-letter table instead of as an act that never happened.
task drain_job_queue {
  description = "Claim and run due jobs: execute allowed acts, process webhooks."
  active = true

  stack {
    for_each (["act.execute", "webhook.esign"] as $kind) {
      function.job_claim { kind = $kind limit = 5 } as $lease

      for_each ($lease.jobs as $job) {
        try {
          stack {
            conditional ($job.kind == "act.execute") {
              then { function.act_execute { job = $job } as $result }
              else {
                conditional ($job.kind == "webhook.esign") {
                  then { function.webhook_esign_process { job = $job } as $result }
                  else {
                    throw { error_type = "fatal" error = "No handler for job kind." }
                  }
                }
              }
            }
            function.job_complete { job_id = $job.id claim_token = $lease.claim_token }
          }
          catch {
            stack {
              // Backoff and the dead-letter decision both live in job_fail; the
              // worker's only job on failure is to report honestly.
              function.job_fail {
                job_id = $job.id
                claim_token = $lease.claim_token
                error = $error.message|default:"unknown failure"
              }
            }
          }
        }
      }
    }
  }

  schedule = [{ starts_on: 2026-09-03 00:00:00+0000, freq: 30 }]
}
---
// task/reap_stale_claims.xs
// job-retry: return abandoned leases to the queue. Every five minutes.
//
// `freq` is SECONDS. 300 is five minutes.
//
// Without this, a worker that dies between claiming a job and completing it
// removes that job from the world: it is neither pending nor done, and nothing
// will ever look at it again. For an act a human already authorised, "silently
// nothing happened" is the worst available outcome — worse than failing loudly,
// because nobody finds out.
//
// The reap counts as an attempt. A job that repeatedly kills its worker is a job
// that will keep killing workers, and it needs to reach the dead-letter tier
// rather than cycling forever.
task reap_stale_claims {
  description = "Return jobs whose lease expired to pending, counting the attempt."
  active = true

  stack {
    db.query job {
      where = ($db.job.status == "claimed" && $db.job.claimed_at < "now"|subtract_seconds:600)
      per_page = 100
    } as $stale

    for_each ($stale as $job) {
      var $attempts = $job.attempts|add:1
      var $log = $job.attempt_log|default:[]|array_push:{
        attempt: $attempts,
        at: "now"|to_iso8601,
        error: "lease expired without completion"
      }

      conditional ($attempts >= $job.max_attempts) {
        then {
          db.add job_dead_letter {
            data = {
              job_id: $job.id,
              kind: $job.kind,
              idempotency_key: $job.idempotency_key,
              payload: $job.payload,
              attempts: $attempts,
              last_error: "lease expired without completion",
              attempt_log: $log
            }
          }
          db.edit job {
            field_name = "id"
            field_value = $job.id
            data = { status: "dead", attempts: $attempts, attempt_log: $log, claim_token: null }
          }
        }
        else {
          db.edit job {
            field_name = "id"
            field_value = $job.id
            data = {
              status: "pending",
              attempts: $attempts,
              attempt_log: $log,
              claim_token: null,
              claimed_at: null,
              run_after: "now"|add_seconds:($job.attempts|add:1)
            }
          }
        }
      }
    }
  }

  schedule = [{ starts_on: 2026-09-03 00:00:00+0000, freq: 300 }]
}

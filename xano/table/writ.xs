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

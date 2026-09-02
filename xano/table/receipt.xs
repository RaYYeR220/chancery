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

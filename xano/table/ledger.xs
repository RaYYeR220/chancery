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

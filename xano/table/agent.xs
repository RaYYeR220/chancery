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

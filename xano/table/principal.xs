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

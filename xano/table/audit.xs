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

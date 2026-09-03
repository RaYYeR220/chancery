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

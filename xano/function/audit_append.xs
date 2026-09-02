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

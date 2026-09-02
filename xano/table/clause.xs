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

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

// Every inbound webhook request, verified or not, kept.
//
// Rejected deliveries are stored too. A forged callback claiming a writ was
// signed is exactly the attack this product exists to stop, and the record of
// the attempt is worth more than the disk it costs.
//
// `raw_body` is the bytes as they arrived. The HMAC is computed over those
// bytes; re-serialising the parsed object reorders keys and the digest stops
// matching, which presents as "the provider's signatures are wrong" and wastes
// a day.
table webhook_request {
  schema {
    int id
    timestamp created_at?=now
    uuid uid
    int source_id { table = "webhook_source" }
    text? delivery_id
    text? signature
    bool verified?=false
    enum status?="received" {
      values = ["received", "queued", "processed", "replayed", "rejected"]
    }
    json headers
    text raw_body
    text? error
    timestamp? processed_at
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "uid", op: "asc"}]}
    // Idempotent replay handling lives here: the provider retries until it sees
    // a 200, and this index is what makes the second delivery a lookup instead
    // of a second signature.
    {type: "btree|unique", field: [{name: "source_id", op: "asc"}, {name: "delivery_id", op: "asc"}]}
    {type: "btree", field: [{name: "status", op: "asc"}, {name: "created_at", op: "asc"}]}
  ]
}

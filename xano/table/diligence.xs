// A check against the live world, with the sources it was derived from.
//
// `verdict` has three values and only one of them passes. `unknown` is not a
// soft `clear`: a check that could not be completed fails the condition, because
// "we could not find out" is not evidence that there is nothing to find. The
// citations are stored so a disputed refusal can be re-queried by hand.
table diligence {
  schema {
    int id
    timestamp created_at?=now
    int? act_id { table = "act" }
    int? writ_id { table = "writ" }
    enum check {
      values = [
        "trademark_clear",
        "no_brand_collision",
        "counterparty_exists",
        "no_adverse_media",
        "no_patent_litigation"
      ]
    }
    enum verdict { values = ["clear", "flagged", "unknown"] }
    text summary
    // [{ title, url, engine }] exactly as the diligence service returned them.
    json citations
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "act_id", op: "asc"}]}
    {type: "btree", field: [{name: "writ_id", op: "asc"}, {name: "created_at", op: "desc"}]}
  ]
}

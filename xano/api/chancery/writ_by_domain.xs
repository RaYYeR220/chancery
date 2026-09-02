// GET /writ/by_domain?domain= — getWritByAgentDomain
//
// This is the lookup the gate makes on every single act, so its resolution rule
// is load-bearing: **newest first, whatever the status.**
//
// Not "newest active". A revoked writ has to stay findable, because the gate
// needs to answer WRIT_REVOKED rather than NO_WRIT, and those are very different
// things to tell a principal — one says "your authority was withdrawn", the
// other says "you never had any", and only the first is true.
query writ/by_domain verb=GET {
  description = "The current writ for an agent domain, scoped to the caller."

  input {
    text domain? filters=trim|lower
  }

  stack {
    db.query writ {
      // The join is on the caller's own agents. An agent domain is public
      // information; the writ behind it is not.
      join = [{table: "agent", on: ($db.agent.id == $db.writ.agent_id)}]
      where = ($db.agent.domain == $input.domain && $db.writ.principal_id == $auth.id)
      sort = [{field: "created_at", order: "desc"}, {field: "id", order: "desc"}]
      per_page = 1
    } as $rows

    var $writ = $rows|first

    conditional ($writ == null) {
      then { var $assembled = null }
      else { function.writ_assemble { writ_id = $writ.id } as $assembled }
    }
  }

  response = $assembled
}

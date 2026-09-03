// GET /writ_by_domain?domain= — getWritByAgentDomain
//
// This is the lookup the gate makes on every single act, so its resolution rule
// is load-bearing: **newest first, whatever the status.**
//
// Not "newest active". A revoked writ has to stay findable, because the gate
// needs to answer WRIT_REVOKED rather than NO_WRIT, and those are very different
// things to tell a principal — one says "your authority was withdrawn", the
// other says "you never had any", and only the first is true.
//
// The name is `writ_by_domain`, not `writ/by_domain`, and that is not a style
// choice. Xano matches `writ/{writ_uid}` FIRST — a literal segment does not beat
// a path parameter — so `GET /writ/by_domain` resolved to the by-uid endpoint
// with `writ_uid = "by_domain"`, which then failed comparing a non-uuid against
// the `uuid` column: `ParseError: Invalid value for param "writ.uid"`. Keeping
// the two off a shared prefix is the only reliable fix.
query "writ_by_domain" verb=GET {
  description = "The current writ for an agent domain, scoped to the caller."
  api_group = "chancery"
  auth = "principal"

  input {
    text domain filters=trim|lower
  }

  stack {
    db.query "writ" {
      join = {
        agent: {
          table: "agent",
          type: "inner",
          where: $db.agent.id == $db.writ.agent_id
        }
      }
      where = $db.agent.domain == $input.domain && $db.writ.principal_id == $auth.id
      sort = {created_at: "desc"}
      return = {type: "single"}
    } as $writ

    var $assembled {
      value = null
    }

    conditional {
      if ($writ != null) {
        function.run "writ_assemble" {
          input = {writ_id: $writ.id}
        } as $found

        var.update $assembled {
          value = $found
        }
      }
    }
  }

  response = $assembled
}

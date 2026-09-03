// POST /writ — createWrit
//
// The principal is read from `$auth.id` and the body cannot name one. That is
// not a convenience: a body that could name a principal is a body that could
// name somebody else's, and the writ is the document that says who is on the
// hook for what an agent spends.
//
// The agent is upserted by (principal, domain). Re-drafting a writ for an agent
// that already exists must not fork it into a second identity, because the
// public join key a verifier uses is the DNS name and two agent rows on one name
// makes "which authority applies" ambiguous at the worst possible moment.
//
// Clauses are inserted, never merged. A writ is drafted whole and then signed
// whole; there is no partial amendment path anywhere in this API.
query "writ" verb=POST {
  description = "Draft a writ. Returns the assembled instrument, status `draft`."
  api_group = "chancery"
  auth = "principal"

  input {
    text agent_external_id filters=trim
    text agent_label filters=trim
    text agent_domain filters=trim|lower
    text agent_public_key filters=trim
    timestamp effective_from
    timestamp expires_at
    text jurisdiction filters=trim
    json grants
  }

  stack {
    function.run "audit_append" {
      input = {principal_id: $auth.id, method: "POST", path: "writ", ip: $env.$remote_ip, vars: {agent_domain: $input.agent_domain}, ledger_sequence: null}
    }

    precondition ($input.expires_at > $input.effective_from) {
      error_type = "inputerror"
      error = "A writ cannot expire before it takes effect."
    }

    precondition (($input.grants|count) > 0) {
      error_type = "inputerror"
      error = "A writ that grants nothing is not a writ."
    }

    db.query "agent" {
      where = $db.agent.principal_id == $auth.id && $db.agent.domain == $input.agent_domain
      return = {type: "single"}
    } as $agent

    conditional {
      if ($agent == null) {
        security.create_uuid {
        } as $agent_uid

        db.add "agent" {
          data = {
            uid: $agent_uid,
            principal_id: $auth.id,
            external_id: $input.agent_external_id,
            label: $input.agent_label,
            domain: $input.agent_domain,
            public_key: $input.agent_public_key
          }
        } as $created_agent

        var.update $agent {
          value = $created_agent
        }
      }
    }

    security.create_uuid {
    } as $writ_uid

    db.add "writ" {
      data = {
        uid: $writ_uid,
        principal_id: $auth.id,
        agent_id: $agent.id,
        version: 1,
        status: "draft",
        effective_from: $input.effective_from,
        expires_at: $input.expires_at,
        jurisdiction: $input.jurisdiction
      }
    } as $writ

    var $ordinal {
      value = 0
    }

    foreach ($input.grants) {
      each as $grant {
        db.add "clause" {
          data = {
            writ_id: $writ.id,
            ref: $grant.ref,
            act_kind: $grant.act_kind,
            limits: $grant.limits,
            conditions: $grant.conditions,
            ordinal: $ordinal
          }
        }

        var.update $ordinal {
          value = $ordinal + 1
        }
      }
    }

    function.run "writ_assemble" {
      input = {writ_id: $writ.id}
    } as $assembled
  }

  response = $assembled
}

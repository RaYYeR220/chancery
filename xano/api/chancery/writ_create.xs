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
query writ verb=POST {
  description = "Draft a writ. Returns the assembled instrument, status `draft`."

  input {
    text agent_external_id? filters=trim
    text agent_label? filters=trim
    text agent_domain? filters=trim|lower
    text agent_public_key? filters=trim
    timestamp effective_from?
    timestamp expires_at?
    text jurisdiction? filters=trim
    // [{ ref, act_kind, limits, conditions }] — limits and conditions stored
    // verbatim; see the note on `clause`.
    json grants?
  }

  stack {
    precondition ($input.expires_at > $input.effective_from) {
      error_type = "input"
      error = "A writ cannot expire before it takes effect."
    }
    precondition ($input.grants|count > 0) {
      error_type = "input"
      error = "A writ that grants nothing is not a writ."
    }

    db.query agent {
      where = ($db.agent.principal_id == $auth.id && $db.agent.domain == $input.agent_domain)
      per_page = 1
    } as $found

    conditional ($found|count > 0) {
      then { var $agent = $found|first }
      else {
        security.uuid {} as $agent_uid
        db.add agent {
          data = {
            uid: $agent_uid,
            principal_id: $auth.id,
            external_id: $input.agent_external_id,
            label: $input.agent_label,
            domain: $input.agent_domain,
            public_key: $input.agent_public_key
          }
        } as $agent
      }
    }

    security.uuid {} as $writ_uid
    db.add writ {
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

    var $ordinal = 0
    for_each ($input.grants as $grant) {
      db.add clause {
        data = {
          writ_id: $writ.id,
          ref: $grant.ref,
          act_kind: $grant.act_kind,
          limits: $grant.limits,
          conditions: $grant.conditions,
          ordinal: $ordinal
        }
      }
      var $ordinal = $ordinal|add:1
    }

    function.writ_assemble { writ_id = $writ.id } as $assembled
  }

  response = $assembled
}

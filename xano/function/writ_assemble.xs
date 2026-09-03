// Build the domain object the API returns, out of the four tables it lives in.
//
// This function is the reason there are no auto-generated CRUD endpoints on
// `writ`. A raw row is not a writ: it has no principal, no agent, no clauses,
// and integer foreign keys that mean nothing outside this workspace. Every read
// path assembles the instrument, so there is exactly one shape a consumer ever
// sees and exactly one place to change it.
//
// Timestamps go out as the raw epoch-millisecond column values rather than
// formatted strings. XanoScript's `format_timestamp` needs escaped literals to
// emit ISO-8601 and every escape is a chance to silently produce a date the
// engine cannot parse; the TypeScript adapter already normalises epoch millis to
// ISO on the way in, so the conversion happens once, in the place that has tests.
function "writ_assemble" {
  description = "Assemble a StoredWrit from writ + principal + agent + clauses."

  input {
    int writ_id
  }

  stack {
    db.get "writ" {
      field_name = "id"
      field_value = $input.writ_id
    } as $writ

    precondition ($writ != null) {
      error_type = "notfound"
      error = "No such writ."
    }

    db.get "principal" {
      field_name = "id"
      field_value = $writ.principal_id
    } as $principal

    db.get "agent" {
      field_name = "id"
      field_value = $writ.agent_id
    } as $agent

    db.query "clause" {
      where = $db.clause.writ_id == $writ.id
      sort = {ordinal: "asc"}
      return = {type: "list"}
    } as $clauses

    var $grants {
      value = []
    }

    foreach ($clauses) {
      each as $clause {
        var.update $grants {
          value = $grants|push:{ref: $clause.ref, act_kind: $clause.act_kind, limits: $clause.limits, conditions: $clause.conditions}
        }
      }
    }
  }

  response = {
    id: $writ.uid,
    status: $writ.status,
    spec: {
      principal: {
        id: $principal.uid,
        legal_name: $principal.legal_name,
        email: $principal.email,
        entity_verified: $principal.entity_verified
      },
      agent: {
        id: $agent.external_id,
        label: $agent.label,
        domain: $agent.domain,
        public_key: $agent.public_key
      },
      grants: $grants,
      effective_from: $writ.effective_from,
      expires_at: $writ.expires_at,
      jurisdiction: $writ.jurisdiction
    },
    document_url: $writ.document_url,
    document_sha256: $writ.document_sha256,
    envelope_id: $writ.envelope_id,
    policy: $writ.policy,
    anchored_at: $writ.anchored_at
  }
}

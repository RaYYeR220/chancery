// GET /verify?domain= — the public verifier.
//
// What a stranger can learn about an agent's authority, and no more: whether a
// writ exists, whether it is live, the hash of the document behind it, where
// that document can be fetched, and when it lapses. All of that is already in
// the WRIT1 TXT record; this endpoint exists so a verifier can cross-check the
// registry against DNS and notice when they disagree.
//
// What it deliberately does not return: the policy, the clauses, the principal,
// the agent's label, or any act. A verifier needs to know THAT an agent is
// authorised, not what for — the instrument itself is the principal's to publish.
//
// The ledger head is included because it is the witness value. Publish it
// anywhere durable and no earlier entry can be altered, removed or reordered
// without the recomputed head diverging from what was published.
query "verify" verb=GET {
  description = "Public authority check for one agent domain."
  api_group = "public"

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
      where = $db.agent.domain == $input.domain
      sort = {created_at: "desc"}
      return = {type: "single"}
    } as $writ

    db.query "ledger" {
      sort = {sequence: "desc"}
      return = {type: "single"}
    } as $head

    var $ledger {
      value = {length: 0, head_hash: "0000000000000000000000000000000000000000000000000000000000000000"}
    }

    conditional {
      if ($head != null) {
        var.update $ledger {
          value = {length: ($head.sequence + 1), head_hash: $head.hash}
        }
      }
    }

    var $summary {
      value = {status: null, document_sha256: null, document_url: null, expires_at: null, anchored_at: null}
    }

    conditional {
      if ($writ != null) {
        var.update $summary {
          value = {status: $writ.status, document_sha256: $writ.document_sha256, document_url: $writ.document_url, expires_at: $writ.expires_at, anchored_at: $writ.anchored_at}
        }
      }
    }
  }

  response = {
    agent_domain: $input.domain,
    status: $summary.status,
    document_sha256: $summary.document_sha256,
    document_url: $summary.document_url,
    expires_at: $summary.expires_at,
    anchored_at: $summary.anchored_at,
    ledger: $ledger
  }
}

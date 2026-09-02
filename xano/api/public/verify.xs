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
query verify verb=GET {
  description = "Public authority check for one agent domain."

  input {
    text domain? filters=trim|lower
  }

  stack {
    db.query writ {
      join = [{table: "agent", on: ($db.agent.id == $db.writ.agent_id)}]
      where = ($db.agent.domain == $input.domain)
      sort = [{field: "created_at", order: "desc"}]
      per_page = 1
    } as $rows
    var $writ = $rows|first

    db.query ledger {
      sort = [{field: "sequence", order: "desc"}]
      per_page = 1
    } as $tail
    var $head = $tail|first
  }

  response = {
    agent_domain: $input.domain,
    status: $writ == null ? null : $writ.status,
    document_sha256: $writ == null ? null : $writ.document_sha256,
    document_url: $writ == null ? null : $writ.document_url,
    expires_at: $writ == null ? null : $writ.expires_at|to_iso8601,
    anchored_at: ($writ == null || $writ.anchored_at == null) ? null : $writ.anchored_at|to_iso8601,
    ledger: {
      length: $head == null ? 0 : $head.sequence|add:1,
      head_hash: $head == null
        ? "0000000000000000000000000000000000000000000000000000000000000000"
        : $head.hash
    }
  }
}

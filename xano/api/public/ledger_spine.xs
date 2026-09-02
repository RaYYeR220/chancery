// GET /ledger/spine?from=&to= — the chain's linkage, without its contents.
//
// Sequence, previous hash, hash, kind and time. No payloads. That is enough for
// anyone to confirm that every entry links to the one before it and that the
// head they were told about is the head of an unbroken chain — and not enough to
// learn what any of it was about.
//
// This is the shape the tamper-evidence argument actually rests on. The chain is
// not tamper-PROOF; anyone holding the database can rewrite it end to end. It is
// tamper-EVIDENT against a witness: publish the head, and no earlier entry can
// be altered, removed or reordered without the spine failing to reproduce it.
query ledger/spine verb=GET {
  description = "Public hash spine. Linkage only, no payloads."

  input {
    int? from
    int? to
  }

  stack {
    db.query ledger {
      where = (
        $db.ledger.sequence >= ($input.from|default:0)
        && $db.ledger.sequence <= ($input.to|default:9223372036854775807)
      )
      sort = [{field: "sequence", order: "asc"}]
      per_page = 1000
    } as $rows

    var $spine = []
    for_each ($rows as $row) {
      var $spine = $spine|array_push:{
        sequence: $row.sequence,
        previous_hash: $row.previous_hash,
        hash: $row.hash,
        kind: $row.kind,
        at: $row.at
      }
    }
  }

  response = $spine
}

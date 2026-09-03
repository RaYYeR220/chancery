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
//
// The bounds are resolved into sentinel vars before the query rather than tested
// for null inside the `where`. A `where` clause compiles to SQL and is not
// short-circuited, so `($input.to == null || col <= $input.to)` still binds null
// against an int column and fails with `ParseError: Invalid value for param`.
query "ledger/spine" verb=GET {
  description = "Public hash spine. Linkage only, no payloads."
  api_group = "public"

  input {
    int? from?
    int? to?
  }

  stack {
    var $from {
      value = 0
    }
    var $to {
      value = 9007199254740991
    }

    conditional {
      if ($input.from != null) {
        var.update $from {
          value = $input.from
        }
      }
    }
    conditional {
      if ($input.to != null) {
        var.update $to {
          value = $input.to
        }
      }
    }

    db.query "ledger" {
      where = $db.ledger.sequence >= $from && $db.ledger.sequence <= $to
      sort = {sequence: "asc"}
      return = {type: "list"}
    } as $rows

    var $spine {
      value = []
    }

    foreach ($rows) {
      each as $row {
        var.update $spine {
          value = $spine|push:{sequence: $row.sequence, previous_hash: $row.previous_hash, hash: $row.hash, kind: $row.kind, at: $row.at}
        }
      }
    }
  }

  response = $spine
}

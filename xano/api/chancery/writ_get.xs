// GET /writ/{writ_uid} — getWrit
//
// Answers 200 with `null` when there is no such writ, rather than 404. Xano also
// answers 404 for a path that does not route, and "you called the wrong URL"
// must not be indistinguishable from "this principal has no such writ" — the
// client would map one to `null` and swallow the other.
//
// A writ belonging to another principal is also `null`, not 403. Returning
// "forbidden" would confirm the uid exists, which is a membership oracle over
// the whole registry.
query "writ/{writ_uid}" verb=GET {
  description = "One assembled writ, scoped to the caller."
  api_group = "chancery"
  auth = "principal"

  input {
    text writ_uid
  }

  stack {
    function.run "writ_owned" {
      input = {writ_uid: $input.writ_uid, required: false}
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

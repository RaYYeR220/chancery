// Resolve a writ uid to a row the CALLER is allowed to touch.
//
// Xano's own security guidance names the failure this prevents as the most
// common application-level mistake: trusting an id that arrived in the request.
// The uid in the path is not an authorisation — the `principal_id == $auth.id`
// clause is. Every authenticated endpoint that names a writ starts here, so
// there is one implementation of the check and no endpoint can forget it.
//
// A writ belonging to someone else is reported as absent, not as forbidden.
// "403" on another principal's uid confirms that the uid exists, which is a
// membership oracle over the whole registry.
function writ_owned {
  description = "Look up a writ by uid, scoped to the authenticated principal."

  input {
    text writ_uid
    // When false the caller gets null instead of an error, for the read paths
    // where "no such writ" is an answer rather than a failure.
    bool required?=true
  }

  stack {
    db.query writ {
      where = ($db.writ.uid == $input.writ_uid && $db.writ.principal_id == $auth.id)
      per_page = 1
    } as $rows

    var $writ = $rows|first

    precondition ($writ != null || $input.required == false) {
      error_type = "notfound"
      error = "No such writ."
    }
  }

  response = $writ
}

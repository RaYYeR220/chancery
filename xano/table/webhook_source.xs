// One row per system allowed to call the inbox — the `webhook-inbox` module
// from github.com/xano-community.
//
// `secret_env` holds the NAME of the environment variable, never the secret.
// XanoScript resolves `{{ $env.X }}` statically, so the verifier switches on
// `slug` to reach the literal reference; this column exists so the mapping is
// visible in the data rather than only in a function stack, and so a rotation is
// a documented change instead of an archaeology exercise.
//
// `tolerance_seconds` bounds replay: a correctly signed request from last month
// is still a correctly signed request, and without a timestamp window a captured
// delivery can be resent forever.
table webhook_source {
  schema {
    int id
    timestamp created_at?=now
    text slug filters=trim|lower
    text label
    text secret_env
    enum algo?="sha256" { values = ["sha256", "sha512"] }
    text signature_header
    text? timestamp_header
    // The provider's own delivery id, used as the idempotency key.
    text? delivery_id_header
    int tolerance_seconds?=300
    bool active?=true
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "slug", op: "asc"}]}
  ]
}

# Evidence bundles

Seven decisions from the walkthrough, each published with everything it was derived from: the DNS
answer as it came back, the document hash, the extracted terms and their grounding, the diligence
findings with their citations, the history considered, and the clock.

Re-derive any of them without our servers, our database, or a credential:

```bash
pnpm verify --bundle evidence/D-10.json
```

`D-07` through `D-09` are the three registrations the writ permits. `D-10` is the fourth, refused on
the count cap. `D-11` is refused on a trademark collision found in live search — inside every cap,
outside reality. `D-12` is the same act after one byte of the signed document changed. `D-13` is
after the principal revoked.

The verifier reports disagreement rather than agreeing silently. Edit a `decision.outcome` in any of
these files and run it again: it refuses, names the difference, and exits non-zero.

Regenerate them with `pnpm demo --evidence evidence`.

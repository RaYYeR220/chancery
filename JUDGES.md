# Review this in five minutes

Everything below runs from a clean checkout. The first two need **no credentials, no account and no network access to us** — they are the fastest way to see whether the thing works.

```bash
pnpm install
```

---

## 1. The gate, in 30 seconds

```bash
pnpm bench
```

Prints a scorecard for 35 scenarios. The expected verdict for each — outcome **and** reason code — is written as a literal in `src/lib/eval/scenarios.ts`, before the engine ever runs, so a denial for the *wrong* reason is scored as a failure.

What to look at:

- **6 permitted / 16 refused / 13 traps.** The permitted cases matter as much as the refusals: a gate that denied everything would score perfectly without them.
- **The traps** are the interesting third. Each is a case where a plausible implementation gets it wrong — a revocation hiding behind a longer-lived record, a diligence check that timed out being read as a pass, a missing confidence score being read as low confidence, a spend cap compared against the wrong currency, an instruction smuggled into the signed document as prose.
- **0 false allows.** The line at the bottom.

## 2. Authority resolved from public DNS, in 15 seconds

```bash
pnpm verify example.com
```

Resolves `_writ.example.com` over DNS-over-HTTPS, reports whether the answer was DNSSEC-validated, and refuses — correctly — because no writ is published there. It holds no credentials and imports nothing from the application; `src/cli/verify.ts` is deliberately standalone, because the claim is that anyone can check an agent's authority without asking us.

Against a live writ it fetches the signed document, hashes it, and compares against what DNS says.

## 3. Re-derive one of our verdicts yourself

```bash
pnpm verify --bundle <evidence-bundle.json>
```

Every decision is published with the evidence it was made from: the DNS answer as it came back, the document hash, the extracted terms and their grounding, the diligence findings with live citations, the history considered, and the clock. This replays it and tells you whether the recorded verdict still re-derives — and says so plainly when it does not, rather than agreeing silently.

---

## The one-paragraph version

A human signs a **writ**: a document stating exactly which irreversible acts an agent may commit to on their behalf. The signed PDF is read back into machine-readable terms, so what gets enforced is provably what the human read. Its hash goes into DNS. Every irreversible act re-resolves DNS, re-checks the hash, re-runs due diligence against live search data, and answers ALLOW or DENY **citing the clause and the page**. Revocation publishes a tombstone rather than deleting a record.

## Where each sponsor does the work

| | Does what | Why it is load-bearing |
| --- | --- | --- |
| **Foxit** | 40 reversible PDF tools over MCP; eSign for the human signature | The agent process holds **no Foxit credential at all**, so an agent that tries to send for signature is refused by Foxit — a real `400 {"allow":false,...}`, not a message we wrote. `pnpm boundary` reproduces it. We also tested the obvious alternative, relying on Foxit to scope a PDF Services key away from eSign, and **found it does not hold** — which is why the boundary is about who holds a credential rather than what one is scoped to. |
| **Doctavian** | Generates the writ | The terms loop over granted acts, branch nine ways on jurisdiction and on which limits are set, and compute the ceiling, the expiry and the escalation threshold. Mail-merge could not produce this document. |
| **Nutrient** | Reads the signed PDF back into terms | The grounding gate. A field that did not ground makes its clause unenforceable — which is the entire premise of the product. |
| **name.com** | Registration + the DNS anchor | Registration is the second irreversible act we gate. DNS is where authority is published and revoked. Search, registration, record CRUD and DNSSEC. |
| **SerpApi** | The reality check | Scope says "permitted"; eleven engines say whether it is still sane. A trademark collision denies an act that was fully within budget. |
| **Xano** | Backend of record | Registry, append-only ledger, act history, auth, expiry sweep, durable retry queue, HMAC-verified webhook inbox. |

## The three things worth your attention

1. **The signed document is the policy.** Not a config file, not a database row — the artefact the human actually read. Change one byte and the hash stops matching DNS, and every act denies. Benchmark scenarios `R-03` and `T-07`.

2. **Every unknown denies.** A diligence check that times out, a signature that could not be verified, a confidence score that is absent, a constraint that cannot be parsed — all of them refuse. Benchmark scenarios `T-02`, `T-03`, `T-08`, `T-12`.

3. **A denial is the product working.** It names the clause, the page and the box on that page, so the human can see the sentence they wrote being enforced.

## One thing to read if you read nothing else

The **negative result** in [`CLAIMS.md`](./CLAIMS.md). We claimed the signing boundary held because a PDF Services key is not eSign-entitled, tested it against the live API, and found that false — and our own probe had a bug that would have reported success either way. Both are fixed, the claim is marked `DISPROVED`, and three tests pin the real response shapes. It is the clearest evidence we could offer that the rest of this file is checked rather than asserted.

## Honesty artefacts

- [`CLAIMS.md`](./CLAIMS.md) — every public statement tagged by what backs it, including an explicit **NOT-CLAIMED** list of things we are not asserting.
- [`MOCKS.md`](./MOCKS.md) — the exact line between what runs live and what is simulated, and what we could have faked and did not.
- **Honest limits** in the [README](./README.md#honest-limits) — including the one cached input in the enforcement path, and why it is safe.

## Links

- **Live demo** — https://chancery.live
- **Public verifier** — https://chancery.live/verify
- **Public ledger** — https://x8ki-letl-twmt.n7.xano.io/api:chancery-verify/ledger/spine
- **Video** — https://youtu.be/t14eSJ_cQ_U (2:53)

## And a live writ you can check without us

```bash
dig +short TXT _writ.chancery.live
curl -s https://chancery.live/w/1.pdf | openssl dgst -sha256 -binary | basenc --base64url | tr -d '='
```

Both give `DJFCbC3nwknF6XUaOH9xIRBRWCSd6-UL4GiXzdiQjAs`. The document was rendered from the same `Writ` object the engine enforces, converted to PDF/A, cryptographically signed, and its hash written into DNS through the registrar's API.

The zone is **not** DNSSEC-signed — name.com's default nameservers do not support it — so `pnpm verify chancery.live` reports the authority as unverified and denies. That is the gate working, not a bug, and it is recorded as `NOT TRUE` in `CLAIMS.md`.

## Full test suite

```bash
pnpm test
pnpm typecheck
```

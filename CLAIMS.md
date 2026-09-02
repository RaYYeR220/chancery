# Claims

Every public statement we make about Chancery, tagged by what actually backs it. If a claim is not in this file, we are not making it.

| Tier | Meaning |
| --- | --- |
| **REPRODUCIBLE** | You can re-run it yourself, from this repo, with no credentials and no account. |
| **VERIFIED-LIVE** | We ran it against the real third-party service and kept the output. |
| **MODELED** | Implemented, typed and tested against the vendor's documented contract — but not yet exercised against a live credential. |
| **NOT-CLAIMED** | Something a reader might reasonably assume, that we are explicitly *not* asserting. |

---

## The decision engine

| Claim | Tier | How to check |
| --- | --- | --- |
| The engine is a pure function of its inputs — no clock, no network, no database read. | REPRODUCIBLE | `src/lib/core/gatekeeper.ts` takes `now` and every piece of evidence as arguments. `pnpm test` runs it with no I/O of any kind. |
| Every unknown denies. Missing evidence, an unparseable record, an absent confidence score and a timed-out check all produce a denial. | REPRODUCIBLE | `pnpm bench` — the thirteen trap scenarios are exactly these cases. |
| 35/35 on the benchmark, with 0 false allows and 0 false denies. | REPRODUCIBLE | `pnpm bench`. The answer key is a literal in `src/lib/eval/scenarios.ts`, written before the engine runs, and a denial for the *wrong reason* is scored as a failure. |
| A denial names the clause, the page and the box on that page. | REPRODUCIBLE | `pnpm bench` prints them; `Decision.reasons[].clauseRef / pageNumber / bbox`. |
| Authority is re-checked at act time, not at issuance. | REPRODUCIBLE | Every act re-resolves DNS, re-hashes the document, re-checks expiry and re-runs diligence. See `Chancery.evaluate`. |
| Any published verdict can be re-derived offline by a third party. | REPRODUCIBLE | `pnpm verify --bundle <file>` replays a decision from its own evidence and reports disagreement rather than agreeing silently. |
| The ledger records refusals as well as approvals, and tampering with it is detectable against a published head hash. | REPRODUCIBLE | `verifyChain()` recomputes the chain; `tests/core/ledger.test.ts` covers edits, deletions, reordering and forged links. |

## DNS

| Claim | Tier | How to check |
| --- | --- | --- |
| The verifier resolves authority from public DNS and holds no credentials. | REPRODUCIBLE | `pnpm verify example.com`. `src/cli/verify.ts` imports nothing from the service layer. |
| DNSSEC validation is required by default; an unvalidated answer is reported as unverified rather than trusted. | REPRODUCIBLE | Benchmark scenario R-16. The opt-out is explicit and every decision made under it says so in its own reasons. |
| Revocation is published as a tombstone that outranks any active record, whatever its expiry. | REPRODUCIBLE | Benchmark scenario T-01. |
| A writ is published in a live DNS zone and resolves from public resolvers. | *pending* | Requires the production registrar credential. Until then this is MODELED, and `MOCKS.md` says so. |

## The signature boundary

| Claim | Tier | How to check |
| --- | --- | --- |
| The agent-facing surface cannot reach the signing service, because it holds no signing credential. | MODELED | Enforced structurally: the agent-facing object has no field that could carry one. |
| An agent attempting to send for signature receives a real HTTP 401 from the signing service. | *pending* | Needs live Foxit eSign credentials to demonstrate. |
| The signed document's cryptographic signature is verified before any act is allowed. | MODELED | `signatureValid !== true` denies, including when the check could not be performed. |

## Grounding

| Claim | Tier | How to check |
| --- | --- | --- |
| Terms are read back out of the signed document, not from a stored copy. | REPRODUCIBLE | Benchmark T-09: extraction failing denies rather than falling back. |
| A term that did not ground in the page it came from makes its clause unenforceable. | REPRODUCIBLE | Benchmark R-15 and T-02. |
| The gate keys on the match kind, not on a confidence number, and there is no default threshold. | REPRODUCIBLE | `src/lib/adapters/nutrient/grounding.ts`; a `fuzzy_match` at 0.99 confidence does not ground. |
| Confidence is never presented as a probability or a percentage. | REPRODUCIBLE | A test asserts no rendered finding contains `%`. |
| Extraction against the live Nutrient API produces these citations for our writ. | *pending* | Needs a live API key. |

## Diligence

| Claim | Tier | How to check |
| --- | --- | --- |
| A check that could not complete returns `unknown`, and `unknown` denies. | REPRODUCIBLE | Benchmark T-03 and T-04. `unknown` is minted in exactly one function, always with zero citations. |
| Eleven search engines are wired, each contributing to a specific check. | MODELED | `DILIGENCE_ENGINES` in `src/lib/adapters/serpapi/diligence.ts`. |
| Findings carry live citations a human can open. | *pending* | The shapes are captured-shape fixtures built to the documented structure, not captured from a live key. |

## The agent

| Claim | Tier | How to check |
| --- | --- | --- |
| A denial is final within a run: the agent cannot retry the same act with tweaked arguments. | MODELED | Enforced in code by a refusal record, not by prompting. |
| Tool output is treated as data and never as instructions. | MODELED | Tool results are never interpolated into the system prompt. |

---

## NOT-CLAIMED

Things a reader might reasonably assume that we are explicitly not asserting:

- **We did not invent DNS-anchored trust, agent identity, or delegated authorisation.** DKIM, SPF and CAA established the DNS pattern decades ago. UCAN and zCap-LD cover capability attenuation. DIF's Trusted AI Agents working group has the problem described in detail. Our contribution is binding a mandate to a document a human signed, and enforcing the two together.
- **This is not a legal opinion, and a writ is not legal advice.** A trademark finding is evidence, not adjudication.
- **A signature produced on a vendor free tier chains to a test certificate, not a publicly trusted root.** It is cryptographically real and it is not a production trust anchor.
- **`document.send_for_signature` and the other act kinds are gated identically but only `domain.register` has an executor wired.** The rest are modelled end to end and refused or allowed correctly; they just do not yet cause anything to happen.
- **We do not claim the extraction model is accurate.** We claim that when it is unsure, the clause stops working — which is a different and much weaker claim, and the only one the design needs.
- **Extraction is cached per document, not re-run per act.** Safe because the hash is re-checked every time, but it is the one cached input in the path and we are not pretending otherwise. See `MOCKS.md`.
- **The benchmark measures the decision engine, not the extraction model or the search provider.** It says the gate behaves correctly given evidence; it says nothing about how good the evidence is.

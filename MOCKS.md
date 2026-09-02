# What is real, and what is not

The exact line between what runs against a live service and what is simulated. Nothing in this project is presented as more real than it is; where a boundary exists, it is drawn here rather than left for a reviewer to find.

Read alongside [`CLAIMS.md`](./CLAIMS.md), which tags each individual claim by its evidence.

---

## The short version

**The decision engine is not simulated in any respect.** It is a pure function, it never had a mock to begin with, and every one of its 35 benchmark scenarios exercises the real thing. Where simulation exists, it is at the edges — in the vendor calls — and each instance is listed below with the reason.

## Component by component

### Decision engine, ledger, evidence bundles, DNS record format
**Fully real.** No mocks anywhere, including in tests: there is nothing to mock, because none of it does I/O. `pnpm bench` and `pnpm test` run the production code paths.

### DNS resolution
**Real.** The verifier queries Cloudflare's DoH endpoint with a Google fallback and reports the DNSSEC AD flag as it came back. `pnpm verify example.com` demonstrates this against a zone we do not control.

It does **not** silently retry an unvalidated answer against the second resolver. Falling back until some resolver returns the answer you wanted is not verification, and the code says so.

### Domain registration and the DNS anchor — name.com
Two environments, and the difference matters:

| | Sandbox | Production |
| --- | --- | --- |
| API calls | real | real |
| Registrations | real API, test credit | real, costs money |
| **DNS resolution** | **never resolves publicly** | resolves |

The sandbox is a real API against a real registrar with $100,000 of test credit — searches, availability, registrations, DNS record writes and DNSSEC all work exactly as in production. **What it cannot do is publish a zone the world can see.** So a writ anchored in the sandbox can be read back through the registrar's own API, and cannot be verified from outside by anyone else.

That is why the client exposes `readFromRegistrar()` separately from the verification path, and why it is labelled as *not* verification. A sandbox anchor is a working integration; it is not a published authority.

### Signature — Foxit eSign
The API is real. Two limits are inherent to the tier rather than to our integration, and we do not paper over either:

- Every envelope carries a **TEST-mode watermark for 30 days**, which cannot be cleared through the API.
- The agent-facing surface holds no signing credential at all. That is the design, not a limitation — and it means the 401 shown in the walkthrough is a real response from Foxit, not a simulated one.

### Reading the signed writ back — Nutrient DWS
The API is real. Two things to be honest about:

- On a free plan, `/sign` uses a **private test certificate**, not one chaining to a publicly trusted root. The signature is cryptographically real; it is not a production trust anchor, and we do not present it as one.
- Free-plan output carries a **"For Evaluation Purposes Only"** watermark.

**Extraction is cached per document, not re-run per act.** One page of schema-bound extraction costs 15 credits against a 50-credit free tier, so re-extracting on every act is not merely expensive, it is impossible. This is safe because the document's hash is re-checked against DNS on *every* act — change one byte and both the record and the stored terms stop matching, and everything denies. It is nonetheless **the one cached input in the enforcement path**, and it is stated here rather than buried in a code comment.

### Due diligence — SerpApi
The API is real. **The fixtures are not captured responses.** They are captured-*shape*: hand-built to the documented structure of each engine, because we had no key while building. That means the parsers are tested against the documented contract rather than against reality, and a field name we got wrong would show up as a `unknown` verdict — which denies — rather than as a false pass.

Three specific things remain unconfirmed and are marked as such in the code: the exact accepted value of the patents `litigation` parameter, whether case law is its own engine or a filter on scholar, and the `json_restrictor` projections. The restrictors default to **off** for exactly this reason: a projection that dropped a key the rules read would turn a real answer into `unknown`, which is a false denial.

### Backend of record — Xano
Real API. An **in-memory store implementing the same interface** ships alongside it, and it is not a fallback to hide behind: it is what lets the demo run with zero credentials. It uses the same ledger chaining code as the real store — it does not reimplement hashing — so a chain built in memory verifies identically to one built in Xano.

The free plan allows **10 requests per 20 seconds** and does not enforce that limit inside Xano's own debugger. Anything demonstrated on the free plan is demonstrated at that rate.

### The agent — Venice
Real inference against a real model. Every test drives a **scripted fake model** instead, because a test whose result depends on what a language model felt like saying is not a test. The adversarial suite proves the runtime cannot be talked past the gate; it does not prove any particular model behaves well, and it is not intended to.

---

## Things we could have faked and deliberately did not

- **A diligence check that times out returns `unknown`, and `unknown` denies.** It would have been trivial — and dishonest — to treat a missing answer as a clear one.
- **A signature that could not be verified denies.** Silence about a signature is not evidence that it is good.
- **A missing confidence score is not treated as low confidence**, because the vendor's own documentation says it is not. It is treated as no score.
- **The benchmark scores a denial for the wrong reason as a failure.** Scoring only the outcome would have made the suite easier to pass and worth less.
- **No fabricated values anywhere.** Where a dependency cannot answer, the result is reported as unavailable. There is no code path that invents a number or a checkmark to fill a gap.

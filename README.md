# Chancery

**Power of attorney for AI agents.** A human signs a document saying exactly what an agent may commit to on their behalf. Every irreversible act the agent attempts is checked against that signed document — and refused, out loud, with the clause it broke.

An AI can draft it. Only a human can commit to it.

---

## The problem

Agents are getting hands. They register domains, send contracts for signature, move money, provision infrastructure. Each of those is irreversible: there is no undo on a purchase, and none on a signature.

The usual answer is a guardrail — a config file, a policy YAML, an allowlist in the agent's prompt. All of which share one flaw: **the human never read them.** The person who bears the consequences approved a summary in a chat window, and what actually gets enforced is a separate artifact they have never seen, sitting in a database row that anyone with write access can widen.

Chancery closes that gap. The thing the human reads and signs **is** the thing that gets enforced, and every field of it traces back to the page it was read from.

## What it does

1. **Generate.** The writ is a real document with real terms — spend caps, allowlists, name patterns, expiry, jurisdiction, escalation thresholds — rendered with branching and computed totals rather than filled into a form letter.
2. **Sign.** A human signs it. The agent cannot: nothing in the agent's process holds a signing credential, so an agent that tries gets an HTTP 401 from the signing service rather than a refusal from a prompt.
3. **Read it back.** The signed PDF is parsed into machine-readable terms with a citation for every field. A term that did not ground in the page it came from is treated as **absent**, not as permissive.
4. **Publish.** The document's hash, the agent's key and an expiry go into DNS as a `WRIT1` TXT record — the same place SPF, DKIM and CAA already live. Anyone can read it. Nobody has to ask us.
5. **Enforce.** Every irreversible act re-resolves DNS, re-checks the document hash, re-runs due diligence against live web data, and returns ALLOW or DENY citing the clause and the page.
6. **Revoke.** A tombstone goes into DNS. Not a deletion — a deleted record is invisible to a resolver still serving the old answer from cache.

## Architecture

```
                    ┌─────────────────────────────────────────────┐
   agent ──MCP──▶   │  reversible: draft · convert · search ·      │
                    │  run diligence · simulate a verdict          │
                    └─────────────────────────────────────────────┘
                                       │
                    ═══════════════════╪═══════════════════════════
                       the boundary    │    irreversibility
                    ═══════════════════╪═══════════════════════════
                                       ▼
                              ┌────────────────┐
                              │   act.request   │
                              └────────┬───────┘
                                       │
      public DNS  ◀── resolve ─────────┤
      signed PDF  ◀── re-hash ─────────┤
      live web    ◀── diligence ───────┤
      ledger      ◀── history ─────────┤
                                       ▼
                              ┌────────────────┐
                              │   gatekeeper   │   pure. every unknown denies.
                              └────────┬───────┘
                                       │
                        ALLOW ─────────┴───────── DENY
                          │                        │
                   execute the act        cite the clause, the page,
                   mint a receipt         and the box on that page
                          │                        │
                          └──────────┬─────────────┘
                                     ▼
                          append-only hash chain
                          + a published evidence bundle
                            anyone can re-derive offline
```

The boundary is drawn at **irreversibility**, not at tool category. Everything reversible is a tool an agent may call freely. Everything irreversible goes through one gate, so an agent may *ask* for anything and the answer is a verdict rather than a missing capability.

## What we claim, and what we don't

Three claims, each of which survives contact with the prior art:

- **The signed document is the policy.** Terms are re-extracted from the artefact the human signed, and a term that did not ground is unenforceable.
- **The grounding gate.** Extraction confidence is a relative, uncalibrated signal — so the gate keys on *how* a field was matched, not on a number, and a missing score means "no score", never "low".
- **Diligence as a second axis.** Scope answers "was this permitted?". Diligence answers "is it still a sane thing to do?" — and a check that could not complete is a failure, never a pass.

We do **not** claim to have invented agent identity, DNS-based trust, or delegated authorisation. DKIM, SPF and CAA established the DNS pattern decades ago; UCAN and zCap-LD cover capability attenuation; DIF's Trusted AI Agents working group has the problem well described. What none of them ship is a mandate bound to a document a human actually signed. That is the gap we build in.

See [`CLAIMS.md`](./CLAIMS.md) for every public statement tagged by what backs it, and [`MOCKS.md`](./MOCKS.md) for the exact line between what runs live and what is simulated.

## Run it

Two things run with **no credentials, no network and no account**:

```bash
pnpm install

pnpm bench                      # the decision benchmark: 35 scenarios, answer key declared up front
pnpm verify example.com         # resolve an agent's authority from live public DNS
```

`pnpm bench` prints a scorecard. Six acts that must go through, sixteen that must not, and thirteen traps where a plausible implementation gets it wrong — a revocation hiding behind a longer-lived record, a diligence check that timed out, an instruction smuggled into the signed document as prose.

The full application needs credentials:

```bash
cp .env.example .env.local      # fill in the values below
pnpm dev
```

| Variable | What it is | Needed for |
| --- | --- | --- |
| `VENICE_API_KEY` | LLM inference | the agent runtime |
| `NUTRIENT_API_KEY` | Nutrient DWS | reading the signed writ back into terms |
| `FOXIT_CLIENT_ID` / `FOXIT_CLIENT_SECRET` | Foxit PDF Services | the reversible document work |
| `FOXIT_ESIGN_*` | Foxit eSign | the signature ceremony — **server-side only, never reachable from agent code** |
| `DOCTAVIAN_BEARER` / `DOCTAVIAN_DOCUMENTS_KEY` / `DOCTAVIAN_SIGNATURES_KEY` | Doctavian | generating the writ |
| `NAMECOM_USERNAME` / `NAMECOM_TOKEN` / `NAMECOM_ENV` | name.com | registration and the DNS anchor |
| `SERPAPI_KEY` | SerpApi | live due diligence |
| `XANO_BASE_URL` / `XANO_TOKEN` | Xano | registry, ledger and act history |

## Tests

```bash
pnpm test         # the full suite
pnpm typecheck
```

The decision engine is a pure function of its inputs — no clock, no network, no database — which is why the benchmark can exist at all and why any published verdict can be re-derived offline from its evidence bundle:

```bash
pnpm verify --bundle path/to/decision.json
```

## Honest limits

- **Extraction is cached, and deliberately so.** Terms are read out of the signed document once, not on every act, because extraction is metered per page. It is safe because the document's hash is re-checked on *every* act against both DNS and the stored terms — change one byte and everything denies. It is still the one cached input in the path, and it is listed here rather than buried.
- **A registrar sandbox does not serve signed zones.** DNSSEC validation is required by default and a verifier that cannot confirm it reports the authority as unverified. Running against a sandbox therefore needs an explicit opt-out, and every decision made under that opt-out says so in its own reasons.
- **A free-tier signature is a test certificate.** It is cryptographically real and it is not a production trust anchor. We do not present it as one.
- **Diligence is evidence, not adjudication.** A trademark search is a strong signal and not a legal opinion. Findings carry their sources so a human can judge them.
- **`domain.register` is the only act with an executor wired.** The others are modelled end to end and gated identically, but only one of them spends money today.

## Licence

MIT.

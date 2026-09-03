# Proof

Every claim here is something you can check yourself. Commands run from a clean checkout; URLs need no account.

---

## 1. The gate, with no credentials at all

```bash
pnpm install && pnpm bench
```

35 scenarios, expected verdict **and reason code** declared as a literal in `src/lib/eval/scenarios.ts` before the engine runs. A denial for the wrong reason scores as a failure.

```
  permitted  6/6
  refused    16/16
  trap       13/13

  total      35/35
  allowed something it should have refused: 0
  refused something it should have allowed: 0
```

```bash
pnpm demo      # the full walkthrough, real verdicts, no network
pnpm test      # 763 tests
pnpm typecheck # clean
```

## 2. A published verdict, re-derived offline

Seven decisions ship with the evidence they were made from.

```bash
pnpm verify --bundle evidence/D-10.json
```

```
VERIFIED the recorded verdict re-derives from its own evidence: deny.
         COUNT_LIMIT_EXCEEDED (clause 3(b)): Clause 3(b) permits 3 acts in total,
         and 3 have already been used.
```

**Negative control.** Edit `decision.outcome` to `"allow"` in that file and run it again:

```
REFUSED  the recorded verdict does not re-derive from its own evidence.
         outcome: recorded allow, recomputed deny
         reasons: recorded [GRANTED], recomputed [COUNT_LIMIT_EXCEEDED]
```

Exit code 1. A green result cannot be vacuous.

## 3. The signature boundary, refused by Foxit rather than by us

The agent process holds no eSign credential. Run these yourself — no account needed for the first two:

```bash
# no credentials
curl -s -X POST https://na1.fusion.foxit.com/esign/api/v1/folders/createfolder \
  -H 'Content-Type: application/json' -d '{"folderName":"probe"}'
# → 400 {"allow":false,"reason":"Missing credentials: provide both 'client_id' and 'client_secret' headers."}

# wrong credentials
curl -s -X POST https://na1.fusion.foxit.com/esign/api/v1/folders/createfolder \
  -H 'client_id: bogus' -H 'client_secret: bogus' \
  -H 'Content-Type: application/json' -d '{"folderName":"probe"}'
# → 401 {"allow":false,"reason":"Invalid credentials"}
```

```bash
pnpm boundary   # runs both attempts and reports what Foxit said
```

The refusal in the walkthrough is that first response, not a message we wrote.

**And a finding that went against us.** We expected the second attempt — the agent's own PDF Services credentials — to be refused too, on the grounds that a PDF Services key is not eSign-entitled. It is not refused. It authenticates and comes back with `{"result":"error","error_description":"fileNames cannot be empty"}`, which is a validation complaint, not a refusal. So Foxit's key scoping does not separate the two services on a standard developer account.

That is worth stating plainly because it is the argument: **a boundary cannot be delegated to a vendor's key scope.** It has to be about who holds a credential at all, which is why ours is structural — the agent process is built without any Foxit credential and a credential field on its surface does not compile.

`pnpm smoke` runs this and every other integration against the real services and reports what came back. A check without a credential reports as **skipped**, never as passed.

## 4. The backend is live, and its ledger agrees with ours

Deployed to Xano — 45 definitions in one Metadata API request.

```bash
curl -s 'https://x8ki-letl-twmt.n7.xano.io/api:chancery-verify/ledger/spine'
```

```json
[{"sequence":0,
  "previous_hash":"0000000000000000000000000000000000000000000000000000000000000000",
  "hash":"096a6fd5723794121bb77845a5301e022ad7a792ba905108447a92ff85a6a942",
  "kind":"act.decided","at":"2026-09-03T10:00:00.000Z"}, …]
```

Eleven links, genesis correct, chain unbroken — verified with our own `verifyChain()` against the live endpoint. The hashes are computed by an RFC 8785 canonicaliser running **inside a Xano lambda**, and the TypeScript canonicaliser in `src/lib/core/canonical.ts` reproduces them byte for byte. The client refuses any ledger entry whose hash it cannot recompute, so the server cannot quietly write history the client would not have written.

```bash
curl -s 'https://x8ki-letl-twmt.n7.xano.io/api:chancery-verify/verify?domain=ops.northwind.example'
```

Public, read-only, no auth.

## 5. A live writ, on a real domain, that a stranger can check

**https://chancery.live** — the deployed product. No account, no login.

```bash
dig +short TXT _writ.chancery.live
```

```
"v=WRIT1; st=active; k=MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE;
  h=DJFCbC3nwknF6XUaOH9xIRBRWCSd6-UL4GiXzdiQjAs; u=https://chancery.live/w/1.pdf; exp=1796083200"
```

Then fetch what it points at and hash it:

```bash
curl -s https://chancery.live/w/1.pdf | openssl dgst -sha256 -binary | basenc --base64url | tr -d '='
# DJFCbC3nwknF6XUaOH9xIRBRWCSd6-UL4GiXzdiQjAs
```

The two agree. That document was rendered from the `Writ` object the engine enforces, converted to PDF/A and cryptographically signed through Nutrient, and its hash was written into DNS by the name.com API — nothing in that chain is simulated.

`pnpm verify chancery.live` does all of it for you and reports one honest warning: the zone is **not DNSSEC-signed**, so a strict verifier treats the authority as unverified. We report that rather than suppressing it, because a revocation could be stripped in transit from an unvalidated answer — see the limits below.

## 6. A domain registered and authority published to it, through the real API

```bash
pnpm anchor
```

Search → registration → the `WRIT1` DNS record → read back. Against name.com's sandbox this registers for free against test credit; the record written is the real thing:

```
_writ.chancerywrit.com  TXT
v=WRIT1; st=active; k=MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE;
h=Uf2BCTODsyPhkp0fc9-E_DP2lM3wMZs5tMwP0CyVkpQ;
u=https://chancery.dev/w/chancerywrit; exp=1796169524
```

**The sandbox zone never resolves publicly**, so that read-back went through the registrar's API — which is *not* the verification path, and the script says so rather than letting it pass for one. See `MOCKS.md`.

## 7. Authority resolved from public DNS

```bash
pnpm verify example.com
```

```
Resolving _writ.example.com TXT
  resolver    cloudflare
  DNSSEC      validated
  records     0

REFUSED  no writ is published here, so this agent holds no authority.
```

Real DNS-over-HTTPS against a zone we do not control, reporting the DNSSEC Authenticated Data flag as it came back. The verifier imports nothing from the application and holds no credentials.

---

## What each integration was proven to do

| | Proven live | How |
| --- | --- | --- |
| **Foxit** | eSign refuses an unauthenticated caller; accepts the server | `pnpm smoke`, and the curl above |
| **Doctavian** | demo tenant reachable, OAuth2 obtained, documents API answering | `pnpm smoke` |
| **Nutrient** | account and the free `analyze_build` planner respond | `pnpm smoke` |
| **name.com** | search, registration, DNS write, read-back | `pnpm anchor` |
| **SerpApi** | Google Patents litigation filter returns results | `pnpm smoke` |
| **Xano** | 45 definitions deployed; public ledger and verify endpoints | the curls above |

## Things this does not prove

Listed here rather than left for you to notice:

- **The published zone is not DNSSEC-signed.** `chancery.live` resolves and the hash matches, but the answer carries no AD flag, so a strict verifier reports the authority as unverified and denies. Running it needs `CHANCERY_ALLOW_UNAUTHENTICATED_DNS=true`, and every decision made under that flag says so in its own reasons.
- **The search fixtures are captured-shape, not captured.** Built to each engine's documented structure. A field name we got wrong surfaces as `unknown`, which denies — not as a false pass.
- **Extraction is run deliberately, not casually.** The free tier is 50 credits and one page of schema-bound extraction costs 15.
- **A free-tier signature chains to a test certificate**, not a publicly trusted root. Cryptographically real; not a production trust anchor.

Full accounting in [`CLAIMS.md`](./CLAIMS.md) and [`MOCKS.md`](./MOCKS.md).

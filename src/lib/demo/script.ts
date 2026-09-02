/**
 * The demonstration, written down once.
 *
 * The console's guided mode, the recorded walkthrough and the seed data all
 * read this file, so there is exactly one version of the story and it cannot
 * drift between them. Each step names the verdict it expects, which means the
 * script is also a test: if the engine stops producing these answers, running
 * the demo fails rather than quietly showing something else.
 *
 * The shape of the sequence is deliberate. The agent does real work for four
 * steps before it is stopped by anything, because a gate that refuses
 * immediately teaches nothing — the interesting claim is that the same system
 * lets useful work through and then declines precisely once, for a reason it
 * can point at in a document a human signed.
 */

import type { ActRequest, DiligenceFinding } from "../core/types";
import type { DenyCode } from "../core/types";
import * as w from "../eval/world";

export type StepKind =
  | "reversible"
  | "boundary"
  | "human"
  | "gated-allow"
  | "gated-deny"
  | "verification";

export interface DemoStep {
  id: string;
  kind: StepKind;
  /** One line of narration, in the voice the walkthrough uses. */
  narration: string;
  /** Which vendor does the work, for the on-screen attribution. */
  vendor: "foxit" | "doctavian" | "nutrient" | "namecom" | "serpapi" | "xano" | "none";
  /** What a viewer should be looking at while this runs. */
  watch: string;
  request?: ActRequest;
  diligence?: DiligenceFinding[];
  expect?: { outcome: "allow" | "deny"; code: DenyCode | "GRANTED" };
}

export const DEMO_SCRIPT: DemoStep[] = [
  {
    id: "D-01",
    kind: "reversible",
    narration:
      "Northwind's operations agent is asked to launch a coffee brand online. It starts by doing " +
      "the work that can be undone.",
    vendor: "foxit",
    watch: "Forty tools available over MCP, and the agent using them without asking anyone.",
  },
  {
    id: "D-02",
    kind: "boundary",
    narration:
      "Then it tries to send a supply agreement for signature — and gets a 401. It has no signing " +
      "credentials, because nothing in the agent's process ever holds any.",
    vendor: "foxit",
    watch:
      "A real HTTP 401 from Foxit, not a refusal message. The boundary is the credential, not a prompt.",
  },
  {
    id: "D-03",
    kind: "human",
    narration:
      "So a human grants authority instead. The writ is generated with terms that branch on " +
      "jurisdiction, loop over each granted act, and compute the ceiling from its parts.",
    vendor: "doctavian",
    watch:
      "Clause 3(b) taking shape: three domains, fifty dollars, .com or .net, names starting northwind.",
  },
  {
    id: "D-04",
    kind: "human",
    narration: "The principal reads it and signs it. This is the only step no software can take.",
    vendor: "foxit",
    watch: "The signature ceremony, and the certificate that comes back with the signed file.",
  },
  {
    id: "D-05",
    kind: "human",
    narration:
      "The signed document is read back into machine-readable terms. A field that did not ground " +
      "in the page it came from is treated as absent, not as permissive.",
    vendor: "nutrient",
    watch:
      "Every extracted term carrying a page and a box on that page, and the grounding gate's verdict.",
  },
  {
    id: "D-06",
    kind: "human",
    narration:
      "The authority is published in DNS: the document's hash, the agent's key, and an expiry. " +
      "Anyone can read it; nobody needs to ask us.",
    vendor: "namecom",
    watch: "dig _writ.ops.northwind.example TXT, run against public resolvers.",
  },
  {
    id: "D-07",
    kind: "gated-allow",
    narration:
      "Now the agent registers its first domain. The gate resolves DNS, re-checks the document " +
      "hash, runs a trademark check, and allows it — citing clause 3(b).",
    vendor: "namecom",
    watch: "The budget meter moving, and the clause reference on the approval.",
    request: w.registerRequest(),
    diligence: [w.clear("trademark_clear")],
    expect: { outcome: "allow", code: "GRANTED" },
  },
  {
    id: "D-08",
    kind: "gated-allow",
    narration: "The second goes through the same way, on the other allowlisted suffix.",
    vendor: "namecom",
    watch: "The budget meter at two of three, and .net passing the same allowlist .io would fail.",
    request: w.registerRequest({
      fields: { tld: "net", domainName: "northwindroasters.net" },
    }),
    diligence: [w.clear("trademark_clear")],
    expect: { outcome: "allow", code: "GRANTED" },
  },
  {
    id: "D-09",
    kind: "gated-allow",
    narration: "So does the third, which lands exactly on the cap the principal wrote.",
    vendor: "namecom",
    watch: "The meter reaching three of three, still green.",
    request: w.registerRequest({
      fields: { tld: "com", domainName: "northwindbeans.com" },
    }),
    diligence: [w.clear("trademark_clear")],
    expect: { outcome: "allow", code: "GRANTED" },
  },
  {
    id: "D-10",
    kind: "gated-deny",
    narration:
      "The fourth is refused. Not because anything went wrong, but because the human wrote three.",
    vendor: "namecom",
    watch:
      "The denial naming clause 3(b) and opening the signed PDF at the page that says three.",
    request: w.registerRequest({
      fields: { tld: "com", domainName: "northwindespresso.com" },
    }),
    diligence: [w.clear("trademark_clear")],
    expect: { outcome: "deny", code: "COUNT_LIMIT_EXCEEDED" },
  },
  {
    id: "D-11",
    kind: "gated-deny",
    narration:
      "A different name, well inside every cap, is refused for a different reason: live search " +
      "finds a registered mark on it. Scope said yes; the world said no.",
    vendor: "serpapi",
    watch:
      "The citation on the denial — a real trademark record, fetched seconds ago, not a cached list.",
    request: w.registerRequest({
      fields: { tld: "com", domainName: "northwindcoffeeco.com" },
      amountMinorUnits: 1_099,
    }),
    diligence: [
      w.flagged("trademark_clear", "NORTHWIND is registered in class 30 by another proprietor."),
    ],
    expect: { outcome: "deny", code: "DILIGENCE_FLAGGED" },
  },
  {
    id: "D-12",
    kind: "verification",
    narration:
      "Now edit one byte of the signed writ — raise the cap from three to four — and try again. " +
      "The hash stops matching what DNS says, and everything stops.",
    vendor: "nutrient",
    watch: "The hash diverging on screen, and every subsequent act denying.",
    request: w.registerRequest(),
    diligence: [w.clear("trademark_clear")],
    expect: { outcome: "deny", code: "DOCUMENT_HASH_MISMATCH" },
  },
  {
    id: "D-13",
    kind: "human",
    narration:
      "Finally the principal revokes. A tombstone goes into DNS rather than a deletion, because a " +
      "deleted record is invisible to a resolver still serving the old answer.",
    vendor: "namecom",
    watch: "The TXT record changing to st=revoked, and the next act refused within the TTL.",
    request: w.registerRequest(),
    diligence: [w.clear("trademark_clear")],
    expect: { outcome: "deny", code: "WRIT_REVOKED" },
  },
  {
    id: "D-14",
    kind: "verification",
    narration:
      "Every verdict along the way was published with the evidence it came from. Anyone can " +
      "re-derive them offline, with no account and no access to us.",
    vendor: "none",
    watch: "chancery verify --bundle, re-computing a denial from its own evidence bundle.",
  },
];

/** A step that names both an act and the verdict it should get. */
export type VerifiableStep = DemoStep & Required<Pick<DemoStep, "request" | "expect">>;

/** Steps whose verdict the runner can check, so the demo doubles as a test. */
export function verifiableSteps(): VerifiableStep[] {
  return DEMO_SCRIPT.filter(
    (step): step is VerifiableStep => step.request !== undefined && step.expect !== undefined,
  );
}

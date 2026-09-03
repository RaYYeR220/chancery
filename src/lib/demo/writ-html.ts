/**
 * The writ, as a document a person reads.
 *
 * Rendering the instrument from the same `Writ` object the engine enforces is
 * the point of the whole product: what the human signs and what the gate
 * applies come from one source, so they cannot drift. Clause references are
 * derived here and printed in the margin, because a denial that says
 * "clause 3(b)" has to be findable by eye.
 *
 * This is the fallback renderer. Doctavian generates the writ when its
 * generation engine is available; this produces the same document through
 * Nutrient's Build API when it is not. Both are recorded in MOCKS.md.
 */

import type { Condition, Grant, Limit, Writ } from "../core/types";

const ACT_LABELS: Record<string, string> = {
  "domain.register": "register a domain name",
  "domain.renew": "renew a domain name",
  "domain.transfer": "transfer a domain name",
  "dns.write": "write a DNS record",
  "document.send_for_signature": "send a document for signature",
  "document.publish": "publish a document",
};

/** 0 -> "3(a)", 1 -> "3(b)". Clause 3 is where the grants live. */
export function clauseRef(index: number): string {
  return `3(${String.fromCharCode(97 + index)})`;
}

function money(minorUnits: number, currency: string): string {
  return `${(minorUnits / 100).toFixed(2)} ${currency}`;
}

function describeLimit(limit: Limit): string {
  switch (limit.type) {
    case "count":
      return `no more than <b>${limit.max}</b> such ${limit.max === 1 ? "act" : "acts"} ${
        limit.window === "total" ? "in total" : `per ${limit.window}`
      }`;
    case "amount":
      return `a total outlay not exceeding <b>${money(limit.maxMinorUnits, limit.currency)}</b> ${
        limit.window === "total" ? "in total" : `per ${limit.window}`
      }`;
    case "allowlist":
      return `only where <span class="f">${limit.field}</span> is one of <b>${limit.values.join(", ")}</b>`;
    case "pattern":
      return `only where <span class="f">${limit.field}</span> matches <b>${limit.pattern}</b>`;
  }
}

function describeCondition(condition: Condition): string {
  switch (condition.type) {
    case "diligence":
      return `subject to the <b>${condition.check.replace(/_/g, " ")}</b> check returning clear`;
    case "jurisdiction":
      return `only under the law of <b>${condition.allowed.join(" or ")}</b>`;
    case "escalation":
      return `above <b>${money(condition.aboveMinorUnits, condition.currency)}</b> a fresh decision by the Principal is required`;
  }
}

function renderGrant(grant: Grant, index: number): string {
  const terms = [
    ...grant.limits.map(describeLimit),
    ...grant.conditions.map(describeCondition),
  ];
  return `
    <section class="clause">
      <div class="ref">${clauseRef(index)}</div>
      <div class="body">
        <p>The Agent may <b>${ACT_LABELS[grant.actKind] ?? grant.actKind}</b> on the Principal's
        behalf, subject to each of the following, all of which apply together:</p>
        <ul>${terms.map((t) => `<li>${t}</li>`).join("")}</ul>
      </div>
    </section>`;
}

export function writHtml(writ: Writ): string {
  const from = new Date(writ.effectiveFrom).toISOString().slice(0, 10);
  const until = new Date(writ.expiresAt).toISOString().slice(0, 10);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Writ of Authority ${writ.id}</title>
<style>
  @page { size: A4; margin: 24mm 20mm; }
  body { font: 11pt/1.55 Georgia, "Times New Roman", serif; color: #14100a; }
  h1 { font-size: 17pt; letter-spacing: .02em; margin: 0 0 2mm; }
  .sub { font-size: 9pt; letter-spacing: .12em; text-transform: uppercase; color: #6b6152; margin-bottom: 8mm; }
  .parties { border-top: 1.5pt solid #14100a; border-bottom: .5pt solid #a89c86; padding: 4mm 0; margin-bottom: 7mm; }
  .parties div { margin: 1.5mm 0; }
  .k { display: inline-block; width: 34mm; font-size: 8.5pt; letter-spacing: .1em;
       text-transform: uppercase; color: #6b6152; }
  h2 { font-size: 11pt; margin: 7mm 0 2mm; }
  .clause { display: flex; gap: 6mm; margin: 0 0 4mm; page-break-inside: avoid; }
  .ref { width: 14mm; flex: none; font-weight: bold; font-variant-numeric: tabular-nums; }
  .body { flex: 1; }
  .body p { margin: 0 0 1.5mm; }
  ul { margin: 0; padding-left: 5mm; }
  li { margin: .8mm 0; }
  .f { font-family: "Courier New", monospace; font-size: 9.5pt; }
  .sig { margin-top: 12mm; border-top: .5pt solid #a89c86; padding-top: 4mm; }
  .line { margin-top: 10mm; border-bottom: .5pt solid #14100a; width: 78mm; }
  .cap { font-size: 8.5pt; color: #6b6152; margin-top: 1.5mm; }
</style></head><body>

<h1>Writ of Authority</h1>
<div class="sub">${writ.id} &nbsp;·&nbsp; version ${writ.version} &nbsp;·&nbsp; governed by the law of ${writ.jurisdiction}</div>

<div class="parties">
  <div><span class="k">Principal</span> ${writ.principal.legalName} (${writ.principal.email})</div>
  <div><span class="k">Agent</span> ${writ.agent.label}</div>
  <div><span class="k">Agent domain</span> <span class="f">${writ.agent.domain}</span></div>
  <div><span class="k">Agent key</span> <span class="f">${writ.agent.publicKey}</span></div>
  <div><span class="k">In force</span> ${from} until ${until}</div>
</div>

<h2>1. Purpose</h2>
<p>The Principal appoints the Agent to act on the Principal's behalf, and only within the authority
set out in clause 3. Nothing in this instrument permits the Agent to sign it, to alter it, to
publish or withdraw it, or to widen its own authority.</p>

<h2>2. How this authority is verified</h2>
<p>A digest of this signed document, together with the Agent's public key and the expiry above, is
published as a <span class="f">WRIT1</span> TXT record at
<span class="f">_writ.${writ.agent.domain}</span>. Any party may resolve that record, retrieve this
document, and confirm the digest before relying on the Agent. Should the published digest cease to
match this document, this authority is to be treated as withdrawn.</p>

<h2>3. Authority granted</h2>
${writ.grants.map(renderGrant).join("")}

<h2>4. Withdrawal</h2>
<p>The Principal may withdraw this authority at any time by publishing a record bearing
<span class="f">st=revoked</span> at the name given in clause 2. Withdrawal takes effect for every
act attempted thereafter, and does not require the Agent's knowledge or agreement.</p>

<div class="sig">
  <p>Signed by the Principal:</p>
  <div class="line"></div>
  <div class="cap">${writ.principal.legalName} &nbsp;·&nbsp; ${writ.principal.email}</div>
</div>

</body></html>`;
}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { sampleWrit } from "../../src/lib/adapters/doctavian/sample-writ";
import { buildWritData, clauseRef } from "../../src/lib/adapters/doctavian/writ-data";
import {
  WRIT_CONDITIONS,
  WRIT_EXPRESSIONS,
  buildWritTemplateDocx,
  writTemplateBlocks,
  writTemplateText,
} from "../../src/lib/adapters/doctavian/writ-template";

const FIXTURES = resolve(__dirname, "../fixtures/doctavian");
const SAMPLE_OPTIONS = {
  escalationPercent: 25,
  escalationFloorMinorUnits: 100_000,
  dailyCapMinorUnits: 50_000,
};

/**
 * Word stores each run's text in its own `<w:t>`, XML-escaped. Reading it back
 * is the only honest check that a tag survived the trip into the .docx as one
 * unbroken run.
 */
async function readDocxRuns(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")!.async("string");
  return [...xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) =>
    match[1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&"),
  );
}

const template = writTemplateText();

describe("looping", () => {
  it("repeats the granted act classes and nests a repeater over each class's limits", () => {
    expect(template).toContain(
      '<mdoc:repeater name="grantedActs" value="{!Writ[0].Grants}" variable="grant">',
    );
    expect(template).toContain(
      '<mdoc:repeater name="grantLimits" value="{!#grant#.Limits}" variable="limit">',
    );
    expect(template).toContain('</mdoc:repeater name="grantLimits">');
    expect(template).toContain('</mdoc:repeater name="grantedActs">');
  });

  it("closes repeaters in the order it opened them", () => {
    const tags = [...template.matchAll(/<\/?mdoc:repeater name="(\w+)"/g)].map((m) => ({
      closing: m[0].startsWith("</"),
      name: m[1],
    }));
    const stack: string[] = [];
    for (const tag of tags) {
      if (tag.closing) expect(stack.pop()).toBe(tag.name);
      else stack.push(tag.name);
    }
    expect(stack).toHaveLength(0);
  });

  it("prints the clause ref carried by each grant, so a denial citing 3(b) points at 3(b)", () => {
    expect(template).toContain("{!#grant#.Ref}");
    expect(template).toContain("{!#limit#.SubRef}");
    expect(clauseRef(0)).toBe("3(a)");
    expect(clauseRef(1)).toBe("3(b)");
    expect(clauseRef(25)).toBe("3(z)");
    expect(clauseRef(26)).toBe("3(aa)");
  });
});

describe("branching", () => {
  it("gates the eIDAS clause and its fallback on jurisdiction, so exactly one prints", () => {
    // The `$` is required: without it the attribute is read as a merge field,
    // a non-empty string is truthy, and the clause hides unconditionally.
    expect(WRIT_CONDITIONS.notEea).toBe("{!$Writ[0].JurisdictionIsEea == 'false'}");
    expect(WRIT_CONDITIONS.isEea).toBe("{!$Writ[0].JurisdictionIsEea == 'true'}");
    expect(template).toContain('name="eidasClause"');
    expect(template).toContain('name="nonEeaClause"');
    expect(template).toContain('name="ukClause"');
    // `!=`, `!(...)` and ternaries are all rejected inside `hidden=`, so "not
    // GB" has to arrive as a pre-computed flag.
    expect(WRIT_CONDITIONS.notUk).toBe("{!$Writ[0].JurisdictionIsUk == 'false'}");
  });

  it("hides the escalation clause below the threshold instead of printing noise", () => {
    expect(WRIT_CONDITIONS.belowEscalationFloor).toBe(
      "{!$sum(Writ[0].Grants, 'CapMinor') <= toDecimal(Writ[0].EscalationFloorMinor)}",
    );
    expect(template).toContain('name="escalationThreshold"');
  });

  it("removes the daily ceiling clause entirely when no ceiling was set", () => {
    expect(WRIT_CONDITIONS.noDailyCap).toBe("{!$Writ[0].DailyCapMinor == ''}");
    expect(template).toContain('name="dailyCeiling"');
  });

  it("hides each per-grant limit clause when that limit is absent", () => {
    for (const condition of [
      WRIT_CONDITIONS.grantUncapped,
      WRIT_CONDITIONS.grantNoCount,
      WRIT_CONDITIONS.grantNoAllowlist,
      WRIT_CONDITIONS.grantNoPattern,
      WRIT_CONDITIONS.grantNoDiligence,
      WRIT_CONDITIONS.grantNoEscalation,
    ]) {
      expect(template).toContain(`hidden="${condition}"`);
    }
  });

  it("puts every hidden condition on an mdoc element rather than leaving it inert", () => {
    const hidden = [...template.matchAll(/hidden="([^"]+)"/g)];
    expect(hidden.length).toBeGreaterThanOrEqual(9);
    for (const [, value] of hidden) {
      // Dropping the `$` is the trap: the clause then hides unconditionally,
      // and its absence from the signed document is reported nowhere.
      expect(value.startsWith("{!$")).toBe(true);
    }
  });
});

describe("calculating", () => {
  it("sums an aggregate ceiling from the per-class caps", () => {
    expect(WRIT_EXPRESSIONS.totalCapMinor).toBe("sum(Writ[0].Grants, 'CapMinor')");
    expect(template).toContain("{!$count(Writ[0].Grants)}");
    expect(template).toContain("max(Writ[0].Grants, 'CapMinor')");
  });

  it("computes the expiry from the effective date plus the term rather than carrying it", () => {
    // `addDays`, not `dateAdd`: an unknown function renders empty rather than
    // erroring, so the wrong name is invisible until you read the output.
    expect(WRIT_EXPRESSIONS.expiresAt).toContain("addDays(Writ[0].EffectiveFrom");
    expect(WRIT_EXPRESSIONS.expiresAt).toContain("toDecimal(Writ[0].TermDays)");
    expect(template).toContain(`{!$${WRIT_EXPRESSIONS.expiresAt}}`);
  });

  it("computes the escalation threshold as a percentage of the aggregate ceiling", () => {
    // `round(x, 0)` evaluates to the empty string on this engine, so the
    // scaling is left entirely to setScale.
    expect(WRIT_EXPRESSIONS.escalationThresholdMinor).toBe(
      "sum(Writ[0].Grants, 'CapMinor') * toDecimal(Writ[0].EscalationPercent) / 100",
    );
    expect(WRIT_EXPRESSIONS.escalationThresholdAmount).not.toContain("round(");
    expect(WRIT_EXPRESSIONS.escalationPercentLabel).toContain("toPercent(");
  });

  it("formats currency with the symbol, two decimals and the code", () => {
    expect(WRIT_EXPRESSIONS.totalCapFormatted).toBe(
      "concat(Writ[0].CurrencySymbol, setScale(sum(Writ[0].Grants, 'CapMinor') / 100, 2), ' ', Writ[0].Currency)",
    );
  });

  it("never does arithmetic on a raw field, because every field is a string", () => {
    // `{!$Writ[0].TermDays + 30}` renders "9030". The only safe operand is a
    // toDecimal(...) result or another function's result.
    const rawOperand = /(Writ\[0\]\.\w+|#\w+#\.\w+)\s*[-+*/]\s*/g;
    expect([...template.matchAll(rawOperand)].map((m) => m[0])).toEqual([]);
    expect(template.match(/toDecimal\(/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });
});

describe("writ data projection", () => {
  const data = buildWritData(sampleWrit(), SAMPLE_OPTIONS);
  const row = data.Writ[0];

  it("addresses the root as an array of one, because the template reads Writ[0]", () => {
    expect(data.Writ).toHaveLength(1);
  });

  it("emits every value as a string, mirroring what Doctavian does to the upload", () => {
    for (const [key, value] of Object.entries(row)) {
      if (key === "Grants") continue;
      expect(typeof value).toBe("string");
    }
    for (const grant of row.Grants) {
      for (const [key, value] of Object.entries(grant)) {
        if (key === "Limits") continue;
        expect(typeof value).toBe("string");
      }
    }
  });

  it("keeps an uncapped grant numeric so the aggregate sum cannot meet a blank", () => {
    const dnsWrite = row.Grants.find((g) => g.ActKind === "dns.write")!;
    expect(dnsWrite.HasCap).toBe("false");
    expect(dnsWrite.CapMinor).toBe("0");
    expect(dnsWrite.CapWindow).toBe("");
  });

  it("blanks the daily ceiling when the principal set none, which hides that clause", () => {
    const withoutCeiling = buildWritData(sampleWrit(), { escalationPercent: 25 });
    expect(withoutCeiling.Writ[0].DailyCapMinor).toBe("");
    expect(row.DailyCapMinor).toBe("50000");
  });

  it("resolves the jurisdiction flag the eIDAS clause branches on", () => {
    expect(row.Jurisdiction).toBe("IE");
    expect(row.JurisdictionIsEea).toBe("true");

    const delaware = buildWritData({ ...sampleWrit(), jurisdiction: "US" });
    expect(delaware.Writ[0].JurisdictionIsEea).toBe("false");
    expect(delaware.Writ[0].JurisdictionName).toBe("the State of Delaware");
  });

  it("derives the term in days, which the template turns back into an expiry date", () => {
    expect(row.EffectiveFrom).toBe("2026-09-03");
    expect(row.TermDays).toBe("90");
  });

  it("numbers limits within their clause", () => {
    const first = row.Grants[0];
    expect(first.Ref).toBe("3(a)");
    expect(first.Limits.map((l) => l.SubRef)).toEqual([
      "3(a)(i)",
      "3(a)(ii)",
      "3(a)(iii)",
      "3(a)(iv)",
    ]);
  });

  it("sums to the ceiling the template will compute", () => {
    const total = row.Grants.reduce((sum, grant) => sum + Number(grant.CapMinor), 0);
    expect(total).toBe(265_000);
  });
});

describe("emitted .docx", () => {
  it("carries every tag as one unbroken run", async () => {
    const runs = await readDocxRuns(await buildWritTemplateDocx());
    const tagRuns = runs.filter((run) => run.includes("<mdoc:"));

    expect(tagRuns.length).toBeGreaterThanOrEqual(11);
    for (const run of tagRuns) {
      // A tag split across two runs stops being a tag, so each run that opens a
      // tag must close it too.
      expect(run.trimEnd().endsWith(">")).toBe(true);
    }
  });

  it("matches the checked-in fixture, so the fixture is never stale", async () => {
    const fixture = await readFile(resolve(FIXTURES, "writ-template.docx"));
    expect(await readDocxRuns(new Uint8Array(fixture))).toEqual(
      await readDocxRuns(await buildWritTemplateDocx()),
    );
  });

  it("ships a sample data fixture that matches the projection", async () => {
    const fixture = JSON.parse(
      await readFile(resolve(FIXTURES, "writ-sample-data.json"), "utf8"),
    );
    expect(fixture).toEqual(buildWritData(sampleWrit(), SAMPLE_OPTIONS));
  });

  it("fires every branch in at least one direction against the sample data", () => {
    const grants = buildWritData(sampleWrit(), SAMPLE_OPTIONS).Writ[0].Grants;
    expect(grants.some((g) => g.HasCap === "true")).toBe(true);
    expect(grants.some((g) => g.HasCap === "false")).toBe(true);
    expect(grants.some((g) => g.AllowlistValues === "")).toBe(true);
    expect(grants.some((g) => g.AllowlistValues !== "")).toBe(true);
    expect(grants.some((g) => g.Pattern === "")).toBe(true);
    expect(grants.some((g) => g.Pattern !== "")).toBe(true);
    expect(grants.some((g) => g.DiligenceChecks === "")).toBe(true);
    expect(grants.some((g) => g.EscalationMinor === "")).toBe(true);
    expect(grants.some((g) => g.EscalationMinor !== "")).toBe(true);
  });
});

describe("template structure", () => {
  it("keeps machinery in its own blocks so no clause text can split a tag", () => {
    for (const block of writTemplateBlocks()) {
      if (block.style === "tag") continue;
      expect(block.text).not.toContain("<mdoc:");
    }
  });
});

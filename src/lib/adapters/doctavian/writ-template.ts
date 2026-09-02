/**
 * The writ DOCX template, expressed as code.
 *
 * A writ is not a mail-merge. Which clauses exist at all depends on the data:
 * an Irish principal gets an eIDAS clause a Delaware one must not get; an
 * escalation clause that appears under a €1,000 ceiling is noise rather than
 * protection; a daily-ceiling clause the principal never set must not appear
 * saying "unlimited", it must not appear at all. A document that prints an
 * inapplicable clause is not a cosmetic bug — it is a false statement about
 * what a human authorised. So the branching lives in the template, where the
 * document itself decides, rather than in a pile of pre-rendered variants.
 *
 * Three layers are in play, all as literal text in the .docx:
 *   - merge fields      {!Writ[0].PrincipalName}
 *   - mdoc elements     <mdoc:repeater …> / <mdoc:text … hidden="…" />
 *   - Jexl expressions  {!$setScale(sum(…) / 100, 2)}
 *
 * Two traps are designed around rather than discovered later:
 *
 *   1. Every uploaded field is a STRING. `{!$Writ[0].TermDays + 30}` yields
 *      "9030", a concatenation. Every arithmetic operand below therefore goes
 *      through `toDecimal(...)`, and `CapMinor` is emitted as "0" rather than
 *      "" for uncapped grants so `sum` never meets a non-numeric string.
 *   2. Google Docs templates need HTML entities for `<` and `>` in comparisons.
 *      This is a DOCX template specifically to dodge that.
 *
 * A third trap is structural to Word rather than to Doctavian: Word splits a
 * paragraph into runs at arbitrary points (spellcheck, formatting, an edit
 * mid-word), and a tag split across two runs stops being a tag. Every tag below
 * is emitted as its own single run in its own paragraph, which is why this file
 * builds the file programmatically instead of shipping a hand-edited .docx.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

/* --------------------------------------------------------- tag builders */

/** A plain merge field: no `$`, no evaluation, just substitution. */
export function field(path: string): string {
  return `{!${path}}`;
}

/**
 * A Jexl expression. The leading `$` marks the whole tag as an expression;
 * function names inside it are bare, as in `{!$concat('-', X, '%')}`.
 */
export function expr(body: string): string {
  return `{!$${body}}`;
}

/** A field of the current repeater item, e.g. `{!#grant#.Ref}`. */
export function loopField(variable: string, path: string): string {
  return `{!#${variable}#.${path}}`;
}

/** Reference to a repeater item inside an expression. */
export function loopRef(variable: string, path: string): string {
  return `#${variable}#.${path}`;
}

export interface MdocTextOptions {
  name: string;
  value: string;
  /** A Jexl expression tag; when it evaluates true the element is not rendered. */
  hidden?: string;
}

export function mdocText(options: MdocTextOptions): string {
  const hidden = options.hidden ? ` hidden="${options.hidden}"` : "";
  return `<mdoc:text name="${options.name}" value="${options.value}"${hidden} />`;
}

export function mdocRepeaterOpen(options: {
  name: string;
  value: string;
  variable: string;
}): string {
  return `<mdoc:repeater name="${options.name}" value="${options.value}" variable="${options.variable}">`;
}

/** Doctavian's closing tag repeats the `name` attribute; this is not a typo. */
export function mdocRepeaterClose(name: string): string {
  return `</mdoc:repeater name="${name}">`;
}

/* ---------------------------------------------------------- expressions */

const GRANTS = "Writ[0].Grants";
const SYMBOL = "Writ[0].CurrencySymbol";

/**
 * Every calculated figure in the document, in one place.
 *
 * `sum`, `count`, `max`, `toDecimal`, `round`, `setScale`, `toPercent`, `join`
 * and `concat` are documented Doctavian functions. `dateAdd` and `formatDate`
 * are named from the documented "full date function set" but their exact
 * spelling is unverified against a live tenant — they are isolated here so one
 * edit fixes the whole document if the names differ.
 */
export const WRIT_EXPRESSIONS = {
  /** Aggregate ceiling: the per-class caps summed, in minor units. */
  totalCapMinor: `sum(${GRANTS}, 'CapMinor')`,
  /** The same figure as major units to two places. */
  totalCapMajor: `setScale(sum(${GRANTS}, 'CapMinor') / 100, 2)`,
  /** Formatted currency figure, symbol and code around the computed amount. */
  totalCapFormatted: `concat(${SYMBOL}, setScale(sum(${GRANTS}, 'CapMinor') / 100, 2), ' ', Writ[0].Currency)`,
  /** Number of act classes actually granted, for the recital. */
  grantCount: `count(${GRANTS})`,
  /** Largest single class cap, so the reader can see the concentration. */
  largestCapFormatted: `concat(${SYMBOL}, setScale(max(${GRANTS}, 'CapMinor') / 100, 2))`,
  /**
   * Escalation threshold: a percentage of the aggregate ceiling, computed here
   * rather than carried in the data so it can never disagree with the caps
   * printed two clauses above it.
   */
  escalationThresholdMinor: `round(sum(${GRANTS}, 'CapMinor') * toDecimal(Writ[0].EscalationPercent) / 100, 0)`,
  escalationThresholdFormatted: `concat(${SYMBOL}, setScale(round(sum(${GRANTS}, 'CapMinor') * toDecimal(Writ[0].EscalationPercent) / 100, 0) / 100, 2))`,
  escalationPercentLabel: `toPercent(toDecimal(Writ[0].EscalationPercent) / 100)`,
  /** Expiry derived from the effective date plus the term, never carried raw. */
  expiresAt: `formatDate(dateAdd(Writ[0].EffectiveFrom, toDecimal(Writ[0].TermDays), 'day'), 'yyyy-MM-dd')`,
  dailyCapFormatted: `concat(${SYMBOL}, setScale(toDecimal(Writ[0].DailyCapMinor) / 100, 2))`,
} as const;

/** Conditions for `hidden=`, i.e. the branching. */
export const WRIT_CONDITIONS = {
  /** eIDAS binds by territory, so the clause hides outside the EEA. */
  notEea: expr("Writ[0].JurisdictionIsEea == 'false'"),
  /** …and the non-EEA fallback hides inside it. Exactly one of the two prints. */
  isEea: expr("Writ[0].JurisdictionIsEea == 'true'"),
  /** A UK-only clause: the 2002 Order, not eIDAS. */
  notUk: expr("!(Writ[0].Jurisdiction in ['GB'])"),
  /** No daily ceiling was set, so the clause must not exist at all. */
  noDailyCap: expr("Writ[0].DailyCapMinor == ''"),
  /** Escalation below the floor protects nothing and only adds friction. */
  belowEscalationFloor: expr(
    `sum(${GRANTS}, 'CapMinor') <= toDecimal(Writ[0].EscalationFloorMinor)`,
  ),
  /** Unverified principal: the recital of verification must not be printed. */
  principalUnverified: expr("Writ[0].PrincipalVerified == 'false'"),
  grantUncapped: expr("#grant#.HasCap == 'false'"),
  grantNoCount: expr("#grant#.CountMax == ''"),
  grantNoAllowlist: expr("#grant#.AllowlistValues == ''"),
  grantNoPattern: expr("#grant#.Pattern == ''"),
  grantNoDiligence: expr("#grant#.DiligenceChecks == ''"),
  grantNoEscalation: expr("#grant#.EscalationMinor == ''"),
} as const;

/* ------------------------------------------------------------- document */

export type BlockStyle =
  | "title"
  | "subtitle"
  | "heading"
  | "clause"
  | "sub"
  | "tag"
  | "note"
  | "signature";

export interface TemplateBlock {
  style: BlockStyle;
  text: string;
}

const REPEATER_GRANTS = "grantedActs";
const REPEATER_LIMITS = "grantLimits";
const GRANT_VAR = "grant";
const LIMIT_VAR = "limit";

/**
 * The template body, in order. Kept as data so the tests can assert on the
 * exact tags without unzipping a .docx, and so the .docx and the assertions can
 * never drift apart.
 */
export function writTemplateBlocks(): TemplateBlock[] {
  return [
    { style: "title", text: "WRIT OF DELEGATED AUTHORITY" },
    {
      style: "subtitle",
      text: `Writ ${field("Writ[0].Id")} · version ${field("Writ[0].Version")} · ${field("Writ[0].JurisdictionName")}`,
    },

    { style: "heading", text: "1. Parties" },
    {
      style: "clause",
      text: `1.1 The Principal is ${field("Writ[0].PrincipalName")} of ${field("Writ[0].PrincipalEmail")} (the "Principal").`,
    },
    {
      style: "tag",
      text: mdocText({
        name: "principalVerification",
        value: expr(
          "concat('1.2 The Principal\\'s legal entity has been corroborated against public registry data as at ', Writ[0].EffectiveFrom, '.')",
        ),
        hidden: WRIT_CONDITIONS.principalUnverified,
      }),
    },
    {
      style: "clause",
      text: `1.3 The Agent is ${field("Writ[0].AgentLabel")}, an autonomous software agent anchored at the DNS name ${field("Writ[0].AgentDomain")} and identified by the Ed25519 public key ${field("Writ[0].AgentPublicKey")} (the "Agent").`,
    },

    { style: "heading", text: "2. Term and aggregate ceiling" },
    {
      style: "clause",
      // The expiry is computed, not carried: a stated expiry that disagrees
      // with the stated term is the kind of contradiction a signed instrument
      // cannot survive.
      text: `2.1 This writ takes effect on ${field("Writ[0].EffectiveFrom")} and expires at 23:59 UTC on ${expr(WRIT_EXPRESSIONS.expiresAt)}, being ${field("Writ[0].TermDays")} days after it takes effect. No act may be committed after that moment, whatever any other clause says.`,
    },
    {
      style: "clause",
      text: `2.2 The Agent's aggregate authority across all ${expr(WRIT_EXPRESSIONS.grantCount)} classes of act granted below is ${expr(WRIT_EXPRESSIONS.totalCapFormatted)}, being the sum of the per-class ceilings in clause 3. The largest single class ceiling is ${expr(WRIT_EXPRESSIONS.largestCapFormatted)}.`,
    },
    {
      style: "tag",
      text: mdocText({
        name: "dailyCeiling",
        value: expr(
          `concat('2.3 The Agent may not commit more than ', ${WRIT_EXPRESSIONS.dailyCapFormatted}, ' in any rolling 24-hour period, irrespective of the ceilings in clause 3.')`,
        ),
        hidden: WRIT_CONDITIONS.noDailyCap,
      }),
    },
    {
      style: "tag",
      text: mdocText({
        name: "escalationThreshold",
        value: expr(
          `concat('2.4 A single act with a value at or above ', ${WRIT_EXPRESSIONS.escalationThresholdFormatted}, ' — being ', Writ[0].EscalationPercent, '% of the aggregate ceiling — requires a fresh human decision and is not authorised by this writ alone.')`,
        ),
        hidden: WRIT_CONDITIONS.belowEscalationFloor,
      }),
    },

    { style: "heading", text: "3. Granted acts" },
    {
      style: "clause",
      text: "3. The Agent is authorised to commit the Principal to the following acts, and to no others. Any act not described below is refused by default.",
    },

    {
      style: "tag",
      text: mdocRepeaterOpen({
        name: REPEATER_GRANTS,
        value: field(GRANTS),
        variable: GRANT_VAR,
      }),
    },
    {
      style: "sub",
      // The ref travels with the grant so a denial citing "3(b)" points at the
      // paragraph a human will actually find under that heading.
      text: `${loopField(GRANT_VAR, "Ref")}  ${loopField(GRANT_VAR, "ActTitle")}`,
    },
    {
      style: "clause",
      text: `The Agent is authorised ${loopField(GRANT_VAR, "ActNarrative")}, subject to the following limits.`,
    },
    {
      style: "tag",
      text: mdocText({
        name: "grantCeiling",
        value: expr(
          `concat('Ceiling: ', ${SYMBOL}, setScale(toDecimal(${loopRef(GRANT_VAR, "CapMinor")}) / 100, 2), ' ', ${loopRef(GRANT_VAR, "CapWindow")}, ' — ', toPercent(toDecimal(${loopRef(GRANT_VAR, "CapMinor")}) / sum(${GRANTS}, 'CapMinor')), ' of the aggregate ceiling.')`,
        ),
        hidden: WRIT_CONDITIONS.grantUncapped,
      }),
    },
    {
      style: "tag",
      text: mdocText({
        name: "grantFrequency",
        value: expr(
          `concat('Frequency: at most ', ${loopRef(GRANT_VAR, "CountMax")}, ' times ', ${loopRef(GRANT_VAR, "CountWindow")}, '.')`,
        ),
        hidden: WRIT_CONDITIONS.grantNoCount,
      }),
    },
    {
      style: "tag",
      text: mdocText({
        name: "grantAllowlist",
        value: expr(
          `concat('Permitted values of ', ${loopRef(GRANT_VAR, "AllowlistField")}, ': ', ${loopRef(GRANT_VAR, "AllowlistValues")}, '. Any other value is outside this writ.')`,
        ),
        hidden: WRIT_CONDITIONS.grantNoAllowlist,
      }),
    },
    {
      style: "tag",
      text: mdocText({
        name: "grantPattern",
        value: expr(
          `concat('The value of ', ${loopRef(GRANT_VAR, "PatternField")}, ' must match ', ${loopRef(GRANT_VAR, "Pattern")}, '.')`,
        ),
        hidden: WRIT_CONDITIONS.grantNoPattern,
      }),
    },
    {
      style: "tag",
      text: mdocText({
        name: "grantDiligence",
        value: expr(
          `concat('Before committing this act the Agent must obtain a clear result for: ', ${loopRef(GRANT_VAR, "DiligenceChecks")}, '. An inconclusive result is treated as a failure.')`,
        ),
        hidden: WRIT_CONDITIONS.grantNoDiligence,
      }),
    },
    {
      style: "tag",
      text: mdocText({
        name: "grantEscalation",
        value: expr(
          `concat('Acts of this class above ', ${SYMBOL}, setScale(toDecimal(${loopRef(GRANT_VAR, "EscalationMinor")}) / 100, 2), ' require a fresh human decision.')`,
        ),
        hidden: WRIT_CONDITIONS.grantNoEscalation,
      }),
    },
    {
      style: "tag",
      text: mdocRepeaterOpen({
        name: REPEATER_LIMITS,
        value: field(loopRef(GRANT_VAR, "Limits")),
        variable: LIMIT_VAR,
      }),
    },
    {
      style: "sub",
      text: `${loopField(LIMIT_VAR, "SubRef")}  ${loopField(LIMIT_VAR, "Text")}`,
    },
    { style: "tag", text: mdocRepeaterClose(REPEATER_LIMITS) },
    { style: "tag", text: mdocRepeaterClose(REPEATER_GRANTS) },

    { style: "heading", text: "4. Governing law and form of signature" },
    {
      style: "clause",
      text: `4.1 This writ is governed by the law of ${field("Writ[0].JurisdictionName")}.`,
    },
    {
      style: "tag",
      text: mdocText({
        name: "eidasClause",
        value: expr(
          "concat('4.2 The Principal\\'s signature is an advanced electronic signature within the meaning of Regulation (EU) No 910/2014 (eIDAS), applied in PAdES form, and may not be denied legal effect on the sole ground that it is in electronic form.')",
        ),
        hidden: WRIT_CONDITIONS.notEea,
      }),
    },
    {
      style: "tag",
      text: mdocText({
        name: "nonEeaClause",
        value: expr(
          "concat('4.2 The Principal\\'s signature is an electronic signature under the law of ', Writ[0].JurisdictionName, ', and the parties agree that it satisfies any requirement of writing or signature under that law.')",
        ),
        hidden: WRIT_CONDITIONS.isEea,
      }),
    },
    {
      style: "tag",
      text: mdocText({
        name: "ukClause",
        value: expr(
          "concat('4.3 Nothing in this writ displaces section 7 of the Electronic Communications Act 2000 as to the admissibility of the Principal\\'s signature.')",
        ),
        hidden: WRIT_CONDITIONS.notUk,
      }),
    },

    { style: "heading", text: "5. Revocation" },
    {
      style: "clause",
      text: `5.1 This writ is revoked the moment a record of the form "v=WRIT1; st=revoked" is published at _writ.${field("Writ[0].AgentDomain")}, whatever the expiry in clause 2.1. Revocation is published rather than deleted, so that a cached record cannot silently restore authority.`,
    },
    {
      style: "clause",
      text: "5.2 A verifier that cannot confirm the zone is DNSSEC-signed must treat this writ as unverified and refuse the act.",
    },

    { style: "heading", text: "6. Execution" },
    {
      style: "clause",
      text: `Signed by ${field("Writ[0].PrincipalName")} as Principal, granting the authority described above to ${field("Writ[0].AgentLabel")}.`,
    },
    { style: "signature", text: "Signature: ______________________________" },
    { style: "signature", text: `Date: ${field("Writ[0].EffectiveFrom")}` },
    {
      style: "note",
      text: `Aggregate ceiling ${expr(WRIT_EXPRESSIONS.totalCapFormatted)} · escalation at ${expr(WRIT_EXPRESSIONS.escalationPercentLabel)} of ceiling · ${expr(WRIT_EXPRESSIONS.grantCount)} classes granted · expires ${expr(WRIT_EXPRESSIONS.expiresAt)}`,
    },
  ];
}

/** The computed summary table, printed above the signature block. */
export function writTemplateSummaryRows(): [string, string][] {
  return [
    ["Aggregate ceiling", expr(WRIT_EXPRESSIONS.totalCapFormatted)],
    ["Classes granted", expr(WRIT_EXPRESSIONS.grantCount)],
    ["Largest single ceiling", expr(WRIT_EXPRESSIONS.largestCapFormatted)],
    ["Escalation threshold", expr(WRIT_EXPRESSIONS.escalationThresholdFormatted)],
    ["Expires", expr(WRIT_EXPRESSIONS.expiresAt)],
  ];
}

/** Every tag in the template, flattened — the surface a live render exercises. */
export function writTemplateText(): string {
  return [
    ...writTemplateBlocks().map((block) => block.text),
    ...writTemplateSummaryRows().flat(),
  ].join("\n");
}

export function buildWritTemplateDocument(): Document {
  return new Document({
    creator: "Chancery",
    title: "Writ of delegated authority",
    description:
      "Doctavian template: branches on jurisdiction and unset limits, loops over granted act classes, computes the aggregate ceiling and expiry.",
    styles: { default: { document: { run: { font: "Calibri", size: 21 } } } },
    sections: [
      {
        properties: {},
        children: [
          ...writTemplateBlocks().map(renderBlock),
          summaryTable(),
        ],
      },
    ],
  });
}

export async function buildWritTemplateDocx(): Promise<Uint8Array> {
  const buffer = await Packer.toBuffer(buildWritTemplateDocument());
  return new Uint8Array(buffer);
}

function renderBlock(block: TemplateBlock): Paragraph {
  switch (block.style) {
    case "title":
      return new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: block.text, bold: true, size: 32 })],
      });
    case "subtitle":
      return new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 320 },
        children: [new TextRun({ text: block.text, color: "555555" })],
      });
    case "heading":
      return new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 320, after: 120 },
        children: [new TextRun({ text: block.text, bold: true, size: 24 })],
      });
    case "clause":
      return new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun(block.text)],
      });
    case "sub":
      return new Paragraph({
        spacing: { before: 160, after: 80 },
        indent: { left: 360 },
        children: [new TextRun({ text: block.text, bold: true })],
      });
    case "tag":
      // Monospaced and indented so a human editing the .docx can see at a glance
      // which paragraphs are machinery. One run, always — a tag split across
      // runs is no longer a tag.
      return new Paragraph({
        spacing: { after: 80 },
        indent: { left: 360 },
        children: [
          new TextRun({ text: block.text, font: "Consolas", size: 18, color: "1F4E79" }),
        ],
      });
    case "note":
      return new Paragraph({
        spacing: { before: 320 },
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" } },
        children: [new TextRun({ text: block.text, italics: true, size: 18 })],
      });
    case "signature":
      return new Paragraph({
        spacing: { before: 240 },
        children: [new TextRun(block.text)],
      });
  }
}

function summaryTable(): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: writTemplateSummaryRows().map(
      ([label, value]) =>
        new TableRow({
          children: [
            new TableCell({
              children: [
                new Paragraph({ children: [new TextRun({ text: label, bold: true })] }),
              ],
            }),
            new TableCell({
              children: [
                new Paragraph({
                  children: [new TextRun({ text: value, font: "Consolas", size: 18 })],
                }),
              ],
            }),
          ],
        }),
    ),
  });
}

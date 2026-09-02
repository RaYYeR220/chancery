/**
 * The Chancery MCP server.
 *
 * Foxit's challenge left signing out of their MCP catalogue on purpose and
 * invited people to argue about where the boundary really sits. This server is
 * the argument.
 *
 * Their line is drawn by tool CATEGORY — signing is not in the catalogue, so an
 * agent that wants to sign has to leave MCP and call the eSign API directly with
 * its own credentials. That works, but it does not generalise: the moment an
 * agent can also spend money, delete a record or publish something, each one
 * needs its own bespoke exclusion, and none of them says what the human
 * actually authorised. Worse, pushing the agent outside the protocol is pushing
 * it outside the place where the decision could have been recorded.
 *
 * Our line is drawn at IRREVERSIBILITY, and it is drawn once. Every reversible
 * thing is a tool. Every irreversible thing goes through a single tool,
 * `act.request`, which cannot do anything the human's signed writ does not
 * permit — so an agent may ask for anything, and the answer is a verdict citing
 * a clause rather than a missing tool.
 *
 * What is absent here, and why:
 *
 *   writ.sign     A signature is the human's act. The credential that could
 *                 produce one is not reachable from this process at all, so an
 *                 agent attempting it gets a 401 from the signing service
 *                 rather than a polite refusal from a prompt.
 *   writ.anchor   Publishing authority is the principal granting it.
 *   writ.revoke   Withdrawing authority is the principal withdrawing it. An
 *                 agent that could revoke could also revoke the constraint it
 *                 dislikes and re-issue a wider one.
 *   domain.register (directly)
 *                 Irreversible and priced. Reachable only through act.request,
 *                 where it is checked against the writ first.
 *
 * The absences are advertised in the server instructions rather than hidden,
 * because an agent that knows why a capability is missing stops looking for a
 * way around it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Chancery } from "../service/chancery";
import { ACT_KINDS, type ActKind, type DiligenceCheck } from "../core/types";

export const SERVER_INSTRUCTIONS = `Chancery issues and enforces writs: human-signed instruments \
stating exactly which irreversible acts an agent may commit to on a principal's behalf.

Reversible work — drafting, searching, running diligence, simulating a verdict — is yours to do \
freely. Irreversible work goes through act.request, which decides against the signed writ before \
anything happens, and answers with a verdict citing the clause it relied on.

There is deliberately no tool here that signs a writ, anchors one, revokes one, or registers a \
domain directly. Those are the principal's acts, not yours, and the credentials for them are not \
held by this process. If you need one of them, say so and a human will act; do not look for \
another route to it.

If act.request denies, the denial names the clause and the page of the signed document it came \
from. That is the answer, not an obstacle: report it rather than retrying with different \
arguments.`;

const actKind = z.enum(ACT_KINDS as unknown as [ActKind, ...ActKind[]]);

const diligenceCheck = z.enum([
  "trademark_clear",
  "no_brand_collision",
  "counterparty_exists",
  "no_adverse_media",
  "no_patent_litigation",
]) satisfies z.ZodType<DiligenceCheck>;

const actFields = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

export interface ChanceryServerOptions {
  chancery: Chancery;
  /** Clock, injected so a transcript of a session is reproducible. */
  now: () => string;
}

export function createChanceryServer({ chancery, now }: ChanceryServerOptions): McpServer {
  const server = new McpServer(
    { name: "chancery", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "writ.explain",
    {
      title: "Explain this agent's authority",
      description:
        "Read back, in plain terms, what the signed writ published for an agent domain permits: " +
        "which acts, under which caps and conditions, until when.",
      inputSchema: { agentDomain: z.string().describe("e.g. ops.example.com") },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ agentDomain }) => {
      const status = await chancery.verify(agentDomain);
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    },
  );

  server.registerTool(
    "verify",
    {
      title: "Verify an agent's writ from public DNS",
      description:
        "Resolve the WRIT1 record for an agent domain and report what public DNS says about its " +
        "authority, including whether the answer was DNSSEC-validated. Uses no Chancery-held state.",
      inputSchema: { agentDomain: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ agentDomain }) => {
      const status = await chancery.verify(agentDomain);
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    },
  );

  server.registerTool(
    "domain.search",
    {
      title: "Search for available domains",
      description:
        "Look up candidate domain names and their prices. Searching buys nothing and commits to " +
        "nothing; registering is an irreversible act and goes through act.request.",
      inputSchema: {
        keyword: z.string(),
        tlds: z.array(z.string()).max(50).default(["com", "net", "org"]),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ keyword, tlds }) => {
      const candidates = await chancery.searchDomains(keyword, tlds);
      return { content: [{ type: "text", text: JSON.stringify(candidates, null, 2) }] };
    },
  );

  server.registerTool(
    "diligence.run",
    {
      title: "Check a proposed act against the live world",
      description:
        "Run due-diligence checks against live web data: trademark conflicts, brand collisions, " +
        "counterparty existence, adverse media, patent litigation. A check that cannot be " +
        "completed returns `unknown`, which is treated as a failure, never as a pass.",
      inputSchema: {
        kind: actKind,
        fields: actFields,
        principalLegalName: z.string(),
        checks: z.array(diligenceCheck).min(1),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ kind, fields, principalLegalName, checks }) => {
      const findings = await chancery.runDiligence(
        { kind, fields, requestedAt: now() },
        principalLegalName,
        checks,
      );
      return { content: [{ type: "text", text: JSON.stringify(findings, null, 2) }] };
    },
  );

  server.registerTool(
    "act.simulate",
    {
      title: "Ask what the answer would be",
      description:
        "Run the full decision — resolve DNS, re-check the document hash, evaluate the signed " +
        "terms, run diligence — and return the verdict WITHOUT carrying anything out. Use this " +
        "before act.request so a refusal costs nothing.",
      inputSchema: {
        agentDomain: z.string(),
        kind: actKind,
        fields: actFields,
        amountMinorUnits: z.number().int().nonnegative().optional(),
        currency: z.string().length(3).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ agentDomain, kind, fields, amountMinorUnits, currency }) => {
      const bundle = await chancery.evaluate(agentDomain, {
        kind,
        fields,
        amountMinorUnits,
        currency,
        requestedAt: now(),
      });
      return { content: [{ type: "text", text: JSON.stringify(bundle.decision, null, 2) }] };
    },
  );

  server.registerTool(
    "act.request",
    {
      title: "Request an irreversible act",
      description:
        "The only way to reach anything irreversible. Decides against the human-signed writ first " +
        "and carries the act out only if it is permitted. A denial names the clause and the page " +
        "of the signed document it came from — treat that as the answer and report it, rather " +
        "than retrying with different arguments.",
      inputSchema: {
        agentDomain: z.string(),
        kind: actKind,
        fields: actFields,
        amountMinorUnits: z.number().int().nonnegative().optional(),
        currency: z.string().length(3).optional(),
      },
      // Truthfully destructive: when this allows, something real and
      // unrepeatable happens. The hint defaults to true anyway; it is set
      // explicitly so nobody later mistakes the default for a decision.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ agentDomain, kind, fields, amountMinorUnits, currency }) => {
      const outcome = await chancery.requestAct(agentDomain, {
        kind,
        fields,
        amountMinorUnits,
        currency,
        requestedAt: now(),
      });
      return {
        // A denial is a normal result, not a protocol error. Marking it as an
        // error would invite the client to retry it.
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { decision: outcome.bundle.decision, executed: outcome.executed },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}

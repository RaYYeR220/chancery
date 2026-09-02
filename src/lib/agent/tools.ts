/**
 * The tool set, as the agent sees it.
 *
 * This is the same surface the MCP server publishes, presented to a model that
 * is not speaking MCP. Keeping the two in step matters more than sharing code
 * between them: the argument the server makes — reversible work is a tool,
 * irreversible work is one gated request — is only true of the agent if the
 * agent's inventory has the same shape. A tool added here that reaches
 * something irreversible without `act.request` would defeat the whole design,
 * which is why `domain.register` appears nowhere as a name.
 *
 * `act.simulate` is deliberately reversible and deliberately present. An agent
 * that can find out it will be refused, for free, has no reason to discover it
 * by attempting the act — and a simulated denial is recorded by the runtime
 * exactly like a real one, so asking twice is not a way to get a second answer.
 */

import type { Chancery } from "../service/chancery";
import type { ActKind, ActRequest, DiligenceCheck } from "../core/types";
import { ACT_KINDS } from "../core/types";
import type { JsonObject, JsonValue } from "./trace";
import type { AgentTool, GatedTool, ReversibleTool } from "./runtime";

export interface ChanceryToolOptions {
  chancery: Chancery;
  /** The domain the writ is anchored under; the agent does not get to choose it. */
  agentDomain: string;
  principalLegalName: string;
  now: () => string;
}

export function chanceryTools(options: ChanceryToolOptions): AgentTool[] {
  return [
    verifyTool(options),
    domainSearchTool(options),
    diligenceTool(options),
    simulateTool(options),
    actRequestTool(options),
  ];
}

const ACT_FIELDS_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: { type: ["string", "number", "boolean"] },
  description: "Flat field bag the writ's limits address, e.g. { tld, domainName }.",
};

function verifyTool({ chancery, agentDomain }: ChanceryToolOptions): ReversibleTool {
  return {
    name: "writ.explain",
    description:
      "Read back what the signed writ published for this agent permits: which acts, under which " +
      "caps and conditions, until when. Reads public DNS; commits to nothing.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      return (await chancery.verify(agentDomain)) as unknown as JsonValue;
    },
  };
}

function domainSearchTool({ chancery }: ChanceryToolOptions): ReversibleTool {
  return {
    name: "domain.search",
    description:
      "Look up candidate domain names and their prices. Searching buys nothing; registering is " +
      "irreversible and goes through act.request.",
    parameters: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        tlds: { type: "array", items: { type: "string" }, maxItems: 50 },
      },
      required: ["keyword"],
      additionalProperties: false,
    },
    async run(args) {
      const tlds = Array.isArray(args.tlds) ? args.tlds.map(String) : ["com", "net", "org"];
      const found = await chancery.searchDomains(String(args.keyword ?? ""), tlds);
      return found as unknown as JsonValue;
    },
  };
}

function diligenceTool({ chancery, principalLegalName, now }: ChanceryToolOptions): ReversibleTool {
  return {
    name: "diligence.run",
    description:
      "Check a proposed act against live web data: trademark conflicts, brand collisions, " +
      "counterparty existence, adverse media, patent litigation. A check that cannot complete " +
      "returns `unknown`, which is a failure, never a pass.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...ACT_KINDS] },
        fields: ACT_FIELDS_SCHEMA,
        checks: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["kind", "fields", "checks"],
      additionalProperties: false,
    },
    async run(args) {
      const request = readActRequest(args, now());
      const checks = Array.isArray(args.checks)
        ? (args.checks.map(String) as DiligenceCheck[])
        : [];
      const findings = await chancery.runDiligence(request, principalLegalName, checks);
      return findings as unknown as JsonValue;
    },
  };
}

function simulateTool({ chancery, agentDomain, now }: ChanceryToolOptions): ReversibleTool {
  return {
    name: "act.simulate",
    description:
      "Ask what the verdict WOULD be, running the full decision without carrying anything out. " +
      "Use this before act.request so a refusal costs nothing.",
    parameters: actParametersSchema(),
    async run(args) {
      const bundle = await chancery.evaluate(agentDomain, readActRequest(args, now()));
      return bundle.decision as unknown as JsonValue;
    },
  };
}

function actRequestTool({ chancery, agentDomain, now }: ChanceryToolOptions): GatedTool {
  return {
    name: "act.request",
    description:
      "The only way to reach anything irreversible. Decides against the human-signed writ first " +
      "and carries the act out only if it is permitted. A denial names the clause it came from; " +
      "that is the answer — report it rather than retrying with different arguments.",
    parameters: actParametersSchema(),
    gated: true,
    toActRequest(args) {
      return readActRequest(args, now());
    },
    async request(act) {
      const outcome = await chancery.requestAct(agentDomain, act);
      return {
        decision: outcome.bundle.decision,
        executed: (outcome.executed ?? null) as unknown as JsonValue,
      };
    },
  };
}

function actParametersSchema(): JsonObject {
  return {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...ACT_KINDS] },
      fields: ACT_FIELDS_SCHEMA,
      amountMinorUnits: { type: "integer", minimum: 0 },
      currency: { type: "string", minLength: 3, maxLength: 3 },
    },
    required: ["kind", "fields"],
    additionalProperties: false,
  };
}

/**
 * Throws rather than coercing.
 *
 * A model that emits `{ kind: "domain.regsiter" }` must produce a visible
 * malformed-arguments block, not a silently repaired act: the whole system is
 * an argument that what gets carried out is exactly what was asked for and
 * exactly what was permitted, and a helpful coercion here breaks the first half.
 */
export function readActRequest(args: JsonObject, requestedAt: string): ActRequest {
  const kind = args.kind;
  if (typeof kind !== "string" || !(ACT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`kind must be one of ${ACT_KINDS.join(", ")}`);
  }
  const rawFields = args.fields;
  if (typeof rawFields !== "object" || rawFields === null || Array.isArray(rawFields)) {
    throw new Error("fields must be an object");
  }
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(rawFields)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`field ${key} must be a string, number or boolean`);
    }
    fields[key] = value;
  }
  const request: ActRequest = { kind: kind as ActKind, fields, requestedAt };
  if (typeof args.amountMinorUnits === "number") request.amountMinorUnits = args.amountMinorUnits;
  if (typeof args.currency === "string") request.currency = args.currency;
  return request;
}

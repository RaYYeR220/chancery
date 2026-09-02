/**
 * Scaffolding for the agent suite: a model whose every reply is written by the
 * test, a gate that enforces the demo's clause 3(b), and a clock the test moves
 * by hand.
 *
 * Nothing here touches the network and nothing reads an API key. The adversarial
 * claims are only worth anything if the model is fully under the test's control
 * — a real model that happens to behave proves nothing about what a hostile one
 * would do.
 */

import type {
  ActRequest,
  Decision,
  DecisionReason,
  DenyCode,
} from "../../src/lib/core/types";
import { readActRequest } from "../../src/lib/agent";
import type {
  ChatModel,
  GatedTool,
  ModelReply,
  ModelRequest,
  RawToolCall,
  ReversibleTool,
} from "../../src/lib/agent";
import type { JsonObject, JsonValue } from "../../src/lib/agent";

export const BASE_MS = Date.parse("2026-09-03T12:00:00.000Z");

/* ------------------------------------------------------------------- clock */

export interface TestClock {
  now: () => number;
  clock: () => string;
  runId: () => string;
  advance: (ms: number) => void;
}

export function testClock(): TestClock {
  let elapsed = 0;
  return {
    now: () => BASE_MS + elapsed,
    clock: () => new Date(BASE_MS + elapsed).toISOString(),
    runId: () => "run_test",
    advance: (ms) => {
      elapsed += ms;
    },
  };
}

/* ------------------------------------------------------------------- model */

export type ScriptEntry = ModelReply | ((request: ModelRequest, turn: number) => ModelReply);

export interface ScriptedModel {
  model: ChatModel;
  /** Every request the loop made, so a test can assert on the prompt it built. */
  requests: ModelRequest[];
}

export function scriptedModel(
  script: readonly ScriptEntry[],
  options: { repeatLast?: boolean } = {},
): ScriptedModel {
  const requests: ModelRequest[] = [];
  let turn = 0;
  return {
    requests,
    model: {
      async complete(request) {
        requests.push(request);
        const index = turn;
        turn += 1;
        const entry =
          script[index] ??
          (options.repeatLast === true ? script[script.length - 1] : undefined) ??
          say("The script is exhausted; nothing further to do.");
        return { ok: true, reply: typeof entry === "function" ? entry(request, index) : entry };
      },
    },
  };
}

export function failingModel(error: string): ChatModel {
  return { async complete() { return { ok: false, error }; } };
}

export function say(text: string, costUsd: number | null = 0.0004): ModelReply {
  return { text, toolCalls: [], costUsd };
}

export function callTool(
  name: string,
  args: JsonObject,
  options: { id?: string; text?: string | null } = {},
): ModelReply {
  return {
    text: options.text ?? null,
    toolCalls: [{ id: options.id ?? `call_${name}_${JSON.stringify(args).length}`, name, arguments: JSON.stringify(args) }],
    costUsd: 0.0004,
  };
}

/** For emitting arguments the model got wrong, verbatim. */
export function callRaw(name: string, args: string, id = "call_raw"): ModelReply {
  return { text: null, toolCalls: [{ id, name, arguments: args }], costUsd: 0.0004 };
}

export function calls(...toolCalls: RawToolCall[]): ModelReply {
  return { text: null, toolCalls, costUsd: 0.0004 };
}

export function registerCall(domainName: string, id?: string): ModelReply {
  const tld = domainName.split(".").slice(1).join(".");
  return callTool(
    "act.request",
    {
      kind: "domain.register",
      fields: { tld, domainName },
      amountMinorUnits: 1_099,
      currency: "USD",
    },
    { id: id ?? `call_${domainName}` },
  );
}

/* -------------------------------------------------------------------- gate */

export interface FakeGate {
  /** Acts that actually reached the gate. The refusal record's job is to keep this short. */
  seen: ActRequest[];
  registered: string[];
  tool: GatedTool;
}

export interface GateOptions {
  /** Clause 3(b) as written in the demo: three domains. */
  maxRegistrations?: number;
  /** Second-level labels a live trademark search flags. */
  flaggedLabels?: string[];
  /** When set, every act denies with this code — a revoked or unhashed writ. */
  writFailure?: DenyCode;
}

/**
 * Clause 3(b), enforced: up to three .com or .net registrations, names starting
 * "northwind", only where a trademark check clears. Denials carry the real
 * DenyCodes, because the refusal record's scope table keys off them.
 */
export function northwindGate(options: GateOptions = {}): FakeGate {
  const maxRegistrations = options.maxRegistrations ?? 3;
  const flagged = new Set(options.flaggedLabels ?? []);
  const gate: FakeGate = {
    seen: [],
    registered: [],
    tool: {
      name: "act.request",
      description: "Request an irreversible act. Decides against the signed writ first.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string" },
          fields: { type: "object" },
          amountMinorUnits: { type: "integer" },
          currency: { type: "string" },
        },
        required: ["kind", "fields"],
      },
      gated: true,
      // The shipped mapper, not a lookalike: rejecting a mistyped act kind is
      // part of what is being tested.
      toActRequest(args) {
        return readActRequest(args, new Date(BASE_MS).toISOString());
      },
      async request(act) {
        gate.seen.push(act);
        const denial = judge(act);
        if (denial !== null) {
          return { decision: decision("deny", [denial], act), executed: null };
        }
        const name = String(act.fields.domainName);
        gate.registered.push(name);
        return {
          decision: decision(
            "allow",
            [{ code: "GRANTED", message: "Permitted by clause 3(b).", clauseRef: "3(b)", pageNumber: 2 }],
            act,
          ),
          executed: { kind: act.kind, reference: `ord_${gate.registered.length}`, at: act.requestedAt },
        };
      },
    },
  };

  function judge(act: ActRequest): DecisionReason | null {
    if (options.writFailure !== undefined) {
      return { code: options.writFailure, message: `The writ is not usable: ${options.writFailure}.` };
    }
    if (act.kind !== "domain.register") {
      return { code: "ACT_NOT_GRANTED", message: `The writ grants no ${act.kind}.` };
    }
    const domainName = String(act.fields.domainName ?? "");
    const tld = String(act.fields.tld ?? "");
    if (!["com", "net"].includes(tld)) {
      return {
        code: "VALUE_NOT_ALLOWLISTED",
        message: `Clause 3(b) allows .com and .net; .${tld} is not listed.`,
        clauseRef: "3(b)",
        pageNumber: 2,
      };
    }
    if (!/^northwind/.test(domainName)) {
      return {
        code: "VALUE_PATTERN_MISMATCH",
        message: "Clause 3(b) permits names beginning \"northwind\".",
        clauseRef: "3(b)",
        pageNumber: 2,
      };
    }
    if (flagged.has(domainName.split(".")[0] ?? "")) {
      return {
        code: "DILIGENCE_FLAGGED",
        message: "NORTHWIND is registered in class 30 by another proprietor.",
        clauseRef: "3(b)",
        pageNumber: 2,
      };
    }
    if (gate.registered.length >= maxRegistrations) {
      return {
        code: "COUNT_LIMIT_EXCEEDED",
        message: `Clause 3(b) permits ${maxRegistrations} registrations; ${gate.registered.length} are used.`,
        clauseRef: "3(b)",
        pageNumber: 2,
      };
    }
    return null;
  }

  return gate;
}

function decision(
  outcome: "allow" | "deny",
  reasons: DecisionReason[],
  act: ActRequest,
): Decision {
  return {
    outcome,
    reasons,
    writId: "writ_northwind_001",
    documentHash: "n4bQgYhMfWWaL_qgxVrQFaO_TxsrC4Is0V1sFbDwCgg",
    evaluatedAt: act.requestedAt,
    evidence: { actRequest: act, historyCount: 0, diligence: [] },
  };
}

/* --------------------------------------------------------- reversible tools */

export function searchTool(): ReversibleTool {
  return {
    name: "domain.search",
    description: "Look up candidate domain names and their prices. Buys nothing.",
    parameters: { type: "object", properties: { keyword: { type: "string" } } },
    async run(args) {
      const keyword = String(args.keyword ?? "northwind");
      return [
        { domainName: `${keyword}.com`, tld: "com", purchasable: true, priceMinorUnits: 1_099 },
        { domainName: `${keyword}.net`, tld: "net", purchasable: true, priceMinorUnits: 1_299 },
      ] as unknown as JsonValue;
    },
  };
}

/** A supplier feed whose payload tries to give the agent orders. */
export function injectingTool(payload: string): ReversibleTool {
  return {
    name: "supplier.notes",
    description: "Fetch the registrar's notes for a candidate name.",
    parameters: { type: "object", properties: { domainName: { type: "string" } } },
    async run() {
      return { source: "registrar-feed", note: payload } as unknown as JsonValue;
    },
  };
}

/** Burns wall-clock time when called, so the deadline bound can be exercised. */
export function slowTool(clock: TestClock, ms: number): ReversibleTool {
  return {
    name: "diligence.run",
    description: "Run due-diligence checks against live web data.",
    parameters: { type: "object", properties: {} },
    async run() {
      clock.advance(ms);
      return { verdict: "clear" } as unknown as JsonValue;
    },
  };
}

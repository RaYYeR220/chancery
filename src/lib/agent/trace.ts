/**
 * The run trace.
 *
 * A trace is the only account of what the agent did, so it is designed as
 * evidence rather than as logging. Three properties follow from that.
 *
 * Every event is plain JSON. No Error objects, no class instances, no Dates —
 * a trace has to survive being written to Xano between turns and read back by
 * a different process, and anything that needs a constructor to rehydrate is a
 * thing that will one day be dropped silently.
 *
 * `blocked` is a separate event from `verdict` on purpose. A `verdict` is the
 * gate answering; a `blocked` is this runtime declining to ask, because the
 * question has already been answered. Collapsing them would hide the single
 * most interesting thing in the trace — the moment the agent tried to work
 * around a refusal and the code, not the model, stopped it.
 *
 * `tool_result` carries `injectionSignals` for the reader's benefit only.
 * Nothing in the runtime branches on it; see the note in refusal.ts.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Why a run ended. Every terminal path sets exactly one of these. */
export type StopReason =
  | "answered"
  | "max_steps"
  | "max_tool_calls"
  | "deadline"
  | "model_error";

/** Why the runtime refused to dispatch a tool call the model asked for. */
export type BlockReason =
  | "refused_equivalent_act"
  | "unknown_tool"
  | "malformed_arguments"
  | "tool_call_budget";

export interface RunStartedEvent {
  type: "run_started";
  at: string;
  runId: string;
  goal: string;
  model: string;
  bounds: { maxSteps: number; maxToolCalls: number; maxWallClockMs: number };
}

export interface ThoughtEvent {
  type: "thought";
  at: string;
  step: number;
  text: string;
  /** Venice quotes a price per completion; the audit trail quotes it back. */
  costUsd: number | null;
}

export interface ToolCallEvent {
  type: "tool_call";
  at: string;
  step: number;
  callId: string;
  tool: string;
  gated: boolean;
  arguments: JsonValue;
}

export interface ToolResultEvent {
  type: "tool_result";
  at: string;
  step: number;
  callId: string;
  tool: string;
  ok: boolean;
  result: JsonValue;
  /** Imperative-looking phrases spotted in the payload. Annotation, not defence. */
  injectionSignals: string[];
}

export interface VerdictEvent {
  type: "verdict";
  at: string;
  step: number;
  callId: string;
  tool: string;
  kind: string;
  outcome: "allow" | "deny";
  code: string;
  clauseRef: string | null;
  message: string;
  executed: JsonValue;
}

export interface BlockedEvent {
  type: "blocked";
  at: string;
  step: number;
  tool: string;
  reason: BlockReason;
  detail: string;
  /** Set when the block came from the refusal record rather than from a bound. */
  priorCode: string | null;
  priorClauseRef: string | null;
}

export interface FinishedEvent {
  type: "finished";
  at: string;
  step: number;
  stopReason: StopReason;
  answer: string | null;
  /** Denials stay in the summary so a run cannot end quietly having been refused. */
  refusals: { kind: string; code: string; clauseRef: string | null; message: string }[];
  toolCalls: number;
  costUsd: number;
}

export type TraceEvent =
  | RunStartedEvent
  | ThoughtEvent
  | ToolCallEvent
  | ToolResultEvent
  | VerdictEvent
  | BlockedEvent
  | FinishedEvent;

/** Events of one type, narrowed. Tests read a trace far more often than a human does. */
export function eventsOfType<T extends TraceEvent["type"]>(
  trace: readonly TraceEvent[],
  type: T,
): Extract<TraceEvent, { type: T }>[] {
  return trace.filter((event): event is Extract<TraceEvent, { type: T }> => event.type === type);
}

/** One line per event, for a console walkthrough and for failure output in tests. */
export function formatTrace(trace: readonly TraceEvent[]): string {
  return trace.map(formatEvent).join("\n");
}

function formatEvent(event: TraceEvent): string {
  switch (event.type) {
    case "run_started":
      return `run_started  ${event.runId} model=${event.model} goal=${event.goal}`;
    case "thought":
      return `thought      [${event.step}] ${event.text}`;
    case "tool_call":
      return `tool_call    [${event.step}] ${event.tool}${event.gated ? " (gated)" : ""} ${JSON.stringify(event.arguments)}`;
    case "tool_result":
      return `tool_result  [${event.step}] ${event.tool} ok=${event.ok}${
        event.injectionSignals.length > 0 ? ` injection=${event.injectionSignals.join(",")}` : ""
      }`;
    case "verdict":
      return `verdict      [${event.step}] ${event.kind} ${event.outcome.toUpperCase()} ${event.code}${
        event.clauseRef === null ? "" : ` clause ${event.clauseRef}`
      }`;
    case "blocked":
      return `blocked      [${event.step}] ${event.tool} ${event.reason}: ${event.detail}`;
    case "finished":
      return `finished     [${event.step}] ${event.stopReason} refusals=${event.refusals.length} toolCalls=${event.toolCalls}`;
  }
}

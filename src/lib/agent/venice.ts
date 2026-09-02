/**
 * The Venice inference client.
 *
 * Venice speaks the OpenAI chat-completions dialect, so the wire types here are
 * deliberately theirs rather than ours: a request built for this client can be
 * pointed at any compatible endpoint by changing `baseUrl`, which is what makes
 * the runtime above it testable without a key and portable if the vendor
 * changes.
 *
 * Three things are worth stating outright.
 *
 * `GET /models` is a public endpoint. A garbage key gets 200 and a full model
 * list, so a smoke test written against it reports "credentials fine" for a
 * process that has none. That is worse than having no smoke test, because it
 * converts an unauthenticated deployment into a confident one. `verifyKey`
 * therefore issues the smallest possible POST /chat/completions and reads the
 * status, which is the only call that actually presents the credential.
 *
 * The cost block is surfaced, not swallowed. Every verdict in this system is
 * published with the evidence it came from, and what the deliberation cost is
 * part of that evidence. A price that only ever reaches a log is not auditable.
 * Its exact nesting differs between the streaming and non-streaming shapes, so
 * `readCost` looks in both places and returns null rather than guessing.
 *
 * `fetchImpl` and `baseUrl` are injected and there is no default-on retry, no
 * default temperature override and no silent model substitution. A client that
 * quietly does something other than what it was asked is not one an
 * irreversible-act gate should sit behind.
 */

import type { JsonObject, JsonValue } from "./trace";

export const VENICE_BASE_URL = "https://api.venice.ai/api/v1";

/**
 * Models that support both function calling and reasoning. The list is here so
 * a caller can validate a configured name before a run rather than discovering
 * mid-run that tools are being ignored; `model` itself stays a plain string, so
 * a newly released model needs no code change.
 */
export const VENICE_TOOL_MODELS = [
  "gemini-3-8-flash",
  "z-ai-glm-5-3",
  "qwen-3-8-max",
  "grok-4-6",
  "qwen3-235b-a22b-thinking-2507",
] as const;

export type VeniceToolModel = (typeof VENICE_TOOL_MODELS)[number];

/** 1M context, function calling, and the cheapest of the five to loop on. */
export const DEFAULT_VENICE_MODEL: VeniceToolModel = "gemini-3-8-flash";

/* -------------------------------------------------------------- wire types */

export interface ToolFunctionDefinition {
  name: string;
  description: string;
  /** JSON Schema, passed to the model verbatim. */
  parameters: JsonObject;
}

export interface ToolDefinition {
  type: "function";
  function: ToolFunctionDefinition;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none" | "required";
  temperature?: number;
  max_tokens?: number;
  /** Venice-specific knobs (web search, system-prompt handling) pass through. */
  venice_parameters?: JsonObject;
}

export interface VeniceCost {
  usd: number | null;
  /** The block as received, so the audit trail can quote it exactly. */
  raw: JsonValue;
}

export interface ChatCompletion {
  id: string;
  model: string;
  finishReason: string | null;
  text: string | null;
  toolCalls: ChatToolCall[];
  cost: VeniceCost | null;
  usage: JsonValue;
  raw: JsonObject;
}

export type ChatStreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "completion"; completion: ChatCompletion };

/* ------------------------------------------------------------------ errors */

export type VeniceErrorKind =
  | "usage"
  | "auth"
  | "rate_limit"
  | "http"
  | "api"
  | "malformed"
  | "timeout"
  | "network";

export class VeniceError extends Error {
  constructor(
    message: string,
    readonly kind: VeniceErrorKind,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "VeniceError";
  }
}

/* ------------------------------------------------------------------ fetch */

export interface FetchLikeInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** Structural, so a fake needs no stream implementation it does not use. */
export interface ByteStreamLike {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    releaseLock?(): void;
  };
}

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  body?: ByteStreamLike | null;
}

export type FetchLike = (url: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;

export interface VeniceClientOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  /** Applied per request; a model that hangs is a run that never reports. */
  timeoutMs?: number;
  /** Used only when a request omits `model`. */
  defaultModel?: string;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export type VeniceOutcome =
  | { ok: true; completion: ChatCompletion }
  | { ok: false; kind: VeniceErrorKind; error: string; status?: number };

export class VeniceClient {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  readonly defaultModel: string;

  constructor(options: VeniceClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
      throw new VeniceError("apiKey is required", "usage", VENICE_BASE_URL);
    }
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.baseUrl = (options.baseUrl ?? VENICE_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultModel = options.defaultModel ?? DEFAULT_VENICE_MODEL;
  }

  async chat(
    request: Omit<ChatCompletionRequest, "model"> & { model?: string },
    options?: RequestOptions,
  ): Promise<ChatCompletion> {
    const body = { ...request, model: request.model ?? this.defaultModel, stream: false };
    const { text, url } = await this.post("/chat/completions", body, options);
    return parseCompletion(text, url);
  }

  /**
   * Never throws. The agent loop has to end every run with a stated reason, and
   * a reason it can put in a trace has to be a value; an exception thrown three
   * frames below the reducer is how runs end up "finished" with no explanation.
   */
  async chatSafe(
    request: Omit<ChatCompletionRequest, "model"> & { model?: string },
    options?: RequestOptions,
  ): Promise<VeniceOutcome> {
    try {
      return { ok: true, completion: await this.chat(request, options) };
    } catch (error) {
      const kind: VeniceErrorKind = error instanceof VeniceError ? error.kind : "network";
      const status = error instanceof VeniceError ? error.status : undefined;
      return {
        ok: false,
        kind,
        error: messageOf(error),
        ...(status === undefined ? {} : { status }),
      };
    }
  }

  /**
   * Server-sent deltas, assembled as they arrive.
   *
   * The last event is always a `completion` carrying the same shape `chat`
   * returns, so a caller that streams to a UI and a caller that waits for an
   * answer consume identical objects and no downstream code has to know which
   * transport produced them.
   */
  async *stream(
    request: Omit<ChatCompletionRequest, "model"> & { model?: string },
    options?: RequestOptions,
  ): AsyncGenerator<ChatStreamEvent, void, undefined> {
    const model = request.model ?? this.defaultModel;
    const body = { ...request, model, stream: true, stream_options: { include_usage: true } };
    const { response, url, cleanup } = await this.open("/chat/completions", body, options);

    const assembler = new StreamAssembler(model);
    try {
      for await (const data of readSse(response, url)) {
        if (data === "[DONE]") break;
        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          throw new VeniceError("stream chunk was not JSON", "malformed", url);
        }
        if (!isRecord(chunk)) continue;
        for (const event of assembler.absorb(chunk)) yield event;
      }
    } finally {
      cleanup();
    }
    yield { type: "completion", completion: assembler.finish() };
  }

  /**
   * Prove the key works.
   *
   * Deliberately a chat completion with one token: `GET /models` answers 200
   * for any string at all, so it can only tell you the service is up. A 401 or
   * 403 here is the answer; any other transport failure is reported as such
   * rather than being folded into "bad key", because sending an operator to
   * rotate a working credential is its own kind of outage.
   */
  async verifyKey(options?: RequestOptions): Promise<
    { valid: true; model: string } | { valid: false; kind: VeniceErrorKind; error: string; status?: number }
  > {
    const outcome = await this.chatSafe(
      { messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
      options,
    );
    if (outcome.ok) return { valid: true, model: outcome.completion.model };
    return {
      valid: false,
      kind: outcome.kind,
      error: outcome.error,
      ...(outcome.status === undefined ? {} : { status: outcome.status }),
    };
  }

  /* ---------------------------------------------------------------- innards */

  private async post(
    path: string,
    body: unknown,
    options?: RequestOptions,
  ): Promise<{ text: string; url: string }> {
    const { response, url, cleanup } = await this.open(path, body, options);
    try {
      return { text: await response.text(), url };
    } finally {
      cleanup();
    }
  }

  private async open(
    path: string,
    body: unknown,
    options?: RequestOptions,
  ): Promise<{ response: FetchLikeResponse; url: string; cleanup: () => void }> {
    const url = `${this.baseUrl}${path}`;
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortFromCaller = () => controller.abort();
    options?.signal?.addEventListener("abort", abortFromCaller);
    const cleanup = () => {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", abortFromCaller);
    };

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream, application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await safeText(response);
        cleanup();
        throw new VeniceError(
          `Venice returned HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`,
          statusKind(response.status),
          url,
          response.status,
        );
      }
      return { response, url, cleanup };
    } catch (error) {
      cleanup();
      if (error instanceof VeniceError) throw error;
      if (timedOut) throw new VeniceError(`request exceeded ${timeoutMs}ms`, "timeout", url);
      if (options?.signal?.aborted) {
        throw new VeniceError("request cancelled by caller", "network", url);
      }
      throw new VeniceError(messageOf(error), "network", url);
    }
  }
}

/** Read from the environment; a key never appears in this repository. */
export function veniceApiKeyFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  const key = env.VENICE_API_KEY;
  if (typeof key !== "string" || key.trim() === "") {
    throw new VeniceError("VENICE_API_KEY is not set", "usage", VENICE_BASE_URL);
  }
  return key.trim();
}

/* --------------------------------------------------------------- parsing */

export function parseCompletion(text: string, url: string): ChatCompletion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VeniceError("response body was not JSON", "malformed", url);
  }
  if (!isRecord(parsed)) {
    throw new VeniceError("response body was not a JSON object", "malformed", url);
  }
  const apiError = readApiError(parsed);
  if (apiError !== null) throw new VeniceError(apiError, "api", url);

  const choice = firstChoice(parsed);
  const message = isRecord(choice?.message) ? choice.message : {};
  return {
    id: typeof parsed.id === "string" ? parsed.id : "",
    model: typeof parsed.model === "string" ? parsed.model : "",
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    text: typeof message.content === "string" ? message.content : null,
    toolCalls: readToolCalls(message.tool_calls),
    cost: readCost(parsed),
    usage: (parsed.usage ?? null) as JsonValue,
    raw: parsed as JsonObject,
  };
}

/**
 * Venice quotes price in a `cost` block, but the block hangs off the response
 * root on one shape and off `usage` on another. Both are checked and neither is
 * inferred: an unrecognised shape returns null, so the audit trail says "not
 * reported" instead of "$0.00".
 */
export function readCost(payload: Record<string, unknown>): VeniceCost | null {
  const candidates: unknown[] = [
    payload.cost,
    isRecord(payload.usage) ? payload.usage.cost : undefined,
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const usd = typeof candidate.usd === "number" ? candidate.usd : null;
    return { usd, raw: candidate as JsonValue };
  }
  return null;
}

function readApiError(payload: Record<string, unknown>): string | null {
  if (typeof payload.error === "string") return payload.error;
  if (isRecord(payload.error)) {
    const message = payload.error.message;
    return typeof message === "string" ? message : JSON.stringify(payload.error);
  }
  return null;
}

function firstChoice(payload: Record<string, unknown>): Record<string, unknown> | null {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  return isRecord(first) ? first : null;
}

function readToolCalls(value: unknown): ChatToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ChatToolCall[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const fn = isRecord(entry.function) ? entry.function : null;
    calls.push({
      id: typeof entry.id === "string" ? entry.id : `call_${calls.length}`,
      type: "function",
      function: {
        name: typeof fn?.name === "string" ? fn.name : "",
        // Kept as the raw string the model emitted. Parsing is the runtime's
        // job precisely because it can fail, and a failure has to be visible.
        arguments: typeof fn?.arguments === "string" ? fn.arguments : "",
      },
    });
  }
  return calls;
}

/* --------------------------------------------------------------- streaming */

/** Accumulates deltas into the same object shape a non-streaming call returns. */
class StreamAssembler {
  private id = "";
  private finishReason: string | null = null;
  private text = "";
  private cost: VeniceCost | null = null;
  private usage: JsonValue = null;
  private last: Record<string, unknown> = {};
  private readonly calls = new Map<number, ChatToolCall>();

  constructor(private model: string) {}

  *absorb(chunk: Record<string, unknown>): Generator<ChatStreamEvent> {
    this.last = chunk;
    if (typeof chunk.id === "string") this.id = chunk.id;
    if (typeof chunk.model === "string") this.model = chunk.model;
    const cost = readCost(chunk);
    if (cost !== null) this.cost = cost;
    if (chunk.usage !== undefined) this.usage = chunk.usage as JsonValue;

    const choice = firstChoice(chunk);
    if (choice === null) return;
    if (typeof choice.finish_reason === "string") this.finishReason = choice.finish_reason;

    const delta = isRecord(choice.delta) ? choice.delta : {};
    if (typeof delta.content === "string" && delta.content !== "") {
      this.text += delta.content;
      yield { type: "text", delta: delta.content };
    }
    if (!Array.isArray(delta.tool_calls)) return;

    for (const entry of delta.tool_calls) {
      if (!isRecord(entry)) continue;
      const index = typeof entry.index === "number" ? entry.index : this.calls.size;
      const fn = isRecord(entry.function) ? entry.function : {};
      const existing = this.calls.get(index) ?? {
        id: "",
        type: "function" as const,
        function: { name: "", arguments: "" },
      };
      if (typeof entry.id === "string") existing.id = entry.id;
      if (typeof fn.name === "string") existing.function.name = fn.name;
      if (typeof fn.arguments === "string") existing.function.arguments += fn.arguments;
      this.calls.set(index, existing);
      yield {
        type: "tool_call",
        index,
        ...(typeof entry.id === "string" ? { id: entry.id } : {}),
        ...(typeof fn.name === "string" ? { name: fn.name } : {}),
        ...(typeof fn.arguments === "string" ? { argumentsDelta: fn.arguments } : {}),
      };
    }
  }

  finish(): ChatCompletion {
    const calls = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    return {
      id: this.id,
      model: this.model,
      finishReason: this.finishReason,
      text: this.text === "" ? null : this.text,
      toolCalls: calls.map((call, index) => ({
        ...call,
        id: call.id === "" ? `call_${index}` : call.id,
      })),
      cost: this.cost,
      usage: this.usage,
      raw: this.last as JsonObject,
    };
  }
}

/**
 * SSE framing, done by hand.
 *
 * A chunk boundary lands mid-line often enough that splitting each network read
 * on newlines loses a token every few hundred; the buffer below is the whole
 * reason this is not three lines.
 */
async function* readSse(response: FetchLikeResponse, url: string): AsyncGenerator<string> {
  const body = response.body;
  if (body === undefined || body === null) {
    // Some fakes — and any non-streaming proxy — answer with a whole body.
    for (const line of (await response.text()).split("\n")) {
      const data = sseData(line);
      if (data !== null) yield data;
    }
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      buffer += decoder.decode(value);
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const data = sseData(line);
        if (data !== null) yield data;
        newline = buffer.indexOf("\n");
      }
    }
  } catch (error) {
    throw new VeniceError(messageOf(error), "network", url);
  } finally {
    reader.releaseLock?.();
  }
  const trailing = sseData(buffer);
  if (trailing !== null) yield trailing;
}

function sseData(line: string): string | null {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  return data === "" ? null : data;
}

/* ------------------------------------------------------------------ shared */

function statusKind(status: number): VeniceErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  return "http";
}

async function safeText(response: FetchLikeResponse): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return "";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

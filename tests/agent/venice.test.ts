/**
 * The Venice client, driven entirely by a fake fetch.
 *
 * The claim worth testing hardest is the credential one: `GET /models` answers
 * 200 to anybody, so the suite asserts on the METHOD and PATH `verifyKey`
 * chooses, not merely on its verdict. A future refactor that "simplifies" it
 * onto the public endpoint fails here rather than in production.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_VENICE_MODEL,
  VENICE_BASE_URL,
  VENICE_TOOL_MODELS,
  VeniceClient,
  VeniceError,
  readCost,
  veniceApiKeyFromEnv,
  veniceChatModel,
  type ChatStreamEvent,
  type FetchLike,
  type FetchLikeInit,
} from "../../src/lib/agent";

const KEY = "vn-test-key-0000";
const FIXTURES = new URL("../fixtures/agent/", import.meta.url);

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, FIXTURES)), "utf8");
}

interface Call {
  url: string;
  init: FetchLikeInit | undefined;
}

function fakeFetch(
  respond: (call: Call) => { ok?: boolean; status?: number; body?: string; stream?: string[] },
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const response = respond(call);
    const body = response.body ?? "";
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => body,
      body: response.stream === undefined ? null : chunked(response.stream),
    };
  };
  return { fetchImpl, calls };
}

/** A byte stream that splits where a real one would: mid-line, mid-token. */
function chunked(parts: readonly string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (index >= parts.length) return { done: true };
          const value = encoder.encode(parts[index]);
          index += 1;
          return { done: false, value };
        },
        releaseLock() {},
      };
    },
  };
}

function client(
  respond: (call: Call) => { ok?: boolean; status?: number; body?: string; stream?: string[] },
) {
  const fake = fakeFetch(respond);
  return { client: new VeniceClient({ apiKey: KEY, fetchImpl: fake.fetchImpl }), fake };
}

describe("transport", () => {
  it("posts to the OpenAI-compatible path with a bearer credential", async () => {
    const { client: sut, fake } = client(() => ({ body: fixture("venice-tool-call.json") }));
    await sut.chat({ messages: [{ role: "user", content: "hello" }] });

    expect(fake.calls[0]?.url).toBe(`${VENICE_BASE_URL}/chat/completions`);
    expect(fake.calls[0]?.init?.method).toBe("POST");
    expect(fake.calls[0]?.init?.headers?.authorization).toBe(`Bearer ${KEY}`);
  });

  it("defaults to a function-calling model and lets the caller override it", async () => {
    const { client: sut, fake } = client(() => ({ body: fixture("venice-tool-call.json") }));
    await sut.chat({ messages: [{ role: "user", content: "hi" }] });
    await sut.chat({ model: "grok-4-6", messages: [{ role: "user", content: "hi" }] });

    expect(VENICE_TOOL_MODELS).toContain(DEFAULT_VENICE_MODEL);
    expect(JSON.parse(fake.calls[0]?.init?.body ?? "{}").model).toBe(DEFAULT_VENICE_MODEL);
    expect(JSON.parse(fake.calls[1]?.init?.body ?? "{}").model).toBe("grok-4-6");
  });

  it("honours an injected base URL, so a proxy needs no code change", async () => {
    const fake = fakeFetch(() => ({ body: fixture("venice-tool-call.json") }));
    const sut = new VeniceClient({
      apiKey: KEY,
      fetchImpl: fake.fetchImpl,
      baseUrl: "https://gateway.internal/v1/",
    });
    await sut.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(fake.calls[0]?.url).toBe("https://gateway.internal/v1/chat/completions");
  });

  it("classifies a 401 as auth and a 429 as rate_limit", async () => {
    const unauthorised = client(() => ({ ok: false, status: 401, body: "invalid key" }));
    await expect(unauthorised.client.chat({ messages: [] })).rejects.toMatchObject({
      name: "VeniceError",
      kind: "auth",
      status: 401,
    });

    const throttled = client(() => ({ ok: false, status: 429, body: "slow down" }));
    const outcome = await throttled.client.chatSafe({ messages: [] });
    expect(outcome).toMatchObject({ ok: false, kind: "rate_limit", status: 429 });
  });

  it("reports a body that is not JSON as malformed rather than as an empty answer", async () => {
    const { client: sut } = client(() => ({ body: "<html>gateway</html>" }));
    const outcome = await sut.chatSafe({ messages: [] });
    expect(outcome).toMatchObject({ ok: false, kind: "malformed" });
  });

  it("times out on its own rather than waiting for the model forever", async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const sut = new VeniceClient({ apiKey: KEY, fetchImpl, timeoutMs: 5 });
    const outcome = await sut.chatSafe({ messages: [] });
    expect(outcome).toMatchObject({ ok: false, kind: "timeout" });
  });
});

describe("completions", () => {
  it("surfaces tool calls with the arguments exactly as the model emitted them", async () => {
    const { client: sut } = client(() => ({ body: fixture("venice-tool-call.json") }));
    const completion = await sut.chat({ messages: [] });

    expect(completion.finishReason).toBe("tool_calls");
    expect(completion.text).toBeNull();
    expect(completion.toolCalls).toHaveLength(1);
    expect(completion.toolCalls[0]?.function.name).toBe("act.request");
    expect(JSON.parse(completion.toolCalls[0]?.function.arguments ?? "{}")).toMatchObject({
      kind: "domain.register",
      fields: { domainName: "northwindcoffee.com" },
    });
  });

  it("keeps a malformed arguments string intact instead of repairing it", async () => {
    const { client: sut } = client(() => ({
      body: JSON.stringify({
        id: "x",
        model: "m",
        choices: [
          {
            message: {
              tool_calls: [{ id: "c1", function: { name: "act.request", arguments: "{oops" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    }));
    const completion = await sut.chat({ messages: [] });
    expect(completion.toolCalls[0]?.function.arguments).toBe("{oops");
  });

  it("surfaces cost.usd from the response root", async () => {
    const { client: sut } = client(() => ({ body: fixture("venice-tool-call.json") }));
    const completion = await sut.chat({ messages: [] });
    expect(completion.cost?.usd).toBeCloseTo(0.00041325, 8);
    expect(completion.cost?.raw).toMatchObject({ vcu: 0.0031788 });
  });

  it("surfaces cost.usd when it hangs off usage instead", async () => {
    const { client: sut } = client(() => ({ body: fixture("venice-usage-cost.json") }));
    const completion = await sut.chat({ messages: [] });
    expect(completion.cost?.usd).toBeCloseTo(0.0019364, 8);
  });

  it("reports an unrecognised cost shape as absent, never as zero", () => {
    expect(readCost({ id: "x" })).toBeNull();
    expect(readCost({ cost: { vcu: 3 } })).toEqual({ usd: null, raw: { vcu: 3 } });
  });

  it("treats an API error object as an error rather than as an empty completion", async () => {
    const { client: sut } = client(() => ({
      body: JSON.stringify({ error: { message: "model is not available" } }),
    }));
    await expect(sut.chat({ messages: [] })).rejects.toMatchObject({ kind: "api" });
  });
});

describe("streaming", () => {
  async function collect(stream: AsyncGenerator<ChatStreamEvent>) {
    const events: ChatStreamEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
  }

  it("assembles text and tool-call arguments across chunk boundaries", async () => {
    const raw = fixture("venice-stream.txt");
    // Split at a point that lands mid-line, which is what a socket actually does.
    const cut = Math.floor(raw.length / 2);
    const { client: sut } = client(() => ({ stream: [raw.slice(0, cut), raw.slice(cut)] }));

    const events = await collect(sut.stream({ messages: [] }));
    const text = events
      .filter((e): e is Extract<ChatStreamEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("Checking the writ first.");

    const final = events.at(-1);
    expect(final?.type).toBe("completion");
    if (final?.type !== "completion") throw new Error("no completion event");
    expect(final.completion.toolCalls[0]?.function.arguments).toBe(
      '{"kind":"domain.register","fields":{"tld":"com"}}',
    );
    expect(final.completion.finishReason).toBe("tool_calls");
    expect(final.completion.cost?.usd).toBeCloseTo(0.00052, 8);
  });

  it("asks the server to include usage, so a streamed run is still priced", async () => {
    const { client: sut, fake } = client(() => ({ stream: [fixture("venice-stream.txt")] }));
    await collect(sut.stream({ messages: [] }));
    const body = JSON.parse(fake.calls[0]?.init?.body ?? "{}");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("falls back to a whole body when the transport gives no stream", async () => {
    const { client: sut } = client(() => ({ body: fixture("venice-stream.txt") }));
    const events = await collect(sut.stream({ messages: [] }));
    const final = events.at(-1);
    if (final?.type !== "completion") throw new Error("no completion event");
    expect(final.completion.text).toBe("Checking the writ first.");
  });
});

describe("credentials", () => {
  it("verifies by POSTing a completion, never by reading the public model list", async () => {
    const { client: sut, fake } = client(() => ({ body: fixture("venice-usage-cost.json") }));
    const result = await sut.verifyKey();

    expect(result).toMatchObject({ valid: true });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url.endsWith("/chat/completions")).toBe(true);
    expect(fake.calls[0]?.init?.method).toBe("POST");
    expect(fake.calls.some((call) => call.url.includes("/models"))).toBe(false);
  });

  it("fails a garbage key even though GET /models would have answered 200", async () => {
    const { client: sut } = client((call) =>
      call.url.includes("/models")
        ? { body: JSON.stringify({ data: [{ id: "gemini-3-8-flash" }] }) }
        : { ok: false, status: 401, body: "authentication failed" },
    );
    const result = await sut.verifyKey();
    expect(result).toMatchObject({ valid: false, kind: "auth", status: 401 });
  });

  it("distinguishes an unreachable service from a bad key", async () => {
    const { client: sut } = client(() => {
      throw new Error("ECONNREFUSED");
    });
    const result = await sut.verifyKey();
    expect(result).toMatchObject({ valid: false, kind: "network" });
  });

  it("reads the key from the environment and refuses to invent one", () => {
    expect(veniceApiKeyFromEnv({ VENICE_API_KEY: "  vn-abc  " })).toBe("vn-abc");
    expect(() => veniceApiKeyFromEnv({})).toThrow(VeniceError);
    expect(() => veniceApiKeyFromEnv({ VENICE_API_KEY: "" })).toThrow(/VENICE_API_KEY/);
    expect(() => new VeniceClient({ apiKey: "" })).toThrow(VeniceError);
  });
});

describe("the runtime's model port", () => {
  it("adapts a completion into a reply the loop can reduce, cost included", async () => {
    const { client: sut } = client(() => ({ body: fixture("venice-tool-call.json") }));
    const outcome = await veniceChatModel(sut).complete({
      model: DEFAULT_VENICE_MODEL,
      messages: [{ role: "user", content: "go" }],
      tools: [],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.reply.toolCalls[0]).toMatchObject({ id: "call_a1", name: "act.request" });
    expect(outcome.reply.costUsd).toBeCloseTo(0.00041325, 8);
  });

  it("turns a transport failure into data, so a run can end with a stated reason", async () => {
    const { client: sut } = client(() => ({ ok: false, status: 401, body: "nope" }));
    const outcome = await veniceChatModel(sut).complete({
      model: DEFAULT_VENICE_MODEL,
      messages: [],
      tools: [],
    });
    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining("auth") });
  });
});

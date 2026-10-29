import assert from "node:assert/strict";
import test from "node:test";
import { z } from "../server/node_modules/zod/index.js";
import { ChatModel, ProviderError, type ChatMessage, type LlmUsage } from "../server/src/providers/llm.js";

const messages: ChatMessage[] = [{ role: "user", content: "说明这个问题" }];
const schema = z.object({ ok: z.literal(true) });
const model = (fetcher: typeof fetch) => new ChatModel({
  baseUrl: "https://synthetic.test/v1", apiKey: "synthetic", model: "test",
  extraBody: {}, timeoutMs: 1000,
}, fetcher);
type Failure = Error & { billing: "none" | "unknown"; usage: LlmUsage };
async function failure(run: () => Promise<unknown>): Promise<Failure> {
  try { await run(); }
  catch (error) { return error as Failure; }
  assert.fail("Expected a provider failure");
}
const json = (content: unknown, usage?: Record<string, number>, finishReason = "stop") => Response.json({
  choices: [{ message: { content }, finish_reason: finishReason }], ...(usage ? { usage } : {}),
});
const frame = (delta: Record<string, unknown>, usage?: Record<string, number>) => new TextEncoder().encode(
  `data: ${JSON.stringify({ choices: [{ delta }], ...(usage ? { usage } : {}) })}\n\n`,
);
function stream(chunks: Uint8Array[], broken = false) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else if (broken) controller.error(new Error("synthetic interrupted stream"));
      else controller.close();
    },
  }));
}

test("JSON timeout estimates sent input instead of presenting initial zero counters as reported usage", async () => {
  const client = model(async () => { throw new Error("synthetic timeout"); });
  const error = await failure(() => client.json(messages, schema));
  assert.equal(error.billing, "unknown");
  assert.equal(error.usage.estimated, true);
  assert.equal(error.usage.calls, 1);
  assert.equal(error.usage.promptTokens, 323);
  assert.equal(error.usage.completionTokens, 0);
});

test("broken streams estimate received text and thinking and retain image input allowance", async () => {
  const client = model(async () => stream([frame({ content: "答案内容", reasoning_content: "思考内容" })], true));
  const error = await failure(() => client.stream([{ role: "user", content: [
    { type: "text", text: "说明这个问题" }, { type: "image_url", image_url: { url: "data:image/png;base64,c3ludGhldGlj" } },
  ] }], { onText() {} }));
  assert.equal(error.billing, "unknown");
  assert.equal(error.usage.estimated, true);
  assert.equal(error.usage.promptTokens, 1347);
  assert.equal(error.usage.completionTokens, 4);
});

test("stream ProviderError paths also retain partial output and estimated input", async () => {
  const client = model(async () => stream([frame({ content: "答案内容", reasoning_content: "思考内容" })]));
  const error = await failure(() => client.stream(messages, { onText() {
    throw new ProviderError("AI_BAD_OUTPUT", "synthetic rejected output", "unknown");
  } }));
  assert.equal(error.billing, "unknown");
  assert.equal(error.usage.estimated, true);
  assert.equal(error.usage.promptTokens, 323);
  assert.equal(error.usage.completionTokens, 4);
});

test("stream cancellation preserves the abort name and observed output usage without mutating its reason", async () => {
  const controller = new AbortController();
  const reason = new DOMException("synthetic cancellation", "AbortError");
  const client = model(async () => stream([frame({ content: "答案内容" })]));
  const error = await failure(() => client.stream(messages, { onText() {
    controller.abort(reason); throw reason;
  } }, { signal: controller.signal }));
  assert.notEqual(error, reason);
  assert.equal(error.name, reason.name);
  assert.equal(error.message, reason.message);
  assert.equal("usage" in reason, false);
  assert.equal(error.billing, "unknown");
  assert.equal(error.usage.estimated, true);
  assert.equal(error.usage.completionTokens, 2);
});

test("JSON cancellation after sending retains estimated usage", async () => {
  const controller = new AbortController();
  const reason = new DOMException("synthetic cancellation", "AbortError");
  const client = model(async () => { controller.abort(reason); throw reason; });
  const error = await failure(() => client.json(messages, schema, controller.signal));
  assert.notEqual(error, reason);
  assert.equal(error.name, reason.name);
  assert.equal(error.message, reason.message);
  assert.equal("usage" in reason, false);
  assert.equal(error.billing, "unknown");
  assert.equal(error.usage.calls, 1);
  assert.equal(error.usage.estimated, true);
  assert.equal(error.usage.promptTokens, 323);
});

test("concurrent streams sharing one cancellation reason retain independent observed usage", async () => {
  const controller = new AbortController();
  const reason = new DOMException("synthetic shared cancellation", "AbortError");
  const errors = await Promise.all([2, 200].map(size => {
    const client = model(async () => stream([frame({ content: "答".repeat(size) })]));
    return failure(() => client.stream(messages, { onText() {
      controller.abort(reason); throw reason;
    } }, { signal: controller.signal }));
  }));
  assert.notEqual(errors[0], errors[1]);
  assert.deepEqual(errors.map(error => error.usage.completionTokens), [1, 100]);
  assert.ok(errors.every(error => error.name === "AbortError" && error.message === reason.message && error.billing === "unknown"));
  assert.equal("usage" in reason, false);
});

test("complete usage survives malformed schema, missing content and truncated output without an estimate", async () => {
  for (const [content, finishReason] of [["{}", "stop"], [undefined, "stop"], ['{"ok":true}', "length"]] as const) {
    const client = model(async () => json(content, { prompt_tokens: 120, completion_tokens: 80 }, finishReason));
    const error = await failure(() => client.json(messages, schema, undefined, { jsonRetries: 0 }));
    assert.equal(error.billing, "unknown");
    assert.equal(error.usage.promptTokens, 120);
    assert.equal(error.usage.completionTokens, 80);
    assert.equal(error.usage.estimated, undefined);
  }
});

test("stream failure after complete provider usage retains actual counters including genuine zero", async () => {
  for (const counters of [{ prompt_tokens: 120, completion_tokens: 80 }, { prompt_tokens: 0, completion_tokens: 0 }]) {
    const client = model(async () => stream([frame({ content: "答案" }, counters)], true));
    const error = await failure(() => client.stream(messages, { onText() {} }));
    assert.equal(error.usage.promptTokens, counters.prompt_tokens);
    assert.equal(error.usage.completionTokens, counters.completion_tokens);
    assert.equal(error.usage.estimated, undefined);
  }
});

test("one reported usage field never makes a failed JSON or stream look completely measured", async () => {
  for (const counters of [{ prompt_tokens: 120 }, { completion_tokens: 80 }]) {
    const jsonClient = model(async () => json("{}", counters));
    const jsonError = await failure(() => jsonClient.json(messages, schema, undefined, { jsonRetries: 0 }));
    assert.equal(jsonError.usage.estimated, true);
    assert.equal(jsonError.usage.promptTokens, counters.prompt_tokens ?? 3);
    assert.equal(jsonError.usage.completionTokens, counters.completion_tokens ?? 1);
    const streamClient = model(async () => stream([frame({ content: "答案", reasoning_content: "思考" }, counters)], true));
    const streamError = await failure(() => streamClient.stream(messages, { onText() {} }));
    assert.equal(streamError.usage.estimated, true);
    assert.equal(streamError.usage.promptTokens, counters.prompt_tokens ?? 323);
    assert.equal(streamError.usage.completionTokens, counters.completion_tokens ?? 2);
  }
});

test("JSON corrective retry ending in non-2xx retains prior measured charges and disables failover", async () => {
  let calls = 0;
  const client = model(async () => ++calls === 1 ? json("{}", { prompt_tokens: 120, completion_tokens: 80 })
    : new Response("synthetic busy", { status: 429 }));
  const error = await failure(() => client.json(messages, schema));
  assert.equal(error.billing, "unknown");
  assert.equal(error.usage.calls, 2);
  assert.equal(error.usage.promptTokens, 120);
  assert.equal(error.usage.completionTokens, 80);
  assert.equal(error.usage.estimated, undefined);
});

test("stream JSON corrective retry ending in non-2xx retains prior measured charges", async () => {
  let calls = 0;
  const client = model(async () => ++calls === 1 ? stream([frame({ content: "{}" }, { prompt_tokens: 120, completion_tokens: 80 })])
    : new Response("synthetic busy", { status: 429 }));
  const error = await failure(() => client.streamJson(messages, schema, { expect: 10 }));
  assert.equal(error.billing, "unknown");
  assert.equal(error.usage.calls, 2);
  assert.equal(error.usage.promptTokens, 120);
  assert.equal(error.usage.completionTokens, 80);
  assert.equal(error.usage.estimated, undefined);
});

test("JSON corrective retry timeout adds an estimate to prior actual usage", async () => {
  let calls = 0;
  const client = model(async () => { if (++calls === 1) return json("{}", { prompt_tokens: 120, completion_tokens: 80 });
    throw new Error("synthetic timeout"); });
  const error = await failure(() => client.json(messages, schema));
  assert.equal(error.billing, "unknown");
  assert.equal(error.usage.calls, 2);
  assert.equal(error.usage.estimated, true);
  assert.ok(error.usage.promptTokens > 443);
  assert.equal(error.usage.completionTokens, 80);
});

test("first non-2xx and preflight cancellation remain unbilled while complete successful usage is unchanged", async () => {
  const rejected = model(async () => new Response("synthetic busy", { status: 429 }));
  const error = await failure(() => rejected.json(messages, schema));
  assert.equal(error.billing, "none");
  assert.equal(error.usage.promptTokens, 0);
  assert.equal(error.usage.completionTokens, 0);
  const controller = new AbortController(); controller.abort();
  const cancelled = model(async () => assert.fail("Cancelled request must not be sent"));
  const aborted = await failure(() => cancelled.json(messages, schema, controller.signal));
  assert.equal(aborted.billing, "none");
  assert.equal(aborted.usage.calls, 0);
  const successful = model(async () => json('{"ok":true}', { prompt_tokens: 120, completion_tokens: 80 }));
  const result = await successful.json(messages, schema);
  assert.equal(result.usage.calls, 1);
  assert.equal(result.usage.promptTokens, 120);
  assert.equal(result.usage.completionTokens, 80);
  assert.equal(result.usage.estimated, undefined);
});

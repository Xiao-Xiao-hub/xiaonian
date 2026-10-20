import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { ChatModel, type JsonProgress } from "../server/src/providers/llm.js";
import type { UsageStart, UsageEnd } from "../server/src/shared/usage-ledger.js";
const { z } = createRequire(new URL("../server/package.json", import.meta.url))("zod") as typeof import("zod");
const messages = [{ role: "user" as const, content: "合成输入" }];
const schema = z.object({ ok: z.literal(true) });
function fixture(responses: Response[]) {
  const bodies: Record<string, any>[] = [];
  const starts: UsageStart[] = [], ends: UsageEnd[] = [];
  const model = new ChatModel({
    baseUrl: "https://synthetic.invalid/v1", apiKey: "synthetic", model: "synthetic",
    extraBody: { max_tokens: 9999 }, timeoutMs: 5000,
    usageMeter: { start: (data) => { starts.push(data); return (end) => { ends.push(end); }; } },
  }, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const response = responses.shift();
    assert.ok(response, "unexpected additional provider call");
    return response;
  });
  return { model, bodies, starts, ends };
}
const reply = (content: string, finish = "stop", cached?: number) => new Response(JSON.stringify({
  choices: [{ message: { content }, finish_reason: finish }],
  usage: { prompt_tokens: 20, completion_tokens: 10,
    ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }) },
}));
const sse = (content: string, finish = "stop") => new Response([
  { choices: [{ delta: { reasoning_content: "合成思考" } }] },
  { choices: [{ delta: { content }, finish_reason: finish }] },
  { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 8 } } },
].map((event) => "data: " + JSON.stringify(event) + "\n\n").join("") + "data: [DONE]\n\n");

test("JSON records actual cache fields and canonical scene and respects the supplied total budget", async () => {
  const { model, bodies, starts, ends } = fixture([reply('{"ok":true}', "stop", 12)]);
  const result = await model.json(messages, schema, undefined, { scenario: "notes", maxTokens: 1600 });
  assert.equal(bodies[0]!.max_tokens, 1600);
  assert.equal(starts[0]!.scene, "card_tidy");
  assert.equal(ends[0]!.cachedTokens, 12);
  assert.equal(result.usage.cachedTokens, 12);
  assert.equal(result.usage.finishReason, "stop");
  assert.equal(result.usage.scene, "card_tidy");
});

test("truncated structured JSON is rejected without corrective retry even when the text parses", async () => {
  const { model, bodies } = fixture([reply('{"ok":true}', "length")]);
  await assert.rejects(model.json(messages, schema), (error: any) => {
    assert.equal(error.code, "OUTPUT_TRUNCATED");
    assert.equal(error.billing, "unknown");
    assert.equal(error.usage.completionTokens, 10);
    return true;
  });
  assert.equal(bodies.length, 1);
});

test("map_stuck does not correct bad JSON; other JSON corrects once and sums usage", async () => {
  const stuck = fixture([reply("bad")]);
  await assert.rejects(stuck.model.json(messages, schema, undefined, { scenario: "map_stuck" }), { code: "AI_BAD_OUTPUT" });
  assert.equal(stuck.bodies.length, 1);
  const tidy = fixture([reply("bad", "stop", 1), reply('{"ok":true}', "stop", 2)]);
  const { usage } = await tidy.model.json(messages, schema);
  assert.equal(usage.calls, 2);
  assert.equal(usage.promptTokens, 40);
  assert.equal(usage.cachedTokens, 3);
});

test("streaming JSON reports thinking then real character counts, and reads terminal usage", async () => {
  const { model, bodies, starts, ends } = fixture([sse('{"ok":true}')]);
  const progress: JsonProgress[] = [];
  const result = await model.streamJson(messages, schema, {
    scenario: "brainstorm", expect: 800, maxTokens: 2400,
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(result.data, { ok: true });
  assert.deepEqual(progress, [
    { chars: 0, expect: 800 }, { chars: 0, expect: 800, thinking: true },
    { chars: 11, expect: 800 },
  ]);
  assert.deepEqual(bodies[0]!.stream_options, { include_usage: true });
  assert.deepEqual(bodies[0]!.response_format, { type: "json_object" });
  assert.equal(starts[0]!.scene, "brainstorm");
  assert.equal(ends[0]!.cachedTokens, 8);
});

test("streaming JSON retries malformed output once but never retries truncation", async () => {
  const bad = fixture([sse("bad"), sse('{"ok":true}')]);
  const result = await bad.model.streamJson(messages, schema, { expect: 800 });
  assert.equal(result.usage.calls, 2);
  assert.equal(result.usage.cachedTokens, 16);
  const cut = fixture([sse('{"ok":true}', "length")]);
  await assert.rejects(cut.model.streamJson(messages, schema, { expect: 800 }), { code: "OUTPUT_TRUNCATED" });
  assert.equal(cut.bodies.length, 1);
  assert.equal(cut.ends[0]!.status, "failed");
});

test("chat keeps truncated partial content; absent or invalid cache counts stay unknown", async () => {
  const { model } = fixture([sse("半句", "length"), reply('{"ok":true}'), reply('{"ok":true}', "stop", -1)]);
  const text: string[] = [];
  const result = await model.stream(messages, { onText: (piece) => text.push(piece) });
  assert.equal(result.text, "半句");
  assert.deepEqual(text, ["半句"]);
  assert.equal(result.usage.finishReason, "length");
  assert.equal((await model.json(messages, schema)).usage.cachedTokens, undefined);
  assert.equal((await model.json(messages, schema)).usage.cachedTokens, undefined);
});

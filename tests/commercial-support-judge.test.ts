import assert from "node:assert/strict";
import test from "node:test";
import {
  createSupportJudge,
  SUPPORT_CATEGORIES,
  type SupportJudgeOptions,
} from "../server/src/modules/support/judge.js";
import { JevError, type JevOptions } from "../server/src/providers/jev.js";
import type {
  CommercialCallInfo,
  CommercialCallUsage,
} from "../server/src/shared/commercial-meter.js";

const response = (answers: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify({ answers }), {
    status,
    headers: { "content-type": "application/json" },
  });
const valid = () => ({
  related: { noul: 0.91 },
  injection: { noul: 0.04 },
  category: {
    choice: "订单支付",
    confidence: 0.88,
    probabilities: { 订单支付: 0.88, 故障: 0.12 },
  },
});
const rejectsCode = async (run: Promise<unknown>, code: string) => {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof JevError);
    assert.equal(error.code, code);
    return true;
  });
};

test("support judge batches related, injection and category in one Jev request", async () => {
  let body: any;
  let calls = 0;
  const judge = createSupportJudge(
    { apiKey: "synthetic-jev", timeoutMs: 1000 },
    (async (_url, init) => {
      calls += 1;
      body = JSON.parse(String(init?.body));
      return response(valid());
    }) as typeof fetch,
  );
  assert.deepEqual(await judge.classify("订单扣款了但没有到账"), {
    related: 0.91,
    injection: 0.04,
    category: "订单支付",
  });
  assert.equal(calls, 1);
  assert.deepEqual(body.state, { text: "订单扣款了但没有到账" });
  assert.deepEqual(Object.keys(body.questions), [
    "related",
    "injection",
    "category",
  ]);
  assert.equal(body.questions.related.type, "noul");
  assert.equal(body.questions.injection.type, "noul");
  assert.equal(body.questions.category.type, "choice");
  assert.deepEqual(Object.keys(body.questions.category.criteria), [
    ...SUPPORT_CATEGORIES,
  ]);
  for (const question of Object.values(body.questions) as any[])
    assert.match(question.instructions, /state\.text.*不得/);
});

test("probabilities outside 0..1 and unknown categories are rejected", async (t) => {
  for (const [name, answers] of [
    ["related too high", { ...valid(), related: { noul: 1.01 } }],
    ["negative injection", { ...valid(), injection: { noul: -0.01 } }],
    [
      "unknown category",
      {
        ...valid(),
        category: {
          choice: "闲聊",
          confidence: 1,
          probabilities: { 闲聊: 1 },
        },
      },
    ],
  ] as const) {
    await t.test(name, async () => {
      const judge = createSupportJudge(
        { apiKey: "synthetic-jev", timeoutMs: 1000 },
        (async () => response(answers)) as typeof fetch,
      );
      await rejectsCode(judge.classify("测试文本"), "JEV_BAD_OUTPUT");
    });
  }
});

test("missing configuration ignores injected answer hooks and fails closed", async () => {
  let answerCalls = 0;
  let fallbackCalls = 0;
  let networkCalls = 0;
  const mixed = {
    timeoutMs: 1000,
    answer: async () => {
      answerCalls += 1;
      return { answers: valid() };
    },
    fallback: async () => {
      fallbackCalls += 1;
      return { answers: valid() };
    },
  } as JevOptions;
  const judge = createSupportJudge(
    mixed as SupportJudgeOptions,
    (async () => {
      networkCalls += 1;
      return response(valid());
    }) as typeof fetch,
  );
  await rejectsCode(judge.classify("怎么查看额度"), "JEV_NOT_CONFIGURED");
  assert.deepEqual(
    { answerCalls, fallbackCalls, networkCalls },
    {
      answerCalls: 0,
      fallbackCalls: 0,
      networkCalls: 0,
    },
  );
});

test("HTTP 401 never invokes answer or fallback hooks", async () => {
  let answerCalls = 0;
  let fallbackCalls = 0;
  let networkCalls = 0;
  const mixed = {
    apiKey: "rejected-key",
    timeoutMs: 1000,
    answer: async () => {
      answerCalls += 1;
      return { answers: valid() };
    },
    fallback: async () => {
      fallbackCalls += 1;
      return { answers: valid() };
    },
  } as JevOptions;
  const judge = createSupportJudge(
    mixed as SupportJudgeOptions,
    (async () => {
      networkCalls += 1;
      return new Response("unauthorized", { status: 401 });
    }) as typeof fetch,
  );
  await rejectsCode(judge.classify("订单在哪里"), "JEV_AUTH");
  assert.deepEqual(
    { answerCalls, fallbackCalls, networkCalls },
    {
      answerCalls: 0,
      fallbackCalls: 0,
      networkCalls: 1,
    },
  );
});

test("support calls retain an independent commercial metering source", async () => {
  const infos: CommercialCallInfo[] = [];
  const meter = {
    async run<T>(
      info: CommercialCallInfo,
      call: () => Promise<T>,
      usage: (result: T) => CommercialCallUsage,
    ) {
      infos.push(info);
      const result = await call();
      assert.deepEqual(usage(result), { requests: 1 });
      return result;
    },
  };
  const judge = createSupportJudge(
    {
      apiKey: "synthetic-jev",
      timeoutMs: 1000,
      commercialMeter: meter,
    },
    (async () => response(valid())) as typeof fetch,
  );
  await judge.classify("我想反馈一个故障");
  assert.equal(infos.length, 1);
  assert.equal(infos[0]!.kind, "jev");
  assert.equal(infos[0]!.source, "support");
});

import test from "node:test";
import assert from "node:assert/strict";
import { referenceFor } from "../server/src/modules/study/service.js";
import {
  fakeServices,
  makeApp,
  NOTE,
  PROBLEM,
  REPLIES,
  type App,
} from "./fixtures.js";
async function login(app: App, key = "owner") {
  const { token } = (
    await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key },
    })
  ).json().data;
  const call = async (method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url,
      payload: payload as string,
      headers: { authorization: `Bearer ${token}` },
    });
  return Object.assign(call, { token: token as string });
}
type Call = Awaited<ReturnType<typeof login>>;
async function settle(call: Call, jobId: string) {
  for (let i = 0; i < 200; i++) {
    const job = (await call("GET", `/v1/jobs/${jobId}`)).json().data;
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job did not finish");
}
async function confirmed(
  call: Call,
  kind: "note" | "problem",
  text: string,
  answer?: string,
) {
  const { id } = (
    await call("POST", "/v1/materials", { kind, text, answer })
  ).json().data;
  await call("PUT", `/v1/materials/${id}`, {
    expectedVersion: 1,
    confirm: true,
  });
  return id as string;
}
const study = async (call: Call, id: string) =>
  (await call("GET", `/v1/materials/${id}/study`)).json().data;
async function run(call: Call, url: string, payload: unknown = {}) {
  const res = await call("POST", url, payload);
  assert.equal(res.statusCode, 200, res.body);
  const { job } = res.json().data;
  return job ? settle(call, job.id) : null;
}

test("notes: explain, ask and quiz need confirmed text and cite numbered paragraphs", async () => {
  const services = fakeServices();
  const app = makeApp(services);
  const call = await login(app);
  const { id: draft } = (
    await call("POST", "/v1/materials", { kind: "note", text: NOTE })
  ).json().data;
  const early = await call("POST", `/v1/materials/${draft}/explain`, {});
  assert.equal(early.statusCode, 409);
  assert.equal(early.json().code, "NOT_CONFIRMED");

  const id = await confirmed(call, "note", NOTE);
  // The mini program may POST with no body at all.
  const bare = await app.inject({
    method: "POST",
    url: `/v1/materials/${id}/explain`,
    headers: {
      authorization: `Bearer ${call.token}`,
      "content-type": "application/json",
    },
  });
  assert.equal(bare.statusCode, 200, bare.body);
  const job = await settle(call, bare.json().data.job.id);
  assert.equal(job.status, "succeeded");
  assert.match(services.llm[0]!.prompt, /\[P1\] 太阳加热水面/);
  assert.match(services.llm[0]!.prompt, /\[P2\] 水蒸气遇冷/);
  // An existing result for the same text is reused; refresh asks again.
  assert.equal(await run(call, `/v1/materials/${id}/explain`), null);
  assert.equal(services.llm.length, 1);
  await run(call, `/v1/materials/${id}/explain`, { refresh: true });
  assert.equal(services.llm.length, 2);

  await run(call, `/v1/materials/${id}/ask`, { question: "降水有什么用？" });
  await run(call, `/v1/materials/${id}/quiz`);
  let state = await study(call, id);
  assert.equal(state.explain.data.points[0].citations[0], 1);
  assert.equal(state.explain.data.model, "hy4-preview");
  assert.equal(state.explain.stale, false);
  assert.equal(state.answers[0].data.question, "降水有什么用？");
  assert.deepEqual(state.answers[0].data.citations, [2]);
  // Quiz answers stay hidden until the question is attempted.
  const quiz = state.quiz;
  assert.equal(quiz.data.questions[0].answer, undefined);
  assert.equal(quiz.data.questions[0].options.length, 3);

  const wrong = (
    await call("POST", `/v1/materials/${id}/attempts`, {
      artifactId: quiz.id,
      item: 0,
      choice: 0,
    })
  ).json().data;
  assert.equal(wrong.job, null);
  assert.equal(wrong.attempt.answer, "风");
  assert.equal(wrong.attempt.result.verdict, "incorrect");
  assert.equal(wrong.attempt.result.reference.value, "太阳辐射");
  state = await study(call, id);
  assert.equal(state.quiz.data.questions[0].answer, 1);
  assert.equal(state.quiz.data.questions[1].answer, undefined);

  // Short answers are judged by meaning through Jev.
  const short = (
    await call("POST", `/v1/materials/${id}/attempts`, {
      artifactId: quiz.id,
      item: 1,
      answer: "让水回到地面",
    })
  ).json().data;
  await settle(call, short.job.id);
  const judged = (await call("GET", `/v1/attempts/${short.attempt.id}`)).json()
    .data;
  assert.equal(judged.result.verdict, "correct");
  assert.equal(judged.result.judge, "jev");
  assert.equal(services.jev[0]!.state.answer, "让水回到地面");

  // Editing the text marks earlier results as stale instead of deleting them.
  await call("PUT", `/v1/materials/${id}`, {
    expectedVersion: 1,
    text: `${NOTE}\n降水汇入河流。`,
  });
  state = await study(call, id);
  assert.equal(state.explain.stale, true);
  const wrongKind = await call("POST", `/v1/materials/${id}/hints`, {});
  assert.equal(wrongKind.json().code, "WRONG_KIND");
  await app.close();
});

test("problems: hints open one level at a time and the answer is labelled by source", async () => {
  const services = fakeServices();
  const app = makeApp(services);
  const call = await login(app);
  const id = await confirmed(call, "problem", PROBLEM);
  await run(call, `/v1/materials/${id}/hints`);
  let hints = (await study(call, id)).hints;
  assert.deepEqual(hints.data.levels, []);
  assert.equal(hints.data.levelCount, 3);
  assert.equal(hints.data.answer, null);
  const level1 = (
    await call("POST", `/v1/artifacts/${hints.id}/reveal`, { level: 1 })
  ).json().data;
  assert.deepEqual(level1.data.levels, ["打八折就是乘以 0.8"]);
  assert.equal(level1.data.answer, null);
  hints = (
    await call("POST", `/v1/artifacts/${hints.id}/reveal`, { level: 3 })
  ).json().data;
  assert.equal(hints.data.levels.length, 3);
  assert.deepEqual(hints.data.answer, {
    value: "48 元",
    source: "rule",
    check: "60*0.8 = 48",
  });
  await app.close();

  const base = REPLIES.hints as Parameters<typeof referenceFor>[0];
  assert.equal(referenceFor({ ...base, complete: false }, null), null);
  const mine = referenceFor(base, "50 元")!;
  assert.equal(mine.source, "user");
  assert.match(mine.note!, /验算得 48，与你提供的答案不一致/);
  const drifted = referenceFor({ ...base, finalAnswer: "46 元" }, null)!;
  assert.equal(drifted.source, "ai");
  assert.match(drifted.note!, /与 AI 给出的答案不一致/);
  assert.equal(referenceFor({ ...base, expression: "" }, null)!.source, "ai");
  // A unit with a superscript is not a second number: the expression still checks it.
  const physics = referenceFor(
    { ...base, finalAnswer: "3 m/s²，方向向右", expression: "(24-9)/5" },
    null,
  )!;
  assert.equal(physics.source, "rule");
  assert.equal(physics.check, "(24-9)/5 = 3");
});

test("a first wrong attempt shows the solution once hints level 3 is open", async () => {
  const services = fakeServices();
  const app = makeApp(services);
  const call = await login(app);
  const id = await confirmed(call, "problem", PROBLEM);
  const { job } = (await call("POST", `/v1/materials/${id}/hints`, {})).json()
    .data;
  await settle(call, job.id);
  const hints = (await study(call, id)).hints;
  for (const level of [1, 2, 3])
    await call("POST", `/v1/artifacts/${hints.id}/reveal`, { level });
  const { attempt, job: feedback } = (
    await call("POST", `/v1/materials/${id}/attempts`, { answer: "50" })
  ).json().data;
  await settle(call, feedback.id);
  const result = (await call("GET", `/v1/attempts/${attempt.id}`)).json().data
    .result;
  assert.equal(result.verdict, "incorrect");
  assert.equal(result.revealSolution, true);
  assert.equal(result.reference.value, "48 元");
  // Read back with a plain-text form for the screen.
  assert.equal(result.reference.text, "48 元");
  assert.deepEqual(
    services.llm.map((c) => c.kind),
    ["hints", "feedback"],
  );
});
test("problem attempts: numbers judged by rule, the solution opens after two wrong tries", async () => {
  const services = fakeServices();
  const app = makeApp(services);
  const call = await login(app);
  const id = await confirmed(call, "problem", PROBLEM);
  const attempt = async (answer: string) => {
    const { attempt, job } = (
      await call("POST", `/v1/materials/${id}/attempts`, { answer })
    ).json().data;
    assert.equal((await settle(call, job.id)).status, "succeeded");
    return (await call("GET", `/v1/attempts/${attempt.id}`)).json().data.result;
  };
  const first = await attempt("50");
  assert.equal(first.verdict, "incorrect");
  assert.equal(first.judge, "rule");
  assert.deepEqual(first.cause, {
    key: "calc",
    label: "计算失误",
    confidence: 0.8,
  });
  assert.match(first.comment, /检查计算/);
  // Probe first: no answer or full solution yet.
  assert.equal(first.revealSolution, false);
  assert.equal(first.reference, null);
  assert.equal(first.explanation, "");
  // The hints generated for judging were kept, still folded; a hidden result
  // shows fixed guidance, so the feedback model was not asked.
  assert.deepEqual(
    services.llm.map((c) => c.kind),
    ["hints"],
  );
  assert.deepEqual((await study(call, id)).hints.data.levels, []);

  const second = await attempt("52 元");
  assert.equal(second.revealSolution, true);
  assert.equal(second.reference.value, "48 元");
  assert.equal(second.reference.source, "rule");
  assert.match(second.explanation, /60×0.8=48/);
  assert.equal((await study(call, id)).hints.data.levels.length, 3);

  const right = await attempt("48");
  assert.equal(right.verdict, "correct");
  assert.match(right.comment, /^答案与参考答案一致/);
  assert.equal(services.llm.length, 2);
  // Words instead of digits go to Jev for an equivalence judgement.
  const worded = await attempt("四十八元");
  assert.equal(worded.verdict, "correct");
  assert.equal(worded.judge, "jev");
  const state = await study(call, id);
  assert.equal(state.attempts.length, 4);
  assert.equal(state.attempts[0].answer, "四十八元");
  await app.close();
});

const VOLUME_PROBLEM = "把 250 毫升和 750 毫升水倒在一起，一共是多少升？";
const VOLUME_HINTS = {
  complete: true,
  missing: "",
  levels: [
    "注意体积单位",
    "先相加，再从毫升换算为升",
    "250+750=1000 毫升，等于 1 升",
  ],
  finalAnswer: "1 升",
  expression: "(250+750)/1000",
  note: "",
};
async function attemptProblem(call: Call, id: string, answer: string) {
  const response = await call("POST", `/v1/materials/${id}/attempts`, {
    answer,
  });
  assert.equal(response.statusCode, 200, response.body);
  const { attempt, job } = response.json().data;
  assert.equal((await settle(call, job.id)).status, "succeeded");
  return (await call("GET", `/v1/attempts/${attempt.id}`)).json().data.result;
}

test("feedback gate blocks a model that leaks the final answer before the second wrong attempt", async (t) => {
  const leaked = "完整答案为48元，计算60乘0.8即可。LEAKED_MODEL_OUTPUT";
  const services = fakeServices({ feedback: { comment: leaked } });
  const app = makeApp(services);
  t.after(() => app.close());
  const call = await login(app);
  const id = await confirmed(call, "problem", PROBLEM);
  const first = await attemptProblem(call, id, "50");
  assert.equal(first.revealSolution, false);
  assert.equal(first.reference, null);
  assert.equal(first.explanation, "");
  assert.doesNotMatch(first.comment, /48|60|0\.8|LEAKED_MODEL_OUTPUT/);
  assert.match(first.comment, /提示/);
  assert.deepEqual((await study(call, id)).hints.data.levels, []);

  const second = await attemptProblem(call, id, "52");
  assert.equal(second.revealSolution, true);
  assert.equal(second.comment, leaked);
  assert.equal(second.reference.value, "48 元");
  assert.match(second.explanation, /48/);

  const other = await confirmed(call, "problem", PROBLEM);
  const right = await attemptProblem(call, other, "48");
  assert.equal(right.revealSolution, true);
  assert.equal(right.reference.value, "48 元");
  assert.match(right.comment, /^答案与参考答案一致/);
  assert.doesNotMatch(right.comment, /思路正确/);
});

test("feedback gate guides uncertain and unclassified answers without model text", async (t) => {
  const leaked = "答案就是48元。LEAKED_UNCERTAIN_OUTPUT";
  const services = fakeServices({ feedback: { comment: leaked } });
  services.judge.noul = 0.5;
  services.judge.cause = "other";
  const app = makeApp(services);
  t.after(() => app.close());
  const call = await login(app);
  const id = await confirmed(call, "problem", PROBLEM);
  for (const answer of ["不知道", "不能确定", "50"]) {
    const result = await attemptProblem(call, id, answer);
    assert.equal(result.verdict, answer === "50" ? "incorrect" : "unsure");
    assert.equal(result.cause, null);
    assert.equal(result.revealSolution, false);
    assert.equal(result.reference, null);
    assert.equal(result.explanation, "");
    assert.doesNotMatch(result.comment, /48|LEAKED_UNCERTAIN_OUTPUT/);
    assert.match(result.comment, /核对.*提示/);
  }
});

test("feedback gate preserves missing-condition guidance with one sentence ending", async (t) => {
  const services = fakeServices({
    hints: {
      complete: false,
      missing: "缺少长方形的宽。",
      levels: [],
      finalAnswer: "",
      expression: "",
      note: "",
    },
  });
  const app = makeApp(services);
  t.after(() => app.close());
  const call = await login(app);
  const id = await confirmed(
    call,
    "problem",
    "一张长方形纸的长为8厘米，求面积。",
  );
  const result = await attemptProblem(call, id, "无法确定，还缺少宽");
  assert.equal(result.verdict, "unsure");
  assert.equal(result.judge, "none");
  assert.equal(result.revealSolution, false);
  assert.equal(result.reference, null);
  assert.equal(
    result.comment,
    "题目条件可能不完整：缺少长方形的宽。请回到原文补全后再作答。",
  );
  assert.deepEqual(
    services.llm.map((c) => c.kind),
    ["hints"],
  );
});

test("problem unit answers: wrong units are not accepted as equal numbers", async (t) => {
  const services = fakeServices({ hints: VOLUME_HINTS });
  services.judge.noul = 0.1;
  services.judge.cause = "unit";
  const app = makeApp(services);
  t.after(() => app.close());
  const call = await login(app);
  const id = await confirmed(call, "problem", VOLUME_PROBLEM);
  const result = await attemptProblem(call, id, "1 毫升");
  assert.equal(
    result.verdict,
    "incorrect",
    "1 毫升 is not equal to the reference 1 升",
  );
  assert.equal(result.judge, "jev");
  assert.deepEqual(services.jev.find((q) => q.type === "noul")?.state, {
    question: VOLUME_PROBLEM,
    reference: "1 升",
    answer: "1 毫升",
  });
});

test("problem unit answers: equivalent converted units are judged by Jev", async (t) => {
  const services = fakeServices({ hints: VOLUME_HINTS });
  const app = makeApp(services);
  t.after(() => app.close());
  const call = await login(app);
  const id = await confirmed(call, "problem", VOLUME_PROBLEM);
  const result = await attemptProblem(call, id, "1000 毫升");
  assert.equal(result.verdict, "correct");
  assert.equal(result.judge, "jev");
  assert.equal(
    services.jev.find((q) => q.type === "noul")?.state.answer,
    "1000 毫升",
  );
});

test("problem unit answers: without Jev conversions and narrative stay unsure", async (t) => {
  const services = fakeServices({ hints: VOLUME_HINTS });
  const app = makeApp(services, { JEV_API_KEY: "" });
  t.after(() => app.close());
  const call = await login(app);
  const id = await confirmed(call, "problem", VOLUME_PROBLEM);
  for (const answer of ["1 毫升", "1000 毫升", "1 升向东", "不是 1 升"]) {
    const result = await attemptProblem(call, id, answer);
    assert.equal(result.verdict, "unsure", answer);
    assert.equal(result.judge, "none", answer);
  }
  assert.equal(services.jev.length, 0);
});

test("problem unit answers: same units and omitted units retain numeric rules", async (t) => {
  const services = fakeServices({ hints: VOLUME_HINTS });
  const app = makeApp(services, { JEV_API_KEY: "" });
  t.after(() => app.close());
  const call = await login(app);
  const id = await confirmed(call, "problem", VOLUME_PROBLEM);
  for (const answer of ["1 升", "１升", "1"]) {
    const result = await attemptProblem(call, id, answer);
    assert.equal(result.verdict, "correct", answer);
    assert.equal(result.judge, "rule", answer);
  }
  const wrong = await attemptProblem(call, id, "2 升");
  assert.equal(wrong.verdict, "incorrect");
  assert.equal(wrong.judge, "rule");
  assert.equal(services.jev.length, 0);
});

test("variants: templates must reproduce the original answer; redraws skip the model", async () => {
  const services = fakeServices();
  const app = makeApp(services);
  const call = await login(app);
  const id = await confirmed(call, "problem", PROBLEM);
  await run(call, `/v1/materials/${id}/variant`);
  let variant = (await study(call, id)).variant;
  assert.match(
    variant.data.question,
    /^一件衣服原价 \d+ 元，打 \d 折后是多少元？$/,
  );
  assert.equal(variant.data.answer, undefined);
  const [, a, d] = variant.data.question.match(/(\d+) 元，打 (\d) 折/)!;
  const opened = (
    await call("POST", `/v1/artifacts/${variant.id}/reveal`, { level: 1 })
  ).json().data;
  assert.equal(opened.data.source, "rule");
  const expected = (Number(a) * Number(d)) / 10;
  assert.equal(parseFloat(opened.data.answer), expected);
  assert.match(opened.data.answer, / 元$/);

  const result = (
    await call("POST", `/v1/materials/${id}/attempts`, {
      artifactId: variant.id,
      answer: String(expected),
    })
  ).json().data;
  await settle(call, result.job.id);
  const judged = (await call("GET", `/v1/attempts/${result.attempt.id}`)).json()
    .data.result;
  assert.equal(judged.verdict, "correct");
  assert.equal(judged.judge, "rule");

  const calls = services.llm.length;
  const redraw = await call("POST", `/v1/materials/${id}/variant`, {});
  assert.equal(redraw.json().data.job, null);
  assert.equal(services.llm.length, calls);
  variant = (await study(call, id)).variant;
  assert.equal(variant.id, redraw.json().data.artifactId);
  // Hints generated while planning were kept for the hint page.
  assert.equal((await study(call, id)).hints.data.levelCount, 3);
  await app.close();

  const bad = fakeServices({
    variant: { ...(REPLIES.variant as object), answer: "a*d/100" },
  });
  const badApp = makeApp(bad);
  const badCall = await login(badApp);
  const other = await confirmed(badCall, "problem", PROBLEM);
  const failed = await run(badCall, `/v1/materials/${other}/variant`);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "VARIANT_UNRELIABLE");
  assert.equal((await study(badCall, other)).variant, null);
  await badApp.close();
});

test("variants: ASCII powers in the unit are written as superscripts", async () => {
  const services = fakeServices({
    variant: { ...(REPLIES.variant as object), unit: "m/s^2" },
  });
  const app = makeApp(services);
  const call = await login(app);
  const id = await confirmed(call, "problem", PROBLEM);
  await run(call, `/v1/materials/${id}/variant`);
  const variant = (await study(call, id)).variant;
  const opened = (
    await call("POST", `/v1/artifacts/${variant.id}/reveal`, { level: 1 })
  ).json().data;
  assert.match(opened.data.answer, /^\d+(\.\d+)? m\/s²$/);
  await app.close();
});

test("without Jev unclear answers stay unsure; limits and ownership hold", async () => {
  const services = fakeServices();
  // the attempt and the variant (≈ ¥0.0005 each at the test
  // model's highest rate) use up a ¥0.0006 day.
  const app = makeApp(services, { JEV_API_KEY: "", DAILY_BUDGET_CNY: "0.0006" });
  const call = await login(app);
  const id = await confirmed(call, "problem", PROBLEM);
  const { attempt, job } = (
    await call("POST", `/v1/materials/${id}/attempts`, { answer: "四十八元" })
  ).json().data;
  await settle(call, job.id);
  const result = (await call("GET", `/v1/attempts/${attempt.id}`)).json().data
    .result;
  assert.equal(result.verdict, "unsure");
  assert.equal(result.judge, "none");
  assert.equal(services.jev.length, 0);

  await run(call, `/v1/materials/${id}/variant`);
  const limited = await call("POST", `/v1/materials/${id}/attempts`, {
    answer: "48",
  });
  assert.equal(limited.statusCode, 429);
  assert.equal((await study(call, id)).attempts.length, 1);

  const hints = (await study(call, id)).hints;
  const stranger = await login(app, "stranger");
  assert.equal(
    (await stranger("GET", `/v1/materials/${id}/study`)).statusCode,
    404,
  );
  assert.equal(
    (
      await stranger("POST", `/v1/artifacts/${hints.id}/report`, {
        reason: "wrong",
      })
    ).statusCode,
    404,
  );
  const report = await call("POST", `/v1/artifacts/${hints.id}/report`, {
    reason: "wrong",
    note: "第二步算错了",
  });
  assert.deepEqual(report.json().data, { reported: true });
  await app.close();
});

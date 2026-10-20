// V4.2 G6 (report B 旧题目, 高): a reference answer the program disagrees with
// is disputed whoever wrote it, so judging stops at "unsure" instead of
// marking a right answer wrong. Equal forms of the same number are not a
// disagreement.
import test from "node:test";
import assert from "node:assert/strict";
import { referenceFor } from "../server/src/modules/study/service.js";
import { fakeServices, makeApp, PROBLEM, REPLIES, type App } from "./fixtures.js";

type Hints = Parameters<typeof referenceFor>[0];
const hints = (expression: string, finalAnswer: string): Hints => ({
  ...(REPLIES.hints as Hints),
  expression,
  finalAnswer,
});

test("a learner's reference that the arithmetic contradicts is disputed", () => {
  // 1/2 - 1/3 = 1/6.
  const sixth = hints("1/2-1/3", "1/6");
  const wrong = referenceFor(sixth, "1/3")!;
  assert.equal(wrong.source, "user");
  assert.equal(wrong.disputed, true);
  assert.match(wrong.note!, /验算得 0\.1666|验算得 1\/6|验算得 0\.17/);
  assert.match(wrong.note!, /这次先不按它判对错/);
  // The same number written another way is no conflict.
  for (const same of ["1/6", "2/12", "0.1666666667"]) {
    const ok = referenceFor(sixth, same)!;
    assert.equal(ok.disputed, undefined, same);
    assert.equal(ok.source, "user");
  }
  const half = hints("1/2", "0.5");
  for (const same of ["0.5", "1/2", "0.50"])
    assert.equal(referenceFor(half, same)!.disputed, undefined, same);
  // A sign is a real difference.
  assert.equal(referenceFor(half, "-1/2")!.disputed, true);
  const negative = hints("1/3-1/2", "-1/6");
  assert.equal(referenceFor(negative, "-1/6")!.disputed, undefined);
  assert.equal(referenceFor(negative, "1/6")!.disputed, true);
  // TeX the number rule cannot read is left alone, not called a conflict.
  assert.equal(referenceFor(negative, String.raw`-\frac{1}{6}`)!.disputed, undefined);
  // Units do not count: 48 元 against 60*0.8.
  assert.equal(referenceFor(hints("60*0.8", "48 元"), "48 元")!.disputed, undefined);
  assert.equal(referenceFor(hints("60*0.8", "48 元"), "50 元")!.disputed, true);
});

test("the program's checks against a learner's reference dispute it too", () => {
  const base = hints("", "1/6");
  const conflict = {
    state: "conflict" as const,
    items: [],
    findings: ["最终答案 1/3 和程序核对的结果不一致"],
  };
  const r = referenceFor(base, "1/3", conflict)!;
  assert.equal(r.source, "user");
  assert.equal(r.disputed, true);
  assert.match(r.note!, /程序核对和这个答案不一致/);
  // Nothing checked: the learner's answer stands.
  assert.equal(referenceFor(base, "1/3", null)!.disputed, undefined);
});

test("an AI answer its own arithmetic contradicts is disputed the same way", () => {
  const drifted = referenceFor(hints("60*0.8", "46 元"), null)!;
  assert.equal(drifted.source, "ai");
  assert.equal(drifted.disputed, true);
  assert.match(drifted.note!, /与 AI 给出的答案不一致/);
  const agreed = referenceFor(hints("60*0.8", "48 元"), null)!;
  assert.equal(agreed.source, "rule");
  assert.equal(agreed.disputed, undefined);
});

async function login(app: App) {
  const { token } = (
    await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: {} })
  ).json().data;
  return (method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url,
      payload: payload as string,
      headers: { authorization: `Bearer ${token}` },
    });
}

test("a right answer is not marked wrong against a disputed reference of the learner's", async (t) => {
  const app = makeApp(fakeServices());
  t.after(() => app.close());
  const call = await login(app);
  const settle = async (jobId: string) => {
    for (let i = 0; i < 400; i++) {
      const job = (await call("GET", `/v1/jobs/${jobId}`)).json().data;
      if (!["queued", "running"].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("job did not finish");
  };
  // 原价 60 元打八折 is 48 元; the learner typed 50 元 as the answer.
  const { id } = (
    await call("POST", "/v1/materials", { kind: "problem", text: PROBLEM, answer: "50 元" })
  ).json().data;
  await call("PUT", `/v1/materials/${id}`, { expectedVersion: 1, confirm: true });
  const { job } = (await call("POST", `/v1/materials/${id}/hints`, {})).json().data;
  await settle(job.id);
  const { attempt, job: judged } = (
    await call("POST", `/v1/materials/${id}/attempts`, { answer: "48" })
  ).json().data;
  await settle(judged.id);
  const result = (await call("GET", `/v1/attempts/${attempt.id}`)).json().data.result;
  assert.equal(result.verdict, "unsure", "not 'incorrect' against 50 元");
  // The reference stays hidden until the solution opens; then it says why.
  const study = (await call("GET", `/v1/materials/${id}/study`)).json().data;
  const opened = (
    await call("POST", `/v1/artifacts/${study.hints.id}/reveal`, { level: 3 })
  ).json().data;
  assert.equal(opened.data.answer.value, "50 元");
  assert.equal(opened.data.answer.disputed, true);
  assert.match(opened.data.answer.note, /验算得 48/);
});

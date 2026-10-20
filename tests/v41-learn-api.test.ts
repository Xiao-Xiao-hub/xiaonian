import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { canonicalInput } from "../server/src/modules/learn/answers.js";
import { BANK, PROBLEMS } from "../server/src/modules/learn/problems.js";
import { POINT_PRACTICE } from "../server/src/modules/learn/point-practice.js";
import { fakeServices, makeApp } from "./fixtures.js";

// 0.6.0 题库 APIs : bank, point detail, practice by point, submit, and
// “AI 再出一道” by point; the old point page APIs keep their shape.
const CHOICE_ID = "derivative-chain"; // problem 0 is served as single choice
const FILL_ID = "limit-rules"; // problem 0 is a plain-number fill-in, 1/2

function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const clock = { at: new Date("2026-10-04T20:00:00Z") };
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, () => clock.at, store);
  t.after(() => app.close());
  const login = async (key: string) => {
    const { token, user } = (
      await app.inject({
        method: "POST",
        url: "/v1/auth/dev-login",
        payload: { key },
      })
    ).json().data;
    const call = async (method: string, url: string, payload?: unknown) => {
      const res = await app.inject({
        method: method as "GET",
        url,
        payload: payload as string,
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: res.statusCode, body: res.json(), text: res.body };
    };
    return { call, userId: user.id as string };
  };
  return { app, store, clock, login };
}
const blocksOk = (blocks: unknown) =>
  Array.isArray(blocks) &&
  blocks.length > 0 &&
  !JSON.stringify(blocks).includes('"t":"tex"');
const rightOf = (pointId: string, index: number) => {
  const problem = BANK[pointId]![index]!;
  if (problem.kind !== "choice") throw new Error("choice fixture");
  const question = problem.questions[0]!;
  return {
    right: question.answer,
    wrong: question.options.find((o) => o.id !== question.answer)!.id,
  };
};

test("bank: chapters with point counts and progress; the guest version has none", async (t) => {
  const { app, login } = setup(t);
  assert.equal(
    (await app.inject({ method: "GET", url: "/v1/learn/bank" })).statusCode,
    401,
  );
  const { call } = await login("owner");
  const bank = (await call("GET", "/v1/learn/bank")).body.data;
  assert.equal(bank.guest, false);
  assert.equal(bank.chapters.length, 6);
  const points = bank.chapters.flatMap((c: any) => c.points);
  assert.equal(points.length, 89);
  assert.equal(
    bank.chapters.reduce((n: number, c: any) => n + c.problems, 0),
    244,
  );
  for (const chapter of bank.chapters)
    assert.equal(
      chapter.problems,
      chapter.points.reduce((n: number, p: any) => n + p.problems, 0),
    );
  const chain = points.find((p: any) => p.id === CHOICE_ID);
  assert.deepEqual(
    Object.keys(chain).sort(),
    [
      "aiPractice",
      "correct",
      "done",
      "hard",
      "id",
      "items",
      "key",
      "line",
      "name",
      "problems",
      "section",
      "short",
      "state",
      "tier",
    ],
  );
  assert.equal(chain.problems, BANK[CHOICE_ID]!.length);
  assert.equal(chain.aiPractice, true);
  assert.equal(
    points.filter((p: any) => p.aiPractice).length,
    Object.keys(POINT_PRACTICE).length,
  );
  assert.ok(!JSON.stringify(bank).includes('"answer"'));

  // Public: the same shape with guest true and no progress (zeros, "none").
  const res = await app.inject({ method: "GET", url: "/v1/learn/bank/public" });
  assert.equal(res.statusCode, 200);
  const guest = res.json().data;
  assert.equal(guest.guest, true);
  const gp = guest.chapters.flatMap((c: any) => c.points);
  assert.equal(gp.length, 89);
  assert.ok(gp.every((p: any) => p.done === 0 && p.correct === 0 && p.state === "none"));
  assert.deepEqual(
    guest.chapters.map((c: any) => c.problems),
    bank.chapters.map((c: any) => c.problems),
  );
});

test("detail: intro, formulas with notes, keys, a worked example, neighbours and state", async (t) => {
  const { app, login } = setup(t);
  const { call } = await login("owner");
  const d = (await call("GET", `/v1/learn/points/${CHOICE_ID}/detail`)).body
    .data;
  assert.equal(d.guest, false);
  assert.equal(d.id, CHOICE_ID);
  assert.ok(d.name && d.section && d.tier && d.why);
  assert.ok(blocksOk(d.intro));
  assert.equal(typeof d.introText, "string");
  assert.ok(d.formulas.length >= 1);
  for (const f of d.formulas) {
    assert.ok(f.tex && !f.tex.includes("$"));
    assert.ok(blocksOk(f.blocks));
    assert.ok(f.note);
    assert.ok(blocksOk(f.noteBlocks));
  }
  assert.equal(d.keys.length, 3);
  for (const k of d.keys) assert.ok(blocksOk(k.blocks));
  // The example: a bank problem with its answer and worked solution.
  assert.equal(d.example.problem.format, "choice");
  assert.ok(blocksOk(d.example.problem.blocks));
  assert.equal(d.example.solution.correct.options.length, 1);
  assert.ok(blocksOk(d.example.solution.correct.blocks));
  assert.ok(blocksOk(d.example.solution.explanation));
  for (const p of [...d.prereqs, ...d.followers])
    assert.deepEqual(Object.keys(p).sort(), ["chapterId", "id", "name", "state"]);
  assert.ok(d.prereqs.length >= 1 && d.followers.length >= 1);
  assert.equal(d.state, "none");
  assert.deepEqual(d.bank, {
    problems: BANK[CHOICE_ID]!.length,
    done: 0,
    correct: 0,
  });
  assert.equal(d.aiPractice, true);
  assert.equal(
    (await call("GET", "/v1/learn/points/nope/detail")).status,
    404,
  );

  // Public: no personal state or progress.
  const res = await app.inject({
    method: "GET",
    url: `/v1/learn/points/${CHOICE_ID}/detail/public?tone=dark`,
  });
  assert.equal(res.statusCode, 200);
  const g = res.json().data;
  assert.equal(g.guest, true);
  assert.equal(g.state, "none");
  assert.equal(g.bank.done, 0);
  assert.ok(g.prereqs.every((p: any) => p.state === "none"));
  assert.deepEqual(g.formulas.length, d.formulas.length);
});

test("practice and submit: next problem in order, verdict, answer and solution; counts by problem", async (t) => {
  const { login } = setup(t);
  const { call } = await login("owner");
  const url = `/v1/learn/points/${CHOICE_ID}`;
  const first = (await call("GET", `${url}/practice`)).body.data;
  assert.equal(first.mode, "normal");
  assert.equal(first.problem.index, 0);
  assert.equal(first.problem.total, BANK[CHOICE_ID]!.length);
  assert.equal(first.problem.format, "choice");
  assert.equal(first.problem.questions.length, 1);
  assert.deepEqual(
    first.problem.questions[0].options.map((o: any) => o.id),
    ["A", "B", "C", "D"],
  );
  for (const o of first.problem.questions[0].options) assert.ok(blocksOk(o.blocks));
  assert.ok(!JSON.stringify(first).includes('"answer"'));
  assert.equal(first.tries, 0);
  assert.equal(first.correct, false);

  const { right, wrong } = rightOf(CHOICE_ID, 0);
  // Invalid: an id that is no option, or no index.
  assert.equal(
    (await call("POST", `${url}/submit`, { answer: "E", index: 0 })).status,
    400,
  );
  assert.equal(
    (await call("POST", `${url}/submit`, { answer: right })).status,
    400,
  );
  const bad = await call("POST", `${url}/submit`, { answer: wrong, index: 0 });
  assert.equal(bad.status, 200);
  assert.equal(bad.body.data.verdict, "incorrect");
  assert.equal(bad.body.data.index, 0);
  assert.deepEqual(bad.body.data.solution.correct.options, [right]);
  assert.ok(blocksOk(bad.body.data.solution.correct.blocks));
  assert.ok(!("standard" in bad.body.data));
  const good = (await call("POST", `${url}/submit`, { answer: right, index: 0 }))
    .body.data;
  assert.equal(good.verdict, "correct");
  // A wrong choice the same day makes it practice, as on the point page.
  assert.equal(good.counted, "practice");

  const again = (await call("GET", `${url}/practice`)).body.data;
  assert.equal(again.problem.index, 1, "the first not yet done right");
  const zero = (await call("GET", `${url}/practice?index=0`)).body.data;
  assert.equal(zero.tries, 2);
  assert.equal(zero.correct, true);
  const next = (await call("GET", `${url}/practice?after=1`)).body.data;
  assert.equal(next.problem.index, 0);
  assert.equal((await call("GET", `${url}/practice?index=99`)).status, 400);

  // A fill-in: one blank; a typed number is judged as a rational.
  const fill = (await call("GET", `/v1/learn/points/${FILL_ID}/practice`)).body
    .data;
  assert.equal(fill.problem.format, "blanks");
  assert.deepEqual(fill.problem.blanks, [{ label: "", note: null }]);
  const lit = (
    await call("POST", `/v1/learn/points/${FILL_ID}/submit`, {
      answer: "0.5",
      index: 0,
    })
  ).body.data;
  assert.equal(lit.verdict, "correct");
  assert.equal(lit.counted, "lit");
  assert.equal(lit.solution.correct.options, null);
  // Something that is not a number: unsure, no answer shown.
  const unsure = (
    await call("POST", `/v1/learn/points/${FILL_ID}/submit`, {
      answer: "asdf",
      index: 1,
    })
  ).body.data;
  assert.equal(unsure.verdict, "unsure");
  assert.equal(unsure.solution, null);

  const bank = (await call("GET", "/v1/learn/bank")).body.data;
  const points = bank.chapters.flatMap((c: any) => c.points);
  const chain = points.find((p: any) => p.id === CHOICE_ID);
  assert.deepEqual([chain.done, chain.correct], [1, 1]);
  const rules = points.find((p: any) => p.id === FILL_ID);
  assert.deepEqual([rules.done, rules.correct, rules.state], [1, 1, "correct"]);
  const detail = (await call("GET", `/v1/learn/points/${FILL_ID}/detail`)).body
    .data;
  assert.equal(detail.state, "correct");
  assert.deepEqual(detail.bank.done, 1);
});

test("old point page APIs keep their shape and answer converted problems either way", async (t) => {
  const { login } = setup(t);
  const { call } = await login("owner");
  const point = (await call("GET", `/v1/learn/points/${CHOICE_ID}`)).body.data;
  assert.equal(point.problem.index, 0);
  assert.equal(point.problem.kind, "choice");
  assert.deepEqual(Object.keys(point.problem).sort(), [
    "blocks",
    "hasExplanation",
    "index",
    "kind",
    "questions",
    "text",
  ]);
  assert.equal(point.problem.questions.length, 1);
  assert.equal(point.problem.questions[0].prompt, "");
  assert.equal(point.problem.questions[0].options.length, 4);
  assert.ok(!("intro" in point) && !("example" in point));

  const { right, wrong } = rightOf(CHOICE_ID, 0);
  const url = `/v1/learn/points/${CHOICE_ID}/answer`;
  const no = (await call("POST", url, { answer: [wrong], index: 0 })).body.data;
  assert.equal(no.verdict, "incorrect");
  assert.ok(!("standard" in no) && !("solution" in no));
  assert.equal(no.items[0].label, "第1问");
  // A page opened before 0.6.0 sends the typed answer: judged as authored.
  const typed = (
    await call("POST", url, {
      answer: canonicalInput(PROBLEMS[CHOICE_ID]![0]!),
      index: 0,
    })
  ).body.data;
  assert.equal(typed.verdict, "correct");
  assert.equal(typed.items, undefined);
  const yes = (await call("POST", url, { answer: [right], index: 0 })).body
    .data;
  assert.equal(yes.verdict, "correct");
  assert.ok(yes.items[0].standard);
  assert.equal(
    (await call("POST", url, { answer: ["E"], index: 0 })).status,
    400,
  );
});

// “AI 再出一道”: the chapter practice with a point; a fake model.
function practiceApp(t: { after: (fn: () => Promise<void>) => void }) {
  const calls: { system: string; last: string }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      const q = body.questions.q;
      return new Response(
        JSON.stringify({
          answers: {
            q:
              q.type === "noul"
                ? { noul: 0.9 }
                : { choice: "derivative", confidence: 0.8, probabilities: { derivative: 0.8 } },
          },
        }),
      );
    }
    const system = String(body.messages[0].content);
    calls.push({ system, last: String(body.messages.at(-1).content) });
    const content = {
      question: String.raw`求函数 $y=\sin x^{2}$ 的导数。`,
      answer: String.raw`2x\cos x^{2}`,
      options: [
        String.raw`$\cos x^{2}$`,
        String.raw`$2x\cos x^{2}$`,
        String.raw`$-2x\cos x^{2}$`,
        String.raw`$2\cos x^{2}$`,
      ],
      correct: 1,
      steps: ["用链式法则", String.raw`$y'=2x\cos x^{2}$`],
      solution: String.raw`链式法则。

**答案**：$2x\cos x^{2}$`,
      checks: [
        { kind: "derivative", expr: "sin(x^2)", answer: "2*x*cos(x^2)" },
      ],
    };
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    );
  }) as typeof fetch;
  const app = buildApp({
    store: new SqliteStore(":memory:"),
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "v41-")),
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "v41-formula-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "test-llm",
      JEV_API_KEY: "test-jev",
    }),
    fetcher,
  });
  t.after(() => app.close());
  return { app, calls };
}

test("AI practice by point: made for the point, checked, choice options; does not count on the map", async (t) => {
  const { app, calls } = practiceApp(t);
  const token = (
    await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: {} })
  ).json().data.token as string;
  const headers = { authorization: `Bearer ${token}` };
  const post = (payload: unknown) =>
    app.inject({ method: "POST", url: "/v1/chat/practice", headers, payload: payload as string });
  assert.equal((await post({})).statusCode, 400);
  assert.equal(
    (await post({ chapter: "derivative", pointId: CHOICE_ID })).statusCode,
    400,
  );
  assert.equal((await post({ pointId: "nope" })).statusCode, 404);
  const refused = await post({ pointId: "limit-epsilon-n" });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().code, "BAD_POINT");

  const made = await post({ pointId: CHOICE_ID });
  assert.equal(made.statusCode, 200);
  const data = made.json().data;
  assert.equal(data.message.kind, "similar");
  assert.equal(data.message.practice, "derivative");
  assert.equal(data.message.practicePoint, CHOICE_ID);
  assert.equal(data.message.similar.verify.state, "pass");
  assert.equal(data.message.similar.options.length, 4);
  const prompt = calls.find((c) => c.system.includes("专项练"))!;
  assert.match(prompt.system, /专门练知识点"复合函数求导"/);
  assert.match(prompt.system, /用链式法则/);
  assert.match(prompt.last, /出一道"复合函数求导"的题/);

  // Answered right in the conversation: the map point stays as it was.
  const answered = await app.inject({
    method: "POST",
    url: `/v1/chat/messages/${data.message.id}/answer`,
    headers,
    payload: { answer: "2x\\cos x^2", clientId: "v41-practice-1" },
  });
  assert.equal(answered.statusCode, 200);
  assert.equal(answered.json().data.judge.attempt.result.verdict, "correct");
  const bank = (
    await app.inject({ method: "GET", url: "/v1/learn/bank", headers })
  ).json().data;
  const chain = bank.chapters
    .flatMap((c: any) => c.points)
    .find((p: any) => p.id === CHOICE_ID);
  assert.deepEqual([chain.state, chain.done, chain.correct], ["none", 0, 0]);
});

test("old point page APIs keep an authored choice problem as authored; the bank serves four options", async (t) => {
  const { login } = setup(t);
  const { call } = await login("owner");
  // A choice problem given a fourth option: the old page keeps its ids.
  const sketch = "application-sketch";
  const authored = PROBLEMS[sketch]![0]!;
  if (authored.kind !== "choice") throw new Error("choice fixture");
  const old = (await call("GET", `/v1/learn/points/${sketch}`)).body.data;
  assert.equal(old.problem.index, 0);
  assert.deepEqual(
    old.problem.questions.map((q: any) => q.options.map((o: any) => o.id)),
    authored.questions.map((q) => q.options.map((o) => o.id)),
  );
  const bankView = (await call("GET", `/v1/learn/points/${sketch}/practice?index=0`))
    .body.data;
  assert.ok(
    bankView.problem.questions.every((q: any) => q.options.length === 4),
  );
  const lit = (
    await call("POST", `/v1/learn/points/${sketch}/answer`, {
      answer: canonicalInput(authored),
      index: 0,
    })
  ).body.data;
  assert.equal(lit.verdict, "correct");
  assert.equal(lit.counted, "lit");

  // Two questions merged into one: the old page still answers both.
  const merged = "definite-improper-test";
  const pair = PROBLEMS[merged]![0]!;
  const two = (
    await call("POST", `/v1/learn/points/${merged}/answer`, {
      answer: canonicalInput(pair),
      index: 0,
    })
  ).body.data;
  assert.equal(two.verdict, "correct");
  const one = (await call("GET", `/v1/learn/points/${merged}/practice?index=0`))
    .body.data;
  assert.equal(one.problem.questions.length, 1);
  const served = BANK[merged]![0]!;
  if (served.kind !== "choice") throw new Error("merged fixture");
  const submitted = (
    await call("POST", `/v1/learn/points/${merged}/submit`, {
      answer: served.questions[0]!.answer,
      index: 0,
    })
  ).body.data;
  assert.equal(submitted.verdict, "correct");
});

test("the detail page's example answered the same day counts as practice; the next day it counts", async (t) => {
  const { login, clock, store } = setup(t);
  const { call, userId } = await login("owner");
  const d = (await call("GET", `/v1/learn/points/${CHOICE_ID}/detail`)).body
    .data;
  const index = d.example.problem.index;
  const { right } = rightOf(CHOICE_ID, index);
  const url = `/v1/learn/points/${CHOICE_ID}/submit`;
  // Opening the page alone records nothing; opening the solution does.
  const before = store.db
    .prepare("SELECT attempts FROM map_points WHERE user_id=? AND point_id=?")
    .get(userId, CHOICE_ID) as { attempts: string | null } | undefined;
  assert.ok(!before?.attempts?.includes("shownOn"));
  const shown = (
    await call("POST", `/v1/learn/points/${CHOICE_ID}/example-shown`)
  ).body.data;
  assert.equal(shown.index, index);
  const same = (await call("POST", url, { answer: right, index })).body.data;
  assert.equal(same.verdict, "correct");
  assert.equal(same.counted, "practice");
  assert.equal(same.practice, true);
  // The shown example is no attempt by itself.
  const bank = (await call("GET", "/v1/learn/bank")).body.data;
  const chain = bank.chapters
    .flatMap((c: any) => c.points)
    .find((p: any) => p.id === CHOICE_ID);
  assert.deepEqual([chain.done, chain.correct], [1, 1]);

  // Two signs in a row are no number: refused, nothing written.
  const malformed = await call("POST", `/v1/learn/points/${FILL_ID}/submit`, {
    answer: "--3",
    index: 0,
  });
  assert.deepEqual([malformed.status, malformed.body.code], [400, "VALIDATION_ERROR"]);
  assert.equal(
    store.db
      .prepare("SELECT COUNT(*) n FROM map_points WHERE user_id=? AND point_id=?")
      .get(userId, FILL_ID)!.n,
    0,
  );
  // A wrong typed answer on submit marks practice in the same write.
  const wrong = (
    await call("POST", `/v1/learn/points/${FILL_ID}/submit`, {
      answer: "3",
      index: 0,
    })
  ).body.data;
  assert.equal(wrong.verdict, "incorrect");
  assert.equal(wrong.practice, true);
  const row = store.db
    .prepare("SELECT practice_on FROM map_points WHERE user_id=? AND point_id=?")
    .get(userId, FILL_ID) as { practice_on: string };
  assert.ok(row.practice_on);

  // The next day, without opening the detail page again, it counts.
  clock.at = new Date(clock.at.getTime() + 86_400_000);
  const next = (await call("POST", url, { answer: right, index })).body.data;
  assert.equal(next.verdict, "correct");
  assert.notEqual(next.counted, "practice");
});

test("a review after the detail page's example takes another problem, the next time too; never the example while one is left", async (t) => {
  const { login, clock, store } = setup(t);
  const { call, userId } = await login("owner");
  assert.equal(BANK[CHOICE_ID]!.length, 2);
  const example = (await call("GET", `/v1/learn/points/${CHOICE_ID}/detail`)).body
    .data.example.problem.index;
  assert.equal(example, 1);
  const url = `/v1/learn/points/${CHOICE_ID}`;
  const lit = (
    await call("POST", `${url}/submit`, { answer: rightOf(CHOICE_ID, 0).right, index: 0 })
  ).body.data;
  assert.equal(lit.counted, "lit");
  const toDue = () => {
    const { due_on } = store.db
      .prepare("SELECT due_on FROM map_points WHERE user_id=? AND point_id=?")
      .get(userId, CHOICE_ID) as { due_on: string };
    clock.at = new Date(`${due_on}T04:00:00Z`);
  };
  toDue();
  // Never shown: the review is the second problem, as before.
  let practice = (await call("GET", `${url}/practice`)).body.data;
  assert.deepEqual([practice.mode, practice.problem.index], ["review", 1]);
  assert.equal((await call("GET", url)).body.data.problem.index, 1);
  // Its answer and solution seen: the review moves to the other problem,
  // which still earns the review the same day.
  assert.equal(
    (await call("POST", `${url}/example-shown`)).body.data.index,
    example,
  );
  practice = (await call("GET", `${url}/practice`)).body.data;
  assert.deepEqual([practice.mode, practice.problem.index], ["review", 0]);
  assert.equal((await call("GET", url)).body.data.problem.index, 0);
  const review = (
    await call("POST", `${url}/submit`, { answer: rightOf(CHOICE_ID, 0).right, index: 0 })
  ).body.data;
  assert.equal(review.counted, "review");
  // The next review, days later, still keeps off the example.
  toDue();
  practice = (await call("GET", `${url}/practice`)).body.data;
  assert.deepEqual([practice.mode, practice.problem.index], ["review", 0]);
  // A problem picked by index is answered as picked.
  assert.equal(
    (await call("GET", `${url}/practice?index=1`)).body.data.problem.index,
    1,
  );
});

test("a retest keeps off a problem shown as the example: chosen after it, or moved off it", async (t) => {
  const { login, clock, store } = setup(t);
  const url = `/v1/learn/points/${CHOICE_ID}`;
  const retestOf = (userId: string) =>
    store.db
      .prepare(
        "SELECT problem_index FROM retests WHERE user_id=? AND point_id=? AND done_at IS NULL",
      )
      .get(userId, CHOICE_ID) as { problem_index: number } | undefined;
  const { wrong, right } = rightOf(CHOICE_ID, 0);

  // Wrong first: the retest takes the other problem; opening the example
  // (that same problem) then moves it back to the one answered.
  const a = await login("a");
  await a.call("POST", `${url}/submit`, { answer: wrong, index: 0 });
  assert.equal(retestOf(a.userId)?.problem_index, 1);
  await a.call("POST", `${url}/example-shown`);
  assert.equal(retestOf(a.userId)?.problem_index, 0);

  // Example first: the retest repeats the answered problem.
  const b = await login("b");
  await b.call("POST", `${url}/example-shown`);
  await b.call("POST", `${url}/submit`, { answer: wrong, index: 0 });
  assert.equal(retestOf(b.userId)?.problem_index, 0);
  clock.at = new Date(clock.at.getTime() + 2 * 86_400_000);
  const due = (await b.call("GET", `${url}/practice`)).body.data;
  assert.deepEqual([due.mode, due.problem.index], ["retest", 0]);
  const done = (
    await b.call("POST", `${url}/submit`, { answer: right, index: 0 })
  ).body.data;
  assert.deepEqual([done.retest.result, done.retest.repeated], ["right", true]);
  assert.equal(done.counted, "lit");
});

test("admin: the bank as served, and each report with the problem it was judged against", async (t) => {
  const KEY = "synthetic-admin-key-for-isolated-tests-01";
  const app = buildApp({
    store: new SqliteStore(":memory:"),
    fetcher: fakeServices().fetcher,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "v41-admin-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "test-llm",
      JEV_API_KEY: "test-jev",
      ADMIN_API_KEY: KEY,
    }),
  });
  t.after(() => app.close());
  const token = (
    await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "a" } })
  ).json().data.token as string;
  const report = (id: string, payload: unknown) =>
    app.inject({
      method: "POST",
      url: `/v1/learn/points/${id}/report`,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as string,
    });
  const admin = async (url: string) =>
    (await app.inject({ method: "GET", url, headers: { "x-admin-key": KEY } })).json()
      .data;
  const typed = canonicalInput(PROBLEMS[CHOICE_ID]![0]!);
  assert.equal(
    (await report(CHOICE_ID, { reason: "judge", answer: typed, index: 0 })).statusCode,
    200,
  );
  const sketch = PROBLEMS["application-sketch"]![0]!;
  assert.equal(
    (
      await report("application-sketch", {
        reason: "judge",
        answer: canonicalInput(sketch),
        index: 0,
      })
    ).statusCode,
    200,
  );
  const { items } = await admin("/v1/admin/feedback");
  const byPoint = (id: string) => items.find((i: any) => i.pointId === id);
  assert.equal(byPoint(CHOICE_ID).problem.kind, PROBLEMS[CHOICE_ID]![0]!.kind);
  assert.equal(byPoint(CHOICE_ID).problem.answer, (PROBLEMS[CHOICE_ID]![0]! as any).answer);
  assert.deepEqual(
    byPoint("application-sketch").problem.questions.map((q: any) => q.options.length),
    sketch.kind === "choice" ? sketch.questions.map((q) => q.options.length) : [],
  );
  const bank = await admin("/v1/admin/bank");
  const chain = bank.points.find((p: any) => p.pointId === CHOICE_ID);
  assert.equal(chain.problems[0].kind, "choice");
  assert.equal(chain.problems[0].source.kind, PROBLEMS[CHOICE_ID]![0]!.kind);
});

test("0.6.0 reports answer the bank form: a fourth option and a merged question judge right; old reports keep the page form", async (t) => {
  const KEY = "synthetic-admin-key-for-isolated-tests-01";
  const store = new SqliteStore(":memory:");
  const app = buildApp({
    store,
    fetcher: fakeServices().fetcher,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "v41-report-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "test-llm",
      JEV_API_KEY: "test-jev",
      ADMIN_API_KEY: KEY,
    }),
  });
  t.after(() => app.close());
  const token = (
    await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "a" } })
  ).json().data.token as string;
  const report = (id: string, payload: unknown) =>
    app.inject({
      method: "POST",
      url: `/v1/learn/points/${id}/report`,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as string,
    });
  const rowOf = (id: string) => ({
    ...(store.db
      .prepare(
        "SELECT form,bank_index,problem_kind,answer_json,verdict FROM map_reports WHERE point_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(id) as Record<string, unknown>),
  });
  const rightIds = (id: string, index: number) => {
    const served = BANK[id]![index]!;
    if (served.kind !== "choice") throw new Error("choice fixture");
    return served.questions.map((q) => q.answer);
  };

  // A fourth option : "D" exists only in the bank form.
  const sketch = "application-sketch";
  const four = rightIds(sketch, 1);
  assert.ok(four.includes("D"));
  assert.equal(
    (await report(sketch, { reason: "judge", answer: four, index: 1 })).statusCode,
    400,
    "the page form has no option D",
  );
  assert.equal(
    (await report(sketch, { reason: "judge", answer: four, index: 1, form: "bank" }))
      .statusCode,
    200,
  );
  assert.deepEqual(rowOf(sketch), {
    form: "bank",
    bank_index: 1,
    problem_kind: "choice",
    answer_json: JSON.stringify(four),
    verdict: null,
  });

  // Two questions merged into one: the page sends one bare option id.
  const merged = "definite-improper-test";
  const [one] = rightIds(merged, 0);
  assert.equal(
    (await report(merged, { reason: "judge", answer: one, index: 0, form: "bank" }))
      .statusCode,
    200,
  );
  assert.deepEqual(rowOf(merged), {
    form: "bank",
    bank_index: 0,
    problem_kind: "choice",
    answer_json: JSON.stringify([one]),
    verdict: null,
  });

  // A bank fill-in: one blank as the number pad sends it, judged as served.
  assert.equal(
    (await report(FILL_ID, { reason: "judge", answer: ["2"], index: 0, form: "bank" }))
      .statusCode,
    200,
  );
  assert.equal(rowOf(FILL_ID).form, "bank");
  assert.ok(rowOf(FILL_ID).verdict);

  // The old page: the authored answer, no form.
  const authored = PROBLEMS[sketch]![1]!;
  assert.equal(
    (await report(sketch, { reason: "judge", answer: canonicalInput(authored), index: 1 }))
      .statusCode,
    200,
  );
  assert.equal(rowOf(sketch).form, null);
  assert.equal(
    (await report(sketch, { reason: "judge", index: 1, form: "page" })).statusCode,
    400,
  );

  // Admin: each report with the problem in the form the learner saw.
  const items = (
    await app.inject({
      method: "GET",
      url: `/v1/admin/feedback?point=${sketch}`,
      headers: { "x-admin-key": KEY },
    })
  ).json().data.items;
  const bankItem = items.find((i: any) => i.form === "bank");
  const pageItem = items.find((i: any) => i.form === null);
  assert.deepEqual(
    bankItem.problem.questions.map((q: any) => q.options.length),
    [4, 4],
  );
  assert.deepEqual(
    bankItem.problem.questions.map((q: any) => q.answer),
    four,
  );
  assert.deepEqual(
    pageItem.problem.questions.map((q: any) => q.options.length),
    authored.kind === "choice" ? authored.questions.map((q) => q.options.length) : [],
  );
});

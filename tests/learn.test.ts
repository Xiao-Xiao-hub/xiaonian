import test from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../server/src/shared/store.js";
import { addDays, chinaDate } from "../server/src/shared/time.js";
import { fakeServices, makeApp } from "./fixtures.js";
import { seedSample } from "./learn-sample.js";
import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";
import {
  cleanTex,
  dueOffset,
  LearnService,
  lightPoint,
} from "../server/src/modules/learn/service.js";
import { PROBLEMS } from "../server/src/modules/learn/problems.js";
import { canonicalInput } from "../server/src/modules/learn/answers.js";

// Exercise unavailable-content behavior with a controlled fixture, including
// when all real map points have been opened by later content releases.
async function withoutProblem<T>(
  id: string,
  run: () => Promise<T>,
): Promise<T> {
  const saved = PROBLEMS[id];
  delete PROBLEMS[id];
  try {
    return await run();
  } finally {
    if (saved) PROBLEMS[id] = saved;
  }
}

async function setup() {
  // 20:00 UTC on a Sunday is already Monday in China.
  const clock = { at: new Date("2026-10-04T20:00:00Z") };
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, () => clock.at, store);
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
  const today = () => chinaDate(clock.at.getTime());
  return { app, store, clock, login, today };
}

test("learn map: login required", async () => {
  const { app } = await setup();
  const res = await app.inject({ method: "GET", url: "/v1/learn/map" });
  assert.equal(res.statusCode, 401);
});

test("learn map: a new learner gets the whole map, untouched, with no problems or answers", async () => {
  const { login } = await setup();
  const { call } = await login("fresh");
  const { status, body, text } = await call("GET", "/v1/learn/map");
  assert.equal(status, 200);
  const { chapters, summary } = body.data;
  assert.equal(chapters.length, 6);
  assert.equal(
    chapters.reduce(
      (n: number, c: { points: unknown[] }) => n + c.points.length,
      0,
    ),
    89,
  );
  assert.deepEqual(Object.keys(chapters[0].points[0]).sort(), [
    "cards",
    "exam",
    "followers",
    "formulas",
    "hard",
    "id",
    "inferredBy",
    "key",
    "keys",
    "level",
    "line",
    "mistakeCount",
    "name",
    "pos",
    "prereqs",
    "ready",
    "red",
    "retest",
    "section",
    "short",
    "side",
    "state",
    "stateReason",
    "stuck",
    "stuckAt",
    "taught",
    "tier",
  ]);
  // ready follows the current content, independently of progress.
  const pointOf = (id: string) =>
    chapters
      .flatMap((c: { points: { id: string; ready: boolean }[] }) => c.points)
      .find((p: { id: string }) => p.id === id);
  assert.equal(pointOf("application-taylor-limit").ready, true);
  assert.equal(
    pointOf("application-sketch").ready,
    !!PROBLEMS["application-sketch"]?.length,
  );
  assert.ok(
    chapters.every(
      (c: { started: boolean; points: { state: string }[] }) =>
        !c.started && c.points.every((p) => p.state === "none"),
    ),
  );
  assert.equal(summary.correct, 0);
  assert.equal(summary.next.text, "开始第 1 章：极限");
  assert.equal(summary.cells, undefined);
  // Problems carry their answers in the source map; none of it goes out.
  assert.doesNotMatch(text, /答案|question|check|x\/\(1-x\)|1\/\(1\+x\)/);
});

test("learn map: the seeded sample comes back as the sketch shows it", async () => {
  const { login, store, today } = await setup();
  const { call, userId } = await login("owner");
  seedSample(store, userId, today());
  const { body } = await call("GET", "/v1/learn/map");
  const { chapters, summary } = body.data;
  assert.equal(summary.today, "2026-10-05");
  assert.equal(summary.correct, 27);
  assert.equal(summary.total, 89);
  assert.equal(summary.xp, 390);
  assert.equal(summary.level, 10);
  assert.equal(summary.levelXp, 66);
  assert.equal(summary.levelNeed, 76);
  assert.deepEqual(summary.week, { correct: 4, xp: 60 });
  assert.equal(summary.due, 2);
  assert.equal(summary.next.text, "中值与应用再做对 1 个重点，就升重点段");
  assert.deepEqual(summary.book, { rank: "起步", reached: 3, of: 6 });
  assert.deepEqual(
    summary.todayList.map((t: { name: string }) => t.name),
    ["等价无穷小替换", "复合函数求导", "最大值最小值应用题"],
  );
  assert.deepEqual(
    chapters.map(
      (c: { short: string; book: string; rank: string; started: boolean }) =>
        `${c.book} ${c.short} ${c.started ? c.rank : "还没开始"}`,
    ),
    [
      "第 1 章 极限 重点段",
      "第 2 章 导数 基础段",
      "第 3 章 中值与应用 基础段",
      "第 4 章 不定积分 还没开始",
      "第 5、6 章 定积分 还没开始",
      "第 7 章 微分方程 还没开始",
    ],
  );
  const states = chapters
    .flatMap((c: { points: { state: string }[] }) => c.points)
    .map((p: { state: string }) => p.state);
  for (const s of ["none", "seen", "self", "correct", "due"])
    assert.ok(states.includes(s), s);
  // 极限 set to 不学: out of the counts, the book rank and today's list; XP stays.
  store.db
    .prepare(
      "INSERT INTO map_chapters(user_id,chapter_id,hidden_at) VALUES(?,?,?)",
    )
    .run(userId, "limit", new Date().toISOString());
  const hidden = (await call("GET", "/v1/learn/map")).body.data;
  assert.equal(hidden.chapters[0].hidden, true);
  assert.equal(hidden.summary.correct, 15);
  assert.equal(hidden.summary.total, 72);
  assert.deepEqual(hidden.summary.book, { rank: "起步", reached: 2, of: 5 });
  assert.equal(hidden.summary.due, 1);
  assert.deepEqual(
    hidden.summary.todayList.map((t: { name: string }) => t.name),
    ["复合函数求导", "最大值最小值应用题"],
  );
  assert.equal(hidden.summary.xp, 390);
  // Another learner sees none of it.
  const other = await login("someone");
  assert.equal(
    (await other.call("GET", "/v1/learn/map")).body.data.summary.correct,
    0,
  );
});

test("learn map: deleting the account deletes the map rows", async () => {
  const { login, store, today } = await setup();
  const { call, userId } = await login("owner");
  seedSample(store, userId, today());
  store.db
    .prepare("INSERT INTO map_chapters VALUES(?,?,?)")
    .run(userId, "ode", new Date().toISOString());
  store.db
    .prepare(
      "INSERT INTO map_reports(id,user_id,point_id,reason,created_at) VALUES(?,?,?,?,?)",
    )
    .run("mrp_1", userId, "limit-function", "wrong", new Date().toISOString());
  const count = (table: string) =>
    (
      store.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`)
        .get(userId) as { n: number }
    ).n;
  assert.equal(count("map_points"), 34);
  assert.equal(count("map_chapters"), 1);
  assert.equal(count("map_reports"), 1);
  const res = await call("DELETE", "/v1/me", { confirm: true });
  assert.equal(res.status, 200);
  for (const table of ["map_points", "map_chapters", "map_reports"])
    assert.equal(count(table), 0, table);
});

// ---------- S2: point page, answers, marks ----------

const pointRow = (store: SqliteStore, userId: string, pointId: string) =>
  store.db
    .prepare("SELECT * FROM map_points WHERE user_id=? AND point_id=?")
    .get(userId, pointId) as Record<string, string | number | null> | undefined;
// 0.6.0 : a judged answer is counted in map_points.attempts for the
// 题库, which may create the row; no progress column changes.
const noProgress = (row: Record<string, unknown> | undefined) =>
  !row ||
  (!row.red &&
    [
      "correct_at",
      "self_at",
      "seen_at",
      "practice_on",
      "reviewed_on",
      "due_on",
      "interval",
      "stuck_at",
    ].every((name) => row[name] === null));
const daysBetween = (a: string, b: string) =>
  (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

test("learn reviews: 7, 21, 63, finish; no XP or first-correct changes", async () => {
  const { login, store, clock, today } = await setup();
  const { userId } = await login("review-cycle");
  const learn = new LearnService(store, () => clock.at);
  const id = "limit-equivalent";
  const first = learn.answer(userId, id, canonicalInput(PROBLEMS[id]![0]!), 0);
  assert.equal(first.counted, "lit");
  const original = pointRow(store, userId, id)!;
  for (const expected of [21, 63, null]) {
    clock.at = new Date(`${pointRow(store, userId, id)!.due_on}T04:00:00Z`);
    const page = learn.point(userId, id);
    assert.equal(page.review, true);
    const result = learn.answer(
      userId,
      id,
      canonicalInput(PROBLEMS[id]![page.problem!.index]!),
      page.problem!.index,
    );
    assert.equal(result.counted, "review");
    assert.deepEqual(result.review, { interval: expected });
    assert.equal(result.xp, 0);
    assert.equal(result.after.xp, first.after.xp);
    assert.deepEqual(result.after.book, first.after.book);
    const row = pointRow(store, userId, id)!;
    assert.equal(row.correct_at, original.correct_at);
    assert.equal(row.reviewed_on, today());
    assert.equal(
      row.due_on,
      expected === null ? null : addDays(today(), expected + dueOffset(id)),
    );
    assert.equal(learn.point(userId, id).state, "correct");
    assert.equal(
      result.after.todayList.find((entry) => entry.id === id)!.done,
      true,
    );
  }
  assert.equal(pointRow(store, userId, id)!.interval, 63);
  clock.at = new Date("2027-12-01T04:00:00Z");
  assert.equal(learn.point(userId, id).review, false);
  assert.equal(learn.point(userId, id).problem!.index, 0);
  assert.equal(
    learn.answer(userId, id, canonicalInput(PROBLEMS[id]![0]!)).counted,
    "again",
  );
});

test("learn reviews: unsure does not write; lapse finishes today, returns tomorrow, retry restarts at 7", async () => {
  const { login, store, clock, today } = await setup();
  const { userId } = await login("review-lapse");
  seedSample(store, userId, today());
  const learn = new LearnService(store, () => clock.at);
  const id = "limit-equivalent";
  const initial = { ...pointRow(store, userId, id)! };
  const unsure = learn.answer(userId, id, "不确定");
  assert.equal(unsure.counted, "none");
  assert.equal(unsure.verdict, "unsure");
  assert.deepEqual({ ...pointRow(store, userId, id) }, initial);
  const lapse = learn.answer(userId, id, "-999");
  assert.equal(lapse.counted, "lapse");
  assert.equal(
    lapse.after.todayList.find((entry) => entry.id === id)!.done,
    true,
  );
  assert.equal(
    lapse.before.todayList.find((entry) => entry.id === id)!.done,
    false,
  );
  assert.equal(pointRow(store, userId, id)!.due_on, addDays(today(), 1));
  assert.equal(pointRow(store, userId, id)!.interval, 0);
  assert.equal(learn.point(userId, id).state, "correct");
  clock.at = new Date(clock.at.getTime() + 86_400_000);
  assert.equal(learn.point(userId, id).state, "due");
  assert.equal(
    learn.summary(userId).todayList.find((entry) => entry.id === id)!.done,
    false,
  );
  // Lapse again; the same Beijing day cannot pass after the failed attempt.
  learn.answer(userId, id, "-999");
  const selected = learn.point(userId, id).problem!.index;
  const retry = learn.answer(
    userId,
    id,
    canonicalInput(PROBLEMS[id]![selected]!),
    selected,
  );
  assert.equal(retry.counted, "lapse");
  clock.at = new Date(clock.at.getTime() + 86_400_000);
  const passed = learn.answer(
    userId,
    id,
    canonicalInput(PROBLEMS[id]![selected]!),
    selected,
  );
  assert.deepEqual(passed.review, { interval: 7 });
  assert.equal(pointRow(store, userId, id)!.correct_at, initial.correct_at);
  assert.equal(passed.after.xp, lapse.before.xp);
  assert.equal(passed.after.due, lapse.before.due - 1);
});

test("learn reviews: displayed index survives midnight and another device's review", async () => {
  const { login, store, clock, today } = await setup();
  const { userId } = await login("review-midnight");
  const learn = new LearnService(store, () => clock.at);
  const id = "limit-equivalent";
  learn.answer(userId, id, canonicalInput(PROBLEMS[id]![0]!), 0);
  store.db
    .prepare("UPDATE map_points SET due_on=? WHERE user_id=? AND point_id=?")
    .run(addDays(today(), 1), userId, id);
  const beforeMidnight = learn.point(userId, id);
  assert.equal(beforeMidnight.problem!.index, 0);
  clock.at = new Date(clock.at.getTime() + 86_400_000);
  assert.equal(
    learn.answer(userId, id, canonicalInput(PROBLEMS[id]![0]!), 0).counted,
    "review",
  );
  assert.equal(
    learn.answer(userId, id, canonicalInput(PROBLEMS[id]![0]!), 0).counted,
    "again",
  );
  assert.equal(pointRow(store, userId, id)!.interval, 21);
});

test("learn reviews: a request uses one date snapshot and rechecks concurrent progress", async () => {
  const { login, store, today } = await setup();
  const { userId } = await login("review-snapshot");
  seedSample(store, userId, today());
  const id = "limit-equivalent";
  const midnight = [
    new Date("2026-10-05T15:59:59.999Z"),
    new Date("2026-10-05T16:00:00.001Z"),
  ];
  store.db
    .prepare("UPDATE map_points SET due_on=? WHERE user_id=? AND point_id=?")
    .run("2026-10-06", userId, id);
  let reads = 0;
  const changing = new LearnService(
    store,
    () => midnight[Math.min(reads++, 1)]!,
  );
  const page = changing.point(userId, id);
  assert.equal(reads, 1);
  assert.equal(page.state, "correct");
  assert.equal(page.review, false);
  assert.equal(page.problem!.index, 0);
  reads = 0;
  const result = changing.answer(
    userId,
    id,
    canonicalInput(PROBLEMS[id]![0]!),
    0,
  );
  assert.equal(reads, 2); // One date for selection, one for the transaction.
  assert.equal(result.counted, "review");
  assert.equal(result.before.today, "2026-10-06");
  assert.equal(result.after.today, result.before.today);
  assert.equal(pointRow(store, userId, id)!.reviewed_on, result.after.today);

  const stable = new LearnService(store, () => midnight[1]!);
  store.db
    .prepare(
      "UPDATE map_points SET due_on=?,interval=7 WHERE user_id=? AND point_id=?",
    )
    .run("2026-10-06", userId, id);
  const selected = stable.point(userId, id).problem!.index;
  const transaction = store.transaction.bind(store);
  let injectOtherDevice = true;
  store.transaction = ((fn: () => unknown) => {
    if (injectOtherDevice) {
      injectOtherDevice = false;
      stable.answer(userId, id, canonicalInput(PROBLEMS[id]![0]!), 0);
    }
    return transaction(fn);
  }) as typeof store.transaction;
  try {
    const duplicate = stable.answer(
      userId,
      id,
      canonicalInput(PROBLEMS[id]![selected]!),
      selected,
    );
    assert.equal(duplicate.counted, "again");
    assert.equal(duplicate.review, undefined);
    assert.equal(pointRow(store, userId, id)!.interval, 21);
    assert.deepEqual(duplicate.before, duplicate.after);
  } finally {
    store.transaction = transaction;
  }
});

test("learn reviews: hidden chapter still reviews and exports reviewed_on without joining today's list", async () => {
  const { login, store, today } = await setup();
  const { userId, call } = await login("hidden-review");
  seedSample(store, userId, today());
  const learn = new LearnService(store, () => new Date("2026-10-04T20:00:00Z"));
  learn.chapter(userId, "hide", "limit");
  const page = learn.point(userId, "limit-equivalent");
  assert.equal(page.review, true);
  const result = learn.answer(
    userId,
    page.id,
    canonicalInput(PROBLEMS[page.id]![page.problem!.index]!),
    page.problem!.index,
  );
  assert.equal(result.counted, "review");
  assert.ok(
    result.after.todayList.every((entry) => entry.chapterId !== "limit"),
  );
  const exported = await call("GET", "/v1/me/export");
  assert.equal(exported.status, 200);
  assert.match(exported.text, /reviewedOn/);
  assert.match(exported.text, new RegExp(today()));
});

test("learn review indices: selection, feedback, fallback, strict schema and missing problem", async () => {
  const { login, store, today } = await setup();
  const { userId, call } = await login("review-indices");
  seedSample(store, userId, today());
  const id = "limit-equivalent";
  const base = `/v1/learn/points/${id}`;
  const original = PROBLEMS[id]!;
  // Inject a distinct, small synthetic problem to test the contract independently
  // of how many reviewed content variants have been approved for production.
  PROBLEMS[id] = [
    original[0]!,
    { kind: "number", text: "计算 $2+2$。", answer: "4" },
  ];
  try {
    const page = (await call("GET", base)).body.data;
    assert.equal(page.review, true);
    assert.equal(page.problem.index, 1);
    assert.equal(page.problem.text, "计算 $2+2$。");
    assert.equal(
      (
        await call("POST", `${base}/report`, {
          reason: "judge",
          answer: "4",
          index: 1,
        })
      ).status,
      200,
    );
    const report = store.db
      .prepare("SELECT verdict FROM map_reports WHERE user_id=?")
      .get(userId)!;
    assert.equal(report.verdict, "correct");
    assert.equal(
      (await call("POST", `${base}/answer`, { answer: "4" })).body.data.counted,
      "review",
    );
    assert.equal((await call("GET", base)).body.data.problem.index, 0);
    for (const path of ["answer", "report"]) {
      const body = path === "answer" ? { answer: "4" } : { reason: "judge" };
      for (const index of [-1, 2, 0.5, "1"])
        assert.equal(
          (await call("POST", `${base}/${path}`, { ...body, index })).status,
          400,
        );
      assert.equal(
        (await call("POST", `${base}/${path}`, { ...body, extra: true }))
          .status,
        400,
      );
    }
    PROBLEMS[id] = [original[0]!];
    store.db
      .prepare("UPDATE map_points SET due_on=? WHERE user_id=? AND point_id=?")
      .run(today(), userId, id);
    assert.equal((await call("GET", base)).body.data.problem.index, 0);
    assert.equal(
      (await call("POST", `${base}/answer`, { answer: "4", index: 1 })).status,
      400,
    );
    assert.equal(
      (await call("POST", `${base}/report`, { reason: "judge", index: 1 }))
        .status,
      400,
    );
    assert.equal(
      (
        await call("POST", `${base}/answer`, {
          answer: canonicalInput(original[0]!),
        })
      ).body.data.counted,
      "review",
    );
  } finally {
    PROBLEMS[id] = original;
  }
});

test("learn point: the page has no answer and no why text", async () => {
  const { login } = await setup();
  const { call } = await login("owner");
  const res = await call("GET", "/v1/learn/points/indefinite-parts?tone=dark");
  assert.equal(res.status, 200);
  const p = res.body.data;
  assert.deepEqual(Object.keys(p).sort(), [
    "chapter",
    "correct",
    "exam",
    "formulaBlocks",
    "formulas",
    "hard",
    "id",
    "key",
    "keyBlocks",
    "keys",
    "kpFormulaBlocks",
    "level",
    "line",
    "mode",
    "name",
    "pos",
    "practice",
    "prereqs",
    "problem",
    "red",
    "retest",
    "review",
    "section",
    "self",
    "short",
    "side",
    "state",
    "stuck",
    "stuckAt",
    "taught",
    "tier",
    "xp",
  ]);
  assert.equal(p.tier, "重点");
  assert.equal(p.xp, 20);
  assert.deepEqual(p.chapter, {
    id: "indefinite",
    short: "不定积分",
    label: p.chapter.label,
    book: "第 4 章",
  });
  assert.equal(p.state, "none");
  assert.equal(p.correct, false);
  assert.equal(p.practice, false);
  assert.equal(p.self, false);
  for (const q of p.prereqs)
    assert.deepEqual(Object.keys(q).sort(), ["id", "name", "state", "tier"]);
  // 0.6.0 : an antiderivative is served as single choice, in the
  // choice shape the page already had, with its solution kept for later.
  assert.deepEqual(Object.keys(p.problem).sort(), [
    "blocks",
    "hasExplanation",
    "index",
    "kind",
    "questions",
    "text",
  ]);
  assert.equal(p.problem.kind, "choice");
  assert.equal(p.problem.questions.length, 1);
  for (const q of p.problem.questions) {
    assert.deepEqual(Object.keys(q).sort(), ["blocks", "options", "prompt"]);
    assert.deepEqual(
      q.options.map((o: { id: string }) => o.id),
      ["A", "B", "C", "D"],
    );
  }
  assert.equal("aiDrafted" in p.problem, false);
  assert.ok(p.problem.blocks.length > 0);
  assert.ok(!res.text.includes('"answer"'));
  assert.ok(!res.text.includes('"standard"'));
  assert.ok(!res.text.includes('"why"'));
  // A point without a problem yet.
  const bare = await withoutProblem(
    "limit-function",
    async () =>
      (await call("GET", "/v1/learn/points/limit-function")).body.data,
  );
  assert.equal(bare.problem, null);
  assert.deepEqual(bare.prereqs, []);
  assert.equal((await call("GET", "/v1/learn/points/nope")).status, 404);
});

test("learn answer: 404, 409 and validation", async () => {
  const { app, login } = await setup();
  const { call } = await login("owner");
  const unauth = await app.inject({
    method: "POST",
    url: "/v1/learn/points/limit-rules/answer",
    payload: { answer: "1/2" },
  });
  assert.equal(unauth.statusCode, 401);
  assert.equal(
    (await call("POST", "/v1/learn/points/nope/answer", { answer: "1" }))
      .status,
    404,
  );
  const none = await withoutProblem("limit-function", () =>
    call("POST", "/v1/learn/points/limit-function/answer", {
      answer: "1",
    }),
  );
  assert.equal(none.status, 409);
  assert.equal(none.body.code, "NO_PROBLEM");
  assert.equal(none.body.message, "题还在出，稍等");
  for (const payload of [
    {},
    { answer: "" },
    { answer: "x".repeat(201) },
    { answer: "1", extra: 1 },
    { answer: 1 },
    { answer: "1", tone: "blue" },
  ])
    assert.equal(
      (await call("POST", "/v1/learn/points/limit-rules/answer", payload))
        .status,
      400,
      JSON.stringify(payload),
    );
});

test("learn answer: a wrong or unsure answer changes nothing and shows no answer", async () => {
  const { login, store } = await setup();
  const { call, userId } = await login("owner");
  for (const [answer, verdict] of [
    ["1/3", "incorrect"],
    ["asdf", "unsure"],
    ["0.5", "correct"],
  ] as const) {
    const res = await call("POST", "/v1/learn/points/limit-rules/answer", {
      answer,
      index: 0,
    });
    assert.equal(res.status, 200);
    const d = res.body.data;
    if (verdict === "correct") {
      // 0.5 is exactly 1/2.
      assert.equal(d.verdict, "correct");
      continue;
    }
    assert.equal(d.verdict, verdict, answer);
    assert.equal(d.counted, "none");
    assert.equal(d.xp, 0);
    assert.ok(!("standard" in d));
    assert.ok(!res.text.includes('"answer"'));
    assert.ok(!res.text.includes('"standard"'));
    assert.deepEqual(d.before, d.after);
    assert.ok(noProgress(pointRow(store, userId, "limit-rules")));
  }
});

test("learn answer: a correct answer lights the point once, due 5–9 days later", async () => {
  const { login, store, clock, today } = await setup();
  const { call, userId } = await login("owner");
  const url = "/v1/learn/points/indefinite-parts/answer";
  const right = "(x^2+1)/2*arctan(x) - x/2 + C";
  const first = await call("POST", url, { answer: right, tone: "dark" });
  assert.equal(first.status, 200);
  const d = first.body.data;
  assert.equal(d.verdict, "correct");
  assert.equal(d.reason, null);
  assert.equal(d.counted, "lit");
  assert.equal(d.xp, 20);
  assert.ok(Array.isArray(d.standard) && d.standard.length > 0);
  assert.ok(Array.isArray(d.read) && d.read.length > 0);
  assert.equal(d.before.xp, 0);
  assert.equal(d.after.xp, 20);
  assert.equal(d.after.level, 3);
  assert.equal(d.after.cells, undefined);
  assert.equal(
    d.after.chapters.find((c: { id: string }) => c.id === "indefinite").done,
    1,
  );
  assert.deepEqual(d.next, {
    id: "indefinite-rational",
    name: d.next.name,
    tier: "重点",
  });
  const row = pointRow(store, userId, "indefinite-parts")!;
  assert.equal(row.correct_at, clock.at.toISOString());
  assert.equal(row.interval, 7);
  const gap = daysBetween(today(), String(row.due_on));
  assert.equal(gap, 7 + dueOffset("indefinite-parts"));
  assert.ok(gap >= 5 && gap <= 9, String(gap));
  // The offsets spread over all five days, the same every time.
  const offsets = CALC_MAP.chapters.flatMap((c) =>
    c.points.map((p) => dueOffset(p.id)),
  );
  assert.deepEqual([...new Set(offsets)].sort(), [-1, -2, 0, 1, 2]);
  // Again: no write, no XP; the first-correct time stays.
  clock.at = new Date(clock.at.getTime() + 86_400_000);
  const again = (await call("POST", url, { answer: right })).body.data;
  assert.equal(again.counted, "again");
  assert.equal(again.xp, 0);
  assert.equal(again.after.xp, 20);
  assert.ok(Array.isArray(again.standard));
  assert.equal(
    pointRow(store, userId, "indefinite-parts")!.correct_at,
    row.correct_at,
  );
  // The point page now says done.
  const page = (await call("GET", "/v1/learn/points/indefinite-parts")).body
    .data;
  assert.equal(page.correct, true);
  assert.equal(page.state, "correct");
  // Missing + C: unsure, nothing counted, no standard.
  const noC = await call("POST", "/v1/learn/points/indefinite-basic/answer", {
    answer: "x^3/3 - x + arctan(x)",
  });
  assert.equal(noC.body.data.verdict, "unsure");
  assert.equal(noC.body.data.reason, "missing-c");
  assert.ok(!noC.text.includes('"standard"'));
});

test("learn answer: a double submit and two concurrent submits add XP once", async () => {
  const { login, store } = await setup();
  const { call, userId } = await login("owner");
  const url = "/v1/learn/points/limit-squeeze/answer";
  const [a, b] = await Promise.all([
    call("POST", url, { answer: "1" }),
    call("POST", url, { answer: "1" }),
  ]);
  assert.deepEqual([a.body.data.counted, b.body.data.counted].sort(), [
    "again",
    "lit",
  ]);
  const third = (await call("POST", url, { answer: "1" })).body.data;
  assert.equal(third.counted, "again");
  assert.equal(third.after.xp, 30);
  const map = (await call("GET", "/v1/learn/map")).body.data;
  assert.equal(map.summary.xp, 30);
  assert.equal(map.summary.correct, 1);
  // answer() runs synchronously, so the two requests above run one after the
  // other and the second one reads the first one's write. A write that would
  // race past that read still goes through the service's own upsert, whose
  // guard keeps the first time:
  const first = pointRow(store, userId, "limit-squeeze")!;
  assert.equal(
    lightPoint(
      store.db,
      userId,
      "limit-squeeze",
      "2030-01-01T00:00:00.000Z",
      "2030-01-08",
      7,
    ),
    false,
  );
  assert.deepEqual(pointRow(store, userId, "limit-squeeze"), first);
  // and on a row without a correct time (only 看过) it writes.
  await call("POST", "/v1/learn/marks", {
    action: "seen",
    pointId: "limit-rules",
  });
  assert.equal(
    lightPoint(
      store.db,
      userId,
      "limit-rules",
      "2030-01-01T00:00:00.000Z",
      "2030-01-08",
      7,
    ),
    true,
  );
  assert.equal(
    pointRow(store, userId, "limit-rules")!.correct_at,
    "2030-01-01T00:00:00.000Z",
  );
});

test("learn answer: standard and read are shown as the Lit board writes them (D5)", () => {
  assert.equal(cleanTex("\\frac{-1}{12}"), "-\\frac{1}{12}");
  assert.equal(cleanTex("x-\\frac{-1}{2}"), "x+\\frac{1}{2}");
  assert.equal(
    cleanTex("3.136\\cdot10^{+5}\\cdot\\pi"),
    "3.136\\cdot10^{5}\\cdot\\pi",
  );
  const store = new SqliteStore(":memory:");
  store.db
    .prepare("INSERT INTO users(id,openid,data) VALUES(?,?,?)")
    .run("u1", "o1", "{}");
  const learn = new LearnService(store, () => new Date("2026-10-04T20:00:00Z"));
  const taylor = learn.answer("u1", "application-taylor-limit", "-1/12");
  assert.equal(taylor.standard, "-\\frac{1}{12}");
  assert.equal(taylor.read, "-\\frac{1}{12}");
  const physics = learn.answer("u1", "definite-physics", "313600π");
  assert.equal(physics.standard, "3.136\\cdot10^{5}\\cdot\\pi");
  assert.doesNotMatch(physics.read!, /\^\{\+/);
  const e = learn.answer(
    "u1",
    "limit-1-to-inf",
    canonicalInput(PROBLEMS["limit-1-to-inf"]![0]!),
  );
  assert.match(e.standard!, /\^\{\\left\(-\\frac\{1\}\{2\}\\right\)\}/);
  // arctan as the textbook writes it, not tan^{-1}
  const parts = learn.answer(
    "u1",
    "indefinite-parts",
    "(x^2+1)/2*arctan(x) - x/2 + C",
  );
  assert.match(parts.standard!, /\\arctan/);
  assert.doesNotMatch(parts.standard! + parts.read!, /\^\{-1\}/);
});

test("learn answer: after 看过解析 today a correct answer is practice only", async () => {
  const { login, store, today, clock } = await setup();
  const { call, userId } = await login("owner");
  store.db
    .prepare(
      "INSERT INTO map_points(user_id,point_id,practice_on,updated_at) VALUES(?,?,?,?)",
    )
    .run(userId, "limit-rules", today(), new Date().toISOString());
  const url = "/v1/learn/points/limit-rules/answer";
  assert.equal(
    (await call("GET", "/v1/learn/points/limit-rules")).body.data.practice,
    true,
  );
  const d = (await call("POST", url, { answer: "1/2" })).body.data;
  assert.equal(d.verdict, "correct");
  assert.equal(d.counted, "practice");
  assert.equal(d.xp, 0);
  assert.equal(d.after.xp, 0);
  assert.equal(pointRow(store, userId, "limit-rules")!.correct_at, null);
  // The next day it lights.
  clock.at = new Date(clock.at.getTime() + 86_400_000);
  const next = (await call("POST", url, { answer: "1/2" })).body.data;
  assert.equal(next.counted, "lit");
  assert.equal(next.xp, 10);
});

test("learn marks: seen once, self unless done, unself", async () => {
  const { login, store, clock } = await setup();
  const { call, userId } = await login("owner");
  const mark = (action: string, pointId: string) =>
    call("POST", "/v1/learn/marks", { action, pointId });
  const seen = await mark("seen", "limit-rules");
  assert.equal(seen.status, 200);
  assert.equal(seen.body.data.state, "seen");
  assert.equal(seen.body.data.summary.cells, undefined);
  assert.equal(seen.body.data.summary.chapters[0].started, true);
  const firstSeen = pointRow(store, userId, "limit-rules")!.seen_at;
  clock.at = new Date(clock.at.getTime() + 3_600_000);
  await mark("seen", "limit-rules");
  assert.equal(pointRow(store, userId, "limit-rules")!.seen_at, firstSeen);
  const self = (await mark("self", "limit-rules")).body.data;
  assert.equal(self.state, "self");
  assert.equal(self.summary.chapters[0].self, 1);
  const page = (await call("GET", "/v1/learn/points/limit-rules")).body.data;
  assert.equal(page.self, true);
  assert.equal(page.state, "self");
  // The next point skips self-assessed points.
  const lit = (
    await call("POST", "/v1/learn/points/limit-continuity/answer", {
      answer: "1/2",
    })
  ).body.data;
  assert.equal(lit.next.id, "limit-discontinuity");
  assert.notEqual(lit.next.id, "limit-rules");
  assert.equal((await mark("unself", "limit-rules")).body.data.state, "seen");
  assert.equal(pointRow(store, userId, "limit-rules")!.self_at, null);
  // A point already done stays done.
  const done = (await mark("self", "limit-continuity")).body.data;
  assert.equal(done.state, "correct");
  assert.equal(pointRow(store, userId, "limit-continuity")!.self_at, null);
  // Self-assessed, then done: solid, with XP.
  await mark("self", "limit-squeeze");
  const after = (
    await call("POST", "/v1/learn/points/limit-squeeze/answer", { answer: "1" })
  ).body.data;
  assert.equal(after.counted, "lit");
  assert.equal(after.xp, 30);
  // Unself on an untouched point writes nothing.
  assert.equal((await mark("unself", "ode-concept")).body.data.state, "none");
  assert.equal(pointRow(store, userId, "ode-concept"), undefined);
  // Validation.
  assert.equal((await mark("seen", "nope")).status, 404);
  for (const payload of [
    { action: "hide", pointId: "limit-rules" },
    { action: "seen" },
    { action: "seen", pointId: "limit-rules", extra: 1 },
    { action: "seen", pointId: "" },
  ])
    assert.equal(
      (await call("POST", "/v1/learn/marks", payload)).status,
      400,
      JSON.stringify(payload),
    );
});

test("learn export: the map rows are in the export", async () => {
  const { login, store } = await setup();
  const { call, userId } = await login("owner");
  await call("POST", "/v1/learn/points/limit-rules/answer", { answer: "1/2" });
  await call("POST", "/v1/learn/marks", {
    action: "self",
    pointId: "limit-order",
  });
  store.db
    .prepare("INSERT INTO map_chapters VALUES(?,?,?)")
    .run(userId, "ode", "2026-10-01T00:00:00.000Z");
  store.db
    .prepare(
      "INSERT INTO map_reports(id,user_id,point_id,reason,created_at) VALUES(?,?,?,?,?)",
    )
    .run("mrp_1", userId, "limit-rules", "wrong", "2026-10-01T00:00:00.000Z");
  const res = await call("GET", "/v1/me/export");
  assert.equal(res.status, 200);
  const { learn } = res.body;
  assert.deepEqual(
    learn.points.map((p: { pointId: string }) => p.pointId),
    ["limit-order", "limit-rules"],
  );
  const rules = learn.points[1];
  assert.equal(rules.interval, 7);
  assert.ok(rules.correctAt && rules.dueOn);
  assert.equal(rules.red, false);
  assert.ok(learn.points[0].selfAt);
  assert.deepEqual(learn.hiddenChapters, [
    { chapterId: "ode", hiddenAt: "2026-10-01T00:00:00.000Z" },
  ]);
  assert.equal(learn.reports.length, 1);
  assert.equal(learn.reports[0].pointId, "limit-rules");
  assert.equal(learn.reports[0].reason, "wrong");
});

test("learn answer: the sketch sample plus -1/12 on 泰勒公式求极限 gives the Lit board", async () => {
  const { login, store, today } = await setup();
  const { call, userId } = await login("owner");
  seedSample(store, userId, today());
  const res = await call(
    "POST",
    "/v1/learn/points/application-taylor-limit/answer",
    { answer: "-1/12" },
  );
  const d = res.body.data;
  assert.equal(d.verdict, "correct");
  assert.equal(d.counted, "lit");
  assert.equal(d.xp, 20);
  assert.equal(d.before.xp, 390);
  assert.equal(d.before.level, 10);
  assert.equal(d.after.xp, 410);
  assert.equal(d.after.level, 11);
  assert.equal(d.after.levelXp, 10);
  assert.equal(d.after.levelNeed, 84);
  assert.equal(d.after.correct, 28);
  assert.equal(d.after.total, 89);
  const rank = (s: { chapters: { id: string; rank: string }[] }) =>
    s.chapters.find((c) => c.id === "application")!.rank;
  assert.equal(rank(d.before), "基础段");
  assert.equal(rank(d.after), "重点段");
  const tier = d.after.chapters
    .find((c: { id: string }) => c.id === "application")
    .tiers.find((t: { tier: string }) => t.tier === "重点");
  assert.deepEqual([tier.done, tier.total, tier.need], [5, 6, 5]);
  assert.deepEqual(d.next, {
    id: "application-taylor-remainder",
    name: "泰勒余项与误差估计",
    tier: "难点",
  });
  // The completed point stays in today's new slot; next allows extra practice.
  assert.equal(
    d.after.todayList.find((t: { kind: string }) => t.kind === "new").id,
    "application-taylor-limit",
  );
});

test("learn map: a new learner's point for today has a problem", async () => {
  const { login } = await setup();
  const { call } = await login("fresh");
  const { todayList } = (await call("GET", "/v1/learn/map")).body.data.summary;
  assert.equal(todayList.length, 1);
  assert.ok(PROBLEMS[todayList[0].id], todayList[0].id);
});

// ---------- S4: chapter actions, up, 这题有问题 ----------

const chapterOf = (
  s: { chapters: { id: string }[] },
  id: string,
): Record<string, any> => s.chapters.find((c) => c.id === id)!;

test("learn map: each chapter carries up, in the map and in the brief summaries", async () => {
  const { login, store, today } = await setup();
  const { call, userId } = await login("owner");
  seedSample(store, userId, today());
  const { chapters } = (await call("GET", "/v1/learn/map")).body.data;
  assert.deepEqual(chapterOf({ chapters }, "application").up, {
    rank: "重点段",
    tier: "重点",
    gap: 1,
    ids: ["application-taylor-limit", "application-sketch"],
    selfOnly: false,
    skip: [],
  });
  assert.deepEqual(chapterOf({ chapters }, "derivative").up.skip, ["难点"]);
  const d = (
    await call("POST", "/v1/learn/points/application-taylor-limit/answer", {
      answer: "-1/12",
    })
  ).body.data;
  assert.equal(chapterOf(d.before, "application").up.rank, "重点段");
  assert.deepEqual(chapterOf(d.after, "application").up, {
    rank: "难点段",
    tier: "难点",
    gap: 4,
    ids: [
      "application-mvt-proof",
      "application-cauchy",
      "application-taylor-remainder",
      "application-inequality",
      "application-root-count",
    ],
    selfOnly: false,
    skip: [],
  });
  const marked = (
    await call("POST", "/v1/learn/marks", {
      action: "seen",
      pointId: "ode-concept",
    })
  ).body.data;
  assert.equal(chapterOf(marked.summary, "ode").up.tier, "基础");
});

test("learn marks: selfRest and unselfRest cover the chapter, never a done point", async () => {
  const { login, store, today } = await setup();
  const { call, userId } = await login("owner");
  seedSample(store, userId, today());
  const act = (action: string, chapterId: string) =>
    call("POST", "/v1/learn/marks", { action, chapterId });
  const before = (await call("GET", "/v1/learn/map")).body.data;
  const application = chapterOf(before, "application");
  const doneIds = application.points
    .filter(
      (p: { state: string }) => p.state === "correct" || p.state === "due",
    )
    .map((p: { id: string }) => p.id);
  const doneRows = doneIds.map((id: string) => pointRow(store, userId, id));
  // 19 points: 9 done, 1 self-assessed → 9 change (the board's 其余 9 个).
  const rest = await act("selfRest", "application");
  assert.equal(rest.status, 200);
  assert.equal(rest.body.data.changed, 9);
  assert.deepEqual(Object.keys(rest.body.data).sort(), ["changed", "summary"]);
  const after = (await call("GET", "/v1/learn/map")).body.data;
  const states = chapterOf(after, "application").points.map(
    (p: { state: string }) => p.state,
  );
  assert.ok(states.every((s: string) => s === "self" || s === "correct"));
  assert.equal(states.filter((s: string) => s === "self").length, 10);
  // Done points untouched, other chapters untouched, no XP.
  assert.deepEqual(
    doneIds.map((id: string) => pointRow(store, userId, id)),
    doneRows,
  );
  assert.equal(after.summary.xp, 390);
  assert.equal(after.summary.correct, 27);
  assert.equal(chapterOf(after, "limit").self, chapterOf(before, "limit").self);
  // 中值与应用 is now held only by self-assessed points.
  const up = chapterOf(rest.body.data.summary, "application").up;
  assert.equal(up.selfOnly, true);
  assert.equal(
    rest.body.data.summary.next.text,
    "中值与应用还差的 1 个重点你标了会，做对就升重点段",
  );
  // Again: nothing left to mark.
  assert.equal((await act("selfRest", "application")).body.data.changed, 0);
  // A point done after selfRest: solid; unselfRest leaves it alone.
  const lit = (
    await call("POST", "/v1/learn/points/application-taylor-limit/answer", {
      answer: "-1/12",
    })
  ).body.data;
  assert.equal(lit.counted, "lit");
  const taylorSelf = pointRow(
    store,
    userId,
    "application-taylor-limit",
  )!.self_at;
  const un = await act("unselfRest", "application");
  assert.equal(un.body.data.changed, 9);
  const cleared = (await call("GET", "/v1/learn/map")).body.data;
  assert.equal(chapterOf(cleared, "application").self, 0);
  assert.equal(
    pointRow(store, userId, "application-taylor-limit")!.self_at,
    taylorSelf,
  );
  assert.equal(chapterOf(cleared, "application").done, 10);
  // Points that were only self-assessed and never seen go back to none.
  assert.equal(
    cleared.chapters
      .find((c: { id: string }) => c.id === "application")
      .points.find((p: { id: string }) => p.id === "application-curvature")
      .state,
    "none",
  );
  assert.equal((await act("unselfRest", "application")).body.data.changed, 0);
});

test("learn marks: hide and unhide a chapter; the last one stays", async () => {
  const { login, store, clock, today } = await setup();
  const { call, userId } = await login("owner");
  seedSample(store, userId, today());
  const act = (action: string, chapterId: string) =>
    call("POST", "/v1/learn/marks", { action, chapterId });
  const hide = await act("hide", "limit");
  assert.equal(hide.status, 200);
  assert.deepEqual(Object.keys(hide.body.data), ["summary"]);
  const s = hide.body.data.summary;
  assert.equal(chapterOf(s, "limit").hidden, true);
  assert.equal(s.correct, 15);
  assert.equal(s.total, 72);
  assert.deepEqual(s.book, { rank: "起步", reached: 2, of: 5 });
  assert.equal(s.xp, 390);
  // Idempotent: one row, the first time kept.
  const firstAt = (
    store.db
      .prepare("SELECT hidden_at FROM map_chapters WHERE user_id=?")
      .all(userId) as { hidden_at: string }[]
  ).map((r) => r.hidden_at);
  // A minute later, so a hide that rewrote the time would show.
  clock.at = new Date(clock.at.getTime() + 60_000);
  assert.equal((await act("hide", "limit")).status, 200);
  assert.deepEqual(
    (
      store.db
        .prepare("SELECT hidden_at FROM map_chapters WHERE user_id=?")
        .all(userId) as { hidden_at: string }[]
    ).map((r) => r.hidden_at),
    firstAt,
  );
  const map = (await call("GET", "/v1/learn/map")).body.data;
  assert.equal(map.chapters[0].hidden, true);
  // Unhide: back to the sample's numbers; unhide again changes nothing.
  const shown = (await act("unhide", "limit")).body.data.summary;
  assert.equal(shown.correct, 27);
  assert.deepEqual(shown.book, { rank: "起步", reached: 3, of: 6 });
  assert.equal((await act("unhide", "limit")).status, 200);
  // Hide all but one; the last one answers 409.
  for (const id of [
    "limit",
    "derivative",
    "application",
    "indefinite",
    "definite",
  ])
    assert.equal((await act("hide", id)).status, 200, id);
  const last = await act("hide", "ode");
  assert.equal(last.status, 409);
  assert.equal(last.body.code, "LAST_CHAPTER");
  assert.equal(last.body.message, "最后一章先留着吧");
  // Hiding one already hidden still works when only one is shown.
  assert.equal((await act("hide", "limit")).status, 200);
  const one = (await call("GET", "/v1/learn/map")).body.data.summary;
  assert.deepEqual(one.book.of, 1);
});

test("learn marks: chapter actions are validated", async () => {
  const { login } = await setup();
  const { call } = await login("owner");
  for (const action of ["selfRest", "unselfRest", "hide", "unhide"]) {
    const res = await call("POST", "/v1/learn/marks", {
      action,
      chapterId: "nope",
    });
    assert.equal(res.status, 404, action);
  }
  for (const payload of [
    { action: "selfRest", pointId: "limit-rules" },
    { action: "hide", chapterId: "limit", pointId: "limit-rules" },
    { action: "seen", chapterId: "limit" },
    { action: "seen", pointId: "limit-rules", chapterId: "limit" },
    { action: "hide" },
    { action: "hide", chapterId: "" },
    { action: "explode", chapterId: "limit" },
    { chapterId: "limit" },
  ])
    assert.equal(
      (await call("POST", "/v1/learn/marks", payload)).status,
      400,
      JSON.stringify(payload),
    );
});

test("learn report: stores the reason, and the answer with what the program read", async () => {
  const { app, login, store } = await setup();
  const { call, userId } = await login("owner");
  const url = "/v1/learn/points/application-taylor-limit/report";
  const reports = () =>
    store.db
      .prepare(
        "SELECT * FROM map_reports WHERE user_id=? ORDER BY created_at,rowid",
      )
      .all(userId) as Record<string, string | null>[];
  const withAnswer = await call("POST", url, {
    reason: "judge",
    answer: "-1/12",
  });
  assert.equal(withAnswer.status, 200);
  assert.deepEqual(withAnswer.body.data, { reported: true });
  await call("POST", url, { reason: "judge", answer: "-0.083" });
  // 我的答案是对的，判错了: the stored reading shows what the program saw.
  await call("POST", url, { reason: "judge", answer: "1/12" });
  await call("POST", url, { reason: "problem" });
  // No dedupe.
  await call("POST", url, { reason: "problem" });
  const rows = reports();
  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((r) => [r.point_id, r.reason, r.answer, r.verdict, r.note]),
    [
      ["application-taylor-limit", "judge", "-1/12", "correct", null],
      ["application-taylor-limit", "judge", "-0.083", "unsure", null],
      ["application-taylor-limit", "judge", "1/12", "incorrect", null],
      ["application-taylor-limit", "problem", null, null, null],
      ["application-taylor-limit", "problem", null, null, null],
    ],
  );
  // understood is the judge's own TeX, before the display clean-up (cleanTex).
  assert.equal(rows[0]!.understood, "\\frac{-1}{12}");
  assert.equal(rows[1]!.understood, "-0.083");
  assert.equal(rows[2]!.understood, "\\frac{1}{12}");
  assert.equal(rows[3]!.understood, null);
  assert.match(String(rows[0]!.id), /^mrp_/);
  // A report changes no progress.
  assert.equal(pointRow(store, userId, "application-taylor-limit"), undefined);
  // 404, 409, validation, login.
  const missing = await call("POST", "/v1/learn/points/nope/report", {
    reason: "other",
  });
  assert.equal(missing.status, 404);
  const none = await withoutProblem("limit-function", () =>
    call("POST", "/v1/learn/points/limit-function/report", {
      reason: "unclear",
    }),
  );
  assert.equal(none.status, 409);
  assert.equal(none.body.code, "NO_PROBLEM");
  assert.equal(none.body.message, "题还在出，稍等");
  for (const payload of [
    {},
    { reason: "wrong" },
    { reason: "judge", answer: "" },
    { reason: "judge", answer: "x".repeat(201) },
    { reason: "judge", note: "备注" },
    { reason: "judge", answer: 1 },
  ])
    assert.equal(
      (await call("POST", url, payload)).status,
      400,
      JSON.stringify(payload),
    );
  assert.equal(reports().length, 5);
  const unauth = await app.inject({
    method: "POST",
    url,
    payload: { reason: "other" },
  });
  assert.equal(unauth.statusCode, 401);
  // The export carries the reports, with the hidden chapter.
  await call("POST", "/v1/learn/marks", { action: "hide", chapterId: "ode" });
  const { learn } = (await call("GET", "/v1/me/export")).body;
  assert.equal(learn.reports.length, 5);
  assert.deepEqual(Object.keys(learn.reports[0]).sort(), [
    "answer",
    "createdAt",
    "id",
    "index",
    "note",
    "pointId",
    "problemKind",
    "reason",
    "understood",
    "verdict",
  ]);
  assert.equal(learn.reports[0].answer, "-1/12");
  assert.equal(learn.reports[0].verdict, "correct");
  assert.deepEqual(
    learn.hiddenChapters.map((c: { chapterId: string }) => c.chapterId),
    ["ode"],
  );
});

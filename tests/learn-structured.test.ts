import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, SqliteStore } from "../server/src/shared/store.js";
import {
  judgeAnswer,
  validateInput,
} from "../server/src/modules/learn/answers.js";
import {
  PROBLEMS,
  type MultiProblem,
  type ChoiceProblem,
} from "../server/src/modules/learn/problems.js";
import { LearnService } from "../server/src/modules/learn/service.js";
import { MarkdownRenderer } from "../server/src/modules/render/markdown.js";
import { fakeServices, makeApp } from "./fixtures.js";

const MULTI_ID = "limit-function",
  CHOICE_ID = "limit-order";
const multi: MultiProblem = {
  kind: "multi",
  text: "按顺序填三个结果。",
  hint: "先分别计算。",
  explanation: "完整解法：逐项计算并保留积分常数。",
  parts: [
    { label: "数值", kind: "number", answer: "-1/12", note: "精确值" },
    { label: "表达式", kind: "expr", answer: "t^2", var: "t" },
    { label: "原函数", kind: "antiderivative", answer: "x + C" },
  ],
};
const choice: ChoiceProblem = {
  kind: "choice",
  text: "分别选出结果。",
  hint: "逐问判断。",
  explanation: "完整解法：先判断条件，再选择。",
  questions: [
    {
      prompt: "第一问",
      options: [
        { id: "A", text: "一" },
        { id: "B", text: "二" },
      ],
      answer: "B",
    },
    {
      prompt: "第二问 $x>0$",
      options: [
        { id: "A", text: "$x$" },
        { id: "B", text: "$-x$" },
      ],
      answer: "A",
    },
  ],
};
function setup(t: TestContext) {
  const oldMulti = PROBLEMS[MULTI_ID],
    oldChoice = PROBLEMS[CHOICE_ID];
  PROBLEMS[MULTI_ID] = [
    multi,
    {
      ...multi,
      parts: multi.parts.map((p) =>
        p.kind === "number" ? { ...p, answer: "1/12" } : p,
      ),
    },
  ];
  PROBLEMS[CHOICE_ID] = [
    choice,
    {
      ...choice,
      questions: choice.questions.map((q) => ({
        ...q,
        answer: q.answer === "A" ? "B" : "A",
      })),
    },
  ];
  t.after(() => {
    if (oldMulti) PROBLEMS[MULTI_ID] = oldMulti;
    else delete PROBLEMS[MULTI_ID];
    if (oldChoice) PROBLEMS[CHOICE_ID] = oldChoice;
    else delete PROBLEMS[CHOICE_ID];
  });
  const clock = { at: new Date("2026-10-05T01:00:00Z") };
  const store = new SqliteStore(":memory:");
  const services = fakeServices();
  const app = makeApp(services, {}, () => clock.at, store);
  t.after(() => app.close());
  const login = async (key: string) => {
    const { token, user } = (
      await app.inject({
        method: "POST",
        url: "/v1/auth/dev-login",
        payload: { key },
      })
    ).json().data;
    const call = (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET",
        url,
        payload: payload as string,
        headers: { authorization: `Bearer ${token}` },
      });
    return { call, userId: user.id as string };
  };
  const row = (userId: string, id: string) =>
    store.db
      .prepare("SELECT * FROM map_points WHERE user_id=? AND point_id=?")
      .get(userId, id);
  return {
    app,
    store,
    services,
    clock,
    login,
    row,
    learn: new LearnService(store, () => clock.at),
  };
}

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

test("structured input: exact shapes and finite limits are validated before computation", () => {
  for (const input of [
    "-1/12",
    [],
    ["-1/12", "t^2"],
    ["-1/12", "t^2", " "],
    ["-1/12", "t^2", "x+C", "extra"],
    ["1".repeat(201), "t^2", "x+C"],
    [1, "t^2", "x+C"],
  ])
    assert.throws(() => validateInput(multi, input), {
      code: "VALIDATION_ERROR",
    });
  const eight: MultiProblem = {
    ...multi,
    parts: Array.from({ length: 8 }, (_, i) => ({
      kind: "number",
      label: `${i}`,
      answer: "1",
    })),
  };
  assert.doesNotThrow(() =>
    validateInput(eight, Array(8).fill("1".repeat(100))),
  );
  assert.throws(() =>
    validateInput(eight, ["1".repeat(101), ...Array(7).fill("1".repeat(100))]),
  );
  assert.throws(() =>
    validateInput(
      { ...eight, parts: [...eight.parts, eight.parts[0]!] },
      Array(9).fill("1"),
    ),
  );
  for (const input of [
    "B",
    ["B"],
    ["B", "A", "A"],
    ["b", "A"],
    [" B", "A"],
    ["C", "A"],
    ["A".repeat(17), "A"],
  ])
    assert.throws(() => validateInput(choice, input), {
      code: "VALIDATION_ERROR",
    });
  assert.doesNotThrow(() => validateInput(PROBLEMS["limit-rules"]![0]!, " "));
});

test("number input with two signs in a row is invalid; a zero denominator stays unsure", () => {
  const number = { kind: "number", text: "求值。", answer: "-3" } as const;
  for (const input of ["--3", "+-3", "- -3", "3--2", "−−3"])
    assert.throws(() => validateInput(number, input), {
      code: "VALIDATION_ERROR",
    });
  assert.throws(() => validateInput(multi, ["--1/12", "t^2", "x+C"]), {
    code: "VALIDATION_ERROR",
  });
  assert.equal(judgeAnswer(number, "-3").verdict, "correct");
  assert.equal(judgeAnswer(number, "3").verdict, "incorrect");
  for (const input of ["2/0", "0/0"])
    assert.equal(judgeAnswer(number, input).verdict, "unsure");
  // Only number problems: an expression may hold "x - -1".
  assert.doesNotThrow(() =>
    validateInput({ kind: "expr", text: "", answer: "x+1" }, "x - -1"),
  );
});

test("multi judge: aggregation preserves unsure reasons, unit context, variables and per-part domain", () => {
  const correct = judgeAnswer(multi, ["-1/12", "t*t", "C+x"]);
  assert.equal(correct.verdict, "correct");
  assert.deepEqual(
    correct.items?.map((p) => p.label),
    ["数值", "表达式", "原函数"],
  );
  const unsure = judgeAnswer(multi, ["-0.083", "t^2", "x+C"]);
  assert.equal(unsure.verdict, "unsure");
  assert.equal(unsure.reason, "decimal");
  const wrong = judgeAnswer(multi, ["-0.083", "t^2+1", "x+C"]);
  assert.equal(wrong.verdict, "incorrect");
  assert.deepEqual(
    wrong.items?.map((p) => p.verdict),
    ["unsure", "incorrect", "correct"],
  );
  const context: MultiProblem = {
    kind: "multi",
    text: "速度的单位为 m/s。",
    parts: [
      { kind: "number", answer: "3/4", label: "速度" },
      {
        kind: "expr",
        answer: "x^2+2*x",
        domain: "positive",
        label: "正域特解",
      },
      { kind: "expr", answer: "ln(x)", onAnswerDomain: true, label: "对数" },
    ],
  };
  assert.equal(
    judgeAnswer(context, ["0.75 m/s", "e^(2*ln(x))+2*e^(ln(x))", "ln|x|"])
      .verdict,
    "correct",
  );
});

test("structured API: public projection has render blocks and no nested answer, hint or explanation", async (t) => {
  const { login } = setup(t);
  const { call } = await login("owner");
  for (const id of [MULTI_ID, CHOICE_ID]) {
    const response = await call("GET", `/v1/learn/points/${id}?tone=dark`);
    assert.equal(response.statusCode, 200);
    const p = response.json().data.problem;
    assert.equal(p.hasHint, true);
    assert.equal(p.hasExplanation, true);
    assert.ok(p.blocks.length);
    assert.doesNotMatch(
      response.body,
      /"(?:answer|hint|explanation|domain|onAnswerDomain)":/,
    );
    assert.doesNotMatch(response.body, /完整解法|先分别计算/);
    if (p.kind === "multi")
      assert.deepEqual(Object.keys(p.parts[0]).sort(), [
        "kind",
        "label",
        "note",
        "var",
      ]);
    else
      for (const q of p.questions) {
        assert.ok(q.blocks.length);
        for (const option of q.options) assert.ok(option.blocks.length);
      }
  }
});

test("structured answer: only an entirely correct answer discloses per-item standards", async (t) => {
  const { login, row } = setup(t);
  const { call, userId } = await login("owner");
  const url = `/v1/learn/points/${MULTI_ID}/answer`;
  for (const [answers, verdict] of [
    [["-0.083", "t^2", "x+C"], "unsure"],
    [["1/12", "t^2", "x+C"], "incorrect"],
  ] as const) {
    const result = (
      await call("POST", url, { answer: answers, index: 0 })
    ).json().data;
    assert.equal(result.verdict, verdict);
    assert.equal(result.read, null);
    assert.equal(result.practice, false);
    assert.equal(result.counted, "none");
    assert.ok(
      result.items.every(
        (item: object) => !("standard" in item) && !("format" in item),
      ),
    );
    assert.ok(!("standard" in result));
    assert.ok(noProgress(row(userId, MULTI_ID) as Record<string, unknown>));
  }
  const right = (
    await call("POST", url, { answer: ["-1/12", "t^2", "x+C"], index: 0 })
  ).json().data;
  assert.equal(right.counted, "lit");
  assert.ok(right.xp > 0);
  assert.ok(
    right.items.every((item: { standard: unknown[] }) => item.standard.length),
  );
  assert.ok(!("standard" in right));
});

test("choice: wrong choice restricts first lighting today, next day lights, invalid input writes nothing", async (t) => {
  const { login, row, clock, services } = setup(t);
  const { call, userId } = await login("owner");
  const url = `/v1/learn/points/${CHOICE_ID}/answer`;
  for (const answer of [["C", "A"], ["A"], "A"])
    assert.equal((await call("POST", url, { answer })).statusCode, 400);
  assert.equal(row(userId, CHOICE_ID), undefined);
  const wrong = (
    await call("POST", url, { answer: ["A", "A"], index: 0 })
  ).json().data;
  assert.equal(wrong.verdict, "incorrect");
  assert.equal(wrong.practice, true);
  assert.equal(wrong.counted, "none");
  assert.equal(row(userId, CHOICE_ID)?.correct_at, null);
  assert.ok(wrong.items.every((item: object) => !("standard" in item)));
  const right = (
    await call("POST", url, { answer: ["B", "A"], index: 0 })
  ).json().data;
  assert.equal(right.counted, "practice");
  assert.equal(right.xp, 0);
  assert.equal(right.practice, true);
  assert.ok(right.items[0].standard.length);
  clock.at = new Date("2026-10-05T16:00:00Z");
  const nextDay = (
    await call("POST", url, { answer: ["B", "A"], index: 0 })
  ).json().data;
  assert.equal(nextDay.counted, "lit");
  assert.equal(nextDay.practice, false);
  assert.ok(nextDay.xp > 0);
  assert.deepEqual(services.llm, []);
  assert.deepEqual(services.jev, []);
});

test("choice review: a wrong due review blocks same-day retry and restarts at 7 tomorrow", async (t) => {
  const { login, store, learn, row, clock } = setup(t);
  const { userId } = await login("owner");
  assert.equal(learn.answer(userId, CHOICE_ID, ["B", "A"], 0).counted, "lit");
  const originalCorrect = row(userId, CHOICE_ID)?.correct_at;
  store.db
    .prepare("UPDATE map_points SET due_on='2026-10-05' WHERE user_id=?")
    .run(userId);
  assert.equal(learn.point(userId, CHOICE_ID).problem?.index, 1);
  const before = learn.summary(userId);
  const wrong = learn.answer(userId, CHOICE_ID, ["B", "A"], 1);
  assert.equal(wrong.counted, "lapse");
  assert.equal(wrong.practice, true);
  const retry = learn.answer(userId, CHOICE_ID, ["A", "B"], 1);
  assert.equal(retry.counted, "lapse");
  clock.at = new Date("2026-10-06T01:00:00Z");
  const nextDay = learn.answer(userId, CHOICE_ID, ["A", "B"], 1);
  assert.equal(nextDay.counted, "review");
  assert.deepEqual(nextDay.review, { interval: 7 });
  assert.equal(retry.practice, true);
  assert.equal(retry.xp, 0);
  assert.equal(learn.summary(userId).xp, before.xp);
  assert.equal(row(userId, CHOICE_ID)?.correct_at, originalCorrect);
});

test("hint and explanation both mark help, schedule retest and respect next day", async (t) => {
  const { login, row, clock, learn, services } = setup(t);
  const { call, userId } = await login("owner");
  const before = (await call("GET", "/v1/me/usage")).body;
  const hint = await call(
    "GET",
    `/v1/learn/points/${MULTI_ID}/hint?index=1&tone=dark`,
  );
  assert.equal(hint.statusCode, 200);
  assert.equal(hint.json().data.index, 1);
  assert.deepEqual(Object.keys(hint.json().data).sort(), [
    "blocks",
    "index",
    "practice",
    "retest",
    "state",
    "summary",
    "text",
  ]);
  assert.equal(row(userId, MULTI_ID)?.practice_on, "2026-10-05");
  assert.equal(hint.json().data.retest.cause, "hint");
  // 0.6.0 : every bank problem has a solution now; a copy of
  // limit-rules is served as written, without one.
  const rules = PROBLEMS["limit-rules"]!;
  PROBLEMS["limit-rules"] = rules.map((problem) => ({ ...problem }));
  t.after(() => {
    PROBLEMS["limit-rules"] = rules;
  });
  for (const [url, payload, code] of [
    ["/v1/learn/points/limit-rules/hint", undefined, "NO_HINT"],
    [
      "/v1/learn/marks",
      { action: "explanation", pointId: "limit-rules", index: 0 },
      "NO_EXPLANATION",
    ],
  ] as const) {
    const missing = await call(payload ? "POST" : "GET", url, payload);
    assert.equal(missing.statusCode, 409);
    assert.equal(missing.json().code, code);
  }
  assert.equal(row(userId, "limit-rules"), undefined);
  const explanation = await call("POST", "/v1/learn/marks", {
    action: "explanation",
    pointId: MULTI_ID,
    index: 0,
    tone: "dark",
  });
  assert.equal(explanation.statusCode, 200);
  assert.equal(explanation.json().data.practice, true);
  assert.equal(row(userId, MULTI_ID)?.practice_on, "2026-10-05");
  assert.equal(
    learn.answer(userId, MULTI_ID, ["-1/12", "t^2", "x+C"], 0).counted,
    "practice",
  );
  assert.equal((await call("GET", "/v1/me/usage")).body, before);
  assert.deepEqual(services.llm, []);
  assert.deepEqual(services.jev, []);
  clock.at = new Date("2026-10-05T16:00:00Z");
  assert.equal(
    learn.answer(userId, MULTI_ID, ["-1/12", "t^2", "x+C"], 0).counted,
    "lit",
  );
  await call("POST", "/v1/learn/marks", {
    action: "explanation",
    pointId: MULTI_ID,
    index: 0,
  });
  assert.equal(
    learn.answer(userId, MULTI_ID, ["-1/12", "t^2", "x+C"], 0).counted,
    "again",
  );
});

test("explanation: rendering fails without a marker; successful delivery commits the response-day marker", async (t) => {
  const { login, row, clock } = setup(t);
  const { call, userId } = await login("owner");
  const original = MarkdownRenderer.prototype.render;
  t.after(() => {
    MarkdownRenderer.prototype.render = original;
  });
  let fail = true;
  MarkdownRenderer.prototype.render = async function (source, color) {
    assert.equal(row(userId, MULTI_ID), undefined);
    if (fail) throw new Error("synthetic rendering failure");
    clock.at = new Date("2026-10-05T16:00:00Z");
    return original.call(this, source, color);
  };
  const payload = { action: "explanation", pointId: MULTI_ID, index: 0 };
  assert.equal(
    (await call("POST", "/v1/learn/marks", payload)).statusCode,
    500,
  );
  assert.equal(row(userId, MULTI_ID), undefined);
  fail = false;
  const success = await call("POST", "/v1/learn/marks", payload);
  assert.equal(success.statusCode, 200);
  assert.equal(row(userId, MULTI_ID)?.practice_on, "2026-10-06");
  assert.equal(success.json().data.summary.today, "2026-10-06");
});

test("structured routes: auth and strict validation precede all writes", async (t) => {
  const { app, login, store, row } = setup(t);
  const { call, userId } = await login("owner");
  for (const [method, url, payload] of [
    ["GET", `/v1/learn/points/${MULTI_ID}/hint?index=bad`],
    [
      "POST",
      "/v1/learn/marks",
      { action: "explanation", pointId: MULTI_ID, index: 5 },
    ],
    ["POST", `/v1/learn/points/${MULTI_ID}/answer`, { answer: [] }],
  ] as const) {
    assert.equal((await app.inject({ method, url, payload })).statusCode, 401);
    assert.equal((await call(method, url, payload)).statusCode, 400);
  }
  for (const payload of [
    { action: "seen", pointId: MULTI_ID, index: 0 },
    { action: "self", pointId: MULTI_ID, tone: "dark" },
    { action: "explanation", pointId: MULTI_ID, chapterId: "limit" },
  ])
    assert.equal(
      (await call("POST", "/v1/learn/marks", payload)).statusCode,
      400,
    );
  assert.equal(row(userId, MULTI_ID), undefined);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM map_reports").get()?.n,
    0,
  );
});

test("structured reports: retain variant and arrays, export raw readings, do not change progress, isolate accounts", async (t) => {
  const { login, store, row } = setup(t);
  const { call, userId } = await login("owner");
  const { call: other, userId: otherId } = await login("other");
  const multiUrl = `/v1/learn/points/${MULTI_ID}/report`;
  assert.equal(
    (
      await call("POST", multiUrl, {
        reason: "judge",
        answer: ["-1/12", "t^2", "x+C"],
        index: 0,
      })
    ).statusCode,
    200,
  );
  await call("POST", `/v1/learn/points/${CHOICE_ID}/report`, {
    reason: "judge",
    answer: ["B", "A"],
    index: 1,
  });
  await call("POST", multiUrl, { reason: "unclear", index: 1 });
  assert.equal(
    (await call("POST", multiUrl, { reason: "judge", answer: ["1", ""] }))
      .statusCode,
    400,
  );
  assert.equal(row(userId, MULTI_ID), undefined);
  assert.equal(row(userId, CHOICE_ID), undefined);
  const stored = store.db
    .prepare("SELECT * FROM map_reports WHERE user_id=? ORDER BY rowid")
    .all(userId);
  assert.equal(stored.length, 3);
  assert.equal(stored[0]?.answer, null);
  const readings = JSON.parse(String(stored[0]?.understood_json));
  assert.equal(readings[0].read, "\\frac{-1}{12}");
  assert.deepEqual(Object.keys(readings[0]).sort(), [
    "read",
    "reason",
    "verdict",
  ]);
  assert.equal(stored[1]?.verdict, null);
  assert.equal(stored[1]?.understood, null);
  assert.equal(stored[1]?.understood_json, null);
  const exported = (await call("GET", "/v1/me/export")).json().learn.reports;
  assert.deepEqual(exported[0].answer, ["-1/12", "t^2", "x+C"]);
  assert.deepEqual(exported[0].understood, readings);
  assert.equal(exported[0].index, 0);
  assert.equal(exported[0].problemKind, "multi");
  assert.equal(exported[1].index, 1);
  assert.equal(exported[1].problemKind, "choice");
  assert.deepEqual(exported[1].answer, ["B", "A"]);
  assert.equal(exported[1].verdict, null);
  assert.equal(exported[1].understood, null);
  assert.equal(exported[2].index, 1);
  assert.equal(exported[2].answer, null);
  assert.equal(exported[2].understood, null);
  assert.deepEqual(
    (await other("GET", "/v1/me/export")).json().learn.reports,
    [],
  );
  await other("POST", multiUrl, { reason: "other", index: 1 });
  await call("DELETE", "/v1/me", { confirm: true });
  assert.equal(
    store.db
      .prepare("SELECT COUNT(*) AS n FROM map_reports WHERE user_id=?")
      .get(userId)?.n,
    0,
  );
  assert.equal(
    store.db
      .prepare("SELECT COUNT(*) AS n FROM map_reports WHERE user_id=?")
      .get(otherId)?.n,
    1,
  );
});

test("choice reports: retain selections without assessments or practice and progress changes", async (t) => {
  const { login, store, row, learn, clock } = setup(t);
  const { call, userId } = await login("owner");
  const url = `/v1/learn/points/${CHOICE_ID}/report`;
  const selections = [
    ["A", "B"],
    ["B", "A"],
  ];
  for (const [i, answer] of selections.entries()) {
    if (i === 1) {
      learn.mark(userId, "seen", CHOICE_ID);
      learn.explanation(userId, CHOICE_ID, 0);
    }
    const before = row(userId, CHOICE_ID);
    const summary = learn.summary(userId);
    clock.at = new Date(clock.at.getTime() + 60_000);
    const response = await call("POST", url, {
      reason: "judge",
      answer,
      index: 0,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, { reported: true });
    assert.deepEqual(row(userId, CHOICE_ID), before);
    assert.deepEqual(learn.summary(userId), summary);
    const invalid = await call("POST", url, {
      reason: "judge",
      answer: ["C", "A"],
      index: 0,
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().code, "VALIDATION_ERROR");
    assert.deepEqual(row(userId, CHOICE_ID), before);
    assert.deepEqual(learn.summary(userId), summary);
  }
  const stored = store.db
    .prepare("SELECT * FROM map_reports WHERE user_id=? ORDER BY rowid")
    .all(userId);
  assert.equal(stored.length, selections.length);
  for (const [i, report] of stored.entries()) {
    assert.deepEqual(JSON.parse(String(report.answer_json)), selections[i]);
    assert.equal(report.verdict, null);
    assert.equal(report.understood, null);
    assert.equal(report.understood_json, null);
  }
  const reports = (await call("GET", "/v1/me/export")).json().learn.reports;
  assert.equal(reports.length, selections.length);
  for (const [i, report] of reports.entries()) {
    assert.deepEqual(report.answer, selections[i]);
    assert.equal(report.problemKind, "choice");
    assert.equal(report.verdict, null);
    assert.equal(report.understood, null);
  }
});

test("migration eight: historical scalar feedback is unchanged and keeps unknown index/kind null", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "zhiye-structured-upgrade-")),
    "app.sqlite",
  );
  const old = new DatabaseSync(path);
  const iso = "2026-10-02T00:00:00Z";
  try {
    old.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)",
    );
    for (let i = 0; i < 7; i++) {
      old.exec(MIGRATIONS[i]!);
      old.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(i + 1, iso);
    }
    old
      .prepare("INSERT INTO users(id,openid,data) VALUES(?,?,?)")
      .run("u", "dev:u", JSON.stringify({ id: "u" }));
    old
      .prepare(
        "INSERT INTO map_reports(id,user_id,point_id,reason,answer,understood,verdict,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        "r",
        "u",
        "limit-rules",
        "judge",
        "1/2",
        "\\frac{1}{2}",
        "correct",
        iso,
      );
  } finally {
    old.close();
  }
  for (let pass = 0; pass < 2; pass++) {
    const store = new SqliteStore(path);
    try {
      const r = store.db
        .prepare("SELECT * FROM map_reports WHERE id='r'")
        .get()!;
      assert.equal(r.answer, "1/2");
      assert.equal(r.understood, "\\frac{1}{2}");
      assert.equal(r.problem_index, null);
      assert.equal(r.problem_kind, null);
      assert.equal(r.answer_json, null);
      assert.equal(r.understood_json, null);
      assert.equal(
        store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM schema_migrations WHERE version=8",
          )
          .get()?.n,
        1,
      );
      assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      store.close();
    }
  }
});

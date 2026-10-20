import assert from "node:assert/strict";
import test from "node:test";
import { fakeServices, makeApp } from "./fixtures.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { LearnService } from "../server/src/modules/learn/service.js";
import { canonicalInput } from "../server/src/modules/learn/answers.js";
import { PROBLEMS } from "../server/src/modules/learn/problems.js";
import { chooseRetestProblem } from "../server/src/modules/learn/retests.js";
import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";

const POINTS = [
  "limit-rules",
  "limit-squeeze",
  "limit-important-sin",
  "limit-important-e",
  "limit-equivalent",
  "limit-1-to-inf",
  "limit-continuity",
];
const ORIGINAL_PROBLEMS = new Map<string, (typeof PROBLEMS)[string]>(
  POINTS.map((id) => [id, PROBLEMS[id]!]),
);
test.before(() => {
  for (const id of POINTS)
    PROBLEMS[id] = PROBLEMS[id]!.map((problem) => ({
      ...problem,
      hint: problem.hint ?? "先看清要算什么。",
      explanation: problem.explanation ?? "按定义逐步计算。",
    }));
});
test.after(() => {
  for (const [id, problems] of ORIGINAL_PROBLEMS) PROBLEMS[id] = problems;
});

async function fixture() {
  const clock = { at: new Date("2026-10-05T01:00:00.000Z") };
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, () => clock.at, store);
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: { key: "v2-retest" },
  });
  const data = login.json().data;
  const headers = { authorization: `Bearer ${data.token}` };
  const call = (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
  const row = (pointId: string) =>
    store.db
      .prepare(
        "SELECT * FROM retests WHERE user_id=? AND point_id=? AND done_at IS NULL",
      )
      .get(data.user.id, pointId) as Record<string, any> | undefined;
  const history = (pointId: string) =>
    store.db
      .prepare(
        "SELECT * FROM retests WHERE user_id=? AND point_id=? ORDER BY id",
      )
      .all(data.user.id, pointId) as Record<string, any>[];
  return {
    app,
    store,
    clock,
    userId: data.user.id as string,
    headers,
    call,
    row,
    history,
    learn: new LearnService(store, () => clock.at),
  };
}

const answer = (pointId: string, index: number) =>
  canonicalInput(PROBLEMS[pointId]![index]!);

test("五种起因排一次复测，帮助标记与 teach/已点亮边界正确", async () => {
  const f = await fixture();
  try {
    const [explanation, hint, stuck, wrong, ask] = POINTS;
    assert.equal(
      (
        await f.call("POST", "/v1/learn/marks", {
          action: "explanation",
          pointId: explanation,
          index: 0,
          tone: "dark",
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.call("GET", `/v1/learn/points/${hint}/hint?index=0&tone=dark`))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await f.call("POST", "/v1/learn/marks", {
          action: "stuck",
          pointId: stuck,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      f.store.db
        .prepare(
          "SELECT practice_on FROM map_points WHERE user_id=? AND point_id=?",
        )
        .get(f.userId, stuck)!.practice_on,
      null,
      "只点卡住还不算收到帮助",
    );
    f.learn.markStuckHelp(f.userId, stuck);
    await f.call("POST", "/v1/learn/marks", { action: "self", pointId: wrong });
    assert.equal(
      (
        await f.call("POST", `/v1/learn/points/${wrong}/answer`, {
          answer: "999999",
          index: 0,
          tone: "dark",
        })
      ).statusCode,
      200,
    );
    const thread = (
      await f.call("POST", "/v1/chat/threads", {
        text: "从这个点问问",
        pointId: ask,
        tone: "dark",
      })
    ).json().data.thread;
    await f.call("POST", "/v1/chat/send", {
      threadId: thread.id,
      text: "为什么这样做",
      mode: "auto",
      clientId: "point-ask-1",
      tone: "dark",
    });
    assert.deepEqual(
      [explanation, hint, stuck, wrong, ask].map((id) => f.row(id)?.cause),
      ["explanation", "hint", "stuck", "wrong", "ask"],
    );
    assert.ok(
      [explanation, hint, stuck, wrong, ask].every(
        (id) => f.row(id)?.due_on === "2026-10-07",
      ),
    );
    const progress = f.store.db
      .prepare(
        "SELECT point_id,practice_on,stuck_at,self_at FROM map_points WHERE user_id=?",
      )
      .all(f.userId) as Record<string, any>[];
    const byPoint = new Map(progress.map((row) => [row.point_id, row]));
    assert.equal(byPoint.get(explanation)?.practice_on, "2026-10-05");
    assert.equal(byPoint.get(hint)?.practice_on, "2026-10-05");
    assert.equal(byPoint.get(ask)?.practice_on, "2026-10-05");
    assert.equal(byPoint.get(stuck)?.practice_on, "2026-10-05");
    assert.ok(byPoint.get(stuck)?.stuck_at);
    assert.equal(
      byPoint.get(wrong)?.practice_on ?? null,
      null,
      "填空答错不算当天帮助",
    );
    assert.equal(byPoint.get(wrong)?.self_at, null, "答错会清掉我会了");

    const teachPoint = POINTS[5]!;
    const teach = (
      await f.call("POST", "/v1/chat/threads", {
        text: "我来讲",
        pointId: teachPoint,
        mode: "teach",
        tone: "dark",
      })
    ).json().data.thread;
    await f.call("POST", "/v1/chat/send", {
      threadId: teach.id,
      text: "这是我的解释",
      mode: "auto",
      clientId: "point-teach-1",
      tone: "dark",
    });
    assert.equal(f.row(teachPoint), undefined);

    const litPoint = POINTS[6]!;
    assert.equal(
      f.learn.answer(f.userId, litPoint, answer(litPoint, 0), 0).counted,
      "lit",
    );
    await f.call("POST", "/v1/learn/marks", {
      action: "hint",
      pointId: litPoint,
      index: 0,
      tone: "dark",
    });
    assert.equal(f.row(litPoint), undefined, "已点亮的点不排复测");
  } finally {
    await f.app.close();
  }
});

test("同点重复触发不改日期，撞到计划题时换题且 clientId 重试不重复", async () => {
  const f = await fixture();
  try {
    const point = POINTS[0]!;
    await f.call("POST", "/v1/learn/marks", {
      action: "hint",
      pointId: point,
      index: 0,
      tone: "dark",
    });
    const first = { ...f.row(point)! };
    assert.equal(first.problem_index, 1);
    await f.call("POST", "/v1/learn/marks", {
      action: "explanation",
      pointId: point,
      index: 1,
      tone: "dark",
    });
    const changed = f.row(point)!;
    assert.equal(changed.id, first.id);
    assert.equal(changed.due_on, first.due_on);
    assert.equal(changed.problem_index, 0);
    assert.equal(f.learn.retests.view(f.userId, changed as any).repeated, true);

    const askPoint = POINTS[1]!;
    const thread = (
      await f.call("POST", "/v1/chat/threads", {
        text: "问这个点",
        pointId: askPoint,
        tone: "dark",
      })
    ).json().data.thread;
    const payload = {
      threadId: thread.id,
      text: "继续问",
      mode: "auto",
      clientId: "same-point-ask",
      tone: "dark",
    };
    await f.call("POST", "/v1/chat/send", payload);
    await f.call("POST", "/v1/chat/send", payload);
    assert.equal(f.history(askPoint).length, 1);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT count(*) n FROM events WHERE user_id=? AND name='retest_scheduled' AND json_extract(data,'$.pointId')=?",
        )
        .get(f.userId, askPoint)!.n,
      1,
    );
  } finally {
    await f.app.close();
  }
});

test("提前独立做对关闭复测；帮助日只算练习，次日起可提前通关", async () => {
  const f = await fixture();
  try {
    const early = POINTS[0]!;
    f.learn.retests.schedule(f.userId, early, "wrong", 0);
    const planned = f.row(early)!.problem_index;
    const result = f.learn.answer(
      f.userId,
      early,
      answer(early, planned),
      planned,
    );
    assert.equal(result.counted, "lit");
    assert.equal(result.retest?.result, "early");
    assert.equal(f.row(early), undefined);

    const practiced = POINTS[1]!;
    f.learn.help(f.userId, practiced, "hint", 0);
    const pIndex = f.row(practiced)!.problem_index;
    const sameDay = f.learn.answer(
      f.userId,
      practiced,
      answer(practiced, pIndex),
      pIndex,
    );
    assert.equal(sameDay.counted, "practice");
    assert.ok(f.row(practiced));
    f.clock.at = new Date("2026-10-06T01:00:00.000Z");
    const nextDay = f.learn.answer(
      f.userId,
      practiced,
      answer(practiced, pIndex),
      pIndex,
    );
    assert.equal(nextDay.counted, "lit");
    assert.equal(nextDay.retest?.result, "early");
  } finally {
    await f.app.close();
  }
});

test("到期复测允许缺省预测，判不了保留；错或看提示只续一轮且换题", async () => {
  const f = await fixture();
  try {
    const point = POINTS[0]!;
    f.learn.retests.schedule(f.userId, point, "explanation", 0);
    f.clock.at = new Date("2026-10-07T01:00:00.000Z");
    const page = (
      await f.call("GET", `/v1/learn/points/${point}?tone=dark`)
    ).json().data;
    assert.equal(page.retest.mode, true);
    assert.equal(page.problem.index, page.retest.problemIndex);
    assert.equal(
      (
        await f.call("POST", `/v1/learn/points/${point}/answer`, {
          answer: "看不清",
          index: page.problem.index,
          tone: "dark",
        })
      ).statusCode,
      200,
    );
    assert.equal(f.row(point)?.predicted, null);
    const unsure = await f.call("POST", `/v1/learn/points/${point}/answer`, {
      answer: "看不清",
      index: page.problem.index,
      predicted: "unsure",
      tone: "dark",
    });
    assert.equal(unsure.json().data.verdict, "unsure");
    assert.equal(f.row(point)?.predicted, "unsure");
    const wrong = await f.call("POST", `/v1/learn/points/${point}/answer`, {
      answer: "999999",
      index: page.problem.index,
      predicted: "yes",
      tone: "dark",
    });
    assert.equal(wrong.json().data.retest.result, "wrong");
    assert.equal(wrong.json().data.retest.next.round, 2);
    assert.equal(f.row(point)?.due_on, "2026-10-10");
    assert.notEqual(f.row(point)?.problem_index, page.problem.index);
    f.clock.at = new Date("2026-10-10T01:00:00.000Z");
    const second = f.row(point)!;
    const failAgain = f.learn.answer(
      f.userId,
      point,
      "999999",
      second.problem_index,
      "no",
    );
    assert.equal(failAgain.retest?.round, 2);
    assert.equal(failAgain.retest?.result, "wrong");
    assert.equal(f.row(point), undefined);
    assert.equal(f.history(point).length, 2);

    const hinted = POINTS[1]!;
    f.learn.retests.schedule(f.userId, hinted, "ask", 0);
    f.clock.at = new Date("2026-10-12T01:00:00.000Z");
    f.store.db
      .prepare(
        "UPDATE retests SET due_on='2026-10-12' WHERE user_id=? AND point_id=? AND done_at IS NULL",
      )
      .run(f.userId, hinted);
    const hIndex = f.row(hinted)!.problem_index;
    const shown = await f.call("POST", "/v1/learn/marks", {
      action: "hint",
      pointId: hinted,
      index: hIndex,
      tone: "dark",
    });
    assert.equal(shown.json().data.retest.result, "hinted");
    assert.equal(shown.json().data.retest.predicted, null);
    assert.equal(shown.json().data.retest.next.round, 2);
  } finally {
    await f.app.close();
  }
});

test("选择题答错算帮助，填空题不算；到期复习帮助后当天不能通过、翌日重启7天", async () => {
  const f = await fixture();
  try {
    const choice = "limit-order";
    const correct = answer(choice, 0) as string[];
    const wrong = [...correct];
    wrong[0] = wrong[0] === "A" ? "B" : "A";
    const choiceResult = f.learn.answer(f.userId, choice, wrong, 0);
    assert.equal(choiceResult.practice, true);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT practice_on FROM map_points WHERE user_id=? AND point_id=?",
        )
        .get(f.userId, choice)!.practice_on,
      "2026-10-05",
    );
    assert.equal(f.row(choice)?.cause, "wrong");
    f.clock.at = new Date("2026-10-07T01:00:00.000Z");
    const planned = f.row(choice)!;
    const plannedAnswer = answer(choice, planned.problem_index) as string[];
    const plannedWrong = [...plannedAnswer];
    plannedWrong[0] = plannedWrong[0] === "A" ? "B" : "A";
    const retested = f.learn.answer(
      f.userId,
      choice,
      plannedWrong,
      planned.problem_index,
      "yes",
    );
    assert.equal(
      retested.retest?.result,
      "wrong",
      "到期后首次独立选择题错答仍是 wrong，只有此前已求助才是 hinted",
    );

    const fill = POINTS[0]!;
    const fillResult = f.learn.answer(f.userId, fill, "999999", 0);
    assert.equal(fillResult.practice, false);

    const review = POINTS[2]!;
    assert.equal(
      f.learn.answer(f.userId, review, answer(review, 0), 0).counted,
      "lit",
    );
    f.store.db
      .prepare(
        "UPDATE map_points SET due_on='2026-10-05',interval=7 WHERE user_id=? AND point_id=?",
      )
      .run(f.userId, review);
    f.learn.help(f.userId, review, "hint", 1);
    const lapse = f.learn.answer(f.userId, review, answer(review, 1), 1);
    assert.equal(lapse.counted, "lapse");
    const row = f.store.db
      .prepare(
        "SELECT due_on,interval FROM map_points WHERE user_id=? AND point_id=?",
      )
      .get(f.userId, review)!;
    assert.equal(row.due_on, "2026-10-08");
    assert.equal(row.interval, 0);
    assert.equal(
      f.learn.answer(f.userId, review, answer(review, 1), 1).counted,
      "lapse",
    );
    f.clock.at = new Date("2026-10-08T01:00:00.000Z");
    const passed = f.learn.answer(f.userId, review, answer(review, 1), 1);
    assert.equal(passed.counted, "review");
    assert.deepEqual(passed.review, { interval: 7 });
  } finally {
    await f.app.close();
  }
});

test("今天先保留已做，再排到期复测和复习，共用三个学习位", async () => {
  const f = await fixture();
  try {
    for (const point of POINTS.slice(0, 2))
      f.learn.retests.schedule(f.userId, point, "wrong", 0);
    f.clock.at = new Date("2026-10-07T01:00:00.000Z");
    const donePoint = POINTS[0]!,
      duePoint = POINTS[1]!;
    const doneIndex = f.row(donePoint)!.problem_index;
    f.learn.answer(
      f.userId,
      donePoint,
      answer(donePoint, doneIndex),
      doneIndex,
      "yes",
    );
    assert.equal(f.history(donePoint)[0]?.result, "right");
    for (const point of POINTS.slice(2, 5)) {
      f.learn.answer(f.userId, point, answer(point, 0), 0);
      f.store.db
        .prepare(
          "UPDATE map_points SET due_on='2026-10-07' WHERE user_id=? AND point_id=?",
        )
        .run(f.userId, point);
    }
    const today = f.learn.summary(f.userId).todayList;
    const learning = today.filter((item) => item.kind !== "new");
    assert.equal(learning.length, 3);
    assert.equal(learning[0]?.id, donePoint);
    assert.equal(learning[0]?.done, true);
    assert.ok(
      learning.some((item) => item.id === duePoint && item.kind === "retest"),
    );
    assert.equal(new Set(today.map((item) => item.id)).size, today.length);
  } finally {
    await f.app.close();
  }
});

test("今天不重复随心记已展示的点，复测按独立重点难点标签优先", async () => {
  const f = await fixture();
  try {
    const points = CALC_MAP.chapters.flatMap((chapter) => chapter.points);
    const special = points.find((point) => point.key || point.hard)!;
    const ordinary = points.find((point) => !point.key && !point.hard)!;
    f.learn.retests.schedule(f.userId, ordinary.id, "wrong", 0);
    f.learn.retests.schedule(f.userId, special.id, "wrong", 0);
    f.clock.at = new Date("2026-10-07T01:00:00.000Z");
    assert.equal(
      f.learn.summary(f.userId).todayList.find((item) => item.kind === "retest")
        ?.id,
      special.id,
      "复测优先级读 v2 的 key/hard 独立标签",
    );

    const at = f.clock.at.toISOString();
    f.store.db
      .prepare(
        "INSERT INTO events(user_id,name,data,created_at) VALUES(?,'resume_show',?,?)",
      )
      .run(f.userId, JSON.stringify({ src: "point", srcId: special.id }), at);
    f.store.db
      .prepare(
        "INSERT INTO events(user_id,name,data,created_at) VALUES(?,'resume_show',?,?)",
      )
      .run(
        f.userId,
        JSON.stringify({ src: "card", srcId: "card-1", pointId: ordinary.id }),
        at,
      );
    const ids = f.learn.summary(f.userId).todayList.map((item) => item.id);
    assert.equal(ids.includes(special.id), false);
    assert.equal(ids.includes(ordinary.id), false);
  } finally {
    await f.app.close();
  }
});

test("复测排题优先未见变式，重复标记定格，停止后不重排且恢复后可排", async () => {
  const f = await fixture();
  const point = POINTS[0]!;
  const original = PROBLEMS[point]!;
  try {
    PROBLEMS[point] = [...original, { ...original[0]! }];
    assert.deepEqual(chooseRetestProblem(point, 0, [0]), {
      problemIndex: 2,
      repeated: false,
    });
    assert.deepEqual(chooseRetestProblem(point, 2, [0, 2]), {
      problemIndex: 1,
      repeated: false,
    });
    // A problem shown as the worked example  only when nothing else is
    // left: a repeat of the used one first.
    assert.deepEqual(chooseRetestProblem(point, 0, [0], [2]), {
      problemIndex: 1,
      repeated: false,
    });
    assert.deepEqual(chooseRetestProblem(point, 0, [0], [1, 2]), {
      problemIndex: 0,
      repeated: true,
    });
    assert.deepEqual(chooseRetestProblem(point, 0, [0], [0, 1, 2]), {
      problemIndex: 2,
      repeated: false,
    });
    PROBLEMS[point] = original;
    f.learn.retests.schedule(f.userId, point, "wrong", 0);
    f.clock.at = new Date("2026-10-07T01:00:00.000Z");
    const first = f.row(point)!;
    f.learn.answer(f.userId, point, "999999", first.problem_index, "yes");
    const second = f.row(point)!;
    assert.equal(f.learn.retests.view(f.userId, second as any).repeated, true);
    PROBLEMS[point] = [...original, { ...original[0]! }];
    assert.equal(
      f.learn.retests.view(f.userId, second as any).repeated,
      true,
      "后来新增变式不能改写历史统计资格",
    );
    const stamp = f.clock.at.toISOString();
    f.store.db
      .prepare(
        "INSERT INTO resume_items(id,user_id,src,src_id,item_key,kind,state,due_on,created_at,updated_at) VALUES(?,?,'point',?,'retest','retest','never',?,?,?)",
      )
      .run(
        "point-retest-disabled",
        f.userId,
        point,
        "2026-10-12",
        stamp,
        stamp,
      );
    const dropped = f.learn.retests.drop(f.userId, point);
    assert.equal(dropped?.finished.result, "dropped");
    assert.equal(f.row(point), undefined);
    assert.equal(
      f.learn.retests.schedule(f.userId, point, "wrong", 0),
      null,
      "停止复测后，后续触发不能重新排题",
    );
    f.store.db
      .prepare(
        "UPDATE resume_items SET state='waiting' WHERE id='point-retest-disabled' AND user_id=?",
      )
      .run(f.userId);
    assert.ok(
      f.learn.retests.schedule(f.userId, point, "wrong", 0),
      "恢复条目后重新允许排题，旧 dropped 历史仍保留",
    );
    assert.equal(
      f.history(point).some((row) => row.result === "dropped"),
      true,
    );
  } finally {
    PROBLEMS[point] = original;
    await f.app.close();
  }
});

test("跨北京时间午夜的复测请求只取选择日和事务日，续排以事务日为准", async () => {
  const f = await fixture();
  try {
    const point = POINTS[0]!;
    f.learn.retests.schedule(f.userId, point, "wrong", 0);
    f.store.db
      .prepare(
        "UPDATE retests SET due_on='2026-10-06' WHERE user_id=? AND point_id=?",
      )
      .run(f.userId, point);
    const moments = [
      new Date("2026-10-05T15:59:59.999Z"),
      new Date("2026-10-05T16:00:00.001Z"),
    ];
    let reads = 0;
    const crossing = new LearnService(
      f.store,
      () => moments[Math.min(reads++, 1)]!,
    );
    const index = f.row(point)!.problem_index;
    const result = crossing.answer(f.userId, point, "999999", index, "yes");
    assert.equal(reads, 2);
    assert.equal(result.retest?.result, "wrong");
    assert.equal(result.retest?.next?.dueOn, "2026-10-09");
  } finally {
    await f.app.close();
  }
});

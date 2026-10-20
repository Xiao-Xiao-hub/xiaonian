import assert from "node:assert/strict";
import test from "node:test";
import { fakeServices, makeApp } from "./fixtures.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";
import { canonicalInput } from "../server/src/modules/learn/answers.js";
import { PROBLEMS } from "../server/src/modules/learn/problems.js";

async function fixture(
  overrides: Record<string, unknown> = {},
  env: Record<string, string> = {},
) {
  const clock = { at: new Date("2026-10-12T01:00:00.000Z") };
  const store = new SqliteStore(":memory:");
  const services = fakeServices(overrides);
  const app = makeApp(services, env, () => clock.at, store);
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: { key: "v2-map" },
  });
  const userId = login.json().data.user.id as string;
  const headers = { authorization: `Bearer ${login.json().data.token}` };
  const call = (
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
  return { app, store, services, clock, userId, headers, call };
}

test("地图返回教学范围、独立标签、推断来源、卡片错题和章节任务视图", async () => {
  const f = await fixture();
  try {
    f.store.db
      .prepare(
        "UPDATE users SET data=json_set(data,'$.suggestCards',json('true')) WHERE id=?",
      )
      .run(f.userId);
    assert.deepEqual((await f.call("GET", "/v1/me/settings")).json().data, {
      taughtTo: null,
    });
    const setting = await f.call("PUT", "/v1/me/settings", { taughtTo: "1.8" });
    assert.deepEqual(setting.json().data, { taughtTo: "1.8" });
    assert.equal(
      JSON.parse(
        f.store.db.prepare("SELECT data FROM users WHERE id=?").get(f.userId)!
          .data,
      ).suggestCards,
      true,
      "更新讲到哪不覆盖其它用户设置",
    );
    assert.equal(
      (await f.call("PUT", "/v1/me/settings", { taughtTo: "9.9" })).statusCode,
      400,
    );

    const at = f.clock.at.toISOString();
    f.store.db
      .prepare(
        "INSERT INTO map_points(user_id,point_id,correct_at,due_on,interval,practice_on,updated_at) VALUES(?,?,?,'2026-10-20',7,NULL,?)",
      )
      .run(f.userId, "limit-1-to-inf", at, at);
    f.store.db
      .prepare(
        "INSERT INTO map_points(user_id,point_id,practice_on,updated_at) VALUES(?,?,'2026-10-12',?)",
      )
      .run(f.userId, "limit-continuity", at);
    f.store.db
      .prepare(
        "INSERT INTO map_points(user_id,point_id,self_at,updated_at) VALUES(?,?,?,?)",
      )
      .run(f.userId, "limit-monotone", at, at);
    for (let i = 0; i < 4; i++)
      f.store.db
        .prepare(
          "INSERT INTO cards(id,user_id,type,scene,title,title_by,origin,point_id,created_at,updated_at) VALUES(?,?,'question','study',?,'user','map','limit-order',?,?)",
        )
        .run(`map-card-${i}`, f.userId, `卡${i}`, at, at);
    f.store.db
      .prepare(
        "INSERT INTO cards(id,user_id,type,scene,title,title_by,origin,point_id,crisis,created_at,updated_at) VALUES('map-card-crisis',?,'question','study','危机','user','map','limit-order',1,?,?)",
      )
      .run(f.userId, at, at);
    f.store.db
      .prepare(
        "INSERT INTO materials(id,user_id,kind,title,status,current_version,created_at,updated_at) VALUES('map-mat',?,'problem','题','confirmed',1,?,?)",
      )
      .run(f.userId, at, at);
    f.store.db
      .prepare(
        "INSERT INTO material_versions(material_id,version,origin,text,paragraphs,created_at) VALUES('map-mat',1,'typed','题','[]',?)",
      )
      .run(at);
    f.store.db
      .prepare(
        "INSERT INTO mistakes(id,user_id,material_id,source,status,due_on,created_at,updated_at,map_point_id,map_version) VALUES('map-mistake',?,'map-mat','judge','open','2026-10-12',?,?,'limit-order',1)",
      )
      .run(f.userId, at, at);

    const response = await f.call("GET", "/v1/learn/map?view=task&level=near");
    assert.equal(response.statusCode, 200);
    const map = response.json().data;
    assert.equal(map.taughtTo, "1.8");
    assert.equal(map.resumeActive, false);
    // The learn home's 错题本 tile counts open mistakes (v4 fix C).
    assert.equal(map.mistakesOpen, 1);
    const related = (
      await f.call("GET", "/v1/mistakes?pointId=limit-order")
    ).json().data;
    assert.equal(related.items.length, 1);
    assert.equal(related.counts.open, 1);
    assert.equal(related.counts.point.id, "limit-order");
    assert.equal(
      (await f.call("GET", "/v1/mistakes?pointId=limit-rules")).json().data
        .items.length,
      0,
    );
    f.store.db
      .prepare("UPDATE mistakes SET map_version=2 WHERE id='map-mistake'")
      .run();
    const stale = (
      await f.call("GET", "/v1/mistakes?pointId=limit-order")
    ).json().data;
    assert.equal(stale.items.length, 0);
    assert.equal(stale.counts.open, 0);
    f.store.db
      .prepare("UPDATE mistakes SET map_version=1 WHERE id='map-mistake'")
      .run();
    const chapter = map.chapters.find((item: any) => item.id === "limit");
    assert.equal(chapter.nodes.length, 6);
    assert.equal(chapter.sides.length, 2);
    assert.deepEqual(Object.keys(chapter.main).sort(), [
      "correct",
      "self",
      "total",
    ]);
    assert.deepEqual(Object.keys(chapter.side).sort(), ["correct", "total"]);
    const byId = new Map(chapter.points.map((point: any) => [point.id, point]));
    assert.equal((byId.get("limit-1-to-inf") as any).state, "correct");
    assert.equal((byId.get("limit-order") as any).state, "inferred");
    assert.equal(
      (byId.get("limit-order") as any).inferredBy.id,
      "limit-1-to-inf",
    );
    assert.equal((byId.get("limit-continuity") as any).state, "practice");
    assert.equal((byId.get("limit-monotone") as any).state, "self");
    assert.equal((byId.get("limit-continuity") as any).taught, true);
    assert.equal((byId.get("limit-zero-theorem") as any).taught, false);
    assert.equal((byId.get("limit-order") as any).cards.count, 4);
    assert.equal((byId.get("limit-order") as any).cards.items.length, 3);
    assert.equal((byId.get("limit-order") as any).mistakeCount, 1);
    assert.ok((byId.get("limit-order") as any).followers.items.length <= 3);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT count(*) n FROM events WHERE user_id=? AND name='map_open' AND json_extract(data,'$.level')='near'",
        )
        .get(f.userId)!.n,
      1,
    );
  } finally {
    await f.app.close();
  }
});

test("章节下一步按到期复测、卡住、重点探路和答错后的直接先修排序", async () => {
  const f = await fixture();
  try {
    await f.call("PUT", "/v1/me/settings", { taughtTo: "all" });
    const at = f.clock.at.toISOString();
    f.store.db
      .prepare(
        "INSERT INTO retests(user_id,point_id,cause,problem_index,round,due_on,created_at) VALUES(?,?,'hint',0,1,'2026-10-12',?)",
      )
      .run(f.userId, "limit-continuity", at);
    let chapter = (await f.call("GET", "/v1/learn/map")).json().data
      .chapters[0];
    assert.equal(chapter.next.id, "limit-continuity");
    f.store.db
      .prepare("UPDATE retests SET result='dropped',done_at=? WHERE user_id=?")
      .run(at, f.userId);
    f.store.db
      .prepare(
        "INSERT INTO map_points(user_id,point_id,stuck_at,updated_at) VALUES(?,?,?,?)",
      )
      .run(f.userId, "limit-monotone", at, at);
    chapter = (await f.call("GET", "/v1/learn/map")).json().data.chapters[0];
    assert.equal(chapter.next.id, "limit-monotone");
    f.store.db
      .prepare("UPDATE map_points SET stuck_at=NULL WHERE user_id=?")
      .run(f.userId);
    // Once a point of the chapter is done, key points come first again.
    f.store.db
      .prepare(
        "INSERT INTO map_points(user_id,point_id,correct_at,due_on,interval,updated_at) VALUES(?,?,?,'2026-10-20',7,?) ON CONFLICT(user_id,point_id) DO UPDATE SET correct_at=excluded.correct_at,due_on=excluded.due_on,interval=excluded.interval",
      )
      .run(f.userId, "limit-function", at, at);
    chapter = (await f.call("GET", "/v1/learn/map")).json().data.chapters[0];
    assert.equal(
      chapter.points.find((point: any) => point.id === chapter.next.id).key,
      true,
    );
    f.store.db
      .prepare(
        "INSERT INTO retests(user_id,point_id,cause,problem_index,round,due_on,created_at) VALUES(?,?,'wrong',0,1,'2026-10-14',?)",
      )
      .run(f.userId, chapter.next.id, at);
    const afterWrong = (await f.call("GET", "/v1/learn/map")).json().data
      .chapters[0];
    assert.notEqual(afterWrong.next.id, chapter.next.id);
    assert.match(afterWrong.next.reason, /前面那一步/);
  } finally {
    await f.app.close();
  }
});

test("本章一个都没做对时按课本顺序推荐第一个讲到的期末要考点，做对过后仍先推重点（D101）", async () => {
  const f = await fixture();
  try {
    const limit = CALC_MAP.chapters[0]!;
    const main = limit.points.filter((point) => point.line === "main");
    const chapterNow = async () =>
      (await f.call("GET", "/v1/learn/map")).json().data.chapters[0];
    // No 讲到哪 set: from the first point of the chapter.
    let chapter = await chapterNow();
    assert.deepEqual(chapter.next, {
      id: main[0]!.id,
      name: main[0]!.name,
      reason: "从这里开始",
    });
    assert.equal(main[0]!.key, false, "the first point is not the hardest one");
    // A 讲到哪 that covers it keeps the same textbook order, key points not first.
    await f.call("PUT", "/v1/me/settings", { taughtTo: "all" });
    chapter = await chapterNow();
    assert.equal(chapter.next.id, main[0]!.id);
    // 我会了 is not 做对: the chapter is still fresh.
    await f.call("POST", "/v1/learn/marks", {
      action: "self",
      pointId: main[0]!.id,
    });
    assert.equal((await chapterNow()).next.id, main[0]!.id);
    // One point done: the old rule (key points, most missing prerequisites first).
    const at = f.clock.at.toISOString();
    f.store.db
      .prepare(
        "INSERT INTO map_points(user_id,point_id,correct_at,due_on,interval,updated_at) VALUES(?,?,?,'2026-10-20',7,?) ON CONFLICT(user_id,point_id) DO UPDATE SET correct_at=excluded.correct_at,due_on=excluded.due_on,interval=excluded.interval",
      )
      .run(f.userId, main[0]!.id, at, at);
    chapter = await chapterNow();
    const next = chapter.points.find((point: any) => point.id === chapter.next.id);
    assert.equal(next.line, "main");
    assert.equal(next.key, true);
    assert.notEqual(chapter.next.reason, "从这里开始");
    // Other chapters with nothing done still start from their first point.
    const derivative = (await f.call("GET", "/v1/learn/map")).json().data
      .chapters[1];
    assert.equal(
      derivative.next.id,
      CALC_MAP.chapters[1]!.points.find((point) => point.line === "main")!.id,
    );
  } finally {
    await f.app.close();
  }
});

test("关系图覆盖当前点和先修边，坐标为左上角且跨章关系单列", async () => {
  const f = await fixture();
  try {
    for (const chapter of CALC_MAP.chapters) {
      const response = await f.call(
        "GET",
        `/v1/learn/map/graph?chapter=${chapter.id}`,
      );
      assert.equal(response.statusCode, 200);
      const graph = response.json().data;
      assert.equal(graph.nodes.length, chapter.points.length);
      assert.ok(graph.width > 0 && graph.height > 0);
      assert.ok(
        graph.nodes.every(
          (node: any) => node.x >= 0 && node.y >= 0 && node.width === 120,
        ),
      );
      assert.ok(
        graph.edges.every(
          (edge: any) =>
            edge.crossChapter === false &&
            edge.label === null &&
            edge.points.length >= 2,
        ),
      );
    }
    const derivative = (
      await f.call("GET", "/v1/learn/map/graph?chapter=application")
    ).json().data;
    assert.ok(derivative.external.length > 0);
    assert.deepEqual(Object.keys(derivative.external[0]).sort(), [
      "chapterId",
      "from",
      "label",
      "to",
    ]);
    assert.equal(
      (await f.call("GET", "/v1/learn/map/graph?chapter=missing")).statusCode,
      404,
    );
  } finally {
    await f.app.close();
  }
});

test("卡住引导只带安全字段，核对引文和先修，成功记帮助并共用聊天额度", async () => {
  const f = await fixture(
    {
      ask: {
        quote: "取对数后不会化",
        ask: "卡在哪一步？",
        options: ["写成指数", "算指数极限"],
        suggest: "limit-equivalent",
      },
    },
    // one help (≈ ¥0.0005 at the test model's highest rate) uses up the day.
    { DAILY_BUDGET_CNY: "0.0001" },
  );
  try {
    const sent = await f.call("POST", "/v1/learn/points/limit-1-to-inf/stuck", {
      text: "取对数后不会化",
    });
    assert.equal(sent.statusCode, 200);
    assert.deepEqual(sent.json().data, {
      crisis: false,
      quote: "取对数后不会化",
      ask: "卡在哪一步？",
      options: ["写成指数", "算指数极限"],
      suggest: "limit-equivalent",
    });
    assert.equal(f.services.llm.at(-1)?.kind, "ask");
    assert.doesNotMatch(f.services.llm.at(-1)!.prompt, /why|answer|解析/);
    const point = f.store.db
      .prepare(
        "SELECT practice_on,stuck_at FROM map_points WHERE user_id=? AND point_id='limit-1-to-inf'",
      )
      .get(f.userId)!;
    assert.equal(point.practice_on, "2026-10-12");
    assert.ok(point.stuck_at);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT count(*) n FROM quota_receipts WHERE user_id=? AND source='chat' AND kind='map_stuck'",
        )
        .get(f.userId)!.n,
      1,
    );
    const limited = await f.call(
      "POST",
      "/v1/learn/points/limit-equivalent/stuck",
      { text: "不知道第一步" },
    );
    assert.equal(limited.statusCode, 429);
  } finally {
    await f.app.close();
  }
});

test("卡住危机不调模型，格式失败固定降级且不把引导算作帮助", async () => {
  const crisis = await fixture({
    ask: { quote: "", ask: "x", options: ["a", "b"], suggest: null },
  });
  try {
    const response = await crisis.call(
      "POST",
      "/v1/learn/points/limit-order/stuck",
      { text: "我不想活了" },
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.crisis, true);
    assert.equal(crisis.services.llm.length, 0);
  } finally {
    await crisis.app.close();
  }
  const fallback = await fixture({
    ask: { quote: "编的", ask: "x", options: ["只有一个"], suggest: "bad" },
  });
  try {
    const response = await fallback.call(
      "POST",
      "/v1/learn/points/limit-order/stuck",
      { text: "这一步看不懂" },
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.fallback, true);
    assert.equal(
      fallback.store.db
        .prepare(
          "SELECT practice_on FROM map_points WHERE user_id=? AND point_id='limit-order'",
        )
        .get(fallback.userId)!.practice_on,
      null,
    );
  } finally {
    await fallback.app.close();
  }
});

test("独立复测通过授权学习卡收尾，普通首次点亮只清卡住状态", async () => {
  const f = await fixture();
  try {
    const at = f.clock.at.toISOString();
    await f.call("POST", "/v1/learn/marks", {
      action: "stuck",
      pointId: "limit-continuity",
    });
    const first = await f.call(
      "POST",
      "/v1/learn/points/limit-continuity/answer",
      {
        answer: canonicalInput(PROBLEMS["limit-continuity"]![0]!),
        index: 0,
        tone: "dark",
      },
    );
    assert.equal(first.json().data.counted, "lit");
    assert.equal("learningCards" in first.json().data, false);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT stuck_at FROM map_points WHERE user_id=? AND point_id='limit-continuity'",
        )
        .get(f.userId)!.stuck_at,
      null,
    );

    f.store.db
      .prepare(
        "INSERT INTO retests(user_id,point_id,cause,problem_index,round,due_on,created_at) VALUES(?,?,'wrong',1,1,'2026-10-12',?)",
      )
      .run(f.userId, "limit-order", at);
    f.store.db
      .prepare(
        "INSERT INTO cards(id,user_id,type,scene,title,title_by,mine,mine_at,origin,point_id,created_at,updated_at) VALUES('learning-card',?,'question','study','怎么判断','user','先比较阶',?,'map','limit-order',?,?)",
      )
      .run(f.userId, at, at, at);
    const passed = await f.call("POST", "/v1/learn/points/limit-order/answer", {
      answer: canonicalInput(PROBLEMS["limit-order"]![1]!),
      index: 1,
      predicted: "yes",
      tone: "dark",
    });
    assert.equal(passed.statusCode, 200);
    assert.equal(passed.json().data.retest.result, "right");
    assert.deepEqual(passed.json().data.learningCards.cardIds, [
      "learning-card",
    ]);
    assert.ok(
      f.store.db
        .prepare("SELECT closed_at FROM cards WHERE id='learning-card'")
        .get()!.closed_at,
    );
  } finally {
    await f.app.close();
  }
});

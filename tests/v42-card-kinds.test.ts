import assert from "node:assert/strict";
import test from "node:test";
import { CardService } from "../server/src/modules/cards/service.js";
import { CrisisSafetyService } from "../server/src/modules/safety/service.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { fakeServices, makeApp } from "./fixtures.js";

// seven kinds over the four-way type, follow-up defaults, kind-aware
// closing. All text below is synthetic.
function setup(answer?: { choice: string; confidence: number }) {
  const store = new SqliteStore(":memory:");
  const owner = store.upsertUser("dev:kinds-owner", "甲", "dev").id;
  const judge = answer
    ? {
        choice: async (_s: unknown, _i: string, criteria: Record<string, string>) => {
          if (!(answer.choice in criteria)) throw new Error("unknown choice");
          return { ...answer, probabilities: { [answer.choice]: answer.confidence } };
        },
      }
    : undefined;
  const cards = new CardService(
    store,
    new CrisisSafetyService({ noul: async () => 0 }),
    undefined,
    undefined,
    judge as never,
  );
  return { store, owner, cards };
}

test("a confident judge picks one of the seven kinds; type is its four-way value", async () => {
  const { store, owner, cards } = setup({ choice: "todo", confidence: 0.92 });
  try {
    const { card } = await cards.create(owner, { text: "周五前交线代作业" });
    assert.equal(card.kind, "todo");
    assert.equal(card.type, "idea");
    assert.equal(card.follow, "done");
    const row = store.db.prepare("SELECT type,kind,follow FROM cards WHERE id=?").get(card.id)!;
    assert.deepEqual({ ...row }, { type: "idea", kind: "todo", follow: null });
    // Old clients filter by type and still find it; new ones filter by kind.
    assert.equal(cards.list(owner, { type: ["idea"] }).total, 1);
    assert.equal(cards.list(owner, { kind: ["todo"] }).total, 1);
    assert.equal(cards.list(owner, { kind: ["idea"] }).total, 0);
    assert.equal(cards.stats(owner).byKind.todo, 1);
    assert.equal(cards.stats(owner).byType.idea, 1);
  } finally {
    store.close();
  }
});

test("low confidence falls back to 随手记, which asks nothing later", async () => {
  const { store, owner, cards } = setup({ choice: "idea", confidence: 0.41 });
  try {
    const { card } = await cards.create(owner, { text: "图书馆三楼靠窗位置有插座" });
    assert.equal(card.kind, "note");
    assert.equal(card.type, "idea");
    assert.equal(card.follow, "none");
    // A question mark is only a clue: it counts when the judge is unsure.
    const asked = await cards.create(owner, { text: "泰勒展开到底要展开到第几阶才够？" });
    assert.equal(asked.card.kind, "question");
  } finally {
    store.close();
  }
});

test("without a judge the old rule still finds questions and the rest is 随手记", async () => {
  const { store, owner, cards } = setup();
  try {
    assert.equal((await cards.create(owner, { text: "为什么洛必达要求分母导数不为零" })).card.kind, "question");
    assert.equal((await cards.create(owner, { text: "今天食堂的麻辣香锅不错" })).card.kind, "note");
  } finally {
    store.close();
  }
});

test("old-client payloads: type on create and update sets the kind", async () => {
  const { store, owner, cards } = setup({ choice: "note", confidence: 0.99 });
  try {
    const { card } = await cards.create(owner, { text: "先列提纲再写正文", type: "method" });
    assert.equal(card.kind, "method");
    const known = await cards.update(owner, card.id, card.version, { kind: "knowledge" });
    assert.equal(known.card.kind, "knowledge");
    assert.equal(known.card.type, "method");
    assert.equal(known.card.follow, "review");
    // An old client changes the type: the kind follows it.
    const old = await cards.update(owner, card.id, known.card.version, { type: "question" });
    assert.equal(old.card.kind, "question");
    assert.equal(old.card.type, "question");
    const row = store.db.prepare("SELECT kind FROM cards WHERE id=?").get(card.id)!;
    assert.equal(row.kind, "question");
  } finally {
    store.close();
  }
});

test("a kind the type no longer matches (rollback edits) gives way to the type", async () => {
  const { store, owner, cards } = setup({ choice: "knowledge", confidence: 0.95 });
  try {
    const { card } = await cards.create(owner, { text: "二战于1945年结束" });
    assert.equal(card.kind, "knowledge");
    // A v4.1 server changed only the type.
    store.db.prepare("UPDATE cards SET type='idea' WHERE id=?").run(card.id);
    assert.equal(cards.detail(owner, card.id).kind, "idea");
    assert.equal(cards.list(owner, { kind: ["knowledge"] }).total, 0);
    assert.equal(cards.list(owner, { kind: ["idea"] }).total, 1);
  } finally {
    store.close();
  }
});

test("follow defaults by kind and scene; legacy rows derive the same; the user can change it", async () => {
  const { store, owner, cards } = setup();
  try {
    const expect: Record<string, string> = {
      todo: "done",
      knowledge: "review",
      question: "chat",
      idea: "chat",
      method: "review",
      spark: "none",
      note: "none",
    };
    for (const [kind, follow] of Object.entries(expect)) {
      const { card } = await cards.create(owner, { text: `合成的${kind}内容`, kind: kind as never });
      assert.equal(card.follow, follow, kind);
    }
    // A v4.1 row: no kind, no follow.
    const { card } = await cards.create(owner, { text: "旧卡的想法", type: "idea" });
    store.db.prepare("UPDATE cards SET kind=NULL,follow=NULL WHERE id=?").run(card.id);
    assert.equal(cards.detail(owner, card.id).follow, "chat");
    store.db
      .prepare("UPDATE users SET data=json_set(data,'$.moodConsentAt',?) WHERE id=?")
      .run(store.now(), owner);
    store.db.prepare("UPDATE cards SET scene='mood' WHERE id=?").run(card.id);
    assert.equal(cards.detail(owner, card.id).follow, "none");
    const set = await cards.update(owner, card.id, cards.detail(owner, card.id).version, { follow: "review" });
    assert.equal(set.card.follow, "review");
    // Changing the kind lets the new kind's default apply again.
    const moved = await cards.update(owner, card.id, set.card.version, { kind: "todo", scene: "life" });
    assert.equal(moved.card.follow, "done");
    assert.equal(moved.card.scene, "life");
  } finally {
    store.close();
  }
});

// the earlier kind's slots are kept as 补充 (they used to stay as
// slots, which old clients and v4.1 cannot save back).
test("type change keeps slots, the earlier kind's as 补充", async () => {
  const { store, owner, cards } = setup();
  try {
    const { card } = await cards.create(owner, { text: "我觉得先复习再刷题", type: "idea" });
    const filled = await cards.update(owner, card.id, card.version, {
      slots: [{ key: "claim", text: "先复习" }],
    });
    const moved = await cards.update(owner, card.id, filled.card.version, {
      kind: "method",
      slots: [{ key: "steps", text: "先看书再做题" }],
    });
    assert.deepEqual(
      moved.card.slots.map((s) => (s as { key: string }).key),
      ["steps"],
    );
    assert.deepEqual(moved.card.supplements.map((x) => x.text), ["我认为：先复习"]);
    const kept = await cards.update(owner, card.id, moved.card.version, { kind: "question" });
    assert.deepEqual(kept.card.slots, []);
    assert.deepEqual(
      kept.card.supplements.map((x) => x.text).sort(),
      ["我认为：先复习", "步骤：先看书再做题"],
    );
  } finally {
    store.close();
  }
});

test("a 待办 closes without words; short words are enough for the others", async () => {
  const { store, owner, cards } = setup();
  try {
    const todo = (await cards.create(owner, { text: "明天去教务处盖章", kind: "todo" })).card;
    const done = await cards.close(owner, todo.id, todo.version);
    assert.equal(done.card.stage, "closed");
    assert.equal(done.card.mine, null);
    assert.equal(cards.list(owner, { closed: true }).total, 1);
    assert.equal(cards.stats(owner).closed, 1);
    const idea = (await cards.create(owner, { text: "先约分再代入更快", kind: "idea" })).card;
    await assert.rejects(cards.close(owner, idea.id, idea.version), /写一句/);
    const closed = await cards.close(owner, idea.id, idea.version, "先约分");
    assert.equal(closed.card.stage, "closed");
    const mine = (await cards.create(owner, { text: "记一句", kind: "note" })).card;
    assert.equal((await cards.mine(owner, mine.id, mine.version, { text: "约分" })).card.mine, "约分");
  } finally {
    store.close();
  }
});

test("search finds words in the organized slots", async () => {
  const { store, owner, cards } = setup();
  try {
    const { card } = await cards.create(owner, { text: "极限题的套路", kind: "method" });
    await cards.update(owner, card.id, card.version, {
      slots: [{ key: "pitfall", text: "忘了检查分母为零" }],
    });
    assert.equal(cards.list(owner, { search: "分母为零" }).total, 1);
  } finally {
    store.close();
  }
});

test("linking two cards no longer closes a spark", async () => {
  const { store, owner, cards } = setup();
  try {
    const a = (await cards.create(owner, { text: "要是错题做成扑克牌", kind: "spark", mine: "抽牌复习" })).card;
    const b = (await cards.create(owner, { text: "每天抽三张复习", kind: "idea", mine: "每天三张" })).card;
    const linked = cards.link(owner, a.id, a.version, b.id);
    assert.equal(linked.closedAt, null);
    assert.notEqual(linked.stage, "closed");
  } finally {
    store.close();
  }
});

test("HTTP: kind, follow and clientId on POST; kind filter on GET; a retried save returns the first card", async () => {
  const services = fakeServices();
  services.judge.noul = 0;
  const app = makeApp(services);
  try {
    const login = (
      await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "kinds-http" } })
    ).json().data;
    const headers = { authorization: `Bearer ${login.token}` };
    const post = () =>
      app.inject({
        method: "POST",
        url: "/v1/cards",
        headers,
        payload: { text: "买洗衣液和充电线", kind: "todo", follow: "none", clientId: "save-0001-abc" },
      });
    const first = await post();
    assert.equal(first.statusCode, 200, first.body);
    const again = await post();
    assert.equal(again.json().data.card.id, first.json().data.card.id);
    const card = first.json().data.card;
    assert.equal(card.kind, "todo");
    assert.equal(card.type, "idea");
    assert.equal(card.follow, "none");
    const listed = await app.inject({ url: "/v1/cards?kind=todo,note", headers });
    assert.equal(listed.json().data.total, 1);
    const old = await app.inject({ url: "/v1/cards?type=idea", headers });
    assert.equal(old.json().data.total, 1);
    const bad = await app.inject({ url: "/v1/cards?kind=todo2", headers });
    assert.equal(bad.statusCode, 400);
    // The automatic tidy may have moved the version on.
    let version = card.version;
    for (let i = 0; i < 500; i++) {
      const detail = (await app.inject({ url: `/v1/cards/${card.id}`, headers })).json().data;
      version = detail.version;
      if (!detail.aiJob || !["queued", "running"].includes(detail.aiJob.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/cards/${card.id}`,
      headers,
      payload: { version, kind: "knowledge", follow: "review" },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(patched.json().data.card.kind, "knowledge");
    assert.equal(patched.json().data.card.type, "method");
  } finally {
    await app.close();
  }
});

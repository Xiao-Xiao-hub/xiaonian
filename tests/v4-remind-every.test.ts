import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { MIGRATIONS, SqliteStore } from "../server/src/shared/store.js";
import { fakeServices, makeApp } from "./fixtures.js";

// 提醒频率 : card_reminders holds day / week; cards.remind_on stays the
// next date, moved on after each answer.
function fixture(t: TestContext, start = "2026-10-17T02:00:00.000Z") {
  let at = Date.parse(start);
  const now = () => new Date(at);
  const store = new SqliteStore(":memory:", now);
  const services = fakeServices();
  services.judge.noul = 0;
  const app = makeApp(services, {}, now, store);
  t.after(() => app.close());
  const login = async (key: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key },
    });
    const { token, user } = response.json().data;
    const call = (
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      url: string,
      payload?: object,
    ) =>
      app.inject({
        method,
        url,
        payload,
        headers: { authorization: "Bearer " + token },
      });
    // Waits for the automatic tidy so the version stays put.
    const settled = async (id: string) => {
      for (let i = 0; i < 500; i++) {
        const detail = (await call("GET", `/v1/cards/${id}`)).json().data;
        if (
          !detail.aiJob ||
          !["queued", "running"].includes(detail.aiJob.status)
        )
          return detail;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error("tidy did not settle");
    };
    return { userId: user.id as string, call, settled };
  };
  return {
    store,
    login,
    setNow: (iso: string) => {
      at = Date.parse(iso);
    },
  };
}
const rows = (store: SqliteStore, cardId: string) =>
  store.db
    .prepare("SELECT every FROM card_reminders WHERE card_id=?")
    .all(cardId)
    .map((row) => ({ every: String(row.every) }));

test("old clients: no remindEvery sent, the card says null and nothing is stored", async (t) => {
  const { login, store } = fixture(t);
  const me = await login("re-old");
  const made = await me.call("POST", "/v1/cards", {
    text: "周末想整理一下错题",
    type: "idea",
  });
  assert.equal(made.statusCode, 200, made.body);
  const card = made.json().data.card;
  assert.equal(card.remindEvery, null);
  assert.equal(card.remindOn, null);
  const detail = await me.settled(card.id);
  const dated = await me.call("PATCH", `/v1/cards/${card.id}`, {
    version: detail.version,
    remindOn: "2026-10-20",
  });
  assert.equal(dated.statusCode, 200, dated.body);
  assert.equal(dated.json().data.card.remindOn, "2026-10-20");
  assert.equal(dated.json().data.card.remindEvery, null);
  assert.deepEqual(rows(store, card.id), []);
  // The cards table keeps its columns: the new table carries the frequency.
  const columns = store.db.prepare("PRAGMA table_info(cards)").all() as {
    name: string;
  }[];
  assert.ok(!columns.some((c) => /every|remind_every/.test(c.name)));
  const version = store.db
    .prepare("SELECT MAX(version) AS v FROM schema_migrations")
    .get() as { v: number };
  assert.equal(version.v, MIGRATIONS.length);
});

test("saving with 每天 starts tomorrow; an answer moves it on from today, 不再提起 ends it", async (t) => {
  const { login, store, setNow } = fixture(t);
  const me = await login("re-day");
  const made = await me.call("POST", "/v1/cards", {
    text: "每天背十个单词",
    type: "idea",
    remindEvery: "day",
  });
  assert.equal(made.statusCode, 200, made.body);
  const card = made.json().data.card;
  assert.equal(card.remindEvery, "day");
  assert.equal(card.remindOn, "2026-10-18");
  assert.deepEqual(rows(store, card.id), [{ every: "day" }]);
  await me.settled(card.id);
  // Answered three days late: the next one is tomorrow, not a day already gone.
  setNow("2026-10-21T02:00:00.000Z");
  const list = async () =>
    (
      (await me.call("GET", "/v1/resume")).json().data as {
        id: string;
        srcId: string;
        kind: string;
        dueOn: string;
      }[]
    ).filter((i) => i.srcId === card.id && i.kind === "chat"); // an idea's reminder asks 接着聊
  let items = await list();
  assert.deepEqual(
    items.map((i) => i.dueOn),
    ["2026-10-18"],
  );
  const answered = await me.call("POST", `/v1/resume/${items[0]!.id}/act`, {
    action: "answer",
    text: "背完了今天的",
  });
  assert.equal(answered.statusCode, 200, answered.body);
  let detail = await me.settled(card.id);
  assert.equal(detail.remindOn, "2026-10-22");
  assert.equal(detail.remindEvery, "day");
  items = await list();
  assert.deepEqual(
    items.map((i) => i.dueOn),
    ["2026-10-22"],
  );
  // 还在进行 counts as no answer elsewhere; here it waits for the next day
  // instead of a three-day snooze.
  setNow("2026-10-22T02:00:00.000Z");
  const going = await me.call("POST", `/v1/resume/${items[0]!.id}/act`, {
    action: "answer",
    text: "还在进行",
  });
  assert.equal(going.statusCode, 200, going.body);
  detail = await me.settled(card.id);
  assert.equal(detail.remindOn, "2026-10-23");
  items = await list();
  assert.deepEqual(
    items.map((i) => i.dueOn),
    ["2026-10-23"],
  );
  // Undo puts the date back.
  const undone = await me.call("POST", "/v1/resume/undo", {
    token: going.json().data.undoToken,
  });
  assert.equal(undone.statusCode, 200, undone.body);
  detail = await me.settled(card.id);
  assert.equal(detail.remindOn, "2026-10-22");
  // 不再提起 ends the frequency and the date; undo brings both back.
  items = await list();
  const never = await me.call("POST", `/v1/resume/${items[0]!.id}/act`, {
    action: "never",
  });
  assert.equal(never.statusCode, 200, never.body);
  detail = await me.settled(card.id);
  assert.equal(detail.remindEvery, null);
  assert.equal(detail.remindOn, null);
  assert.deepEqual(rows(store, card.id), []);
  const back = await me.call("POST", "/v1/resume/undo", {
    token: never.json().data.undoToken,
  });
  assert.equal(back.statusCode, 200, back.body);
  detail = await me.settled(card.id);
  assert.equal(detail.remindEvery, "day");
  assert.equal(detail.remindOn, "2026-10-22");
});

test("PATCH sets 每周, a picked date keeps it, 不提醒 or remindEvery null turns it off", async (t) => {
  const { login, store } = fixture(t);
  const me = await login("re-week");
  const made = await me.call("POST", "/v1/cards", {
    text: "这周想把极限复习完",
    type: "idea",
  });
  const id = made.json().data.card.id as string;
  let detail = await me.settled(id);
  // A card with reminders off: a frequency turns them on for set dates.
  const off = await me.call("PATCH", `/v1/cards/${id}`, {
    version: detail.version,
    resume: "off",
  });
  const weekly = await me.call("PATCH", `/v1/cards/${id}`, {
    version: off.json().data.card.version,
    remindEvery: "week",
  });
  assert.equal(weekly.statusCode, 200, weekly.body);
  let card = weekly.json().data.card;
  assert.equal(card.remindEvery, "week");
  assert.equal(card.remindOn, "2026-10-24");
  assert.equal(card.resume, "manual");
  // Only remindEvery is a change on its own (not 没有要改的地方).
  const picked = await me.call("PATCH", `/v1/cards/${id}`, {
    version: card.version,
    remindOn: "2026-10-20",
  });
  card = picked.json().data.card;
  assert.equal(card.remindOn, "2026-10-20");
  assert.equal(card.remindEvery, "week");
  const stop = await me.call("PATCH", `/v1/cards/${id}`, {
    version: card.version,
    remindOn: null,
  });
  card = stop.json().data.card;
  assert.equal(card.remindOn, null);
  assert.equal(card.remindEvery, null);
  assert.deepEqual(rows(store, id), []);
  const daily = await me.call("PATCH", `/v1/cards/${id}`, {
    version: card.version,
    remindEvery: "day",
  });
  card = daily.json().data.card;
  assert.equal(card.remindOn, "2026-10-18");
  const none = await me.call("PATCH", `/v1/cards/${id}`, {
    version: card.version,
    remindEvery: null,
  });
  card = none.json().data.card;
  assert.equal(card.remindEvery, null);
  assert.equal(card.remindOn, null);
  const bad = await me.call("PATCH", `/v1/cards/${id}`, {
    version: card.version,
    remindEvery: "month",
  });
  assert.equal(bad.statusCode, 400);
  detail = await me.settled(id);
  assert.equal(detail.remindEvery, null);
});

test("closing the card from 回顾 ends the frequency", async (t) => {
  const { login, store } = fixture(t);
  const me = await login("re-close");
  const made = await me.call("POST", "/v1/cards", {
    text: "要不要换个时间复习",
    type: "idea",
    mine: "我决定改成晚上九点复习比较好",
    remindEvery: "day",
  });
  const id = made.json().data.card.id as string;
  await me.settled(id);
  const items = (
    (await me.call("GET", "/v1/resume")).json().data as {
      id: string;
      srcId: string;
      kind: string;
    }[]
  ).filter((i) => i.srcId === id && i.kind === "chat"); // an idea's reminder asks 接着聊
  assert.equal(items.length, 1);
  const done = await me.call("POST", `/v1/resume/${items[0]!.id}/act`, {
    action: "answer",
    text: "已完成",
  });
  assert.equal(done.statusCode, 200, done.body);
  const detail = await me.settled(id);
  assert.equal(detail.stage, "closed");
  assert.equal(detail.remindOn, null);
  assert.deepEqual(rows(store, id), []);
});

test("stats count each type; the frequency is exported and goes with the card and the account", async (t) => {
  const { login, store } = fixture(t);
  const me = await login("re-export");
  const a = (
    await me.call("POST", "/v1/cards", {
      text: "一个灵感",
      type: "spark",
      remindEvery: "week",
    })
  ).json().data.card;
  const b = (
    await me.call("POST", "/v1/cards", {
      text: "一个问题怎么解",
      type: "question",
      remindEvery: "day",
    })
  ).json().data.card;
  await me.settled(a.id);
  await me.settled(b.id);
  const stats = (await me.call("GET", "/v1/cards/stats")).json().data;
  assert.deepEqual(stats.byType, { spark: 1, idea: 0, question: 1, method: 0 });
  assert.equal(stats.total, 2);
  const exported = (await me.call("GET", "/v1/me/export")).json();
  assert.deepEqual(
    exported.cardReminders.map((r: { cardId: string; every: string }) => [
      r.cardId,
      r.every,
    ]),
    [
      [a.id, "week"],
      [b.id, "day"],
    ],
  );
  assert.equal((await me.call("DELETE", `/v1/cards/${a.id}`)).statusCode, 200);
  assert.deepEqual(rows(store, a.id), []);
  const erased = await me.call("DELETE", "/v1/me", { confirm: true });
  assert.equal(erased.statusCode, 200, erased.body);
  const left = store.db
    .prepare("SELECT COUNT(*) AS n FROM card_reminders WHERE user_id=?")
    .get(me.userId) as { n: number };
  assert.equal(left.n, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { CardService } from "../server/src/modules/cards/service.js";
import { CrisisSafetyService } from "../server/src/modules/safety/service.js";
import { ResumeService } from "../server/src/modules/resume/service.js";
import { MoodService } from "../server/src/modules/safety/mood.js";
import { fakeServices, makeApp } from "./fixtures.js";

// merging keeps the originals (hidden) and every word they had.
// Synthetic text only.
function setup() {
  const store = new SqliteStore(":memory:");
  const user = store.upsertUser("dev:merge", "甲", "dev").id;
  const clock = () => new Date("2026-10-01T02:00:00.000Z");
  const safety = new CrisisSafetyService({ noul: async () => 0 });
  const cards = new CardService(store, safety, clock);
  const resume = new ResumeService(store, cards, safety, clock);
  return { store, user, cards, resume };
}
const AI = {
  type: "idea" as const,
  scene: "study" as const,
  title: "周末复习",
  summary: "先整理错题再复习",
  slots: [{ key: "claim", text: "周末集中复习" }],
};

test("merged originals are hidden everywhere but kept whole", async () => {
  const s = setup();
  try {
    const long = "错题".repeat(950);
    const a = (await s.cards.create(s.user, { text: long, kind: "idea", mine: "先整理错题" })).card;
    const b = (await s.cards.create(s.user, { text: "按章节复习一遍" + "章".repeat(400), kind: "idea" })).card;
    const withOpen = await s.cards.update(s.user, b.id, b.version, {
      open: [{ key: "q1", text: "先复习哪一章？", cat: "decide" }],
    });
    await s.cards.supplement(s.user, a.id, a.version, { text: "补一句：周六上午" });
    const tag1 = s.store.db.prepare("INSERT INTO tags(id,user_id,name,color,by,created_at) VALUES('tag_1',?,'一',1,'user',?)");
    tag1.run(s.user, "2026-10-01T02:00:00Z");
    s.store.db.prepare("INSERT INTO card_tags(card_id,tag_id,user_id) VALUES(?,?,?)").run(a.id, "tag_1", s.user);
    s.resume.sync(s.user);
    const sources = [a.id, b.id].map((id) => ({ id, version: s.cards.detail(s.user, id).version }));
    assert.equal(withOpen.card.id, b.id);
    const id = s.cards.merge(s.user, sources, { ...AI, kind: "idea" });
    const merged = s.cards.detail(s.user, id);
    // Nothing cut: the full quote, both 我的话, the open question, tag and 补充.
    assert.ok(merged.quote!.includes(long));
    assert.match(merged.quote!, /按章节复习一遍/);
    assert.equal(merged.mine, "先整理错题");
    assert.deepEqual((merged.open as { text: string }[]).map((o) => o.text), ["先复习哪一章？"]);
    assert.deepEqual(merged.tags.map((t) => t.id), ["tag_1"]);
    assert.deepEqual(merged.supplements.map((x) => x.text), ["补一句：周六上午"]);
    // Same clock for both cards: their order is not fixed, only the set is.
    assert.deepEqual(merged.mergedFrom.map((c) => c.id).sort(), [a.id, b.id].sort());
    // The originals: gone from lists, counts, search and follow-ups.
    assert.equal(s.cards.list(s.user, {}).total, 1);
    assert.equal(s.cards.list(s.user, { search: "章节" }).total, 1);
    assert.equal(s.cards.stats(s.user).total, 1);
    const left = s.store.db
      .prepare("SELECT count(*) AS n FROM resume_items WHERE src_id IN (?,?)")
      .get(a.id, b.id)!;
    assert.equal(left.n, 0);
    s.resume.sync(s.user);
    assert.equal(
      s.store.db.prepare("SELECT count(*) AS n FROM resume_items WHERE src_id IN (?,?)").get(a.id, b.id)!.n,
      0,
    );
    // Kept in the database and readable on request.
    assert.throws(() => s.cards.detail(s.user, a.id), /找不到/);
    const original = s.cards.detail(s.user, a.id, true);
    assert.equal(original.quote, long);
    assert.equal(original.mergedInto, id);
    // An original cannot be merged a second time.
    const c = (await s.cards.create(s.user, { text: "再来一张", kind: "idea" })).card;
    assert.throws(
      () => s.cards.merge(s.user, [{ id: a.id, version: original.version }, { id: c.id, version: c.version }], AI),
      /改过了/,
    );
  } finally {
    s.store.close();
  }
});

test("拆开 brings the originals back while the merged card is untouched", async () => {
  const s = setup();
  try {
    const a = (await s.cards.create(s.user, { text: "第一张", kind: "idea" })).card;
    const b = (await s.cards.create(s.user, { text: "第二张", kind: "idea" })).card;
    const id = s.cards.merge(s.user, [a, b].map((c) => ({ id: c.id, version: c.version })), AI);
    const merged = s.cards.detail(s.user, id);
    const back = s.cards.unmerge(s.user, id, merged.version);
    assert.deepEqual(back.cardIds.sort(), [a.id, b.id].sort());
    assert.equal(s.cards.list(s.user, {}).total, 2);
    assert.throws(() => s.cards.detail(s.user, id), /找不到/);
    // Once the merged card has been edited, 拆开 would lose that edit.
    const again = s.cards.merge(s.user, [a, b].map((c) => ({ id: c.id, version: c.version })), AI);
    const edited = await s.cards.update(s.user, again, s.cards.detail(s.user, again).version, { title: "改过" });
    assert.throws(() => s.cards.unmerge(s.user, again, edited.card.version), /拆开会丢掉/);
  } finally {
    s.store.close();
  }
});

test("HTTP: old clients get 404 for originals; export keeps them; a failed merge can be retried; account deletion removes all", async () => {
  const services = fakeServices();
  services.judge.noul = 0;
  const store = new SqliteStore(":memory:");
  let fail = true;
  const base = services.fetcher;
  services.fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(body.messages?.[0]?.content ?? "").includes("[CARD_MERGE]")) {
      if (fail) return new Response("busy", { status: 500 });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ title: "合起来", summary: "两张合一张", slots: [] }) } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      );
    }
    return base(url, init);
  }) as typeof fetch;
  const app = makeApp(services, {}, undefined, store);
  try {
    const token = (
      await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "merge-http" } })
    ).json().data.token;
    const headers = { authorization: `Bearer ${token}` };
    const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
      app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    const settle = async (jobId: string) => {
      for (let i = 0; i < 500; i++) {
        const job = (await call("GET", `/v1/jobs/${jobId}`)).json().data;
        if (["succeeded", "failed", "unknown"].includes(job.status)) return job;
        await new Promise((r) => setTimeout(r, 2));
      }
      throw new Error("job did not settle");
    };
    const ids: string[] = [];
    for (const text of ["合并前的第一张", "合并前的第二张"]) {
      const id = (await call("POST", "/v1/cards", { text, kind: "note" })).json().data.card.id;
      for (let i = 0; i < 500; i++) {
        const job = (await call("GET", `/v1/cards/${id}`)).json().data.aiJob;
        if (!job || !["queued", "running"].includes(job.status)) break;
        await new Promise((r) => setTimeout(r, 2));
      }
      ids.push(id);
    }
    const first = await call("POST", "/v1/cards/merge", { cardIds: ids, clientId: "merge-retry-1" });
    const failed = await settle(first.json().data.job.id);
    assert.notEqual(failed.status, "succeeded");
    fail = false;
    const retry = await call("POST", "/v1/cards/merge", { cardIds: ids, clientId: "merge-retry-1" });
    assert.notEqual(retry.json().data.job.id, failed.id);
    const done = await settle(retry.json().data.job.id);
    assert.equal(done.status, "succeeded", JSON.stringify(done));
    const merged = (await call("GET", `/v1/cards/${done.result.cardId}`)).json().data;
    assert.equal(merged.kind, "note");
    assert.equal(merged.mergedFrom.length, 2);
    for (const id of ids) assert.equal((await call("GET", `/v1/cards/${id}`)).statusCode, 404);
    assert.equal((await call("GET", "/v1/cards")).json().data.total, 1);
    const exported = (await call("GET", "/v1/me/export")).json();
    const hidden = exported.cards.filter((c: { mergedInto: string | null }) => c.mergedInto === merged.id);
    assert.deepEqual(hidden.map((c: { id: string }) => c.id).sort(), [...ids].sort());
    assert.equal((await call("DELETE", "/v1/me", { confirm: true })).statusCode, 200);
    const userId = store.db.prepare("SELECT count(*) AS n FROM cards").get()!;
    assert.equal(userId.n, 0);
  } finally {
    await app.close();
  }
});

test("deleting a merged card removes the originals behind it, also after a second merge", async () => {
  const s = setup();
  try {
    const make = async (text: string) => (await s.cards.create(s.user, { text, kind: "idea" })).card;
    const [a, b, c, keep] = [await make("第一张"), await make("第二张"), await make("第三张"), await make("留下的")];
    const ref = (id: string) => ({ id, version: s.cards.detail(s.user, id).version });
    const first = s.cards.merge(s.user, [ref(a.id), ref(b.id)], AI);
    const second = s.cards.merge(s.user, [ref(first), ref(c.id)], AI);
    s.cards.remove(s.user, second);
    const left = s.store.db
      .prepare("SELECT id FROM cards WHERE user_id=? ORDER BY id")
      .all(s.user)
      .map((r) => String(r.id));
    assert.deepEqual(left, [keep.id]);
  } finally {
    s.store.close();
  }
});

test("removing mood content brings back a study original merged into a mood card", async () => {
  const s = setup();
  try {
    const mood = new MoodService(s.store, {}, () => new Date("2026-10-01T02:00:00.000Z"));
    mood.consent(s.user);
    const study = (await s.cards.create(s.user, { text: "按章节复习", kind: "idea", scene: "study" })).card;
    // A jot is never a mood card; it becomes one the way a learner moves it.
    const jot = (await s.cards.create(s.user, { text: "今天有点累", kind: "note", scene: "life" })).card;
    const feel = (await s.cards.update(s.user, jot.id, jot.version, { scene: "mood" })).card;
    const id = s.cards.merge(
      s.user,
      [study, feel].map((card) => ({ id: card.id, version: card.version })),
      { ...AI, scene: "mood" },
    );
    assert.equal(s.cards.list(s.user, {}).total, 1);
    mood.remove(s.user);
    assert.throws(() => s.cards.detail(s.user, id), /找不到/);
    assert.throws(() => s.cards.detail(s.user, feel.id, true), /找不到/);
    const back = s.cards.list(s.user, {});
    assert.deepEqual(back.data.map((card) => card.id), [study.id]);
    assert.equal(back.data[0]!.mergedInto, null);
  } finally {
    s.store.close();
  }
});

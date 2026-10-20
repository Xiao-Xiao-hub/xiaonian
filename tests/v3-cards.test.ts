import assert from "node:assert/strict";
import test from "node:test";
import { addDays, chinaDate } from "../server/src/shared/time.js";
import { fakeServices, makeApp } from "./fixtures.js";

const calm = () => {
  const services = fakeServices();
  services.judge.noul = 0;
  return services;
};

async function login(app: ReturnType<typeof makeApp>, key: string) {
  const data = (
    await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key } })
  ).json().data;
  return { authorization: `Bearer ${data.token}` };
}
async function card(app: ReturnType<typeof makeApp>, headers: Record<string, string>, text: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/cards",
    headers,
    payload: { text, type: "idea" },
  });
  assert.equal(res.statusCode, 200, res.body);
  const id = res.json().data.card.id as string;
  // Let the automatic tidy finish so versions stay put.
  for (let i = 0; i < 500; i++) {
    const detail = (await app.inject({ url: `/v1/cards/${id}`, headers })).json().data;
    if (!detail.aiJob || !["queued", "running"].includes(detail.aiJob.status))
      return detail as { id: string; version: number; favorite: boolean; remindOn: string | null };
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("tidy did not settle");
}

test("favorite is a mark: toggling keeps the version, filters the wall and counts in stats", async () => {
  const app = makeApp(calm());
  try {
    const headers = await login(app, "fav-owner");
    const other = await login(app, "fav-other");
    const a = await card(app, headers, "第一张想收藏的卡");
    await card(app, headers, "第二张普通的卡");
    assert.equal(a.favorite, false);
    assert.equal(a.remindOn, null);
    const on = await app.inject({
      method: "PUT",
      url: `/v1/cards/${a.id}/favorite`,
      headers,
      payload: { favorite: true },
    });
    assert.equal(on.statusCode, 200, on.body);
    assert.equal(on.json().data.card.favorite, true);
    assert.equal(on.json().data.card.version, a.version);
    const list = (await app.inject({ url: "/v1/cards?favorite=1", headers })).json().data;
    assert.equal(list.total, 1);
    assert.equal(list.data[0].id, a.id);
    assert.equal((await app.inject({ url: "/v1/cards", headers })).json().data.total, 2);
    assert.equal((await app.inject({ url: "/v1/cards/stats", headers })).json().data.favorites, 1);
    assert.equal(
      (await app.inject({ url: "/v1/cards?favorite=0", headers })).statusCode,
      400,
    );
    const stranger = await app.inject({
      method: "PUT",
      url: `/v1/cards/${a.id}/favorite`,
      headers: other,
      payload: { favorite: false },
    });
    assert.equal(stranger.statusCode, 404);
    const off = await app.inject({
      method: "PUT",
      url: `/v1/cards/${a.id}/favorite`,
      headers,
      payload: { favorite: false },
    });
    assert.equal(off.json().data.card.favorite, false);
    assert.equal((await app.inject({ url: "/v1/cards/stats", headers })).json().data.favorites, 0);
  } finally {
    await app.close();
  }
});

test("a supplement bumps the version, shows in detail, is searchable and replays once per clientId", async () => {
  const app = makeApp(calm());
  try {
    const headers = await login(app, "supp-owner");
    const c = await card(app, headers, "周末想把错题本整理一遍");
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: `/v1/cards/${c.id}/supplements`, headers, payload });
    const first = await post({ version: c.version, text: "  先整理极限那一章  ", clientId: "supp-client-1" });
    assert.equal(first.statusCode, 200, first.body);
    const detail = first.json().data.card;
    assert.equal(first.json().data.crisis, false);
    assert.equal(detail.version, c.version + 1);
    assert.deepEqual(
      detail.supplements.map((s: { text: string }) => s.text),
      ["先整理极限那一章"],
    );
    assert.ok(detail.supplements[0].createdAt);
    assert.equal(detail.nextResumeOn, null);
    const replay = await post({ version: c.version, text: "先整理极限那一章", clientId: "supp-client-1" });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().data.card.version, detail.version);
    assert.equal(replay.json().data.card.supplements.length, 1);
    const stale = await post({ version: c.version, text: "再补一句" });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().code, "CARD_CHANGED");
    assert.equal((await post({ version: detail.version, text: "   " })).statusCode, 400);
    const second = await post({ version: detail.version, text: "然后做导数" });
    assert.deepEqual(
      second.json().data.card.supplements.map((s: { text: string }) => s.text),
      ["先整理极限那一章", "然后做导数"],
    );
    const found = (await app.inject({ url: `/v1/cards?q=${encodeURIComponent("极限那一章")}`, headers })).json().data;
    assert.equal(found.total, 1);
  } finally {
    await app.close();
  }
});

test("remindOn makes a resume item, moves with the date and is cleared by answering", async () => {
  const app = makeApp(calm());
  try {
    const headers = await login(app, "remind-owner");
    const c = await card(app, headers, "下周要不要报那个比赛");
    const today = chinaDate();
    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: `/v1/cards/${c.id}`, headers, payload });
    const past = await patch({ version: c.version, remindOn: addDays(today, -1) });
    assert.equal(past.statusCode, 400);
    assert.equal(past.json().code, "VALIDATION_ERROR");
    assert.equal((await patch({ version: c.version, remindOn: addDays(today, 400) })).statusCode, 400);
    assert.equal((await patch({ version: c.version, remindOn: "2026/10/20" })).statusCode, 400);
    const off = await patch({ version: c.version, resume: "off" });
    const first = addDays(today, 3);
    const set = await patch({ version: off.json().data.card.version, remindOn: first });
    assert.equal(set.statusCode, 200, set.body);
    assert.equal(set.json().data.card.remindOn, first);
    assert.equal(set.json().data.card.resume, "manual");
    assert.ok(set.json().data.card.versions.some((v: { kind: string; data: { remindOn?: string } }) => v.kind === "edit" && v.data.remindOn === first));
    const list = async () => (await app.inject({ url: "/v1/resume", headers })).json().data as { id: string; srcId: string; kind: string; dueOn: string; state: string }[];
    // the date says when; the card's follow-up (接着聊 for this
    // question) says how, so the item is no longer a "promise".
    const items = (await list()).filter((i) => i.srcId === c.id && i.kind === "chat");
    assert.equal(items.length, 1);
    assert.equal(items[0]!.dueOn, first);
    let detail = (await app.inject({ url: `/v1/cards/${c.id}`, headers })).json().data;
    assert.equal(detail.nextResumeOn, first);
    // Moving the date retires the old item.
    const second = addDays(today, 5);
    const moved = await patch({ version: detail.version, remindOn: second });
    assert.equal(moved.statusCode, 200, moved.body);
    const after = (await list()).filter((i) => i.srcId === c.id && i.kind === "chat");
    assert.deepEqual(after.map((i) => i.dueOn), [second]);
    detail = (await app.inject({ url: `/v1/cards/${c.id}`, headers })).json().data;
    assert.equal(detail.nextResumeOn, second);
    const act = await app.inject({
      method: "POST",
      url: `/v1/resume/${after[0]!.id}/act`,
      headers,
      payload: { action: "answer", text: "报了" },
    });
    assert.equal(act.statusCode, 200, act.body);
    detail = (await app.inject({ url: `/v1/cards/${c.id}`, headers })).json().data;
    assert.equal(detail.remindOn, null);
    // Clearing by hand works too.
    const again = await patch({ version: detail.version, remindOn: first });
    const cleared = await patch({ version: again.json().data.card.version, remindOn: null });
    assert.equal(cleared.json().data.card.remindOn, null);
  } finally {
    await app.close();
  }
});

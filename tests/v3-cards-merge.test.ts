import assert from "node:assert/strict";
import test from "node:test";
import { fakeServices, makeApp } from "./fixtures.js";

const MERGED = {
  title: "周末复习安排",
  summary: "先整理错题，再按章节复习，最后做一套卷子。",
  slots: [
    { key: "claim", text: "周末集中复习" },
    { key: "nope", text: "不该出现的槽位" },
  ],
};

function setup() {
  const services = fakeServices();
  services.judge.noul = 0;
  const gate: { wait?: Promise<void> } = {};
  let merges = 0;
  const base = services.fetcher;
  services.fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(body.messages?.[0]?.content ?? "").includes("[CARD_MERGE]")) {
      merges++;
      await gate.wait;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(MERGED) } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      );
    }
    return base(url, init);
  }) as typeof fetch;
  const app = makeApp(services);
  return { app, gate, merges: () => merges };
}

async function login(app: ReturnType<typeof makeApp>) {
  const data = (
    await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "merge-owner" } })
  ).json().data;
  const headers = { authorization: `Bearer ${data.token}` };
  const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  return call;
}
type Call = Awaited<ReturnType<typeof login>>;

async function detail(call: Call, id: string) {
  for (let i = 0; i < 500; i++) {
    const card = (await call("GET", `/v1/cards/${id}`)).json().data;
    if (!card.aiJob || !["queued", "running"].includes(card.aiJob.status)) return card;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("tidy did not settle");
}
async function card(call: Call, text: string, type = "idea") {
  const res = await call("POST", "/v1/cards", { text, type });
  assert.equal(res.statusCode, 200, res.body);
  return detail(call, res.json().data.card.id);
}
async function settle(call: Call, jobId: string) {
  for (let i = 0; i < 500; i++) {
    const job = (await call("GET", `/v1/jobs/${jobId}`)).json().data;
    if (["succeeded", "failed", "unknown"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("job did not settle");
}

// V4.2 G3 changed this on purpose: all tags are kept and the originals are
// hidden (merged_into), not deleted; old clients still get 404 for them.
test("three cards merge into one: tags unioned, links moved, originals hidden", async () => {
  const { app } = setup();
  try {
    const call = await login(app);
    const a = await card(call, "周六上午整理错题本");
    const b = await card(call, "周日按章节复习一遍");
    const c = await card(call, "最后做一套卷子怎么样？", "question");
    const x = await card(call, "别的一张卡");
    const tags = [];
    for (const name of ["一", "二", "三", "四"])
      tags.push((await call("POST", "/v1/tags", { name, color: 1 })).json().data.id);
    let version = (await call("PUT", `/v1/cards/${a.id}/tags`, { version: a.version, tagIds: [tags[0], tags[1]] })).json().data.version;
    version = (await call("POST", `/v1/cards/${a.id}/links`, { version, cardId: b.id })).json().data.version;
    await call("POST", `/v1/cards/${a.id}/links`, { version, cardId: x.id });
    const bNow = await detail(call, b.id);
    const bVersion = (await call("PUT", `/v1/cards/${b.id}/tags`, { version: bNow.version, tagIds: [tags[1], tags[2]] })).json().data.version;
    await call("POST", `/v1/cards/${b.id}/links`, { version: bVersion, cardId: x.id });
    await call("PUT", `/v1/cards/${c.id}/tags`, { version: c.version, tagIds: [tags[3]] });
    await call("PUT", `/v1/cards/${c.id}/favorite`, { favorite: true });

    const started = await call("POST", "/v1/cards/merge", { cardIds: [a.id, b.id, c.id], clientId: "merge-client-1" });
    assert.equal(started.statusCode, 200, started.body);
    const job = await settle(call, started.json().data.job.id);
    assert.equal(job.status, "succeeded", JSON.stringify(job));
    const merged = await detail(call, job.result.cardId);
    assert.equal(merged.type, "idea");
    assert.equal(merged.origin, "jot");
    assert.equal(merged.title, MERGED.title);
    assert.equal(merged.titleBy, "ai");
    assert.equal(merged.summary, MERGED.summary);
    assert.deepEqual(merged.slots.map((s: { key: string }) => s.key), ["claim"]);
    assert.equal(merged.favorite, true);
    assert.match(merged.quote, /周六上午整理错题本\n—\n周日按章节复习一遍\n—\n最后做一套卷子/);
    // at most 3 tags (what PUT tags takes back), in the cards'
    // order; the fourth stays on its hidden original.
    assert.deepEqual(
      merged.tags.map((t: { id: string }) => t.id).sort(),
      [tags[0], tags[1], tags[2]].sort(),
    );
    assert.deepEqual(merged.links.map((l: { id: string }) => l.id), [x.id]);
    const created = merged.versions.find((v: { kind: string }) => v.kind === "create");
    assert.deepEqual(created.data, { from: "merge", cardIds: [a.id, b.id, c.id] });
    for (const id of [a.id, b.id, c.id])
      assert.equal((await call("GET", `/v1/cards/${id}`)).statusCode, 404);
    assert.equal((await call("GET", "/v1/cards")).json().data.total, 2);
    for (const id of [a.id, b.id, c.id])
      assert.equal((await call("GET", `/v1/cards/${id}?merged=1`)).json().data.mergedInto, merged.id);
    // The same clientId gets the same job back.
    const again = await call("POST", "/v1/cards/merge", { cardIds: [a.id, b.id, c.id], clientId: "merge-client-1" });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().data.job.id, job.id);
  } finally {
    await app.close();
  }
});

test("merge refuses crisis cards, duplicates and strangers' cards", async () => {
  const { app } = setup();
  try {
    const call = await login(app);
    const a = await card(call, "一张普通的卡");
    const crisis = (await call("POST", "/v1/cards", { text: "我不想活了", type: "idea" })).json().data.card;
    const refused = await call("POST", "/v1/cards/merge", { cardIds: [a.id, crisis.id], clientId: "merge-client-2" });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().code, "CARD_CRISIS");
    assert.equal((await call("POST", "/v1/cards/merge", { cardIds: [a.id, a.id], clientId: "merge-client-3" })).statusCode, 400);
    assert.equal((await call("POST", "/v1/cards/merge", { cardIds: [a.id], clientId: "merge-client-4" })).statusCode, 400);
    assert.equal((await call("POST", "/v1/cards/merge", { cardIds: [a.id, "card_missing"], clientId: "merge-client-5" })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test("a card changed while merging fails the job and keeps the originals", async () => {
  const { app, gate, merges } = setup();
  try {
    const call = await login(app);
    const a = await card(call, "第一张要合并的卡");
    const b = await card(call, "第二张要合并的卡");
    let release!: () => void;
    gate.wait = new Promise((resolve) => (release = resolve));
    const started = await call("POST", "/v1/cards/merge", { cardIds: [a.id, b.id], clientId: "merge-client-6" });
    assert.equal(started.statusCode, 200, started.body);
    for (let i = 0; i < 500 && !merges(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
    const edited = await call("PATCH", `/v1/cards/${a.id}`, { version: a.version, title: "改了标题" });
    assert.equal(edited.statusCode, 200, edited.body);
    release();
    const job = await settle(call, started.json().data.job.id);
    assert.equal(job.status, "failed");
    assert.equal(job.error.code, "CARD_CHANGED");
    assert.equal((await call("GET", `/v1/cards/${a.id}`)).statusCode, 200);
    assert.equal((await call("GET", `/v1/cards/${b.id}`)).statusCode, 200);
    assert.equal((await call("GET", "/v1/cards")).json().data.total, 2);
  } finally {
    await app.close();
  }
});

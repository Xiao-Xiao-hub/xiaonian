import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SqliteStore } from "../server/src/shared/store.js";
import { fakeServices, makeApp } from "./fixtures.js";
const oldQuestion = "求定积分 0 到 1 的 2 dx。";
const newQuestion = "求复合函数 sin(x^2) 的导数。";
async function setup(t: TestContext) {
  const store = new SqliteStore(":memory:"), services = fakeServices(), fetcher = services.fetcher;
  const classified: unknown[] = [];
  services.fetcher = (async (url, init) => {
    const body = JSON.parse(String(init?.body)), q = body.questions?.q;
    if (q?.criteria?.["application-taylor-limit"]) {
      classified.push(body.state);
      return new Response(JSON.stringify({ answers: { q: { choice: "derivative-chain", confidence: 1, probabilities: { "derivative-chain": 1 } } } }));
    }
    if (body.stream) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "第一步不成立。\n\n**结论**：第 1 步有误。" } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    return fetcher(url, init);
  }) as typeof fetch;
  const app = makeApp(services, {}, undefined, store); t.after(() => app.close());
  const { token, user } = (await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "synthetic-version-audit" } })).json().data;
  const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as "GET", url, payload: payload as string, headers: { authorization: `Bearer ${token}` } });
  const material = (await call("POST", "/v1/materials", { kind: "problem", text: oldQuestion })).json().data;
  await call("PUT", `/v1/materials/${material.id}`, { expectedVersion: 1, confirm: true });
  const at = new Date().toISOString();
  store.db.prepare("INSERT INTO threads(id,user_id,title,material_id,data,created_at,updated_at) VALUES('thr_version',?,'synthetic',?,?,?,?)")
    .run(user.id, material.id, JSON.stringify({ problem: oldQuestion, practice: "definite" }), at, at);
  store.db.prepare("INSERT INTO messages(id,thread_id,user_id,role,kind,content,data,status,created_at) VALUES('msg_version','thr_version',?,'assistant','similar','',?,'done',?)")
    .run(user.id, JSON.stringify({ practice: "definite", similar: { question: oldQuestion, answer: "2", key: "2", solution: "2", verify: { state: "pass", items: [] } } }), at);
  const edit = () => call("PUT", `/v1/materials/${material.id}`, { expectedVersion: 1, text: newQuestion, confirm: true });
  const assertUnlinked = async () => {
    await delay(10);
    const mistake = store.db.prepare("SELECT map_point_id,map_version FROM mistakes WHERE material_id=?").get(material.id)!;
    assert.ok(mistake, "The original tool mistake still exists");
    assert.equal(mistake.map_point_id, null); assert.equal(mistake.map_version, null);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM map_points WHERE user_id=?").get(user.id)?.n, 0);
    assert.deepEqual(classified, []);
  };
  return { call, edit, assertUnlinked, classified, store, material };
}
test("chat map links: answering a retained practice question after a library edit cannot flag the new question", async (t) => {
  const s = await setup(t); assert.equal((await s.edit()).statusCode, 200);
  const answer = await s.call("POST", "/v1/chat/messages/msg_version/answer", { answer: "9", clientId: "version-answer-01" });
  assert.equal(answer.statusCode, 200); await s.assertUnlinked();
});
test("chat map links: grading retained problem text after a library edit cannot flag the new question", async (t) => {
  const s = await setup(t); assert.equal((await s.edit()).statusCode, 200);
  const answer = await s.call("POST", "/v1/chat/send", { threadId: "thr_version", steps: ["错误地把积分写成 9"], mode: "grade", clientId: "version-grade-01" });
  assert.equal(answer.statusCode, 200); await s.assertUnlinked();
});
test("chat map links: the unchanged practice source still starts point classification", async (t) => {
  const s = await setup(t);
  const answer = await s.call("POST", "/v1/chat/messages/msg_version/answer", { answer: "9", clientId: "version-answer-02" });
  assert.equal(answer.statusCode, 200); await delay(10);
  assert.equal(s.classified.length, 1);
  assert.equal(s.store.db.prepare("SELECT map_version FROM mistakes WHERE material_id=?").get(s.material.id)?.map_version, 1);
});
test("chat map links: an old thread does not display a valid newer library association", async (t) => {
  const s = await setup(t);
  await s.call("POST", "/v1/chat/messages/msg_version/answer", { answer: "9", clientId: "version-answer-03" });
  await delay(10); await s.edit();
  s.store.db.prepare("UPDATE mistakes SET map_point_id='derivative-chain',map_version=2 WHERE material_id=?").run(s.material.id);
  const thread = (await s.call("GET", "/v1/chat/threads/thr_version")).json().data.thread;
  assert.equal(thread.mistake.mapPoint, null);
  const list = (await s.call("GET", "/v1/mistakes")).json().data;
  assert.equal(list.items[0].mapPoint.id, "derivative-chain");
});

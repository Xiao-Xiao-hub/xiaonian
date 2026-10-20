import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { PRIVACY_VERSION } from "../server/src/shared/domain.js";
import { fakeServices, makeApp } from "./fixtures.js";

test("export carries the implicit AI label, consents, events and AI markers", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  t.after(() => app.close());
  const login = (await app.inject({
    method: "POST", url: "/v1/auth/dev-login", payload: { key: "v4-export" },
  })).json().data;
  const headers = { authorization: "Bearer " + login.token };
  const userId = login.user.id as string;
  await app.inject({
    method: "PUT", url: "/v1/me/consent", headers,
    payload: { version: PRIVACY_VERSION, ageBand: "child", guardian: true },
  });
  const at = "2026-10-16T08:00:00.000Z";
  store.db.prepare(
    "INSERT INTO cards(id,user_id,type,scene,title,title_by,quote,origin,slots,created_at,updated_at) VALUES(?,?,'idea','life',?,'ai',?,'jot',?,?,?)",
  ).run("card-ai", userId, "AI 标题", "原话", "{}", at, at);
  store.db.prepare(
    "INSERT INTO cards(id,user_id,type,scene,title,title_by,quote,origin,slots,created_at,updated_at) VALUES(?,?,'idea','life',?,'user',?,'jot',?,?,?)",
  ).run("card-user", userId, "我的标题", "原话", "{}", at, at);
  store.db.prepare(
    "INSERT INTO card_versions(card_id,user_id,kind,by,data,created_at) VALUES(?,?,'slots','ai',?,?)",
  ).run("card-ai", userId, "{}", at);
  store.db.prepare(
    "INSERT INTO tags(id,user_id,name,color,by,created_at) VALUES(?,?,'AI 标签',0,'ai',?)",
  ).run("tag-ai", userId, at);
  store.db.prepare(
    "INSERT INTO events(user_id,name,data,created_at) VALUES(?,?,?,?)",
  ).run(userId, "card_close", JSON.stringify({ cardId: "card-ai" }), at);

  const response = await app.inject({ method: "GET", url: "/v1/me/export", headers });
  assert.equal(response.statusCode, 200);
  const data = response.json();
  // The implicit label comes first in the file.
  assert.equal(Object.keys(data)[0], "aigc");
  assert.equal(data.aigc.label, "AI 生成");
  assert.equal(data.aigc.provider, "晓念");
  assert.match(data.aigc.exportId, /^exp_[0-9a-f]{32}$/);
  assert.ok(data.aigc.note.length > 10);

  assert.equal(data.user.ageBand, "child");
  assert.deepEqual(
    data.user.consents.map((c: { kind: string; scope?: string }) => c.scope ?? c.kind),
    ["docs", "basic"],
  );
  assert.equal(data.user.personalized, false);

  assert.deepEqual(data.events, [
    { name: "card_close", data: { cardId: "card-ai" }, createdAt: at },
  ]);
  const card = (id: string) => data.cards.find((c: { id: string }) => c.id === id);
  assert.deepEqual(card("card-ai").aiGeneratedFields, ["title"]);
  assert.equal(card("card-ai").aiLabel, "AI 生成");
  assert.equal(card("card-user").aiGeneratedFields, undefined);
  assert.equal(card("card-user").aiLabel, undefined);
  assert.equal(data.cardVersions[0].aiGenerated, true);
  assert.equal(data.cardVersions[0].aiLabel, "AI 生成");
  assert.equal(data.tags[0].aiGenerated, true);

  assert.equal(data.aigc.generatedAt, data.exportedAt);
});

test("export marks the model-written parts of judged answers only", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  t.after(() => app.close());
  const login = (await app.inject({
    method: "POST", url: "/v1/auth/dev-login", payload: { key: "v4-export-attempts" },
  })).json().data;
  const headers = { authorization: "Bearer " + login.token };
  const userId = login.user.id as string;
  await app.inject({
    method: "PUT", url: "/v1/me/consent", headers,
    payload: { version: PRIVACY_VERSION, ageBand: "adult" },
  });
  const at = "2026-10-16T08:00:00.000Z";
  store.db.prepare(
    "INSERT INTO materials(id,user_id,kind,title,status,current_version,created_at,updated_at) VALUES('m',?,'problem','题','confirmed',1,?,?)",
  ).run(userId, at, at);
  const attempt = (id: string, result: unknown) =>
    store.db.prepare(
      "INSERT INTO attempts(id,user_id,material_id,item,version,answer,result,created_at) VALUES(?,?,'m',0,1,'2',?,?)",
    ).run(id, userId, JSON.stringify(result), at);
  const base = { confidence: 1, citations: [], revealSolution: true };
  // The program judged it wrong; the feedback model wrote the comment and the
  // solution is a model's.
  attempt("a1", {
    ...base, verdict: "incorrect", judge: "rule",
    reference: { value: "3", source: "rule" },
    cause: { key: "sign", label: "符号", confidence: 0.8 },
    comment: "再想想符号。", explanation: "第一步……",
  });
  // Not judged: the comment carries the hints' note on what is missing.
  attempt("a2", {
    ...base, verdict: "unsure", judge: "none", reference: null,
    cause: null, comment: "题目条件可能不完整：缺少单价。", explanation: "",
  });
  // A choice checked by the program, but the question and explanation were drafted by a model.
  attempt("a3", {
    ...base, verdict: "correct", judge: "choice",
    reference: { value: "B", source: "ai" },
    cause: null, comment: "答对了。", explanation: "因为……",
  });
  // A choice whose answer no model drafted: nothing to mark.
  attempt("a4", {
    ...base, verdict: "correct", judge: "choice",
    reference: { value: "B", source: "user" },
    cause: null, comment: "答对了。", explanation: "",
  });
  const data = (await app.inject({ method: "GET", url: "/v1/me/export", headers })).json();
  const results = data.materials[0].attempts.map(
    (a: { result: { aiLabel?: string; aiGeneratedFields?: string[] } }) => a.result,
  );
  assert.deepEqual(results[0].aiGeneratedFields, ["comment", "explanation", "cause"]);
  assert.equal(results[0].aiLabel, "AI 生成");
  assert.deepEqual(results[1].aiGeneratedFields, ["comment"]);
  assert.deepEqual(results[2].aiGeneratedFields, ["comment", "explanation"]);
  assert.equal(results[3].aiGeneratedFields, undefined);
  assert.equal(results[3].aiLabel, undefined);
});

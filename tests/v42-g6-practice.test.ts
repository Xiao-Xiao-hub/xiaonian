// V4.2 G6 (report B 旧题目、旧练习、回头看看): an answer sent again with its
// key is the same attempt, judged once; the hints say what "再练一道" can offer
// before anything is generated; a note with no points is reviewed whole.
import assert from "node:assert/strict";
import test from "node:test";
import { fakeServices, makeApp, PROBLEM, REPLIES, type App } from "./fixtures.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { variantKind, type HintsData } from "../server/src/modules/study/service.js";

async function login(app: App) {
  const { token } = (
    await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: {} })
  ).json().data;
  return (method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url,
      payload: payload as string,
      headers: { authorization: `Bearer ${token}` },
    });
}
async function settle(call: Awaited<ReturnType<typeof login>>, jobId: string) {
  for (let i = 0; i < 400; i++) {
    const job = (await call("GET", `/v1/jobs/${jobId}`)).json().data;
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job did not finish");
}

test("an answer sent again with the same key returns the first attempt; no key, or a new one, is a new attempt", async (t) => {
  const store = new SqliteStore(":memory:");
  const services = fakeServices();
  const app = makeApp(services, {}, undefined, store);
  t.after(() => app.close());
  const call = await login(app);
  const { id } = (await call("POST", "/v1/materials", { kind: "problem", text: PROBLEM })).json().data;
  await call("PUT", `/v1/materials/${id}`, { expectedVersion: 1, confirm: true });
  const send = (body: object) => call("POST", `/v1/materials/${id}/attempts`, body);
  const first = (await send({ answer: "50", clientKey: "k-0001-abcd" })).json().data;
  assert.ok(first.job);
  await settle(call, first.job.id);
  const feedbackCalls = services.llm.length;
  // The reply was lost; the page sends the same answer with the same key.
  const again = await send({ answer: "50", clientKey: "k-0001-abcd" });
  assert.equal(again.statusCode, 200, again.body);
  const same = again.json().data;
  assert.equal(same.attempt.id, first.attempt.id);
  assert.equal(same.job.id, first.job.id);
  assert.equal(same.job.status, "succeeded");
  assert.equal(same.attempt.result.verdict, "incorrect");
  assert.equal(services.llm.length, feedbackCalls, "not judged twice");
  const count = () =>
    Number(store.db.prepare("SELECT count(*) n FROM attempts WHERE material_id=?").get(id)!.n);
  assert.equal(count(), 1);
  // Old clients send no key: every send is an attempt, as before.
  const old = (await send({ answer: "50" })).json().data;
  assert.notEqual(old.attempt.id, first.attempt.id);
  await settle(call, old.job.id);
  const next = (await send({ answer: "48", clientKey: "k-0002-abcd" })).json().data;
  assert.notEqual(next.attempt.id, first.attempt.id);
  await settle(call, next.job.id);
  assert.equal(count(), 3);
  // A key is short and plain.
  assert.equal((await send({ answer: "1", clientKey: "short" })).statusCode, 400);
  assert.equal((await send({ answer: "1", clientKey: "有中文的钥匙一二三四" })).statusCode, 400);
});

const hints = (extra: Partial<HintsData>): HintsData => ({
  ...(REPLIES.hints as HintsData),
  answer: { value: "48 元", source: "rule" },
  checks: [],
  ...extra,
});

test("what 再练一道 can offer is known from the hints", async (t) => {
  // 60*0.8 = 48 元: change the numbers.
  assert.equal(variantKind(hints({})), "numbers");
  // A limit: the program checks a new problem of the same kind.
  assert.equal(
    variantKind(
      hints({
        expression: "",
        levels: ["$\\lim_{x\\to0}\\frac{\\sin x}{x}=1$", "代入", "答案 $1$"],
        answer: { value: "1", source: "ai" },
      }),
    ),
    "similar",
  );
  assert.equal(
    variantKind(hints({ expression: "", checks: [{ kind: "limit" }], answer: { value: "e", source: "ai" } })),
    "similar",
  );
  // A concept question with no number to compute: nothing to offer.
  assert.equal(
    variantKind(
      hints({
        expression: "",
        levels: ["想想定义", "对照定义", "因为它满足定义，所以是"],
        answer: { value: "是单调函数", source: "ai" },
      }),
    ),
    null,
  );
  assert.equal(variantKind(hints({ complete: false, levels: [] })), null);
  assert.equal(variantKind(hints({ answer: null })), null);
  // The hints view carries it.
  const app = makeApp(fakeServices());
  t.after(() => app.close());
  const call = await login(app);
  const { id } = (await call("POST", "/v1/materials", { kind: "problem", text: PROBLEM })).json().data;
  await call("PUT", `/v1/materials/${id}`, { expectedVersion: 1, confirm: true });
  const { job } = (await call("POST", `/v1/materials/${id}/hints`, {})).json().data;
  await settle(call, job.id);
  const study = (await call("GET", `/v1/materials/${id}/study`)).json().data;
  assert.equal(study.hints.data.variant, "numbers");
});

test("a note with no points is reviewed whole, not its first 600 characters", async (t) => {
  const store = new SqliteStore(":memory:");
  const clock = { at: new Date("2026-10-12T01:00:00.000Z") };
  const app = makeApp(fakeServices(), {}, () => clock.at, store);
  t.after(() => app.close());
  const login = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "v42-review" } });
  const userId = login.json().data.user.id as string;
  const headers = { authorization: `Bearer ${login.json().data.token}` };
  const at = clock.at.toISOString();
  const text = `${"水循环。".repeat(200)}结论在最后：降水把水送回地面。`;
  assert.ok(text.length > 600);
  store.db
    .prepare("INSERT INTO materials(id,user_id,kind,title,status,current_version,created_at,updated_at) VALUES('n1',?,'note','水循环','confirmed',1,?,?)")
    .run(userId, at, at);
  store.db
    .prepare("INSERT INTO material_versions(material_id,version,origin,text,paragraphs,created_at) VALUES('n1',1,'typed',?,'[]',?)")
    .run(text, at);
  store.db
    .prepare("INSERT INTO reviews(id,user_id,material_id,box,due_on,created_at) VALUES('rev1',?,'n1',1,'2026-10-12',?)")
    .run(userId, at);
  const list = (await app.inject({ method: "GET", url: "/v1/reviews", headers })).json().data;
  assert.equal(list.due.length, 1);
  assert.equal(list.due[0].text, text);
  assert.match(list.due[0].text, /结论在最后/);
});

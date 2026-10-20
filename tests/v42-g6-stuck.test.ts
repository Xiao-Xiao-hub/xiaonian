// V4.2 G6 (report B 知识点详情、卡点弹层, 高): the 卡点 help is kept on the
// point, so a reply that comes after the page gave up can be read again; it
// is charged once it reaches the student, and a failed one never is.
import assert from "node:assert/strict";
import test from "node:test";
import { fakeServices, makeApp } from "./fixtures.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { LearnService } from "../server/src/modules/learn/service.js";

const REPLY = {
  quote: "",
  hint: "先把 1^∞ 写成 e 的指数，再看指数部分的极限。",
  ask: "指数部分你会求吗？",
  options: ["会求", "不会化简"],
  suggest: null,
};
async function fixture(ask: object = REPLY) {
  const clock = { at: new Date("2026-10-12T01:00:00.000Z") };
  const store = new SqliteStore(":memory:");
  const services = fakeServices({ ask });
  const app = makeApp(services, {}, () => clock.at, store);
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: { key: "v42-stuck" },
  });
  const userId = login.json().data.user.id as string;
  const headers = { authorization: `Bearer ${login.json().data.token}` };
  const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  const receipts = () =>
    Number(
      store.db
        .prepare(
          "SELECT count(*) n FROM quota_receipts WHERE user_id=? AND kind='map_stuck'",
        )
        .get(userId)!.n,
    );
  const practiceOn = (pointId: string) =>
    store.db
      .prepare("SELECT practice_on FROM map_points WHERE user_id=? AND point_id=?")
      .get(userId, pointId)?.practice_on ?? null;
  return { app, store, clock, userId, call, receipts, practiceOn, services };
}

test("a delivered help is charged once and can be read again; the hint comes along", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const sent = await f.call("POST", "/v1/learn/points/limit-1-to-inf/stuck", {
    text: "取对数以后不会化",
  });
  assert.equal(sent.statusCode, 200, sent.body);
  const reply = sent.json().data;
  assert.equal(reply.hint, REPLY.hint);
  assert.equal(reply.ask, REPLY.ask);
  assert.equal(f.receipts(), 1);
  // The prompt no longer demands a quote and asks for a hint when it is clear.
  const system = f.services.llm.at(-1)!;
  assert.equal(system.kind, "ask");
  const again = (await f.call("GET", "/v1/learn/points/limit-1-to-inf/stuck")).json().data;
  assert.equal(again.help.status, "ready");
  assert.equal(again.help.text, "取对数以后不会化");
  assert.deepEqual(again.help.reply, reply);
  assert.equal(f.receipts(), 1, "reading it again is not charged again");
  // 现在懂了 clears it with the mark.
  await f.call("POST", "/v1/learn/marks", { action: "unstuck", pointId: "limit-1-to-inf" });
  assert.equal((await f.call("GET", "/v1/learn/points/limit-1-to-inf/stuck")).json().data.help, null);
  // No help at all: null, not an error.
  assert.equal((await f.call("GET", "/v1/learn/points/limit-order/stuck")).json().data.help, null);
});

test("a reply the student was no longer waiting for is charged only when it is shown", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const llm = {
    json: async (_m: unknown, schema: { parse: (v: unknown) => unknown }) => ({
      data: schema.parse(REPLY),
      usage: { model: "m", input: 1, output: 1 },
    }),
  };
  const learn = new LearnService(f.store, () => f.clock.at, {
    llm,
    safety: { check: async () => false },
    limitFor: () => 60,
  } as unknown as ConstructorParameters<typeof LearnService>[2]);
  learn.mark(f.userId, "stuck", "limit-1-to-inf");
  const reply = await learn.stuckGuide(f.userId, "limit-1-to-inf", "不会化", () => false);
  assert.equal(reply.ask, REPLY.ask);
  assert.equal(f.receipts(), 0, "nobody saw it: not charged");
  assert.equal(f.practiceOn("limit-1-to-inf"), null, "nor counted as help");
  const shown = learn.stuckHelp(f.userId, "limit-1-to-inf");
  assert.equal(shown.help!.status, "ready");
  assert.equal(shown.help!.reply!.hint, REPLY.hint);
  assert.equal(f.receipts(), 1, "charged as it is shown");
  assert.equal(f.practiceOn("limit-1-to-inf"), "2026-10-12");
  learn.stuckHelp(f.userId, "limit-1-to-inf");
  assert.equal(f.receipts(), 1);
});

test("a failed help is not charged; a lost one stops saying it is running; an older help is not shown", async (t) => {
  const f = await fixture({ quote: "", ask: "x", options: ["只有一个"], suggest: null });
  t.after(() => f.app.close());
  const sent = await f.call("POST", "/v1/learn/points/limit-order/stuck", { text: "这一步看不懂" });
  assert.equal(sent.json().data.fallback, true);
  assert.equal(f.receipts(), 0, "the fallback costs nothing");
  assert.equal(
    (await f.call("GET", "/v1/learn/points/limit-order/stuck")).json().data.help.status,
    "failed",
  );
  // Running since a restart two minutes and a half ago: failed.
  const at = f.clock.at.toISOString();
  f.store.db
    .prepare("UPDATE map_points SET stuck_help=? WHERE user_id=? AND point_id='limit-order'")
    .run(JSON.stringify({ text: "t", at, status: "running" }), f.userId);
  assert.equal(
    (await f.call("GET", "/v1/learn/points/limit-order/stuck")).json().data.help.status,
    "running",
  );
  f.clock.at = new Date(f.clock.at.getTime() + 151_000);
  assert.equal(
    (await f.call("GET", "/v1/learn/points/limit-order/stuck")).json().data.help.status,
    "failed",
  );
  // Marked stuck again without asking: the old help is not this one.
  await f.call("POST", "/v1/learn/marks", { action: "stuck", pointId: "limit-order" });
  assert.equal((await f.call("GET", "/v1/learn/points/limit-order/stuck")).json().data.help, null);
});

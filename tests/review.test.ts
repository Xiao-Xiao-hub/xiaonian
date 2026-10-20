import test from "node:test";
import assert from "node:assert/strict";
import { addDays, chinaDate } from "../server/src/shared/time.js";
import { fakeServices, makeApp, NOTE, PROBLEM } from "./fixtures.js";

async function setup() {
  // 20:00 UTC is already the next day in China.
  const clock = { at: new Date("2026-09-30T20:00:00Z") };
  const app = makeApp(fakeServices(), {}, () => clock.at);
  const login = async (key: string) => {
    const { token } = (
      await app.inject({
        method: "POST",
        url: "/v1/auth/dev-login",
        payload: { key },
      })
    ).json().data;
    return async (method: string, url: string, payload?: unknown) => {
      const res = await app.inject({
        method: method as "GET",
        url,
        payload: payload as string,
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: res.statusCode, body: res.json() };
    };
  };
  const call = await login("owner");
  const material = async (kind: string, text: string) => {
    const { id } = (await call("POST", "/v1/materials", { kind, text })).body
      .data;
    return id as string;
  };
  const confirm = (id: string) =>
    call("PUT", `/v1/materials/${id}`, { expectedVersion: 1, confirm: true });
  const later = (days: number) => {
    clock.at = new Date(clock.at.getTime() + days * 86_400_000);
  };
  const settle = async (jobId: string) => {
    for (let i = 0; i < 200; i++) {
      const job = (await call("GET", `/v1/jobs/${jobId}`)).body.data;
      if (!["queued", "running"].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("job did not finish");
  };
  return { app, call, login, material, confirm, later, settle };
}

test("review dates follow the China calendar", () => {
  assert.equal(chinaDate(Date.parse("2026-09-30T15:59:00Z")), "2026-09-30");
  assert.equal(chinaDate(Date.parse("2026-09-30T16:00:00Z")), "2026-10-01");
  assert.equal(addDays("2026-09-30", 2), "2026-10-02");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("reviews: boxes move up when remembered, back to 1 when forgotten", async () => {
  const { app, call, login, material, confirm, later, settle } = await setup();
  const id = await material("note", NOTE);
  const draft = await call("POST", `/v1/materials/${id}/review`);
  assert.equal(draft.status, 409);
  await confirm(id);

  const added = await call("POST", `/v1/materials/${id}/review`);
  assert.deepEqual(added.body.data, { box: 1, dueOn: "2026-10-02" });
  // Adding again keeps the schedule.
  later(1);
  assert.deepEqual(
    (await call("POST", `/v1/materials/${id}/review`)).body.data,
    {
      box: 1,
      dueOn: "2026-10-02",
    },
  );
  let list = (await call("GET", "/v1/reviews")).body.data;
  assert.equal(list.today, "2026-10-02");
  assert.deepEqual(list.counts, { due: 1, total: 1 });
  let card = list.due[0];
  // No explanation yet: the back shows the original text.
  assert.equal(card.prompt, "不看原文，回想这份资料讲了什么。");
  assert.match(card.text, /^太阳加热水面/);
  assert.deepEqual(card.points, []);
  const study = (await call("GET", `/v1/materials/${id}/study`)).body.data;
  assert.deepEqual(study.review, { box: 1, dueOn: "2026-10-02" });

  const { job } = (await call("POST", `/v1/materials/${id}/explain`)).body.data;
  await settle(job.id);
  card = (await call("GET", "/v1/reviews")).body.data.due[0];
  assert.equal(card.prompt, "不看原文，说出这份资料的 1 个重点。");
  assert.deepEqual(card.points, [
    { title: "蒸发", explanation: "太阳加热让水变成水蒸气" },
  ]);
  assert.equal(card.text, "");

  const step = async (outcome: string) =>
    (await call("POST", `/v1/reviews/${card.id}`, { outcome })).body.data;
  assert.deepEqual(await step("remembered"), {
    id: card.id,
    box: 2,
    dueOn: "2026-10-04",
  });
  list = (await call("GET", "/v1/reviews")).body.data;
  assert.deepEqual(list.counts, { due: 0, total: 1 });
  assert.equal(list.upcoming[0].dueOn, "2026-10-04");
  assert.equal((await step("remembered")).dueOn, "2026-10-06");
  assert.equal((await step("remembered")).dueOn, "2026-10-09");
  assert.deepEqual(await step("remembered"), {
    id: card.id,
    box: 5,
    dueOn: "2026-10-17",
  });
  assert.equal((await step("remembered")).box, 5);
  assert.deepEqual(await step("forgot"), {
    id: card.id,
    box: 1,
    dueOn: "2026-10-03",
  });
  const bad = await call("POST", `/v1/reviews/${card.id}`, {
    outcome: "maybe",
  });
  assert.equal(bad.status, 400);

  const stranger = await login("stranger");
  assert.equal(
    (await stranger("POST", `/v1/reviews/${card.id}`, { outcome: "forgot" }))
      .status,
    404,
  );
  assert.equal(
    (await stranger("DELETE", `/v1/materials/${id}/review`)).status,
    404,
  );
  assert.deepEqual((await stranger("GET", "/v1/reviews")).body.data.counts, {
    due: 0,
    total: 0,
  });

  assert.deepEqual(
    (await call("DELETE", `/v1/materials/${id}/review`)).body.data,
    {
      removed: true,
    },
  );
  assert.deepEqual((await call("GET", "/v1/reviews")).body.data.counts, {
    due: 0,
    total: 0,
  });
  assert.equal(
    (await call("GET", `/v1/materials/${id}/study`)).body.data.review,
    null,
  );
  await app.close();
});

test("problem review cards show the checked answer and key steps", async () => {
  const { app, call, material, confirm, later, settle } = await setup();
  const id = await material("problem", PROBLEM);
  await confirm(id);
  await call("POST", `/v1/materials/${id}/review`);
  later(1);
  let card = (await call("GET", "/v1/reviews")).body.data.due[0];
  assert.equal(card.question, PROBLEM);
  assert.equal(card.answer, null);
  assert.deepEqual(card.steps, []);

  const { job } = (await call("POST", `/v1/materials/${id}/hints`)).body.data;
  await settle(job.id);
  card = (await call("GET", "/v1/reviews")).body.data.due[0];
  assert.deepEqual(card.answer, {
    value: "48 元",
    source: "rule",
    check: "60*0.8 = 48",
  });
  assert.deepEqual(card.steps, ["列式 60×0.8", "60×0.8=48，所以是 48 元"]);
  // Deleting the material removes its review card.
  await call("DELETE", `/v1/materials/${id}`);
  assert.equal((await call("GET", "/v1/reviews")).body.data.counts.total, 0);
  await app.close();
});

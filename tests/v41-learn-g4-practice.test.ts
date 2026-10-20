import test from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../server/src/shared/store.js";
import { POINT_PRACTICE } from "../server/src/modules/learn/point-practice.js";
import { fakeServices, makeApp } from "./fixtures.js";

// GET …/practice adds (only adds) aiPractice, so the practice page
// knows whether 让 AI 再出一道 can follow the bank, as the bank list does.
test("practice says whether the AI can make one more problem for the point", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(
    fakeServices(),
    {},
    () => new Date("2026-10-04T20:00:00Z"),
    store,
  );
  t.after(() => app.close());
  const { token } = (
    await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key: "g4p" },
    })
  ).json().data;
  const headers = { authorization: `Bearer ${token}` };
  const get = async (url: string) =>
    (await app.inject({ method: "GET", url, headers })).json().data;

  const points = (await get("/v1/learn/bank")).chapters
    .flatMap((c: any) => c.points)
    .filter((p: any) => p.problems > 0);
  const withAi = points.find((p: any) => p.id in POINT_PRACTICE);
  const without = points.find((p: any) => !(p.id in POINT_PRACTICE));
  assert.ok(withAi && without);
  assert.equal(withAi.aiPractice, true);
  assert.equal(without.aiPractice, false);

  const a = await get(`/v1/learn/points/${withAi.id}/practice`);
  const b = await get(`/v1/learn/points/${without.id}/practice`);
  assert.equal(a.aiPractice, true);
  assert.equal(b.aiPractice, false);
  // The rest is unchanged.
  for (const r of [a, b]) {
    assert.equal(typeof r.problem.index, "number");
    assert.ok(r.problem.total > 0);
    assert.ok(["choice", "blanks"].includes(r.problem.format));
  }
});

// map_reports.problem_index is CHECKed to (0,1), from when a point had two
// problems; past the second the served position goes to bank_index.
test(
  "这题有问题 on a bank problem past the second",
  async (t) => {
    const app = makeApp(
      fakeServices(),
      {},
      () => new Date("2026-10-04T20:00:00Z"),
      new SqliteStore(":memory:"),
    );
    t.after(() => app.close());
    const { token } = (
      await app.inject({
        method: "POST",
        url: "/v1/auth/dev-login",
        payload: { key: "g4r" },
      })
    ).json().data;
    const res = await app.inject({
      method: "POST",
      url: "/v1/learn/points/limit-equivalent/report",
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: "problem", index: 2 },
    });
    assert.equal(res.statusCode, 200);
  },
);

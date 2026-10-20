import assert from "node:assert/strict";
import test from "node:test";
import { fakeServices, makeApp } from "./fixtures.js";
import { SqliteStore } from "../server/src/shared/store.js";

// 心情卡 sit with the other cards; new clients that hide them send
// scene=study,life to the list and the counts. Synthetic text only.
test("counts and lists include 心情卡 unless the scene filter leaves them out", async () => {
  const services = fakeServices();
  services.judge.noul = 0;
  const store = new SqliteStore(":memory:");
  const app = makeApp(services, {}, undefined, store);
  try {
    const login = (
      await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "mood-cards" } })
    ).json().data;
    const headers = { authorization: `Bearer ${login.token}` };
    store.db
      .prepare("UPDATE users SET data=json_set(data,'$.moodConsentAt',?) WHERE id=?")
      .run(store.now(), login.user.id);
    const ids: string[] = [];
    for (const [text, scene] of [
      ["周五前交线代作业", "study"],
      ["周末去爬山", "life"],
      ["今天有点低落", "life"],
    ]) {
      const res = await app.inject({ method: "POST", url: "/v1/cards", headers, payload: { text, kind: "note", scene } });
      assert.equal(res.statusCode, 200, res.body);
      ids.push(res.json().data.card.id);
    }
    // A mood card (made from a mood chat or brainstorm in the app).
    store.db.prepare("UPDATE cards SET scene='mood' WHERE id=?").run(ids[2]);
    const get = async (url: string) => (await app.inject({ url, headers })).json().data;
    // Old clients send no scene: everything, as before.
    assert.equal((await get("/v1/cards")).total, 3);
    assert.equal((await get("/v1/cards/stats")).total, 3);
    assert.equal((await get("/v1/cards/stats")).byKind.note, 3);
    // Hidden: list and counts agree.
    assert.equal((await get("/v1/cards?scene=study,life")).total, 2);
    const hidden = await get("/v1/cards/stats?scene=study,life");
    assert.equal(hidden.total, 2);
    assert.equal(hidden.byKind.note, 2);
    assert.equal(hidden.byType.idea, 2);
  } finally {
    await app.close();
  }
});

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { MoodService } from "../server/src/modules/safety/mood.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { fakeServices, makeApp } from "./fixtures.js";

// V4.2 closing: fields added by different groups that deletion and export
// must also cover.

function fixture(t: TestContext) {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  t.after(() => app.close());
  const login = async (key: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key },
    });
    const { token, user } = response.json().data;
    return {
      userId: user.id as string,
      call: (method: "GET" | "POST" | "DELETE", url: string) =>
        app.inject({ method, url, headers: { authorization: "Bearer " + token } }),
    };
  };
  return { store, login };
}

const now = "2026-10-18T00:00:00.000Z";

test("removing mood content also clears the import text kept past the limit", async (t) => {
  const { store, login } = fixture(t);
  const owner = await login("closing-mood");
  const insert = store.db.prepare(
    "INSERT INTO imports(id,user_id,source,segments,candidates,status,created_at,updated_at,extra) VALUES(?,?,'paste',?,?,'saved',?,?,?)",
  );
  const segments = JSON.stringify([{ n: 1, text: "前面的原文" }]);
  const rest = JSON.stringify({ rest: "超出上限的后半段原文" });
  insert.run("import-mood", owner.userId, segments, JSON.stringify([{ savedScene: "mood" }]), now, now, rest);
  insert.run("import-life", owner.userId, segments, JSON.stringify([{ savedScene: "life" }]), now, now, rest);
  assert.equal(new MoodService(store).remove(owner.userId).imports, 1);
  const extra = (id: string) =>
    store.db.prepare("SELECT extra FROM imports WHERE id=?").get(id)!.extra;
  assert.equal(extra("import-mood"), null);
  assert.equal(extra("import-life"), rest);
});

test("the export carries how a mistake was mastered and the import text kept past the limit", async (t) => {
  const { store, login } = fixture(t);
  const owner = await login("closing-export");
  store.db
    .prepare(
      "INSERT INTO materials(id,user_id,kind,title,status,current_version,created_at,updated_at) VALUES('m1',?,'problem','题','confirmed',1,?,?)",
    )
    .run(owner.userId, now, now);
  store.db
    .prepare(
      "INSERT INTO mistakes(id,user_id,material_id,source,status,due_on,created_at,updated_at,mastered_at,mastered_by) VALUES('k1',?,'m1','judge','mastered','2026-10-20',?,?,?,'redo')",
    )
    .run(owner.userId, now, now, now);
  store.db
    .prepare(
      "INSERT INTO imports(id,user_id,source,segments,status,created_at,updated_at,extra) VALUES('i1',?,'paste','[]','read',?,?,?)",
    )
    .run(owner.userId, now, now, JSON.stringify({ rest: "后半段原文" }));
  const data = (await owner.call("GET", "/v1/me/export")).json();
  assert.equal(data.mistakes[0].masteredBy, "redo");
  assert.deepEqual(data.imports[0].extra, { rest: "后半段原文" });
});

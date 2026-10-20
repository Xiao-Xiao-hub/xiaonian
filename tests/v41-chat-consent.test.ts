import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PREVIOUS_PRIVACY_VERSION, PRIVACY_VERSION } from "../server/src/shared/domain.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { fakeServices, makeApp } from "./fixtures.js";

// Keep one-version compatibility for an older client during rollout.
// Store the version actually consented to, rather than silently upgrading it.
test("consent takes the current and the previous version and records which", async (t) => {
  assert.equal(PRIVACY_VERSION, "2026-10-20.1");
  assert.equal(PREVIOUS_PRIVACY_VERSION, "2026-10-17.1");
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  t.after(() => app.close());
  const login = async (key: string) => {
    const { token, user } = (
      await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key } })
    ).json().data;
    const put = (version: string) =>
      app.inject({
        method: "PUT",
        url: "/v1/me/consent",
        payload: { version, ageBand: "adult" },
        headers: { authorization: `Bearer ${token}` },
      });
    return { id: user.id as string, put };
  };
  const old = await login("consent-prev");
  const prev = await old.put(PREVIOUS_PRIVACY_VERSION);
  assert.equal(prev.statusCode, 200, prev.body);
  assert.equal(prev.json().data.version, PREVIOUS_PRIVACY_VERSION);
  assert.equal(store.getUser(old.id)!.consents!.at(-1)!.version, PREVIOUS_PRIVACY_VERSION);
  // Agreeing to the new text afterwards adds a record for it.
  await old.put(PRIVACY_VERSION);
  assert.deepEqual(
    store.getUser(old.id)!.consents!.map((c) => c.version),
    [PREVIOUS_PRIVACY_VERSION, PRIVACY_VERSION],
  );
  const other = await login("consent-other");
  for (const version of ["2026-10-16.1", "2026-10-18.1", "2026-10-21.1", "2026-01-01.1"]) {
    const res = await other.put(version);
    assert.equal(res.statusCode, 400, version);
    assert.equal(res.json().code, "OLD_VERSION");
  }
  assert.equal(store.getUser(other.id)!.consents, undefined);
  // The three documents and the mini program say the same version.
  for (const doc of ["privacy-policy", "user-agreement", "children-privacy"])
    assert.match(
      readFileSync(new URL(`../server/legal/${doc}.md`, import.meta.url), "utf8"),
      /版本：2026-10-20\.1　更新日期：2026-10-20　生效日期：2026-10-20/,
    );
  assert.match(
    readFileSync(new URL("../miniprogram/utils/config.js", import.meta.url), "utf8"),
    /PRIVACY_VERSION: "2026-10-20\.1"/,
  );
});

test("the privacy policy says chat photos and files go to the AI", () => {
  const policy = readFileSync(new URL("../server/legal/privacy-policy.md", import.meta.url), "utf8");
  const children = readFileSync(new URL("../server/legal/children-privacy.md", import.meta.url), "utf8");
  assert.ok((policy.match(/聊天里发的图片和文件/g) ?? []).length >= 3);
  assert.match(policy, /在聊天里点“＋”选择文件/);
  assert.match(children, /聊天里发的图片和文件交给 AI 处理/);
});

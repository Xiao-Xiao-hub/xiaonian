import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { PRIVACY_VERSION } from "../server/src/shared/domain.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { fakeServices, makeApp } from "./fixtures.js";

const VERSION = PRIVACY_VERSION;

function fixture(t: TestContext) {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  t.after(() => app.close());
  const login = async (key: string) => {
    const response = await app.inject({
      method: "POST", url: "/v1/auth/dev-login", payload: { key },
    });
    const { token, user } = response.json().data;
    return {
      userId: user.id as string,
      call: (method: "GET" | "PUT" | "DELETE", url: string, payload?: object) =>
        app.inject({ method, url, payload, headers: { authorization: "Bearer " + token } }),
    };
  };
  return { app, store, login };
}

test("consent records the documents and age band and reads back", async (t) => {
  const { store, login } = fixture(t);
  const me = await login("consent-adult");
  const empty = await me.call("GET", "/v1/me/consent");
  assert.deepEqual(empty.json().data, { ageBand: null, version: null, at: null });
  const put = await me.call("PUT", "/v1/me/consent", { version: VERSION, ageBand: "adult" });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().data.ageBand, "adult");
  assert.equal(put.json().data.version, VERSION);
  const got = (await me.call("GET", "/v1/me/consent")).json().data;
  assert.equal(got.ageBand, "adult");
  assert.equal(got.version, VERSION);
  const user = store.getUser(me.userId)!;
  assert.equal(user.ageBand, "adult");
  assert.deepEqual(user.consents?.map((c) => c.kind), ["docs"]);
  // An adult keeps the default switches.
  assert.notEqual(user.suggestCards, false);
  assert.notEqual(user.personalized, false);
});

test("a child's consent needs the guardian and turns personalisation off once", async (t) => {
  const { store, login } = fixture(t);
  const me = await login("consent-child");
  const refused = await me.call("PUT", "/v1/me/consent", { version: VERSION, ageBand: "child" });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().code, "GUARDIAN_REQUIRED");
  assert.equal(store.getUser(me.userId)!.ageBand, undefined);

  const ok = await me.call("PUT", "/v1/me/consent", {
    version: VERSION, ageBand: "child", guardian: true,
  });
  assert.equal(ok.statusCode, 200);
  let user = store.getUser(me.userId)!;
  assert.equal(user.ageBand, "child");
  assert.equal(user.suggestCards, false);
  assert.equal(user.personalized, false);
  assert.deepEqual(
    user.consents?.map((c) => (c.kind === "guardian" ? `guardian:${c.scope}` : c.kind)),
    ["docs", "guardian:basic"],
  );
  const prefs = (await me.call("GET", "/v1/me/prefs")).json().data;
  assert.deepEqual(prefs, { personalized: false, studyTime: true });

  // The child turns it back on; a second child consent does not reset it.
  await me.call("PUT", "/v1/me/prefs", { personalized: true });
  await me.call("PUT", "/v1/me/consent", { version: VERSION, ageBand: "child", guardian: true });
  assert.equal(store.getUser(me.userId)!.personalized, true);

  // child → adult does not restore anything by itself.
  await me.call("PUT", "/v1/me/prefs", { personalized: false });
  await me.call("PUT", "/v1/me/consent", { version: VERSION, ageBand: "adult" });
  user = store.getUser(me.userId)!;
  assert.equal(user.ageBand, "adult");
  assert.equal(user.personalized, false);
  assert.equal(user.suggestCards, false);
});

test("consent and prefs reject bad bodies", async (t) => {
  const { app, login } = fixture(t);
  const me = await login("consent-bad");
  for (const body of [
    { version: "v1", ageBand: "adult" },
    { version: VERSION, ageBand: "teen" },
    { version: VERSION, ageBand: "adult", extra: 1 },
  ]) {
    const response = await me.call("PUT", "/v1/me/consent", body);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
  }
  assert.equal((await me.call("PUT", "/v1/me/prefs", {})).statusCode, 400);
  assert.equal((await me.call("PUT", "/v1/me/prefs", { personalized: "no" })).statusCode, 400);
  const anonymous = await app.inject({ method: "GET", url: "/v1/me/consent" });
  assert.equal(anonymous.statusCode, 401);
});

test("prefs default on and save each switch", async (t) => {
  const { login } = fixture(t);
  const me = await login("prefs");
  assert.deepEqual((await me.call("GET", "/v1/me/prefs")).json().data, {
    personalized: true, studyTime: true,
  });
  const put = await me.call("PUT", "/v1/me/prefs", { studyTime: false });
  assert.deepEqual(put.json().data, { personalized: true, studyTime: false });
  assert.deepEqual((await me.call("GET", "/v1/me/prefs")).json().data, {
    personalized: true, studyTime: false,
  });
});

test("mood consent needs the guardian for a child and records it", async (t) => {
  const { store, login } = fixture(t);
  const adult = await login("mood-adult");
  await adult.call("PUT", "/v1/me/consent", { version: VERSION, ageBand: "adult" });
  assert.equal((await adult.call("PUT", "/v1/me/mood-consent", {})).statusCode, 200);
  assert.ok(store.getUser(adult.userId)!.moodConsentAt);

  const child = await login("mood-child");
  await child.call("PUT", "/v1/me/consent", { version: VERSION, ageBand: "child", guardian: true });
  const refused = await child.call("PUT", "/v1/me/mood-consent", {});
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().code, "GUARDIAN_REQUIRED");
  assert.equal(store.getUser(child.userId)!.moodConsentAt, undefined);

  const ok = await child.call("PUT", "/v1/me/mood-consent", { guardian: true });
  assert.equal(ok.statusCode, 200);
  const user = store.getUser(child.userId)!;
  assert.ok(user.moodConsentAt);
  const mood = user.consents?.filter((c) => c.kind === "guardian" && c.scope === "mood");
  assert.equal(mood?.length, 1);
  assert.equal(mood?.[0]?.version, VERSION);
  // Agreeing again adds no second record.
  await child.call("PUT", "/v1/me/mood-consent", { guardian: true });
  assert.equal(
    store.getUser(child.userId)!.consents?.filter((c) => c.kind === "guardian" && c.scope === "mood").length,
    1,
  );
});

test("the server and mini program share one privacy version", () => {
  const config = readFileSync(
    new URL("../miniprogram/utils/config.js", import.meta.url),
    "utf8",
  );
  const match = config.match(/PRIVACY_VERSION:\s*"([^"]+)"/);
  assert.equal(match?.[1], PRIVACY_VERSION);
  assert.equal(VERSION, PRIVACY_VERSION);
});

test("consent takes only the current or previous version, skips repeats and keeps 50", async (t) => {
  const { store, login } = fixture(t);
  const me = await login("consent-version");
  const old = await me.call("PUT", "/v1/me/consent", { version: "2026-01-01.1", ageBand: "adult" });
  assert.equal(old.statusCode, 400);
  assert.equal(old.json().code, "OLD_VERSION");
  assert.equal(store.getUser(me.userId)!.consents, undefined);

  const first = (await me.call("PUT", "/v1/me/consent", { version: VERSION, ageBand: "adult" })).json().data;
  const again = (await me.call("PUT", "/v1/me/consent", { version: VERSION, ageBand: "adult" })).json().data;
  assert.equal(again.at, first.at);
  const kinds = () =>
    store.getUser(me.userId)!.consents!.map((c) => (c.kind === "guardian" ? `guardian:${c.scope}` : c.kind));
  assert.deepEqual(kinds(), ["docs"]);
  // A different age band, then the same child twice.
  await me.call("PUT", "/v1/me/consent", { version: VERSION, ageBand: "child", guardian: true });
  await me.call("PUT", "/v1/me/consent", { version: VERSION, ageBand: "child", guardian: true });
  assert.deepEqual(kinds(), ["docs", "docs", "guardian:basic"]);

  // A withdrawal in between makes the next consent a new record.
  const withdrawn = await me.call("DELETE", "/v1/me/consent");
  assert.equal(withdrawn.statusCode, 200);
  await me.call("PUT", "/v1/me/consent", { version: VERSION, ageBand: "child", guardian: true });
  assert.deepEqual(kinds(), ["docs", "docs", "guardian:basic", "withdraw", "docs", "guardian:basic"]);

  for (let i = 0; i < 30; i++) {
    await me.call("PUT", "/v1/me/consent", { version: VERSION, ageBand: i % 2 ? "child" : "adult", guardian: true });
  }
  const consents = store.getUser(me.userId)!.consents!;
  assert.equal(consents.length, 50);
  assert.equal(consents.at(-1)!.kind, "guardian");
});

test("revoking records a withdrawal and deletes nothing", async (t) => {
  const { store, login, app } = fixture(t);
  const me = await login("consent-withdraw");
  await me.call("PUT", "/v1/me/consent", { version: VERSION, ageBand: "adult" });
  await me.call("PUT", "/v1/me/mood-consent", {});
  const response = await me.call("DELETE", "/v1/me/consent");
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.withdrawn, true);
  const user = store.getUser(me.userId)!;
  const last = user.consents!.at(-1)!;
  assert.equal(last.kind, "withdraw");
  assert.equal(last.version, VERSION);
  assert.ok(last.at);
  // The account and its settings are still there.
  assert.equal(user.ageBand, "adult");
  assert.ok(user.moodConsentAt);
  assert.equal((await me.call("GET", "/v1/me/consent")).json().data.ageBand, "adult");
  const anonymous = await app.inject({ method: "DELETE", url: "/v1/me/consent" });
  assert.equal(anonymous.statusCode, 401);
});

test("an account turning child asks for mood consent again, with the guardian", async (t) => {
  const { store, login } = fixture(t);
  const me = await login("mood-turns-child");
  await me.call("PUT", "/v1/me/consent", { version: VERSION, ageBand: "adult" });
  assert.equal((await me.call("PUT", "/v1/me/mood-consent", {})).statusCode, 200);
  assert.ok(store.getUser(me.userId)!.moodConsentAt);

  await me.call("PUT", "/v1/me/consent", { version: VERSION, ageBand: "child", guardian: true });
  assert.equal(store.getUser(me.userId)!.moodConsentAt, undefined);
  const refused = await me.call("PUT", "/v1/me/mood-consent", {});
  assert.equal(refused.json().code, "GUARDIAN_REQUIRED");
  assert.equal((await me.call("PUT", "/v1/me/mood-consent", { guardian: true })).statusCode, 200);
  const consentedAt = store.getUser(me.userId)!.moodConsentAt;
  assert.ok(consentedAt);

  // With the guardian's mood record in place, agreeing again keeps it.
  await me.call("PUT", "/v1/me/consent", { version: VERSION, ageBand: "adult" });
  await me.call("PUT", "/v1/me/consent", { version: VERSION, ageBand: "child", guardian: true });
  assert.equal(store.getUser(me.userId)!.moodConsentAt, consentedAt);
});

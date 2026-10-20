"use strict";
// V4.md 约定 4: gate's three states, guest mode, the welcome flow and 隐私政策.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");
const VERSION = require(path.join(__dirname, "../miniprogram/utils/config.js")).PRIVACY_VERSION;

let storage, moves, modals, requests, routes;
const mod = (file) => require(path.join(root, file));
function page(file) {
  let value;
  global.Page = (p) => (value = p);
  mod(file);
  value.data = structuredClone(value.data || {});
  value.setData = function (patch) {
    Object.assign(this.data, patch);
  };
  return value;
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const sessionBody = (id = "u-1") => ({
  data: {
    token: "server-token",
    user: { id, nickname: "测试" },
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  },
});
beforeEach(() => {
  Object.keys(require.cache)
    .filter((x) => x.startsWith(root + path.sep))
    .forEach((x) => delete require.cache[x]);
  storage = new Map();
  moves = [];
  modals = [];
  requests = [];
  routes = {
    "GET /v1/config": () => [200, { data: { devLogin: true } }],
    "POST /v1/auth/dev-login": () => [200, sessionBody()],
    "PUT /v1/me/consent": (o) => [200, { data: { ageBand: o.data.ageBand, version: o.data.version } }],
  };
  global.getApp = (() => {
    const app = { globalData: {} };
    return () => app;
  })();
  global.wx = {
    getStorageSync: (key) => (storage.has(key) ? structuredClone(storage.get(key)) : ""),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: (key) => storage.delete(key),
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
    getPrivacySetting: (o) => o.success({ needAuthorization: false }),
    login: () => assert.fail("wx.login must not be called"),
    reLaunch: ({ url }) => moves.push(`relaunch:${url}`),
    navigateTo: ({ url }) => moves.push(url),
    switchTab: ({ url }) => moves.push(`tab:${url}`),
    showModal: (o) => {
      modals.push(o);
      if (o.success) return o.success({ confirm: true });
    },
    showToast() {},
    pageScrollTo() {},
    setClipboardData: (o) => {
      requests.push({ clipboard: o.data });
      o.success();
    },
    request: (o) => {
      const pathname = o.url.replace(/^https?:\/\/[^/]+/, "");
      requests.push({ method: o.method || "GET", pathname, data: o.data, auth: o.header.Authorization });
      const handler = routes[`${o.method || "GET"} ${pathname}`];
      if (!handler) return o.fail({ errMsg: "request:fail" });
      const [statusCode, data] = handler(o);
      o.success({ statusCode, data, header: {} });
    },
  };
});

test("gate has three states; an older or malformed agreement counts as none", () => {
  const gate = mod("utils/gate.js");
  assert.equal(gate.state(), "none");
  storage.set("zhiye_privacy_consent", "2026-10-02.1");
  assert.equal(gate.state(), "none");
  storage.set("zhiye_privacy_consent", { v: "2026-10-02.1", age: "adult" });
  assert.equal(gate.state(), "none");
  storage.set("zhiye_privacy_consent", { v: VERSION, age: "teen" });
  assert.equal(gate.state(), "none");
  storage.set("zhiye_guest", "1");
  assert.equal(gate.state(), "guest");
  mod("utils/auth.js").recordConsent("child");
  assert.equal(gate.state(), "ok");
  assert.equal(gate.age(), "child");
  assert.equal(storage.has("zhiye_guest"), false, "agreeing leaves guest mode");
});

test("check() sends only state none back to the welcome page", () => {
  const gate = mod("utils/gate.js");
  assert.equal(gate.check(), false);
  assert.deepEqual(moves, ["relaunch:/pages/welcome/index"]);
  mod("utils/auth.js").enterGuest();
  assert.equal(gate.check(), true);
  mod("utils/auth.js").recordConsent("adult");
  assert.equal(gate.check(), true);
  assert.equal(moves.length, 1);
});

test("a guest never logs in; a request says GUEST_MODE and asks to agree", async () => {
  const auth = mod("utils/auth.js");
  const api = mod("utils/api.js");
  auth.enterGuest();
  await assert.rejects(auth.login(), (e) => e.code === "GUEST_MODE");
  let error;
  await api.post("/v1/notes", { text: "草稿" }).catch((e) => (error = e));
  assert.equal(error.code, "GUEST_MODE");
  assert.equal(requests.length, 0);
  assert.equal(api.needsConsent(error), true);
  assert.equal(modals.length, 1);
  assert.deepEqual(moves, ["relaunch:/pages/welcome/index"]);
  // Without any choice it is CONSENT_REQUIRED, which goes straight back.
  auth.clearConsent();
  storage.delete("zhiye_guest");
  await assert.rejects(auth.login(), (e) => e.code === "CONSENT_REQUIRED");
});

test("先看看 keeps a guest on the page, except on pages with nothing a guest can see", () => {
  const gate = mod("utils/gate.js");
  let stack = 2;
  global.getCurrentPages = () => Array.from({ length: stack }, () => ({}));
  wx.navigateBack = () => moves.push("back");
  wx.showModal = (o) => o.success({ confirm: false, cancel: true });
  gate.ask();
  assert.deepEqual(moves, []);
  gate.ask({ leave: true });
  stack = 1;
  gate.ask({ leave: true });
  assert.deepEqual(moves, ["back", "tab:/pages/notes/index"]);
  wx.showModal = (o) => o.success({ confirm: true, cancel: false });
  gate.ask({ leave: true });
  assert.deepEqual(moves.slice(2), ["relaunch:/pages/welcome/index"]);
  delete global.getCurrentPages;
  // The pages a guest can reach only by a direct link, each with nothing to show.
  const pages = [
    "brainstorm/process", "brainstorm/conclude", "brainstorm/result", "brainstorm/pick", "card-pick",
    "tags", "resume-list", "resume-settings", "import/source", "import/split", "note", "chapter",
  ];
  for (const name of pages) {
    const code = fs.readFileSync(path.join(root, `pages/${name}/index.js`), "utf8");
    assert.match(code, /gate\.ask\(\{ leave: true \}\)/, name);
    assert.doesNotMatch(code, /gate\.ask\(\)/, name);
  }
});

test("guest mode keeps an old session so 隐私政策 can still export and revoke", async () => {
  mod("utils/session.js").setSession(sessionBody("old-user").data);
  mod("utils/auth.js").enterGuest();
  const privacy = page("pages/privacy/index.js");
  privacy.onShow();
  assert.equal(privacy.data.canRevoke, true);
  assert.equal(privacy.data.signedIn, true);
  assert.equal(privacy.data.age, "");
});

test("copyAi marks the copied text once", async () => {
  const { copyAi } = mod("utils/copy.js");
  await copyAi("先看分母是几阶。\n");
  await copyAi("已经有标记（AI 生成）");
  assert.deepEqual(requests.map((r) => r.clipboard), [
    "先看分母是几阶。（AI 生成）",
    "已经有标记（AI 生成）",
  ]);
});

test("welcome: 同意并继续 only opens 青少年守护; closing records nothing", () => {
  const welcome = page("pages/welcome/index.js");
  welcome.agree();
  assert.equal(welcome.data.youth, true);
  welcome.closeYouth();
  assert.equal(welcome.data.youth, false);
  assert.equal(storage.size, 0);
  assert.equal(requests.length, 0);
});

test("welcome: 已满14岁 saves the agreement on the account, then the tour once", async () => {
  const welcome = page("pages/welcome/index.js");
  welcome.agree();
  welcome.pick({ currentTarget: { dataset: { age: "adult" } } });
  await settle();
  const put = requests.find((r) => r.pathname === "/v1/me/consent");
  assert.deepEqual(put.data, { version: VERSION, ageBand: "adult" });
  assert.equal(put.auth, "Bearer server-token");
  assert.deepEqual(moves, ["relaunch:/pages/onboard/index"]);
  const onboard = page("pages/onboard/index.js");
  onboard.onLoad();
  // seen for good only at the end, so a cut-short tour comes back.
  assert.equal(storage.has("zhiye_onboarded"), false);
  onboard.next();
  onboard.next();
  onboard.next();
  assert.equal(storage.get("zhiye_onboarded"), "1");
  assert.equal(moves.at(-1), "relaunch:/pages/notes/index");
});

test("welcome: 监护人同意 sends the guardian's consent; a phone that saw the tour skips it", async () => {
  mod("utils/session.js").setSession(sessionBody("old-user").data);
  storage.set("zhiye_privacy_consent", "2026-10-02.1");
  // an older agreement alone no longer skips the tour; having seen it does.
  storage.set("zhiye_onboarded", "1");
  const welcome = page("pages/welcome/index.js");
  welcome.pick({ currentTarget: { dataset: { age: "child" } } });
  await settle();
  const put = requests.find((r) => r.pathname === "/v1/me/consent");
  assert.deepEqual(put.data, { version: VERSION, ageBand: "child", guardian: true });
  assert.equal(mod("utils/gate.js").age(), "child");
  assert.deepEqual(moves, ["relaunch:/pages/notes/index"]);
});

test("welcome: a failed save leaves nothing agreed and can be tried again", async () => {
  routes["PUT /v1/me/consent"] = () => [503, { code: "UNAVAILABLE", message: "服务器忙，过一会儿再试" }];
  const welcome = page("pages/welcome/index.js");
  welcome.pick({ currentTarget: { dataset: { age: "adult" } } });
  await settle();
  assert.equal(welcome.data.error, "服务器忙，过一会儿再试");
  assert.equal(welcome.data.busy, false);
  assert.equal(mod("utils/gate.js").state(), "none");
  assert.deepEqual(moves, []);
  routes["PUT /v1/me/consent"] = (o) => [200, { data: { ageBand: o.data.ageBand } }];
  welcome.pick({ currentTarget: { dataset: { age: "adult" } } });
  await settle();
  // The first try's session does not make this a returning user.
  assert.deepEqual(moves, ["relaunch:/pages/onboard/index"]);
});

test("welcome: 不同意 and 游客模式 enter guest mode without a request", () => {
  const welcome = page("pages/welcome/index.js");
  welcome.refuse();
  assert.equal(mod("utils/gate.js").state(), "guest");
  assert.deepEqual(moves, ["relaunch:/pages/notes/index"]);
  assert.equal(requests.length, 0);
});

test("隐私政策: a child's 撤回 deletes the account after one confirmation", async () => {
  routes["GET /v1/me/consent"] = () => [200, { data: { ageBand: "child", version: VERSION } }];
  routes["DELETE /v1/me"] = () => [200, { data: { deleted: true } }];
  mod("utils/session.js").setSession(sessionBody("kid").data);
  mod("utils/auth.js").recordConsent("child");
  storage.set("v2_map_cache:kid", { chapters: [] });
  storage.set("v2_map_view:kid", { top: 1 });
  const privacy = page("pages/privacy/index.js");
  privacy.onShow();
  assert.equal(privacy.data.age, "child");
  privacy.revoke();
  await settle();
  assert.equal(modals.length, 1);
  assert.match(modals[0].content, /注销账号/);
  assert.deepEqual(
    requests.map((r) => [r.method, r.pathname, r.data]),
    [["GET", "/v1/me/consent", undefined], ["DELETE", "/v1/me", { confirm: true }]],
  );
  assert.equal(mod("utils/session.js").getSession(), null);
  assert.equal(mod("utils/gate.js").state(), "none");
  assert.equal(privacy.data.canRevoke, false);
  assert.equal(storage.has("v2_map_cache:kid"), false);
  assert.equal(storage.has("v2_map_view:kid"), false);
  assert.deepEqual(moves, ["tab:/pages/notes/index"]);
});

test("隐私政策: the server's age band picks the 撤回 path, not this phone's", async () => {
  // This phone says adult, the account is a child's: the account is deleted.
  routes["GET /v1/me/consent"] = () => [200, { data: { ageBand: "child", version: VERSION } }];
  routes["DELETE /v1/me"] = () => [200, { data: { deleted: true } }];
  mod("utils/session.js").setSession(sessionBody("kid").data);
  mod("utils/auth.js").recordConsent("adult");
  const privacy = page("pages/privacy/index.js");
  privacy.revoke();
  await settle();
  assert.match(modals[0].title, /注销账号/);

  // This phone says child, the account is an adult's: only 撤回授权.
  storage.clear();
  modals.length = 0;
  requests.length = 0;
  routes["GET /v1/me/consent"] = () => [200, { data: { ageBand: "adult", version: VERSION } }];
  routes["DELETE /v1/me/consent"] = () => [200, { data: { withdrawn: true } }];
  routes["POST /v1/auth/logout"] = () => [200, { data: {} }];
  mod("utils/session.js").setSession(sessionBody("grown").data);
  mod("utils/auth.js").recordConsent("child");
  storage.set("v2_map_cache:grown", { chapters: [] });
  storage.set("v2_map_view:grown", { top: 1 });
  privacy.revoke();
  await settle();
  assert.equal(modals[0].title, "撤回授权");
  assert.deepEqual(
    requests.map((r) => [r.method, r.pathname]),
    [["GET", "/v1/me/consent"], ["DELETE", "/v1/me/consent"], ["POST", "/v1/auth/logout"]],
  );
  assert.equal(mod("utils/session.js").getSession(), null);
  assert.equal(mod("utils/gate.js").state(), "none");
  assert.equal(storage.has("v2_map_cache:grown"), false);
  assert.equal(storage.has("v2_map_view:grown"), false);
});

test("隐私政策: 撤回 says what went wrong when the age band cannot be read", async () => {
  mod("utils/session.js").setSession(sessionBody("kid").data);
  mod("utils/auth.js").recordConsent("adult");
  const privacy = page("pages/privacy/index.js");
  // Offline: nothing happens, and no adult path by default.
  privacy.revoke();
  await settle();
  assert.equal(modals.length, 0);
  assert.ok(privacy.data.error);
  assert.equal(privacy.data.busy, false);
  assert.equal(mod("utils/gate.js").state(), "ok");
  assert.ok(mod("utils/session.js").getSession());
  // An expired login says so.
  routes["GET /v1/me/consent"] = () => [401, { code: "SESSION_EXPIRED", message: "登录状态已失效" }];
  privacy.revoke();
  await settle();
  assert.equal(modals.length, 0);
  assert.equal(privacy.data.error, "登录过期了，重新打开晓念登录后再来撤回");
});

test("隐私政策: an adult's 撤回 still logs out when the withdrawal cannot be recorded", async () => {
  routes["GET /v1/me/consent"] = () => [200, { data: { ageBand: "adult", version: VERSION } }];
  routes["POST /v1/auth/logout"] = () => [200, { data: {} }];
  mod("utils/session.js").setSession(sessionBody("me").data);
  mod("utils/auth.js").recordConsent("adult");
  const privacy = page("pages/privacy/index.js");
  privacy.revoke();
  await settle();
  assert.deepEqual(
    requests.map((r) => [r.method, r.pathname]),
    [["GET", "/v1/me/consent"], ["DELETE", "/v1/me/consent"], ["POST", "/v1/auth/logout"]],
  );
  // logged out, and said plainly that the withdrawal is not on record.
  assert.equal(privacy.data.error, "已经退出了，但撤回没记到服务器上（没连上）。下次登录时会重新问你是否同意。");
  assert.equal(mod("utils/session.js").getSession(), null);
  assert.equal(mod("utils/gate.js").state(), "none");
});

test("an interrupted 监护人同意 is saved on the account before anything else at the next start", async () => {
  // The welcome page recorded the choice, then the app was closed before the save.
  mod("utils/auth.js").recordConsent("child", false);
  routes["POST /v1/notes"] = () => [200, { data: { id: "n1" } }];
  // The next start: nothing else goes out before the age band is saved.
  const offline = routes["PUT /v1/me/consent"];
  delete routes["PUT /v1/me/consent"];
  await assert.rejects(mod("utils/api.js").post("/v1/notes", { text: "草稿" }));
  assert.equal(requests.some((r) => r.pathname === "/v1/notes"), false);
  assert.equal(storage.get("zhiye_privacy_consent").synced, false);

  routes["PUT /v1/me/consent"] = offline;
  let app;
  global.App = (value) => (app = value);
  mod("app.js");
  app.onShow();
  await settle();
  const puts = requests.filter((r) => r.method === "PUT" && r.pathname === "/v1/me/consent");
  assert.deepEqual(puts.at(-1).data, { version: VERSION, ageBand: "child", guardian: true });
  assert.equal(storage.get("zhiye_privacy_consent").synced, true);
  assert.deepEqual(await mod("utils/api.js").post("/v1/notes", { text: "草稿" }), { id: "n1" });
  // Saved once; later requests do not send it again.
  assert.equal(requests.filter((r) => r.pathname === "/v1/me/consent").length, puts.length);
});

test("a business request with an unsaved agreement saves it first, signing in again after a 401", async () => {
  mod("utils/session.js").setSession(sessionBody("me").data);
  mod("utils/auth.js").recordConsent("child", false);
  routes["POST /v1/auth/dev-login"] = () => [200, sessionBody("me")];
  let expired = true;
  routes["PUT /v1/me/consent"] = (o) =>
    expired
      ? ((expired = false), [401, { code: "SESSION_EXPIRED", message: "登录状态已失效" }])
      : [200, { data: { ageBand: o.data.ageBand, version: o.data.version } }];
  routes["POST /v1/notes"] = () => [200, { data: { id: "n1" } }];
  assert.deepEqual(await mod("utils/api.js").post("/v1/notes", { text: "草稿" }), { id: "n1" });
  assert.deepEqual(
    requests.map((r) => [r.method, r.pathname]),
    [
      ["PUT", "/v1/me/consent"],
      ["GET", "/v1/config"],
      ["POST", "/v1/auth/dev-login"],
      ["PUT", "/v1/me/consent"],
      ["POST", "/v1/notes"],
    ],
  );
  assert.equal(storage.get("zhiye_privacy_consent").synced, true);
});

test("mood consent shows the guardian's checkbox when the server says the account is a child's", async () => {
  mod("utils/session.js").setSession(sessionBody("kid").data);
  mod("utils/auth.js").recordConsent("adult");
  routes["PUT /v1/me/mood-consent"] = () => [400, { code: "GUARDIAN_REQUIRED", message: "未满 14 周岁要监护人同意" }];
  global.getCurrentPages = () => [];
  const mood = page("pages/mood-consent/index.js");
  mood.onLoad({});
  mood.onShow();
  assert.equal(mood.data.child, false);
  mood.agree();
  await settle();
  assert.equal(mood.data.child, true);
  assert.equal(mood.data.guardian, false);
  assert.ok(mood.data.error);
  mood.onShow();
  assert.equal(mood.data.child, true);
});

test("a stopped request after agreeing again asks to tap once more instead of going back", () => {
  const toasts = [];
  wx.showToast = (o) => toasts.push(o.title);
  const api = mod("utils/api.js");
  mod("utils/auth.js").recordConsent("adult");
  assert.equal(api.needsConsent({ code: "CONSENT_REQUIRED" }), true);
  assert.equal(toasts.length, 1);
  assert.deepEqual(moves, []);
  mod("utils/auth.js").clearConsent();
  assert.equal(api.needsConsent({ code: "CONSENT_REQUIRED" }), true);
  assert.deepEqual(moves, ["relaunch:/pages/welcome/index"]);
});

test("隐私政策: age band changes go through the account first", async () => {
  mod("utils/session.js").setSession(sessionBody("me").data);
  mod("utils/auth.js").recordConsent("child");
  const privacy = page("pages/privacy/index.js");
  privacy.onShow();
  privacy.toAdult();
  await settle();
  assert.deepEqual(requests.at(-1).data, { version: VERSION, ageBand: "adult" });
  assert.equal(privacy.data.age, "adult");
  privacy.toChild();
  assert.equal(privacy.data.guardian, true);
  privacy.guardianAgree();
  await settle();
  assert.deepEqual(requests.at(-1).data, { version: VERSION, ageBand: "child", guardian: true });
  assert.equal(privacy.data.age, "child");
  assert.equal(privacy.data.guardian, false);
});

test("协议查看页 opens the asked document and switches", async () => {
  const view = (doc) => ({ doc, title: doc, version: "版本", summary: { head: "摘要", note: "", blocks: [] }, blocks: [], sections: [{ title: "一、", blocks: [] }] });
  for (const doc of ["user-agreement", "privacy-policy", "children-privacy"])
    routes[`GET /v1/legal/${doc}`] = () => [200, { data: view(doc) }];
  const legal = page("pages/legal/index.js");
  legal.onLoad({ doc: "children-privacy" });
  await settle();
  assert.equal(legal.data.view.doc, "children-privacy");
  legal.pick({ currentTarget: { dataset: { doc: "user-agreement" } } });
  await settle();
  assert.equal(legal.data.view.doc, "user-agreement");
  assert.equal(requests.every((r) => r.auth === undefined), true, "public, no login");
});

test("welcome keeps the designed text and the native privacy button; no old wording anywhere", () => {
  const welcome = fs.readFileSync(path.join(root, "pages/welcome/index.wxml"), "utf8");
  assert.match(welcome, /open-type="agreePrivacyAuthorization"/);
  for (const text of ["用户隐私协议", "同意并继续", "不同意", "青少年守护", "监护人同意", "已满14岁", "游客模式"])
    assert.ok(welcome.includes(text), text);
  const app = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
  for (const p of ["pages/welcome/index", "pages/onboard/index", "pages/legal/index"])
    assert.ok(app.pages.includes(p), p);
  for (const file of [
    "pages/welcome/index.wxml",
    "pages/onboard/index.wxml",
    "pages/privacy/index.wxml",
    "pages/mood-consent/index.wxml",
    "pages/notes/index.wxml",
    "pages/home/index.wxml",
  ])
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"), /境内|境外|数据出境/, file);
});

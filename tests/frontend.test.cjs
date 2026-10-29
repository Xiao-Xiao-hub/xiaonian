"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");

test("AI content pages keep one top-level verification notice", () => {
  const notice = "AI 生成可能有误，注意核实";
  const pages = [
    "material/index",
    "problem/index",
    "practice/index",
    "grade/index",
    "note/index",
    "review/index",
    "mistakes/index",
    "proofread/index",
  ];
  for (const page of pages) {
    const source = fs.readFileSync(path.join(root, "pages", `${page}.wxml`), "utf8");
    assert.match(source, new RegExp(`^[\\s\\S]*?<view class=\\"[^\\"]*(?:page|landscape-page)[^\\"]*\\"[^>]*>\\s*<view class=\\"ai-line\\">${notice}</view>`));
  }
  const map = fs.readFileSync(path.join(root, "pages/map/index.wxml"), "utf8");
  // 40-map.html: no notice under the toolbar. V4.1 G4: the stuck sheet (and its
  // AI reply) moved to the detail page, which keeps the notice at its top only
  // (one AI line per page).
  assert.equal(map.split(notice).length - 1, 0, "the map shows no AI reply any more");
  const detail = fs.readFileSync(path.join(root, "pages/knowledge/index.wxml"), "utf8");
  assert.match(detail, new RegExp(`^<view class="page[^"]*"[^>]*>\\s*<view class="ai-line">${notice}</view>`));
  assert.equal(detail.split(notice).length - 1, 1, "one notice, at the top");
  const landscape = fs.readFileSync(path.join(root, "pages/map/landscape/index.wxml"), "utf8");
  assert.ok(landscape.indexOf('class="land-nav"') < landscape.indexOf(`class="ai-line">${notice}`));
  assert.ok(landscape.indexOf(`class="ai-line">${notice}`) < landscape.indexOf('class="status"'));
  const app = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
  assert.ok(!app.pages.includes("pages/home/index"), "unreachable legacy home is not registered");
});
let storage;
let envVersion;
function mod(file) {
  return require(path.join(root, file));
}
// setData keys may be paths such as "messages[1].blocks[0]", as in WeChat.
function setPath(data, key, value) {
  const parts = key.match(/[^.[\]]+/g);
  let target = data;
  for (let i = 0; i < parts.length - 1; i++) {
    if (target[parts[i]] === undefined)
      target[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    target = target[parts[i]];
  }
  target[parts[parts.length - 1]] = value;
}
function page(file) {
  let value;
  global.Page = (p) => {
    value = p;
  };
  mod(file);
  value.data = structuredClone(value.data || {});
  value.setData = (patch) => {
    for (const [key, v] of Object.entries(patch)) setPath(value.data, key, v);
  };
  return value;
}
function wxStub() {
  return {
    getStorageSync: (key) => structuredClone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: (key) => storage.delete(key),
    getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
    getPrivacySetting: (opts) => opts.success({ needAuthorization: false }),
    showModal: (args) => args.success && args.success({ confirm: true }),
    setNavigationBarTitle() {},
    setNavigationBarColor() {},
    setBackgroundColor() {},
    setTabBarStyle() {},
    setTabBarItem() {},
    navigateTo() {},
    redirectTo() {},
    switchTab() {},
    reLaunch() {},
    pageScrollTo() {},
    stopPullDownRefresh() {},
    showToast() {},
  };
}
// Route stubbed wx.request calls by path; each handler returns [statusCode, body].
function serve(routes) {
  const calls = [];
  wx.request = (opts) => {
    const pathname = opts.url.replace(/^https?:\/\/[^/]+/, "");
    calls.push({ ...opts, pathname });
    const handler = routes[`${opts.method || "GET"} ${pathname}`];
    if (!handler) return opts.fail({ errMsg: "request:fail" });
    const [statusCode, data] = handler(opts);
    opts.success({ statusCode, data, header: {} });
  };
  return calls;
}
const sessionBody = (id = "u-1") => ({
  data: {
    token: "server-token",
    user: { id, nickname: "测试" },
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  },
});
async function microtasksUntil(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail("expected asynchronous stage did not start");
}
beforeEach(() => {
  Object.keys(require.cache)
    .filter((x) => x.startsWith(root + path.sep))
    .forEach((x) => delete require.cache[x]);
  storage = new Map();
  envVersion = "develop";
  global.wx = wxStub();
  const app = { globalData: {} };
  global.getApp = () => app;
});

test("all registered native pages have four files and bound handlers, with no HTML br or missing local images", () => {
  const app = JSON.parse(fs.readFileSync(path.join(root, "app.json")));
  for (const entry of app.pages) {
    for (const ext of ["js", "json", "wxml", "wxss"])
      assert.ok(
        fs.existsSync(path.join(root, `${entry}.${ext}`)),
        `${entry}.${ext}`,
      );
    const definition = page(`${entry}.js`);
    const wxml = fs.readFileSync(path.join(root, `${entry}.wxml`), "utf8");
    assert.doesNotMatch(wxml, /<br\b/);
    for (const m of wxml.matchAll(
      /(?:bind|catch)(?:tap|longpress|input|change|confirm|blur|agreeprivacyauthorization)="([A-Za-z]\w*)"/g,
    ))
      assert.equal(typeof definition[m[1]], "function", `${entry}: ${m[1]}`);
    for (const m of wxml.matchAll(/src="(\/[^"{]+)"/g))
      assert.ok(fs.existsSync(path.join(root, m[1])), `${entry}: ${m[1]}`);
  }
  for (const tab of app.tabBar.list)
    for (const icon of [tab.iconPath, tab.selectedIconPath])
      assert.ok(fs.existsSync(path.join(root, icon)), icon);
});

test("app launch never silently logs the visitor in", () => {
  let app;
  global.App = (value) => {
    app = value;
  };
  mod("app.js");
  app.onLaunch();
  assert.equal(storage.size, 0);
});

test("crisis event removes waiting reply and opens help, with actions limited to phone and return", () => {
  const ask = page("pages/ask/index.js");
  ask.alive = true;
  ask.data.messages = [{ id: "local_test", role: "user" }, { id: "wait_test", role: "assistant", status: "streaming" }];
  let destination;
  wx.navigateTo = (options) => { destination = options.url; };
  ask.onEvent({ e: "crisis", thread: { id: "thread_test" }, question: { id: "msg_test", role: "user", crisis: 1, status: "done" } }, "test");
  assert.equal(destination, "/pages/crisis/index");
  assert.deepEqual(ask.data.messages.map((m) => m.id), ["msg_test"]);
  assert.equal(ask.data.sending, false);
  assert.deepEqual(ask.data.actions, []);
});

test("consent is required and concurrent login shares one in-flight exchange", async () => {
  const auth = mod("utils/auth.js");
  await assert.rejects(auth.login(), /隐私/);
  const calls = serve({
    "GET /v1/config": () => [200, { data: { devLogin: true } }],
    "POST /v1/auth/dev-login": () => [200, sessionBody("dev-user")],
  });
  auth.recordConsent();
  const [a, b] = await Promise.all([auth.login(), auth.login()]);
  const logins = calls.filter((c) => c.pathname.includes("login"));
  assert.equal(logins.length, 1);
  assert.deepEqual(logins[0].data, { key: "owner" });
  assert.equal(a.id, b.id);
  assert.equal(auth.getUser().id, "dev-user");
});

test("expired or malformed cached sessions are never accepted", () => {
  const store = mod("utils/session.js");
  for (const expiresAt of [
    "bad-date",
    new Date(Date.now() - 1000).toISOString(),
  ]) {
    store.setSession({ token: "x", user: { id: "x" }, expiresAt });
    assert.equal(store.getSession(), null);
  }
});

test("a cached session cannot send learning content after the privacy version changes", async () => {
  mod("utils/session.js").setSession(sessionBody("existing-user").data);
  storage.set("zhiye_privacy_consent", "previous-version");
  const calls = serve({
    "POST /v1/materials": () => [200, { data: { id: "material" } }],
  });
  await assert.rejects(
    mod("utils/api.js").post("/v1/materials", { text: "笔记" }),
    (error) => error.code === "CONSENT_REQUIRED",
  );
  assert.equal(calls.length, 0);
  mod("utils/auth.js").recordConsent();
  assert.deepEqual(
    await mod("utils/api.js").post("/v1/materials", { text: "笔记" }),
    { id: "material" },
  );
  assert.equal(calls.length, 1);
});

test("outside the develop version login always uses the WeChat code, never dev login", async () => {
  envVersion = "trial";
  mod("utils/config.js").API_BASE_URL = "https://api.example.test";
  let codeCalls = 0;
  wx.login = (opts) => {
    codeCalls++;
    opts.success({ code: "one-time-code" });
  };
  const calls = serve({
    "POST /v1/auth/wechat-login": () => [200, sessionBody("real-user")],
  });
  const auth = mod("utils/auth.js");
  auth.recordConsent();
  await auth.login();
  assert.equal(codeCalls, 1);
  assert.deepEqual(
    calls.map((c) => c.pathname),
    ["/v1/auth/wechat-login"],
  );
  assert.deepEqual(calls[0].data, { code: "one-time-code" });
  assert.equal(mod("utils/session.js").getSession().token, "server-token");
});

test("release builds refuse to send requests without an HTTPS base URL", async () => {
  envVersion = "release";
  mod("utils/config.js").API_BASE_URL = "http://insecure.example.test";
  const calls = serve({});
  await assert.rejects(
    mod("utils/request.js").request({ url: "/v1/config" }),
    (error) => error.code === "NO_API_BASE_URL",
  );
  assert.equal(calls.length, 0);
});

test("requests attach Bearer, HTTP 401 clears session, and correlation ID is preserved", async () => {
  mod("utils/session.js").setSession(sessionBody().data);
  const calls = serve({
    "GET /v1/auth/me": () => [
      401,
      {
        code: "SESSION_EXPIRED",
        message: "登录状态已失效",
        requestId: "trace-test",
      },
    ],
  });
  await assert.rejects(
    mod("utils/request.js").request({ url: "/v1/auth/me", auth: true }),
    (error) => error.requestId === "trace-test",
  );
  assert.equal(calls[0].header.Authorization, "Bearer server-token");
  assert.equal(mod("utils/session.js").getSession(), null);
});

test("login cannot proceed while the native privacy consent is still pending", async () => {
  let requests = 0;
  wx.getPrivacySetting = (args) => args.success({ needAuthorization: true });
  wx.request = () => {
    requests++;
  };
  const auth = mod("utils/auth.js");
  auth.recordConsent();
  await assert.rejects(
    auth.login(),
    (error) => error.code === "CONSENT_REQUIRED",
  );
  assert.equal(requests, 0);
  // Our consent is cleared, so the next page sends the user back to the welcome page.
  assert.equal(auth.hasConsent(), false);
});

test("after a privacy version change an old session can still export, delete the account and revoke", async () => {
  mod("utils/session.js").setSession(sessionBody("existing-user").data);
  storage.set("zhiye_privacy_consent", "previous-version");
  getApp().globalData.noteContext = { pointId: "point-old", name: "旧知识点" };
  mod("utils/learning-space.js").remember("existing-user", "point-old");
  const calls = serve({
    "DELETE /v1/me": () => [200, { data: { deleted: true } }],
    "POST /v1/auth/logout": () => [200, { data: { loggedOut: true } }],
    "GET /v1/me/consent": () => [200, { data: { ageBand: "adult", version: "2026-10-02.1" } }],
    "DELETE /v1/me/consent": () => [200, { data: { withdrawn: true } }],
  });
  const downloads = [];
  wx.downloadFile = (opts) => {
    downloads.push(opts);
    opts.success({ statusCode: 200, tempFilePath: "export.json" });
  };
  wx.shareFileMessage = (opts) => opts.success();
  const privacy = page("pages/privacy/index.js");
  privacy.onShow();
  assert.equal(privacy.data.canRevoke, true);
  // v4: 我的 goes through utils/gate.js, so an old consent goes to the welcome
  // page and 我的 sends nothing; export and 注销 stay on 隐私政策.
  const relaunched = [];
  wx.reLaunch = (opts) => relaunched.push(opts.url);
  const profile = page("pages/profile/index.js");
  profile.onShow();
  assert.deepEqual(relaunched, ["/pages/welcome/index"]);
  privacy.exportData();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(privacy.data.error, "");
  assert.equal(downloads[0].header.Authorization, "Bearer server-token");
  assert.deepEqual(calls, []);
  // No current age band: the page lists 注销账号.
  assert.equal(privacy.data.age, "");
  const wxml = fs.readFileSync(path.join(root, "pages/privacy/index.wxml"), "utf8");
  assert.match(wxml, /<view wx:else class="item"[^>]*bindtap="deleteAccount">/);
  privacy.deleteAccount();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(privacy.data.error, "");
  assert.deepEqual(
    calls.map((c) => [c.method, c.pathname, c.header.Authorization]),
    [["DELETE", "/v1/me", "Bearer server-token"]],
  );
  assert.equal(mod("utils/session.js").getSession(), null);
  assert.equal(getApp().globalData.noteContext, undefined);
  assert.equal(storage.has("zhiye_last_point:existing-user"), false);
  calls.length = 0;

  // Revoking an old consent is a separate action and must not require renewal.
  mod("utils/session.js").setSession(sessionBody("existing-user").data);
  storage.set("zhiye_privacy_consent", "previous-version");
  getApp().globalData.noteContext = { pointId: "point-old", name: "旧知识点" };
  mod("utils/learning-space.js").remember("existing-user", "point-old");
  privacy.onShow();
  privacy.revoke();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(privacy.data.error, "");
  assert.equal(privacy.data.canRevoke, false);
  assert.equal(mod("utils/session.js").getSession(), null);
  assert.equal(storage.has("zhiye_privacy_consent"), false);
  assert.equal(storage.has("zhiye_last_point:existing-user"), false);
  assert.equal(getApp().globalData.noteContext, undefined);
  assert.deepEqual(
    calls.map((c) => [c.method, c.pathname, c.header.Authorization]),
    [
      ["GET", "/v1/me/consent", "Bearer server-token"],
      ["DELETE", "/v1/me/consent", "Bearer server-token"],
      ["POST", "/v1/auth/logout", "Bearer server-token"],
    ],
  );
});

test("revoking consent during a network failure clears local credentials, pointers and context", async () => {
  mod("utils/session.js").setSession(sessionBody("existing-user").data);
  mod("utils/auth.js").recordConsent();
  mod("utils/learning-space.js").remember("existing-user", "point-old");
  getApp().globalData.noteContext = { pointId: "point-old", name: "旧知识点" };
  const requests = [];
  // The age band is read, then the network goes.
  wx.request = (opts) => {
    if (!requests.length && (opts.method || "GET") === "GET" && opts.url.endsWith("/v1/me/consent"))
      return opts.success({ statusCode: 200, data: { data: { ageBand: "adult" } }, header: {} });
    requests.push(opts);
    opts.fail({ errMsg: "request:fail offline" });
  };
  let revokeTask;
  wx.showModal = (args) => {
    revokeTask = args.success({ confirm: true });
  };
  const privacy = page("pages/privacy/index.js");
  privacy.onShow();
  assert.equal(privacy.data.canRevoke, true);
  privacy.revoke();
  await microtasksUntil(() => revokeTask);
  await revokeTask;
  assert.deepEqual(
    requests.map((r) => [r.method, new URL(r.url).pathname, r.header.Authorization]),
    [
      ["DELETE", "/v1/me/consent", "Bearer server-token"],
      ["POST", "/v1/auth/logout", "Bearer server-token"],
    ],
  );
  assert.equal(
    privacy.data.error,
    // says the withdrawal was not recorded either.
    "这台手机已经退出了。服务器没连上，撤回没记上；那边的登录过一阵会自己失效，下次登录时会重新问你是否同意。",
  );
  assert.equal(privacy.data.canRevoke, false);
  assert.equal(mod("utils/session.js").getSession(), null);
  assert.equal(storage.has("zhiye_privacy_consent"), false);
  assert.equal(storage.has("zhiye_last_point:existing-user"), false);
  assert.equal(getApp().globalData.noteContext, undefined);
});

for (const boundary of [
  "platform privacy",
  "config",
  "WeChat code",
  "session",
]) {
  test(`revocation invalidates a pending login at the ${boundary} boundary`, async () => {
    const auth = mod("utils/auth.js");
    const session = mod("utils/session.js");
    let held;
    const requests = [];
    if (boundary === "platform privacy")
      wx.getPrivacySetting = (opts) => {
        held = opts;
      };
    if (boundary === "WeChat code") {
      envVersion = "trial";
      mod("utils/config.js").API_BASE_URL = "https://api.example.test";
      wx.login = (opts) => {
        held = opts;
      };
    }
    wx.request = (opts) => {
      const route = new URL(opts.url).pathname;
      requests.push(route);
      if (route === "/v1/config") {
        if (boundary === "config") held = opts;
        else
          opts.success({ statusCode: 200, data: { data: { devLogin: true } } });
      } else if (route === "/v1/auth/dev-login") held = opts;
      else assert.fail(`unexpected request ${route}`);
    };
    auth.recordConsent();
    const business = mod("utils/api.js").post("/v1/notes", {
      text: "撤权前草稿",
    });
    const rejected = assert.rejects(
      business,
      (error) => error.code === "CONSENT_REQUIRED",
    );
    await microtasksUntil(() => held);
    const sentBeforeRevocation = [...requests];
    let revoked;
    wx.showModal = (opts) => {
      revoked = opts.success({ confirm: true });
    };
    const privacy = page("pages/privacy/index.js");
    privacy.revoke();
    assert.equal(auth.hasConsent(), false);
    await revoked;
    if (boundary === "platform privacy")
      held.success({ needAuthorization: false });
    else if (boundary === "WeChat code") held.success({ code: "old-code" });
    else if (boundary === "config")
      held.success({ statusCode: 200, data: { data: { devLogin: true } } });
    else held.success({ statusCode: 200, data: sessionBody("old-user") });
    await rejected;
    assert.equal(session.getSession(), null);
    assert.equal(privacy.data.canRevoke, false);
    assert.deepEqual(requests, sentBeforeRevocation);
  });
}

test("an invalidated login cannot clear a new pending login after deliberate consent", async () => {
  const auth = mod("utils/auth.js");
  const logins = [];
  const notes = [];
  wx.request = (opts) => {
    const route = new URL(opts.url).pathname;
    if (route === "/v1/config")
      opts.success({ statusCode: 200, data: { data: { devLogin: true } } });
    else if (route === "/v1/auth/dev-login") logins.push(opts);
    else if (route === "/v1/notes") {
      notes.push(opts);
      opts.success({ statusCode: 200, data: { data: { id: "new-note" } } });
    } else assert.fail(`unexpected request ${route}`);
  };
  auth.recordConsent();
  const oldBusiness = mod("utils/api.js").post("/v1/notes", { text: "旧草稿" });
  const oldRejected = assert.rejects(
    oldBusiness,
    (error) => error.code === "CONSENT_REQUIRED",
  );
  await microtasksUntil(() => logins.length === 1);
  auth.clearConsent();
  auth.recordConsent();
  const newLogin = auth.login();
  await microtasksUntil(() => logins.length === 2);
  logins[0].success({ statusCode: 200, data: sessionBody("old-user") });
  await oldRejected;
  assert.equal(mod("utils/session.js").getSession(), null);
  assert.equal(auth.login(), newLogin);
  const fresh = sessionBody("new-user");
  fresh.data.token = "new-token";
  logins[1].success({ statusCode: 200, data: fresh });
  assert.equal((await newLogin).id, "new-user");
  assert.equal(auth.hasConsent(), true);
  assert.deepEqual(
    await mod("utils/api.js").post("/v1/notes", { text: "新草稿" }),
    { id: "new-note" },
  );
  assert.equal(notes.length, 1);
  assert.equal(notes[0].header.Authorization, "Bearer new-token");
  assert.deepEqual(notes[0].data, { text: "新草稿" });
});

test("late old 401 and logout responses preserve a deliberately renewed session", async () => {
  const auth = mod("utils/auth.js");
  const session = mod("utils/session.js");
  auth.recordConsent();
  session.setSession(sessionBody("old-user").data);
  let oldBusiness, oldRead, oldLogout;
  const businessRequests = [];
  wx.request = (opts) => {
    const route = new URL(opts.url).pathname;
    if (route === "/v1/notes") {
      businessRequests.push(opts);
      oldBusiness = opts;
    } else if (route === "/v1/old-read") oldRead = opts;
    else if (route === "/v1/auth/logout") oldLogout = opts;
    else if (route === "/v1/me/consent")
      opts.success({ statusCode: 200, data: { data: { ageBand: "adult" } } });
    else if (route === "/v1/config")
      opts.success({ statusCode: 200, data: { data: { devLogin: true } } });
    else if (route === "/v1/auth/dev-login") {
      const fresh = sessionBody("new-user");
      fresh.data.token = "new-token";
      opts.success({ statusCode: 200, data: fresh });
    } else assert.fail(`unexpected request ${route}`);
  };
  const business = mod("utils/api.js").post("/v1/notes", { text: "旧草稿" });
  const businessRejected = assert.rejects(
    business,
    (error) => error.code === "CONSENT_REQUIRED",
  );
  const read = mod("utils/request.js").request({
    url: "/v1/old-read",
    auth: true,
  });
  const readRejected = assert.rejects(
    read,
    (error) => error.statusCode === 401,
  );
  await microtasksUntil(() => oldBusiness && oldRead);
  let revoked;
  wx.showModal = (opts) => {
    revoked = opts.success({ confirm: true });
  };
  const privacy = page("pages/privacy/index.js");
  privacy.revoke();
  await microtasksUntil(() => oldLogout);
  assert.equal(auth.hasConsent(), false);
  oldBusiness.success({ statusCode: 401, data: { code: "SESSION_EXPIRED" } });
  await businessRejected;
  assert.equal(session.getSession(), null);
  assert.equal(businessRequests.length, 1);
  auth.recordConsent();
  assert.equal((await auth.login()).id, "new-user");
  oldRead.success({ statusCode: 401, data: { code: "SESSION_EXPIRED" } });
  await readRejected;
  assert.equal(session.getSession().token, "new-token");
  oldLogout.fail({ errMsg: "request:fail offline" });
  await revoked;
  assert.equal(session.getSession().token, "new-token");
  assert.equal(auth.hasConsent(), true);
  assert.equal(privacy.data.canRevoke, true);
  assert.equal(privacy.data.error, "退出时没连上服务器，之前的登录过一阵会自己失效。");
});

for (const change of ["renewed consent", "changed owner"]) {
  test(`an old business 401 after ${change} cannot replay with the new session`, async () => {
    const auth = mod("utils/auth.js");
    const session = mod("utils/session.js");
    auth.recordConsent();
    session.setSession(sessionBody("old-user").data);
    let oldRequest;
    const notes = [];
    wx.request = (opts) => {
      const route = new URL(opts.url).pathname;
      if (route === "/v1/notes") {
        notes.push(opts);
        if (!oldRequest) oldRequest = opts;
        else
          opts.success({ statusCode: 200, data: { data: { id: "replayed" } } });
      } else if (route === "/v1/auth/logout" || route === "/v1/me/consent")
        opts.success({ statusCode: 200, data: { data: { ageBand: "adult" } } });
      else if (route === "/v1/config")
        opts.success({ statusCode: 200, data: { data: { devLogin: true } } });
      else if (route === "/v1/auth/dev-login") {
        const fresh = sessionBody("new-user");
        fresh.data.token = "new-token";
        opts.success({ statusCode: 200, data: fresh });
      } else assert.fail(`unexpected request ${route}`);
    };
    const oldBusiness = mod("utils/api.js").post("/v1/notes", {
      text: "旧草稿",
    });
    const oldRejected = assert.rejects(
      oldBusiness,
      (error) =>
        error.code ===
        (change === "renewed consent" ? "CONSENT_REQUIRED" : "SESSION_CHANGED"),
    );
    await microtasksUntil(() => oldRequest);
    if (change === "renewed consent") {
      let revoked;
      wx.showModal = (opts) => {
        revoked = opts.success({ confirm: true });
      };
      page("pages/privacy/index.js").revoke();
      await microtasksUntil(() => revoked);
      await revoked;
      assert.equal(auth.hasConsent(), false);
      assert.equal(session.getSession(), null);
      auth.recordConsent();
    } else session.clearSession();
    await auth.login();
    assert.equal(session.getSession().token, "new-token");
    oldRequest.success({ statusCode: 401, data: { code: "SESSION_EXPIRED" } });
    await oldRejected;
    assert.equal(notes.length, 1);
    assert.equal(session.getSession().token, "new-token");
    assert.equal(auth.hasConsent(), true);
  });
}

test("an unsure verdict only asks for a self-check when a reference answer is shown", () => {
  const practice = page("pages/practice/index.js");
  practice.data.mode = "problem";
  const attempt = (reference) => ({
    answer: "四十八元",
    version: 1,
    result: {
      verdict: "unsure",
      reference,
      cause: null,
      comment: "写出算式再试试。",
      explanation: "",
      citations: [],
      revealSolution: Boolean(reference),
    },
  });
  practice.showResult(attempt(null));
  assert.equal(
    practice.data.result.sub,
    "先看看下面的说明，再试一次，或者看看提示。",
  );
  assert.equal(practice.data.result.compare, false);
  practice.showResult(
    attempt({ value: "48 元", source: "rule", check: "60*0.8 = 48" }),
  );
  assert.equal(practice.data.result.sub, "对照答案一起看看？");
  assert.equal(practice.data.result.reference, "48 元");
});

test("v4 has one look: choosing a skin changes nothing and never restyles native bars", () => {
  const native = [];
  for (const api of [
    "setNavigationBarColor",
    "setBackgroundColor",
    "setTabBarStyle",
    "setTabBarItem",
  ])
    wx[api] = (opts) => native.push([api, opts]);
  const { SKINS, current } = mod("utils/theme.js");
  assert.deepEqual(SKINS.map((s) => s.cls), [""], "only the default is left");
  // v4: 我的 has no 换皮肤 any more.
  const profile = page("pages/profile/index.js");
  assert.equal(profile.chooseSkin, undefined);
  assert.ok(!profile.data.skin);
  assert.equal(storage.get("skin"), undefined);
  assert.equal(current().id, "sky");
  // A value an older version stored is ignored.
  storage.set("skin", "notebook");
  const library = page("pages/library/index.js");
  library.route = "pages/library/index";
  library.onShow();
  // v4 pages no longer go through themed(): no skin class at all.
  assert.ok(!library.data.skin);
  assert.deepEqual(native, [], "app.json draws the window and tab bar");
  // The tab icons app.json names exist.
  const app = JSON.parse(fs.readFileSync(path.join(root, "app.json")));
  for (const tab of app.tabBar.list)
    for (const icon of [tab.iconPath, tab.selectedIconPath])
      assert.ok(fs.existsSync(path.join(root, icon)), icon);
  assert.equal(app.tabBar.selectedColor, "#2f6bf6");
  assert.equal(app.window.backgroundColor, "#f5f6f8");
});

test("every skin class exists in app.wxss and each themed page root carries it", () => {
  const wxss = fs.readFileSync(path.join(root, "app.wxss"), "utf8");
  const { SKINS } = mod("utils/theme.js");
  const fixedSkinPages = new Set(["pages/map/landscape/index"]);
  for (const skin of SKINS)
    if (skin.cls) assert.match(wxss, new RegExp(`\\.${skin.cls} \\{`));
  const app = JSON.parse(fs.readFileSync(path.join(root, "app.json")));
  for (const entry of app.pages) {
    const wxml = fs.readFileSync(path.join(root, `${entry}.wxml`), "utf8");
    const rootClass = /^<view class="([^"]+)"/.exec(wxml)?.[1].split(/\s+/) || [];
    // v4 pages no longer use themed() (it is a no-op now) and drop {{skin}}.
    const themedPage = /themed\(/.test(fs.readFileSync(path.join(root, `${entry}.js`), "utf8"));
    if (themedPage && !fixedSkinPages.has(entry)) assert.ok(rootClass.includes("{{skin}}"), entry);
  }
  // Page styles only use colour tokens, so both skins apply everywhere.
  for (const entry of app.pages) {
    const css = fs.readFileSync(path.join(root, `${entry}.wxss`), "utf8");
    assert.doesNotMatch(css, /var\(--(paper|sheet)\)/, entry);
  }
});

test("reference answers say whether the program confirmed them", () => {
  const { sourceOf } = mod("utils/format.js");
  assert.deepEqual(sourceOf({ source: "rule" }), {
    text: "算过一遍，对得上",
    tone: "green",
  });
  assert.deepEqual(sourceOf({ source: "ai" }), {
    text: "AI 给的，还没算过",
    tone: "amber",
  });
  assert.deepEqual(sourceOf({ source: "ai", disputed: true }), {
    text: "我又算了一遍，对不上，你也核一下",
    tone: "red",
  });
  assert.deepEqual(sourceOf(null), { text: "", tone: "" });
});

test("the theme restyles exactly the tabs app.json declares", () => {
  const app = JSON.parse(fs.readFileSync(path.join(root, "app.json")));
  const { TABS, TAB_ROUTES } = mod("utils/theme.js");
  assert.deepEqual(
    app.tabBar.list.map((t) => t.pagePath),
    TAB_ROUTES,
  );
  assert.deepEqual(
    app.tabBar.list.map((t) => t.iconPath),
    TABS.map((name) => `assets/tab/${name}.png`),
  );
  // 随心记 · 卡片 · 学习 · 聊一聊 · 我的; 解题 is a page of its own.
  assert.deepEqual(app.tabBar.list.map((t) => t.text), ["随心记", "卡片", "学习", "聊一聊", "我的"]);
  assert.ok(!TAB_ROUTES.includes("pages/ask/index"));
  assert.ok(app.pages.includes("pages/ask/index"));
});

// SSE text as the server sends it: pure ASCII, other characters as \uXXXX.
const sseText = (events) =>
  events
    .map(
      (e) =>
        `data: ${JSON.stringify(e).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n\n`,
    )
    .join("") + "data: [DONE]\n\n";
const bytes = (text, from, to) =>
  Uint8Array.from(Buffer.from(text, "ascii").subarray(from, to)).buffer;
// wx.request for the chat: /v1/chat/send streams `reply` in small chunks (or answers
// with an error status), other paths answer from `routes`.
function chatServer(reply, routes = {}) {
  const sent = [];
  wx.request = (opts) => {
    const pathname = opts.url.replace(/^https?:\/\/[^/]+/, "");
    const listeners = [];
    const task = { onChunkReceived: (fn) => listeners.push(fn), abort() {} };
    setTimeout(() => {
      if (pathname === "/v1/chat/send") {
        sent.push(opts.data);
        if (reply.status) {
          // Errors before the stream starts are plain UTF-8 JSON.
          const body = Uint8Array.from(
            Buffer.from(JSON.stringify(reply.body)),
          ).buffer;
          return opts.success({
            statusCode: reply.status,
            data: body,
            header: {},
          });
        }
        const text = sseText(reply.events);
        for (let i = 0; i < text.length; i += 37)
          listeners.forEach((fn) => fn({ data: bytes(text, i, i + 37) }));
        return opts.success({
          statusCode: 200,
          data: new ArrayBuffer(0),
          header: {},
        });
      }
      const handler =
        routes[`${opts.method || "GET"} ${pathname.split("?")[0]}`];
      if (!handler) return opts.fail({ errMsg: "request:fail" });
      opts.success({
        statusCode: 200,
        data: { data: handler(opts) },
        header: {},
      });
    });
    return task;
  };
  return sent;
}
const usage = {
  answers: { used: 1, limit: 30 },
  photos: { used: 0, limit: 10 },
};
const para = (v) => ({ t: "p", c: [{ t: "text", v }] });

test("streamed frames survive any cut, decode escapes and stop at [DONE]", () => {
  const { parser } = mod("utils/stream.js");
  const events = [];
  const input = parser((e) => events.push(e));
  const text = sseText([
    { e: "tail", id: "r", text: "极限是 ½" },
    { e: "thinking", id: "r" },
  ]);
  for (let i = 0; i < text.length; i += 3) input.push(bytes(text, i, i + 3));
  assert.deepEqual(events, [
    { e: "tail", id: "r", text: "极限是 ½" },
    { e: "thinking", id: "r" },
  ]);
  assert.equal(input.done, true);
});

test("formula blocks copy back as text with their TeX", () => {
  const { plain, plainAll } = mod("utils/blocks.js");
  assert.equal(
    plain({
      t: "p",
      c: [
        { t: "text", v: "所以 " },
        { t: "math", id: "a", tex: String.raw`\frac{9}{2}` },
      ],
    }),
    String.raw`所以 $\frac{9}{2}$`,
  );
  assert.equal(
    plain({
      t: "list",
      items: [{ n: "1.", lv: 0, c: [{ t: "text", v: "展开" }] }],
    }),
    "1. 展开",
  );
  assert.equal(
    plainAll([{ t: "math", tex: "x^2" }, { t: "hr" }, para("完")]),
    "$$x^2$$\n\n完",
  );
});

test("a formula and the punctuation right after it are drawn together", () => {
  const { glueBlocks, plain } = mod("utils/blocks.js");
  const e = { t: "math", id: "e", tex: "e" };
  const p = {
    t: "p",
    c: [
      { t: "text", v: "已知 " },
      e,
      { t: "text", v: "，误差小于 " },
      { t: "math", id: "m", tex: "10^{-3}" },
      { t: "text", v: "。" },
    ],
  };
  const [g] = glueBlocks([p]);
  assert.deepEqual(g.c, [
    { t: "text", v: "已知 " },
    { t: "glue", m: e, v: "，" },
    { t: "text", v: "误差小于 " },
    { t: "glue", m: { t: "math", id: "m", tex: "10^{-3}" }, v: "。" },
  ]);
  // The originals are untouched: tapping still copies them.
  assert.equal(plain(p), "已知 $e$，误差小于 $10^{-3}$。");
  // Text not starting with punctuation, display formulas, lists and tables.
  const d = { t: "math", id: "d", d: true, tex: "x" };
  assert.deepEqual(
    glueBlocks([
      {
        t: "p",
        c: [e, { t: "text", v: " 是常数" }, d, { t: "text", v: "，" }],
      },
    ])[0].c,
    [e, { t: "text", v: " 是常数" }, d, { t: "text", v: "，" }],
  );
  const [list, table, hr] = glueBlocks([
    { t: "list", items: [{ n: "1.", lv: 0, c: [e, { t: "text", v: "；" }] }] },
    {
      t: "table",
      head: [[e, { t: "text", v: "，" }]],
      rows: [[[e, { t: "text", v: "：x" }]]],
    },
    { t: "hr" },
  ]);
  assert.deepEqual(list.items[0].c, [{ t: "glue", m: e, v: "；" }]);
  assert.deepEqual(table.head[0], [{ t: "glue", m: e, v: "，" }]);
  assert.deepEqual(table.rows[0][0], [
    { t: "glue", m: e, v: "：" },
    { t: "text", v: "x" },
  ]);
  assert.deepEqual(hr, { t: "hr" });
});

test("a typed question streams into the conversation, becomes the problem and offers next steps", async () => {
  mod("utils/session.js").setSession(sessionBody().data);
  mod("utils/auth.js").recordConsent();
  global.getApp = () => ({ globalData: {} });
  const thread = {
    id: "t1",
    title: "求极限",
    materialId: null,
    problem: null,
    pending: [],
    imageId: null,
  };
  const sent = chatServer(
    {
      events: [
        {
          e: "start",
          thread,
          question: {
            id: "q1",
            role: "user",
            kind: "text",
            status: "done",
            mode: "auto",
            images: [],
            quote: null,
            blocks: [para("求极限")],
          },
          replyId: "r1",
        },
        { e: "thinking", id: "r1" },
        { e: "blocks", id: "r1", blocks: [para("先看类型。")] },
        { e: "tail", id: "r1", text: "分子分母都趋于" },
        {
          e: "done",
          message: {
            id: "r1",
            role: "assistant",
            kind: "reply",
            status: "done",
            mode: "auto",
            images: [],
            quote: null,
            verify: null,
            blocks: [para("先看类型。"), para("分子分母都趋于 0。")],
          },
        },
        {
          e: "thread",
          thread: { ...thread, materialId: "m1", problem: [para("求极限")] },
        },
        { e: "verify", id: "r1", verify: { state: "pass", items: [] } },
      ],
    },
    {
      "GET /v1/chat/threads": () => ({ threads: [], usage }),
      "GET /v1/chat/usage": () => usage,
    },
  );
  const ask = page("pages/ask/index.js");
  ask.route = "pages/ask/index";
  ask.onLoad();
  ask.onShow();
  ask.onDraft({ detail: { value: "求极限" } });
  ask.submit();
  // 拍一道题 : a typed problem is confirmed first, then 没思路 sends it.
  assert.equal(ask.data.confirm.text, "求极限");
  ask.choose({ currentTarget: { dataset: { way: "hint" } } });
  // The question and a waiting reply show at once.
  assert.deepEqual(
    ask.data.messages.map((m) => [m.role, m.status]),
    [
      ["user", "done"],
      ["assistant", "streaming"],
    ],
  );
  assert.equal(ask.data.draft, "");
  await ask.request.promise;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "求极限");
  assert.equal(sent[0].mode, "auto");
  assert.match(sent[0].clientId, /^[A-Za-z0-9]{16}$/);
  assert.equal(sent[0].threadId, undefined);
  const [question, reply] = ask.data.messages;
  assert.equal(question.id, "q1");
  assert.equal(reply.id, "r1");
  assert.equal(reply.tail, "");
  assert.equal(reply.blocks.length, 2);
  // A checked reply only carries a small mark in its corner.
  assert.deepEqual(reply.badge, {
    tone: "green",
    mark: "✓",
    text: "算过一遍，对得上",
  });
  // "＋ 存成卡" sits under the newest finished reply only.
  assert.equal(ask.data.collectId, "r1");
  assert.equal(ask.data.thread.materialId, "m1");
  assert.equal(storage.get("ask_thread:u-1"), "t1");
  assert.equal(ask.data.sending, false);
  // A hint on a problem: answer it, ask for more, or open the solution.
  assert.deepEqual(
    ask.data.actions.map((a) => a.key),
    ["answer", "more", "solution"],
  );
  // The day's count only shows once it runs low.
  assert.equal(ask.data.usageText, "");
  ask.showUsage({ answers: { used: 25, limit: 30 } });
  assert.equal(ask.data.usageText, "今天还能用 5 次");
  ask.showUsage({ answers: { used: 30, limit: 30 } });
  assert.equal(ask.data.usageText, "今天的次数用完了");
  // The next question goes into the same conversation.
  ask.act({ currentTarget: { dataset: { key: "more" } } });
  assert.equal(ask.data.messages.length, 4);
  await ask.request.promise.catch(() => {});
  assert.equal(sent[1].threadId, "t1");
});

test("解题 opens empty (D112), opens a chat it is handed, and starts clean for another account", async () => {
  const thread = { id: "tA", title: "A 的问题", materialId: null, problem: null, pending: [], imageId: null, updatedAt: new Date().toISOString() };
  const message = { id: "mA", role: "user", kind: "text", status: "done", mode: "auto", images: [], quote: null, blocks: [{ t: "p", c: [{ t: "text", v: "A 的私密问题" }] }] };
  const usage = { answers: { used: 0, limit: 30 }, photos: { used: 0, limit: 10 } };
  const calls = serve({
    "GET /v1/chat/threads/tA?tone=light": () => [200, { data: { thread, messages: [message] } }],
    "GET /v1/chat/threads?kind=solve": () => [200, { data: { threads: [], usage } }],
  });
  storage.set("ask_thread", "tA"); // the old key shared by every account
  mod("utils/session.js").setSession(sessionBody("u-A").data);
  mod("utils/auth.js").recordConsent();
  mod("utils/learning-space.js").rememberThread("u-A", "tA");
  const app = { globalData: {} };
  global.getApp = () => app;
  const ask = page("pages/ask/index.js");
  ask.onLoad();
  ask.onShow();
  await new Promise((r) => setTimeout(r, 20));
  // A page of its own opens on its empty page; the last chat is in 最近.
  assert.equal(ask.data.thread, null);
  assert.equal(calls.filter((c) => c.pathname.startsWith("/v1/chat/threads/tA")).length, 0);
  app.globalData.ask = { threadId: "tA" };
  ask.onShow();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ask.data.thread.id, "tA");
  assert.equal(ask.data.messages.length, 1);
  // A revokes and B signs in on the same phone.
  const auth = mod("utils/auth.js");
  mod("utils/learning-space.js").clear("u-A");
  auth.clearConsent();
  assert.equal(storage.has("ask_thread:u-A"), false);
  assert.equal(storage.has("ask_thread"), false);
  mod("utils/session.js").setSession(sessionBody("u-B").data);
  auth.recordConsent();
  ask.onHide();
  ask.onShow();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ask.data.thread, null);
  assert.deepEqual(ask.data.messages, []);
  assert.equal(calls.filter((c) => c.pathname.startsWith("/v1/chat/threads/tA")).length, 1);
});

test("reopening a 解题 chat lands on its newest message, and a stray scroll event does not stop that", async () => {
  const thread = { id: "tA", title: "旧对话", materialId: null, problem: null, pending: [], imageId: null, updatedAt: new Date().toISOString() };
  const messages = [1, 2, 3].map((n) => ({ id: `m${n}`, role: n % 2 ? "user" : "assistant", kind: "text", status: "done", mode: "auto", images: [], quote: null, blocks: [{ t: "p", c: [{ t: "text", v: `第 ${n} 条` }] }] }));
  const usage = { answers: { used: 0, limit: 30 }, photos: { used: 0, limit: 10 } };
  serve({
    "GET /v1/chat/threads/tA?tone=light": () => [200, { data: { thread, messages } }],
    "GET /v1/chat/threads?kind=solve": () => [200, { data: { threads: [], usage } }],
  });
  mod("utils/session.js").setSession(sessionBody("u-A").data);
  mod("utils/auth.js").recordConsent();
  const scrolls = [];
  wx.pageScrollTo = (options) => scrolls.push(options.scrollTop);
  global.getApp = () => ({ globalData: { ask: { threadId: "tA" } } });
  const ask = page("pages/ask/index.js");
  ask.onLoad();
  ask.onShow();
  ask.lastTop = 4000; // where the page was before
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ask.data.messages.length, 3);
  // The new content resets the page to the top first.
  ask.onPageScroll({ scrollTop: 0 });
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(scrolls.length >= 2, `scrolled ${scrolls.length} times`);
  assert.ok(scrolls.every((top) => top === 1e6));
  ask.onUnload();
});

test("a refused question gives the typed text back and leaves no empty reply", async () => {
  mod("utils/session.js").setSession(sessionBody().data);
  mod("utils/auth.js").recordConsent();
  global.getApp = () => ({ globalData: {} });
  chatServer(
    {
      status: 429,
      body: {
        code: "QUOTA_EXCEEDED",
        message: "今天的 30 次提问用完了",
        requestId: "req-9",
      },
    },
    { "GET /v1/chat/threads": () => ({ threads: [], usage }) },
  );
  const ask = page("pages/ask/index.js");
  ask.onLoad();
  ask.onShow();
  ask.onDraft({ detail: { value: "洛必达什么时候不能用？" } });
  ask.submit();
  ask.choose({ currentTarget: { dataset: { way: "hint" } } });
  await ask.request.promise.catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ask.data.messages.length, 0);
  assert.equal(ask.data.draft, "洛必达什么时候不能用？");
  assert.match(ask.data.error, /30 次提问用完了/);
  assert.doesNotMatch(ask.data.error, /req-9/);
});

// Brief summaries as POST /v1/learn/points/:id/answer returns them (only the
// fields the comparison reads).
function brief(
  xp,
  level,
  levelXp,
  levelNeed,
  chapters,
  book = { rank: "起步", reached: 0, of: 6 },
) {
  return { xp, level, levelXp, levelNeed, maxed: false, chapters, book };
}
const tiers = (counts) =>
  counts.map(([tier, done, total, need]) => ({
    tier,
    done,
    total,
    need,
    self: 0,
  }));

test("the answer moment: XP, level-up line and a chapter rank-up from two summaries", () => {
  const { moment } = mod("utils/learn.js");
  const app = (rank, key, up) => ({
    id: "application",
    rank,
    tiers: tiers([
      ["基础", 5, 6, 5],
      ["重点", key, 6, 5],
      ["难点", 0, 5, 4],
      ["拓展", 0, 2, null],
    ]),
    up,
  });
  const toHard = {
    rank: "难点段",
    tier: "难点",
    gap: 4,
    ids: [],
    selfOnly: false,
    skip: [],
  };
  const other = { id: "limit", rank: "重点段", tiers: [] };
  const before = brief(390, 10, 66, 76, [other, app("基础段", 4)]);
  const after = brief(410, 11, 10, 84, [other, app("重点段", 5, toHard)]);
  assert.deepEqual(moment(before, after, "application"), {
    xp: 20,
    levelUp: {
      level: 11,
      text: "升到 Lv.11",
      sub: "经验 10/84，再得 74 升到 Lv.12",
    },
    rankUp: {
      from: "基础段",
      to: "重点段",
      steps: 1,
      jump: "",
      next: {
        rank: "难点段",
        stamp: "hard",
        tier: "难点",
        gap: "还差 4 个难点",
        note: "",
      },
    },
    book: null,
  });
  // Nothing changed (a wrong answer): before and after are the same summary.
  assert.deepEqual(moment(before, before, "application"), {
    xp: 0,
    levelUp: null,
    rankUp: null,
    book: null,
  });
  // Another chapter's rank is not this answer's.
  assert.equal(moment(before, after, "limit").rankUp, null);
});

test("a chapter without 难点 rises two ranks at once and has no next rank", () => {
  const { moment } = mod("utils/learn.js");
  const derivative = (rank, base, key, up) => ({
    id: "derivative",
    rank,
    tiers: tiers([
      ["基础", base, 6, 5],
      ["重点", key, 5, 4],
      ["难点", 0, 0, 0],
      ["拓展", 0, 1, null],
    ]),
    up,
  });
  const m = moment(
    brief(100, 6, 0, 24, [
      derivative("基础段", 5, 3, {
        rank: "难点段",
        tier: "重点",
        gap: 1,
        ids: ["d"],
        selfOnly: false,
        skip: ["难点"],
      }),
    ]),
    brief(120, 6, 20, 24, [derivative("难点段", 5, 4, null)]),
    "derivative",
  );
  assert.equal(m.levelUp, null);
  assert.deepEqual(m.rankUp, {
    from: "基础段",
    to: "难点段",
    steps: 2,
    jump: "连升两段 · 本章没有难点",
    next: null,
  });
  // 起步 to 基础段: 下一段 is the server's up, not the rank after 基础段 (导数 has no 难点).
  const base = moment(
    brief(100, 6, 0, 24, [
      derivative("起步", 4, 1, {
        rank: "基础段",
        tier: "基础",
        gap: 1,
        ids: ["b"],
        selfOnly: false,
        skip: [],
      }),
    ]),
    brief(110, 6, 10, 24, [
      derivative("基础段", 5, 1, {
        rank: "难点段",
        tier: "重点",
        gap: 3,
        ids: ["x", "y", "z", "w"],
        selfOnly: false,
        skip: ["难点"],
      }),
    ]),
    "derivative",
  );
  assert.deepEqual(base.rankUp.next, {
    rank: "难点段",
    stamp: "hard",
    tier: "重点",
    gap: "还差 3 个重点",
    note: "本章没有难点，重点达标就连升两段",
  });
  assert.equal(
    `下一段 ${base.rankUp.next.rank} ${base.rankUp.next.gap} · ${base.rankUp.next.note}`,
    "下一段 难点段 还差 3 个重点 · 本章没有难点，重点达标就连升两段",
  );
});

test("the answer moment: the book rank-up lists the chapters not hidden", () => {
  const { moment } = mod("utils/learn.js");
  const ch = (id, rank, hidden = false) => ({
    id,
    rank,
    hidden,
    tiers: [],
    up: null,
  });
  const before = brief(
    390,
    10,
    66,
    76,
    [
      ch("limit", "重点段"),
      ch("derivative", "基础段", true),
      ch("application", "基础段"),
    ],
    {
      rank: "基础段",
      reached: 2,
      of: 2,
    },
  );
  const after = brief(
    410,
    11,
    10,
    84,
    [
      ch("limit", "重点段"),
      ch("derivative", "基础段", true),
      ch("application", "重点段"),
    ],
    {
      rank: "重点段",
      reached: 2,
      of: 2,
    },
  );
  assert.deepEqual(moment(before, after, "application").book, {
    from: "基础段",
    to: "重点段",
    stamp: "key",
    title: "高数上 全书 升到 重点段",
    line: "每一章的重点也大部分做对过。",
    chapters: [
      { id: "limit", rank: "重点段", stamp: "key" },
      { id: "application", rank: "重点段", stamp: "key" },
    ],
  });
  // The book's first rank and its top one have their own sentence.
  const lift = (from, to) =>
    moment(
      brief(0, 1, 0, 4, [], { rank: from, reached: 0, of: 6 }),
      brief(0, 1, 0, 4, [], { rank: to, reached: 6, of: 6 }),
      "limit",
    ).book;
  assert.equal(lift("起步", "基础段").line, "每一章的基础都大部分做对过。");
  assert.equal(lift("重点段", "难点段").line, "每一章的难点也大部分做对过。");
  assert.equal(lift("基础段", "基础段"), null);
  // Showing a chapter again can lower the book rank; that is no moment.
  assert.equal(lift("重点段", "起步"), null);
});

test("point page copy: answer hints, verdict lines by reason and tier counts", () => {
  const { answerHints, verdictText, tierCount, sheetCount, tierCells } =
    mod("utils/learn.js");
  assert.deepEqual(answerHints({ kind: "number", note: null }), {
    placeholder: "写精确值，如 3/4",
    hint: "分数、根号、π、e 都能认出",
  });
  // A number problem's own note wins: no "3/4" example next to "只填数字".
  assert.deepEqual(answerHints({ kind: "number", note: "只填数字" }), {
    placeholder: "写你的答案",
    hint: "只填数字",
  });
  assert.equal(
    answerHints({ kind: "expr", var: "t", note: "写 y 的显式表达式" })
      .placeholder,
    "写关于 t 的式子",
  );
  assert.equal(
    answerHints({ kind: "expr", var: "t", note: "写 y 的显式表达式" }).hint,
    "写 y 的显式表达式",
  );
  assert.equal(
    answerHints({ kind: "antiderivative", note: null }).placeholder,
    "写一个原函数，记得 +C",
  );
  const v = (verdict, reason, counted = "none") =>
    verdictText({ verdict, reason, counted }, "t");
  assert.equal(v("correct", null, "lit"), "做对了");
  assert.equal(
    v("correct", null, "again"),
    "做对了。这个点之前做对过，这次不加经验。",
  );
  assert.equal(
    v("correct", null, "practice"),
    "做对了。今天只算练习，明天再做对就算数。",
  );
  for (const interval of [7, 21, 63])
    assert.equal(
      verdictText({
        verdict: "correct",
        counted: "review",
        review: { interval },
      }),
      `做对了，${interval} 天后再回头看看`,
    );
  assert.equal(
    verdictText({
      verdict: "correct",
      counted: "review",
      review: { interval: null },
    }),
    "做对了。这个点以后不再提醒，想练随时能做。",
  );
  assert.equal(v("incorrect", null), "不对，可以再试");
  assert.equal(v("incorrect", "divergent"), "不对，可以再试");
  assert.equal(v("incorrect", "extra-c"), "不对。这题不用加 C");
  assert.equal(
    v("incorrect", "constant"),
    "不对。要代入初始条件，把常数定出来",
  );
  assert.equal(
    v("incorrect", null, "lapse"),
    "不对，可以再试。明天再回头看看这个点",
  );
  assert.equal(
    v("incorrect", "divergent", "lapse"),
    "不对，可以再试。明天再回头看看这个点",
  );
  assert.equal(
    v("incorrect", "extra-c", "lapse"),
    "不对。这题不用加 C。明天再回头看看这个点",
  );
  assert.equal(
    v("incorrect", "constant", "lapse"),
    "不对。要代入初始条件，把常数定出来。明天再回头看看这个点",
  );
  assert.equal(
    v("unsure", "decimal"),
    "小数换成分数、根号、π 或 e 再交",
  );
  assert.equal(v("unsure", "abs"), "ln 里面要加绝对值，写成 ln|…| 再交");
  assert.equal(
    v("unsure", "division"),
    "除号后面加个乘号或括号再交，如 1/(2x) 或 (1/2)x",
  );
  assert.equal(
    v("unsure", "variable"),
    "答案里有 t 以外的字母，记得换回 t 再交",
  );
  assert.equal(v("unsure", "missing-c"), "不定积分要写 +C，补上再交");
  assert.equal(v("unsure", "unparsed"), "这个写法认不出，换个写法再交");
  assert.equal(
    v("unsure", "something-new"),
    "这个写法认不出，换个写法再交",
  );
  assert.equal(tierCount({ done: 5, total: 6, need: 5 }), "做对 5/6，要 5");
  assert.equal(tierCount({ done: 1, total: 2, need: null }), "做对 1/2");
  assert.equal(
    sheetCount({ done: 0, total: 5, need: 4 }, 1),
    "做对 0/5，要 4 · 看过 1",
  );
  assert.equal(sheetCount({ done: 0, total: 5, need: 4 }, 0), "做对 0/5，要 4");
  assert.deepEqual(
    tierCells(
      [
        { id: "a", tier: "重点", state: "correct" },
        { id: "b", tier: "基础", state: "none" },
        { id: "c", tier: "重点", state: "none" },
      ],
      "重点",
      "c",
    ),
    [
      { id: "a", cls: "correct", fresh: false },
      { id: "c", cls: "", fresh: true },
    ],
  );
});

test("learning week counts only unfinished reviews in today's list", () => {
  const { weekLine } = mod("utils/learn.js");
  const summary = {
    week: { correct: 4, xp: 60 },
    todayList: [
      { kind: "review", done: true },
      { kind: "review", done: false },
      { kind: "new", done: true },
    ],
  };
  assert.equal(
    weekLine(summary),
    "本周做对 4 个 · +60 经验 · 1 个点该复习，做一题就亮",
  );
  summary.todayList[1].done = true;
  assert.equal(weekLine(summary), "本周做对 4 个 · +60 经验");
  assert.equal(
    weekLine({ week: { correct: 0, xp: 0 }, todayList: [] }),
    "本周还没有新做对的点",
  );
});

test("learning home shows completion without promising more XP and keeps completed rows navigable", async () => {
  mod("utils/auth.js").recordConsent();
  mod("utils/session.js").setSession(sessionBody().data);
  const summary = {
    ...brief(20, 3, 4, 20, []),
    correct: 1,
    total: 2,
    week: { correct: 1, xp: 20 },
    next: { text: "继续学习", chapterId: "limit" },
    todayList: [],
    todayDone: false,
  };
  serve({
    "GET /v1/learn/map": () => [
      200,
      { data: { title: "高数上", summary, chapters: [] } },
    ],
  });
  const learn = page("pages/learn/index.js");
  await learn.load();
  assert.deepEqual(learn.data.card.today, []);
  assert.equal(learn.data.card.todaySide, "");
  summary.todayList = [
    {
      id: "review",
      name: "复习",
      kind: "review",
      chapter: "极限",
      tier: "重点",
      xp: 0,
      state: "due",
      done: true,
    },
    {
      id: "new",
      name: "新点",
      kind: "new",
      chapter: "极限",
      tier: "重点",
      xp: 20,
      state: "none",
      done: false,
    },
  ];
  await learn.load();
  assert.equal(learn.data.card.todaySide, "1 个复习 · 1 个新的");
  assert.equal(
    learn.data.card.today[1].meta,
    "极限 · 重点",
  );
  assert.equal(learn.data.card.week, "本周做对 1 个 · +20 经验");
  summary.todayList[1].done = true;
  summary.todayList[1].state = "correct";
  summary.todayDone = true;
  await learn.load();
  assert.equal(learn.data.card.todaySide, "今天的做完了");
  assert.equal(learn.data.card.today[1].meta, "极限 · 重点");
  assert.equal(learn.data.card.today[1].cell, "correct");
  let target;
  wx.navigateTo = (o) => {
    target = o.url;
  };
  learn.openPoint({ currentTarget: { dataset: { id: "new" } } });
  assert.equal(target, "/pages/point/index?id=new");
});

test("due map cells stand out from untouched cells by at least 3:1", () => {
  const css = fs.readFileSync(path.join(root, "app.wxss"), "utf8");
  const luminance = (hex) => {
    const c = hex
      .match(/\w\w/g)
      .map((v) => parseInt(v, 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  for (const selector of ["page"]) {
    const block = css.match(
      new RegExp(`(?:^|\\n)${selector} \\{([^}]+)\\}`),
    )[1];
    const color = (key) =>
      block.match(new RegExp(`--${key}: #([a-f0-9]{6});`))[1];
    const due = luminance(color("map-due"));
    for (const key of ["map-idle", "map-idle-muted"]) {
      const idle = luminance(color(key));
      assert.ok((idle + 0.05) / (due + 0.05) >= 3, `${selector}: ${key}`);
    }
    assert.ok(
      due > luminance(color("map-done")),
      "due remains lighter than correct",
    );
  }
});

test("point reviews keep their displayed index for answers and reports, show the solution and go round the bank (V4.1 G4)", async () => {
  mod("utils/auth.js").recordConsent();
  mod("utils/session.js").setSession(sessionBody().data);
  let current = {
    id: "review-point",
    name: "复习点",
    tier: "重点",
    section: "1.1",
    xp: 20,
    chapter: { id: "limit", book: "第 1 章", short: "极限" },
    prereqs: [],
    state: "due",
    review: true,
    correct: true,
    self: false,
  };
  // 0.6.0 : the problem comes from the bank, two problems here.
  const bankProblem = (index, text) => ({
    mode: "review",
    tries: 0,
    correct: false,
    aiPractice: false,
    problem: { index, total: 2, text, blocks: [para(text)], hasHint: false, format: "blanks", blanks: [{ label: "", note: "写精确值" }] },
  });
  const summary = brief(20, 3, 4, 20, [
    { id: "limit", rank: "起步", tiers: [] },
  ]);
  let counted = "lapse";
  const calls = serve({
    "GET /v1/learn/points/review-point?tone=light": () => [200, { data: current }],
    "GET /v1/learn/points/review-point/practice?tone=light": () => [200, { data: bankProblem(1, "第二题") }],
    "GET /v1/learn/points/review-point/practice?tone=light&after=1": () => [200, { data: bankProblem(0, "第一题") }],
    "GET /v1/learn/points/review-point/practice?tone=light&index=0": () => [200, { data: bankProblem(0, "第一题") }],
    "POST /v1/learn/marks": () => [200, { data: { state: "due" } }],
    "POST /v1/learn/points/review-point/submit": (opts) => [
      200,
      {
        data: {
          verdict: counted === "review" ? "correct" : "incorrect",
          counted,
          xp: 0,
          before: summary,
          after: summary,
          review: { interval: 7 },
          index: opts.data.index,
          read: null,
          solution: { correct: { options: null, blocks: [para("4")] }, explanation: [para("因为……")] },
        },
      },
    ],
    "POST /v1/learn/points/review-point/report": () => [200, { data: {} }],
  });
  const point = page("pages/point/index.js");
  point.id = current.id;
  await point.load();
  assert.equal(point.data.point.review, true);
  assert.equal(point.data.point.cell, "due");
  assert.equal(point.data.point.problem.index, 1);
  assert.equal(point.data.point.problem.kind, "number");
  point.onPad({ detail: { values: ["2"], active: 0 } });
  assert.equal(point.data.canSubmit, true);
  await point.submit();
  assert.deepEqual(calls.find((c) => c.pathname.endsWith("/submit")).data, { answer: "2", index: 1, tone: "light" });
  assert.equal(point.data.point.review, true);
  assert.equal(point.data.point.stateText, "该复习");
  // Wrong, and the solution shows at once; this problem is settled.
  assert.deepEqual(point.data.result.solution.answer, [para("4")]);
  assert.deepEqual(point.data.result.solution.explanation, [para("因为……")]);
  assert.match(point.data.result.text, /看看下面的解法/);
  assert.equal(point.data.done, true);
  assert.equal(point.data.bankDone, false);
  // 下一题: the one after it.
  await point.nextProblem();
  assert.equal(point.data.point.problem.index, 0);
  assert.deepEqual(point.data.answers, [""]);
  assert.equal(point.data.canSubmit, false);
  assert.equal(point.data.done, false);
  assert.equal(point.data.result, null);
  counted = "review";
  point.onPad({ detail: { values: ["4"], active: 0 } });
  await point.submit();
  assert.equal(point.data.point.review, false);
  assert.equal(point.data.point.cell, "correct");
  assert.equal(point.data.point.stateText, "做对了");
  assert.equal(point.data.point.problem.index, 0, "the problem stays visible after answering");
  assert.equal(point.data.result.xp, 0);
  assert.equal(point.data.sheet, null);
  assert.equal(point.data.book, null);
  // Round the bank back to the first one shown: done.
  assert.equal(point.data.bankDone, true);
  await point.report("judge");
  const submissions = calls.filter((c) => /\/(submit|report)$/.test(c.pathname));
  assert.deepEqual(submissions.map((c) => c.data.index), [1, 0, 0]);
  assert.equal(submissions[2].data.answer, "4");
  assert.ok(
    !calls.some((c) => c.pathname === "/v1/learn/map"),
    "review updates the head without fetching the map",
  );
  // Back on the page: the same problem keeps its result.
  current = { ...current, state: "correct", review: false };
  await point.load({ index: 0 });
  assert.deepEqual(point.data.answers, ["4"]);
  assert.ok(point.data.result);
  // The bank's first problem again from the server's pick: old work clears.
  await point.load();
  assert.equal(point.data.point.problem.index, 1);
  assert.deepEqual(point.data.answers, [""]);
  assert.equal(point.data.result, null);
  await point.report("unclear");
  assert.deepEqual(
    calls.at(-1).data,
    { reason: "unclear", form: "bank", index: 1 },
    "the previous problem's answer is not reported",
  );
});

// A chapter of GET /v1/learn/map with only the fields the chapter page reads.
function chapter(over) {
  const pt = (id, tier, state, section) => ({
    id,
    name: id,
    tier,
    state,
    section,
    red: false,
  });
  return {
    id: "application",
    short: "中值与应用",
    label: "微分中值定理与导数的应用",
    book: "第 3 章",
    hidden: false,
    started: true,
    rank: "基础段",
    done: 7,
    total: 10,
    points: [
      pt("b1", "基础", "correct", "3.1"),
      pt("b2", "基础", "due", "3.4"),
      pt("b3", "基础", "self", "3.7"),
      pt("k1", "重点", "correct", "3.2"),
      pt("k2", "重点", "none", "3.3"),
      pt("k3", "重点", "seen", "3.6"),
      pt("h1", "难点", "correct", "3.1"),
      pt("h2", "难点", "correct", "3.3"),
      pt("h3", "难点", "correct", "3.4"),
      pt("e1", "拓展", "correct", "3.8"),
    ],
    tiers: tiers([
      ["基础", 2, 3, 2],
      ["重点", 1, 3, 2],
      ["难点", 3, 3, 2],
      ["拓展", 1, 1, null],
    ]).map((t) => (t.tier === "基础" ? { ...t, self: 1 } : t)),
    up: {
      rank: "难点段",
      tier: "重点",
      gap: 1,
      ids: ["k2", "k3"],
      selfOnly: false,
      skip: [],
    },
    ...over,
  };
}

test("chapter page view: head, next rank, tiers, statuses and the rest to mark", () => {
  const { chapterView } = mod("utils/learn.js");
  const v = chapterView(chapter());
  assert.equal(v.meta, "第 3 章 微分中值定理与导数的应用 · 10 个点 · 3.1—3.8");
  assert.equal(v.countText, "做对 7/10 个点");
  assert.equal(v.stamp, "base");
  // 重点 passing also passes 难点 (already done): two ranks, no tier skipped.
  assert.deepEqual(
    {
      ...v.next,
      rows: v.next.rows.map((r) => [r.id, r.cell, r.status, r.section]),
    },
    {
      rank: "难点段",
      stamp: "hard",
      gap: "还差 1 个重点",
      rows: [
        ["k2", "", "", "3.3"],
        ["k3", "seen", "", "3.6"],
      ],
      note: "做对其中任一个，就升难点段。",
      jump: "重点达标就连升两段",
    },
  );
  assert.deepEqual(
    v.tiers.map((t) => [t.tier, t.cls, t.count, t.side, t.ok, t.none]),
    [
      ["基础", "base", "做对 2/3，要 2 · 标了会 1", "达标", true, false],
      ["重点", "key", "做对 1/3，要 2", "还差 1", false, false],
      ["难点", "hard", "做对 3/3，要 2", "达标", true, false],
      ["拓展", "ext", "做对 1/1 · 不设段", "", false, false],
    ],
  );
  assert.deepEqual(
    v.tiers[0].rows.map((r) => r.status),
    ["做对了", "该复习", "标了会"],
  );
  assert.deepEqual(
    v.tiers[1].rows.map((r) => [r.status, r.push]),
    [
      ["做对了", false],
      ["", true],
      ["", true],
    ],
  );
  assert.equal(v.rest, 2);
  assert.equal(v.selfCount, 1);
  assert.equal(
    v.restNote,
    "其余 2 个还没做对的点记成你会了（空心格）：不算段位、不加经验，随时能撤销；以后做对照样算、照样给经验",
  );
});

test("chapter page view: a missing tier, a gap above 1, self-only, one point left and the top rank", () => {
  const { chapterView } = mod("utils/learn.js");
  // 导数: no 难点, 重点 needs 3 more.
  const derivative = chapterView(
    chapter({
      rank: "基础段",
      tiers: tiers([
        ["基础", 2, 3, 2],
        ["重点", 0, 3, 2],
        ["难点", 0, 0, 0],
        ["拓展", 1, 1, null],
      ]),
      up: {
        rank: "难点段",
        tier: "重点",
        gap: 3,
        ids: ["k1", "k2", "k3"],
        selfOnly: false,
        skip: ["难点"],
      },
    }),
  );
  assert.equal(derivative.next.gap, "还差 3 个重点");
  assert.deepEqual(derivative.next.rows, []);
  assert.equal(derivative.next.note, "");
  assert.equal(derivative.next.jump, "本章没有难点，重点达标就连升两段");
  assert.equal(derivative.tiers[2].none, true);
  assert.ok(derivative.tiers[1].rows.every((r) => !r.push));
  // Unstarted: 起步, the next rank is the next one up.
  const fresh = chapterView(
    chapter({
      started: false,
      rank: "起步",
      up: {
        rank: "基础段",
        tier: "基础",
        gap: 2,
        ids: ["b1", "b2", "b3"],
        selfOnly: false,
        skip: [],
      },
    }),
  );
  assert.equal(fresh.next.jump, "");
  assert.equal(fresh.stamp, "start");
  // Every point still needed is self-assessed.
  const self = chapterView(
    chapter({
      up: {
        rank: "重点段",
        tier: "基础",
        gap: 1,
        ids: ["b3"],
        selfOnly: true,
        skip: [],
      },
      rank: "起步",
    }),
  );
  assert.equal(self.next.note, "还差的 1 个基础你标了会，做对就升重点段。");
  assert.equal(self.next.jump, "基础达标就连升两段");
  assert.deepEqual(
    self.next.rows.map((r) => r.id),
    ["b3"],
  );
  const one = chapterView(
    chapter({
      up: {
        rank: "难点段",
        tier: "重点",
        gap: 1,
        ids: ["k2"],
        selfOnly: false,
        skip: [],
      },
      rank: "重点段",
    }),
  );
  assert.equal(one.next.note, "做对这一个，就升难点段。");
  assert.equal(chapterView(chapter({ up: null, rank: "难点段" })).next, null);
});

test("chapter page view: points without a problem never promise a rank; unstarted cells are muted", () => {
  const { chapterView } = mod("utils/learn.js");
  const base = chapter();
  const unready = (ids) =>
    base.points.map((p) => (ids.includes(p.id) ? { ...p, ready: false } : p));
  // k3 has no problem: k2 is the only way up.
  const one = chapterView({ ...base, points: unready(["k3"]) });
  assert.deepEqual(
    one.next.rows.map((r) => [r.id, r.status]),
    [
      ["k2", ""],
      ["k3", "题还在出"],
    ],
  );
  assert.equal(one.next.note, "做对“k2”，就升难点段。");
  assert.deepEqual(
    one.tiers[1].rows.map((r) => [r.id, r.push, r.status]),
    [
      ["k1", false, "做对了"],
      ["k2", true, ""],
      // Seen stays seen; the tag 做对就升段 is not promised.
      ["k3", false, "看过"],
    ],
  );
  // Neither has a problem: no promise at all.
  const none = chapterView({ ...base, points: unready(["k2", "k3"]) });
  assert.equal(none.next.note, "这一层的题还在出。");
  // Self-assessed but without problems: still no promise.
  const selfNone = chapterView({
    ...base,
    points: unready(["k2", "k3"]),
    up: { ...base.up, selfOnly: true },
  });
  assert.equal(selfNone.next.note, "这一层的题还在出。");
  // Two still needed, one of them without a problem: no rows, no promise,
  // self-assessed or not (the 下一步 line in summary.ts counts the same).
  const two = { ...base.up, gap: 2 };
  assert.equal(
    chapterView({ ...base, points: unready(["k3"]), up: two }).next.note,
    "这一层的题还在出。",
  );
  assert.equal(
    chapterView({
      ...base,
      points: unready(["k3"]),
      up: { ...two, selfOnly: true },
    }).next.note,
    "这一层的题还在出。",
  );
  // Both have a problem: the selfOnly sentence; otherwise nothing under 还差 2 个.
  assert.equal(
    chapterView({ ...base, up: { ...two, selfOnly: true } }).next.note,
    "还差的 2 个重点你标了会，做对就升难点段。",
  );
  assert.equal(chapterView({ ...base, up: two }).next.note, "");
  assert.ok(none.tiers[1].rows.every((r) => !r.push));
  assert.equal(none.tiers[1].rows[1].status, "题还在出");
  // A done point without a problem (none in the map today) says nothing extra.
  assert.equal(
    chapterView({ ...base, points: unready(["k1"]) }).tiers[1].rows[0].status,
    "做对了",
  );
  // A chapter not started: untouched cells use the lighter colour, as on the map.
  const fresh = chapterView({ ...base, started: false });
  assert.equal(fresh.next.rows[0].cell, "muted");
  assert.equal(fresh.tiers[1].rows[1].cell, "muted");
  assert.equal(fresh.tiers[1].rows[2].cell, "seen");
  assert.equal(base.started && chapterView(base).tiers[1].rows[1].cell, "");
  // 拓展 shows its self-assessed count like the ranked tiers.
  const ext = chapterView({
    ...base,
    tiers: base.tiers.map((t) =>
      t.tier === "拓展" ? { ...t, done: 0, self: 1 } : t,
    ),
  });
  assert.equal(ext.tiers[3].count, "做对 0/1 · 标了会 1 · 不设段");
});

test("learning-map links go back to a page in the stack, stay put, or open one; 8 deep they replace", () => {
  const { navPlan, backTo } = mod("utils/learn.js");
  const p = (route, id) => ({
    route: `pages/${route}/index`,
    options: id ? { id } : {},
  });
  const stack = [
    p("learn"),
    p("map"),
    p("chapter", "application"),
    p("point", "application-sketch"),
  ];
  assert.deepEqual(navPlan(stack, "pages/map/index"), {
    kind: "back",
    delta: 2,
  });
  assert.deepEqual(navPlan(stack, "pages/chapter/index", "application"), {
    kind: "back",
    delta: 1,
  });
  assert.deepEqual(navPlan(stack, "pages/chapter/index", "derivative"), {
    kind: "navigateTo",
    url: "/pages/chapter/index?id=derivative",
  });
  assert.deepEqual(navPlan(stack, "pages/point/index", "application-sketch"), {
    kind: "stay",
  });
  assert.deepEqual(navPlan([], "pages/ranks/index"), {
    kind: "navigateTo",
    url: "/pages/ranks/index",
  });
  const deep = Array.from({ length: 8 }, (_, i) => p("point", `p${i}`));
  assert.deepEqual(navPlan(deep, "pages/map/index"), {
    kind: "redirectTo",
    url: "/pages/map/index",
  });
  assert.deepEqual(navPlan(deep.slice(1), "pages/map/index"), {
    kind: "navigateTo",
    url: "/pages/map/index",
  });
  // The newest match wins.
  assert.deepEqual(
    navPlan(
      [p("map"), p("chapter", "a"), p("map"), p("chapter", "b")],
      "pages/map/index",
    ),
    {
      kind: "back",
      delta: 1,
    },
  );
  const calls = [];
  wx.navigateBack = (o) => calls.push(["back", o.delta]);
  wx.switchTab = (o) => calls.push(["tab", o.url]);
  wx.navigateTo = (o) => calls.push(["to", o.url]);
  global.getCurrentPages = () => stack;
  backTo("pages/learn/index");
  backTo("pages/chapter/index", "limit");
  backTo("pages/point/index", "application-sketch");
  delete global.getCurrentPages;
  assert.deepEqual(calls, [
    ["tab", "/pages/learn/index"],
    ["to", "/pages/chapter/index?id=limit"],
  ]);
});

test("native transfers stop before sending after consent changes", async () => {
  const auth = mod("utils/auth.js"), sessions = mod("utils/session.js"), api = mod("utils/api.js");
  sessions.setSession(sessionBody("A").data);
  auth.recordConsent();
  let sent = 0;
  wx.uploadFile = wx.downloadFile = () => { sent++; };
  const upload = api.upload("note", "synthetic.png");
  const download = api.download("/v1/me/export", "导出文件", { account: true });
  auth.clearConsent();
  auth.recordConsent();
  await assert.rejects(upload, e => e.code === "CONSENT_REQUIRED");
  await assert.rejects(download, e => e.code === "CONSENT_REQUIRED");
  assert.equal(sent, 0);
});

test("native transfer results cannot cross accounts or clear a newer session", async () => {
  const auth = mod("utils/auth.js"), sessions = mod("utils/session.js"), api = mod("utils/api.js");
  sessions.setSession(sessionBody("A").data);
  auth.recordConsent();
  let uploadOptions, downloadOptions;
  const discarded = [];
  wx.getFileSystemManager = () => ({ unlink: opts => discarded.push(opts.filePath) });
  wx.uploadFile = opts => { uploadOptions = opts; };
  wx.downloadFile = opts => { downloadOptions = opts; };
  const upload = api.upload("note", "synthetic.png");
  const download = api.download("/v1/me/export", "导出文件", { account: true });
  await microtasksUntil(() => uploadOptions && downloadOptions);
  sessions.setSession({ ...sessionBody("B").data, token: "new-token" });
  uploadOptions.success({ statusCode: 401, data: '{}' });
  downloadOptions.success({ statusCode: 200, tempFilePath: "A-private.json" });
  await assert.rejects(upload, e => e.code === "SESSION_CHANGED");
  await assert.rejects(download, e => e.code === "SESSION_CHANGED");
  assert.equal(sessions.getSession().user.id, "B");
  assert.deepEqual(discarded, ["A-private.json"]);
});

test("an upload that gets 401 logs in again and retries once for the same account", async () => {
  const auth = mod("utils/auth.js"), sessions = mod("utils/session.js"), api = mod("utils/api.js");
  sessions.setSession(sessionBody("A").data);
  auth.recordConsent();
  serve({
    "GET /v1/config": () => [200, { data: { devLogin: true } }],
    "POST /v1/auth/dev-login": () => [200, { data: { ...sessionBody("A").data, token: "fresh-token" } }],
  });
  const headers = [];
  wx.uploadFile = (opts) => {
    headers.push(opts.header.Authorization);
    if (headers.length === 1) opts.success({ statusCode: 401, data: "{}" });
    else opts.success({ statusCode: 200, data: '{"data":{"ok":true}}' });
  };
  assert.deepEqual(await api.uploadTo("/v1/imports/photo", "a.png"), { ok: true });
  assert.deepEqual(headers, ["Bearer server-token", "Bearer fresh-token"]);
  wx.uploadFile = (opts) => opts.success({ statusCode: 401, data: "{}" });
  await assert.rejects(api.uploadTo("/v1/imports/photo", "a.png"), (e) => e.statusCode === 401);
});

test("an account deletion confirmation is bound to the account that opened it", async () => {
  const sessions = mod("utils/session.js");
  sessions.setSession(sessionBody("A").data);
  const profile = page("pages/profile/index.js");
  let dialog;
  wx.showModal = opts => { dialog = opts; };
  const calls = serve({ "DELETE /v1/me": () => [200, { data: { deleted: true } }] });
  profile.deleteAccount();
  sessions.setSession({ ...sessionBody("B").data, token: "new-token" });
  dialog.success({ confirm: true });
  await Promise.resolve();
  assert.equal(calls.length, 0);
  assert.equal(sessions.getSession().user.id, "B");
  assert.equal(profile.data.error, "换了账号，退出这页再进来");
});

test("an account with unfinished orders is not deleted and is pointed to its orders", async () => {
  const sessions = mod("utils/session.js"), auth = mod("utils/auth.js");
  sessions.setSession(sessionBody("A").data);
  auth.recordConsent();
  const profile = page("pages/profile/index.js");
  const dialogs = [], pages = [];
  wx.showModal = opts => { dialogs.push(opts); };
  wx.navigateTo = opts => { pages.push(opts.url); };
  const message = "有订单还没处理完（刚下单、已付款待到账或正在退款），处理完再注销。有疑问可以在客服里提工单。";
  serve({ "DELETE /v1/me": () => [409, { code: "ACCOUNT_OPEN_ORDERS", message }] });
  profile.deleteAccount();
  assert.match(dialogs[0].content, /没用完的套餐和积分也会作废/);
  assert.match(dialogs[0].content, /订单和退款记录另存 3 年/);
  dialogs[0].success({ confirm: true });
  await microtasksUntil(() => dialogs.length === 2 && !profile.data.busy);
  assert.equal(dialogs[1].title, "暂时不能注销");
  assert.equal(dialogs[1].content, message);
  assert.equal(profile.data.error, "");
  dialogs[1].success({ confirm: true });
  assert.deepEqual(pages, ["/pages/commercial/orders/index"]);
  assert.equal(sessions.getSession().user.id, "A");
  assert.equal(auth.hasConsent(), true);
});

test("finishing an earlier account deletion preserves a newly signed in account", async () => {
  const sessions = mod("utils/session.js"), auth = mod("utils/auth.js");
  sessions.setSession(sessionBody("A").data);
  auth.recordConsent();
  const profile = page("pages/profile/index.js");
  let request;
  wx.request = opts => { request = opts; };
  profile.deleteAccount();
  await microtasksUntil(() => request);
  sessions.setSession({ ...sessionBody("B").data, token: "new-token" });
  getApp().globalData.noteContext = { pointId: "B-context" };
  request.success({ statusCode: 200, data: { data: { deleted: true } } });
  await microtasksUntil(() => !profile.data.busy);
  assert.equal(sessions.getSession().user.id, "B");
  assert.equal(auth.hasConsent(), true);
  assert.equal(getApp().globalData.noteContext.pointId, "B-context");
});

test("tool pages keep extra actions behind ⋯ and offer a way on when loading fails", async () => {
  const sheets = [];
  wx.showActionSheet = (o) => sheets.push(o.itemList);
  const library = page("pages/library/index.js");
  library.openMore();
  assert.deepEqual(sheets.pop(), ["学一份资料", "放一道题进来", "回头看看", "错题本"]);
  const material = page("pages/material/index.js");
  material.openMore();
  assert.deepEqual(sheets.pop(), ["改原文", "过几天回头看看", "删掉这份资料"]);
  material.setData({ explain: { id: "e1", data: { points: [] } }, review: { id: "r1" } });
  material.openMore();
  assert.deepEqual(sheets.pop(), ["换一种讲法", "讲错了，反馈一下", "改原文", "不用再提醒了", "删掉这份资料"]);
  const problem = page("pages/problem/index.js");
  problem.openMore();
  assert.deepEqual(sheets.pop(), ["改题目", "过几天回头看看"]);
  problem.setData({ hints: { id: "h1", data: { complete: true } } });
  problem.openMore();
  assert.deepEqual(sheets.pop(), ["改题目", "换几个数字，再练一道", "过几天回头看看", "提示讲错了，反馈一下"]);
  const mistakes = page("pages/mistakes/index.js");
  mistakes.setData({
    items: [
      { id: "m1", status: "open", threadId: "t1", mapPoint: { id: "p1", name: "极限" } },
      { id: "m2", status: "mastered" },
    ],
  });
  mistakes.cardMore({ currentTarget: { dataset: { id: "m1" } } });
  assert.deepEqual(sheets.pop(), ["再来一道差不多的", "看讲解", "我会了", "去看看「极限」", "拿出错题本"]);
  mistakes.cardMore({ currentTarget: { dataset: { id: "m2" } } });
  assert.deepEqual(sheets.pop(), ["再练练", "拿出错题本"]);
  const note = page("pages/note/index.js");
  note.setData({ note: { result: { items: [] }, resultStale: false } });
  note.openMore();
  assert.deepEqual(sheets.pop(), ["改标题", "让 AI 再理一遍", "删掉这张卡"]);
  // A page with nothing loaded says why and offers to retry, or a way back when it is gone.
  const api = mod("utils/api.js");
  const pages = [material, problem, page("pages/practice/index.js")];
  for (const [code, retry] of [["NETWORK", true], ["NOT_FOUND", false]]) {
    api.get = () => Promise.reject(Object.assign(new Error("没连上"), { code }));
    for (const p of pages) {
      p.setData({ id: "x", loadFailed: false });
      await p.load();
      assert.deepEqual([p.data.loadFailed, p.data.canRetry, p.data.error], [true, retry, "没连上"]);
    }
  }
  for (const name of ["material", "problem", "practice"]) {
    const wxml = fs.readFileSync(path.join(root, `pages/${name}/index.wxml`), "utf8");
    assert.match(wxml, /wx:if="\{\{loadFailed\}\}"[^>]*>\{\{error\}\}<text wx:if="\{\{canRetry\}\}" class="link" bindtap="reload">再试一次<\/text><text wx:else class="link" bindtap="openLibrary">回我的资料<\/text>/, name);
  }
});

test("tool pages avoid banned phrases and model names", () => {
  const banned = [
    ...fs
      .readFileSync(path.join(root, "../server/src/modules/safety/banned-phrases.ts"), "utf8")
      .matchAll(/"([^"]+)"/g),
  ].map((m) => m[1]);
  assert.ok(banned.length > 5);
  const tools = ["library", "mistakes", "material", "practice", "review", "note", "capture", "proofread", "homework", "problem"];
  for (const name of tools)
    for (const ext of ["js", "wxml"]) {
      const text = fs.readFileSync(path.join(root, `pages/${name}/index.${ext}`), "utf8");
      for (const phrase of banned) assert.ok(!text.includes(phrase), `${name}: ${phrase}`);
      assert.doesNotMatch(text, /GLM|glm-|DeepSeek|GPT|Qwen|Claude|Gemini|Hunyuan|混元/, name);
    }
});


test("returning to the app restores an expired authorized login without prompting for profile", async () => {
  envVersion = "trial";
  mod("utils/config.js").API_BASE_URL = "https://api.example.test";
  let codeCalls = 0;
  wx.login = (opts) => { codeCalls++; opts.success({ code: "one-time-code" }); };
  const calls = serve({ "POST /v1/auth/wechat-login": () => [200, sessionBody("returning-user")] });
  let application;
  global.App = (value) => { application = value; };
  mod("app.js");
  const auth = mod("utils/auth.js");
  application.onShow();
  await Promise.resolve();
  assert.equal(codeCalls, 0, "no login before user consent");
  auth.enterGuest();
  application.onShow();
  await Promise.resolve();
  assert.equal(codeCalls, 0, "guest choice is respected");
  auth.recordConsent();
  mod("utils/session.js").setSession({ ...sessionBody("old-user").data, expiresAt: new Date(Date.now()-1000).toISOString() });
  application.onShow();
  await auth.login();
  assert.equal(codeCalls, 1, "app and page share one login");
  assert.equal(calls.length, 1);
  application.onShow();
  assert.equal(codeCalls, 1, "valid session is reused");
});

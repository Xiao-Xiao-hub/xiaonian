"use strict";
// Regression checks for FE-01/02/03. Synthetic native events and network replies.
// Assertions describe desired behavior, unlike the preserved acceptance probes.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");
const file = (name) => path.join(root, name);
let user, generation, agreed, store;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const settle = () => new Promise((r) => setImmediate(r));
function stub(name, exports) {
  const filename = file(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
function page(name) {
  let value;
  global.Page = (v) => { value = v; };
  delete require.cache[file(name)];
  require(file(name));
  value.data = structuredClone(value.data);
  value.setData = function (patch) { Object.assign(this.data, patch); };
  return value;
}
beforeEach(() => {
  for (const key of Object.keys(require.cache)) if (key.startsWith(root + path.sep)) delete require.cache[key];
  user = "A"; generation = 1; agreed = true; store = {};
  global.wx = {
    getStorageSync: (k) => store[k] || "",
    setStorageSync: (k, v) => { store[k] = structuredClone(v); },
    removeStorageSync: (k) => { delete store[k]; },
    getWindowInfo: () => ({ windowWidth: 375, windowHeight: 740, statusBarHeight: 24 }),
    pageScrollTo() {},
    showToast() {},
  };
  stub("utils/auth.js", {
    getUser: () => user ? { id: user } : null,
    consentGeneration: () => generation,
    hasConsent: () => agreed,
    login: () => Promise.resolve({ id: user }),
  });
  stub("utils/session.js", { getSession: () => user && ({ user: { id: user }, token: user }), lastUser: () => user && ({ id: user }) });
  stub("utils/gate.js", { state: () => agreed ? "ok" : "guest", check: () => true });
  stub("utils/clock.js", { observe() {} });
  stub("utils/study-clock.js", { track: (x) => x });
  stub("utils/tex.js", { lineTex: () => false, lineBlocks: () => [], typeset() {} });
  stub("utils/stream.js", { clientId: () => "synthetic-client-id" });
});

for (const change of ["withdraw", "switch", "logout"]) {
  test(`FE-01 API rejects a successful response after ${change}`, async () => {
    const pending = deferred();
    stub("utils/request.js", { request: () => pending.promise, baseUrl: () => "https://invalid.local" });
    const api = require(file("utils/api.js"));
    const call = api.get("/v1/synthetic");
    await settle();
    if (change === "withdraw") { generation++; agreed = false; }
    if (change === "switch") user = "B";
    if (change === "logout") user = "";
    pending.resolve({ data: { privateText: "A synthetic private result" } });
    await assert.rejects(call, { code: change === "withdraw" ? "GUEST_MODE" : "SESSION_CHANGED" });
  });
}

test("FE-01 API keeps same-account responses and account operations without consent", async () => {
  stub("utils/request.js", { request: () => Promise.resolve({ data: { ok: true } }), baseUrl: () => "https://invalid.local" });
  const api = require(file("utils/api.js"));
  assert.deepEqual(await api.get("/v1/synthetic"), { ok: true });
  agreed = false;
  assert.deepEqual(await api.post("/v1/synthetic-export", {}, { account: true }), { ok: true });
});

test("FE-01 API still permits 401 re-login of the same account", async () => {
  let calls = 0;
  stub("utils/request.js", {
    request: () => {
      calls++;
      if (calls === 1) { user = ""; return Promise.reject({ statusCode: 401 }); }
      return Promise.resolve({ data: { ok: true } });
    }, baseUrl: () => "https://invalid.local",
  });
  require(file("utils/auth.js")).login = () => { user = "A"; return Promise.resolve({ id: user }); };
  assert.deepEqual(await require(file("utils/api.js")).get("/v1/synthetic"), { ok: true });
  assert.equal(calls, 2);
});

for (const crossAccount of [false, true]) {
  for (const fails of [false, true]) {
    test(`FE-01 old homework ${fails ? "permanent error" : "success"} preserves ${crossAccount ? "other account" : "new same-account"} draft`, async () => {
      const pending = deferred();
      stub("utils/api.js", { post: () => pending.promise, needsConsent: () => false });
      const p = page("pages/grade/index.js");
      const tools = require(file("utils/tools.js"));
      p.onLoad({});
      const call = p.startPage({ imageId: "old-photo", homework: 2 });
      p.onUnload();
      if (crossAccount) user = "B";
      const draft = { problem: "new unsent exercise", lines: ["my working"] };
      tools.keep("grade", draft);
      if (fails) pending.reject(Object.assign(new Error("gone"), { code: "NOT_FOUND" }));
      else pending.resolve({ id: "old-server-grading" });
      await call;
      assert.deepEqual(tools.kept("grade"), draft);
    });
  }
}

test("FE-01 an identical rewritten scan is a newer draft, not cleared by the first request", async () => {
  const pending = deferred();
  stub("utils/api.js", { post: () => pending.promise, needsConsent: () => false });
  const p = page("pages/grade/index.js");
  const tools = require(file("utils/tools.js"));
  const scan = { imageId: "same-photo", homework: 2 };
  p.onLoad({});
  const call = p.startPage(scan);
  p.onUnload();
  tools.keep("grade", { scan });
  pending.resolve({ id: "old-server-grading" });
  await call;
  assert.deepEqual(tools.kept("grade"), { scan });
});

test("FE-01 the original scan alone is removed after the server accepts it, even if page left", async () => {
  const pending = deferred();
  stub("utils/api.js", { post: () => pending.promise, needsConsent: () => false });
  const p = page("pages/grade/index.js");
  const tools = require(file("utils/tools.js"));
  p.onLoad({});
  const call = p.startPage({ imageId: "old-photo", homework: 2 });
  p.onUnload();
  pending.resolve({ id: "old-server-grading" });
  await call;
  assert.equal(tools.kept("grade"), null);
});

test("FE-01 withdrawing consent prevents even mocked late success from modifying drafts or page", async () => {
  const pending = deferred();
  stub("utils/api.js", { post: () => pending.promise, needsConsent: () => false });
  const p = page("pages/grade/index.js");
  const tools = require(file("utils/tools.js"));
  const scan = { imageId: "old-photo", homework: 2 };
  p.onLoad({});
  const call = p.startPage(scan);
  generation++; agreed = false;
  pending.resolve({ id: "old-server-grading" });
  await call;
  assert.deepEqual(tools.kept("grade"), { scan });
  assert.equal(p.data.id, "");
  p.onUnload();
});

test("FE-01 late OCR after leaving cannot overwrite a newer draft", async () => {
  const pending = deferred();
  stub("utils/api.js", { uploadTo: () => pending.promise, needsConsent: () => false });
  const p = page("pages/grade/index.js");
  const tools = require(file("utils/tools.js"));
  p.onLoad({});
  const call = p.read({ tempFilePath: "/synthetic/photo.jpg", size: 1 });
  p.onUnload();
  const draft = { problem: "new exercise", lines: ["new work"] };
  tools.keep("grade", draft);
  pending.resolve({ imageId: "old-photo", homework: 1 });
  await call;
  assert.deepEqual(tools.kept("grade"), draft);
});

const thread = (id) => ({ id, title: "synthetic homework", homework: { imageId: "synthetic-photo", items: [], counts: { correct: 0, wrong: 0, unclear: 0, unsure: 0, failed: 0, grading: 0 } } });
for (const fails of [false, true]) {
  test(`FE-03 late single-item ${fails ? "error" : "success"} leaves new exercise and its pending state alone`, async () => {
    const pending = deferred();
    stub("utils/api.js", { post: () => pending.promise, get: () => Promise.resolve({ threads: [] }), needsConsent: () => false });
    const p = page("pages/grade/index.js");
    p.onLoad({});
    p.setData({ stage: "page", id: "old-homework" });
    const call = p.gradeItem(0, { steps: ["old working"] });
    assert.equal(p.data.sending, true);
    p.again();
    assert.equal(p.data.sending, false);
    p.typeIn();
    p.onProblem({ detail: { value: "new exercise" } });
    p.setData({ sending: true, error: "new task message" });
    if (fails) pending.reject(new Error("old error"));
    else pending.resolve(thread("old-homework"));
    await call;
    assert.equal(p.data.stage, "edit");
    assert.equal(p.data.id, "");
    assert.equal(p.data.problem, "new exercise");
    assert.equal(p.data.error, "new task message");
    assert.equal(p.data.sending, true);
    p.onUnload();
  });
}

test("FE-03 same homework ID in a new page generation still rejects the earlier result", async () => {
  const pending = deferred();
  stub("utils/api.js", { post: () => pending.promise, needsConsent: () => false });
  const p = page("pages/grade/index.js");
  p.onLoad({});
  p.setData({ stage: "page", id: "same-homework" });
  const call = p.gradeItem(0, { steps: ["old working"] });
  p.nextTask();
  p.setData({ title: "newly refreshed homework" });
  pending.resolve(thread("same-homework"));
  await call;
  assert.equal(p.data.title, "newly refreshed homework");
  p.onUnload();
});

test("FE-03 current single-item response still updates the matching page", async () => {
  stub("utils/api.js", { post: () => Promise.resolve(thread("current-homework")), needsConsent: () => false });
  const p = page("pages/grade/index.js");
  p.onLoad({});
  p.setData({ stage: "page", id: "current-homework" });
  await p.gradeItem(0, { steps: ["working"] });
  assert.equal(p.data.title, "synthetic homework");
  assert.equal(p.data.sending, false);
  p.onUnload();
});

for (const guest of [true, false]) {
  for (const oldFirst of [true, false]) {
    test(`FE-02 ${guest ? "guest" : "signed-in"} map starts fresh after foreground (${oldFirst ? "old" : "new"} response first)`, async () => {
      agreed = !guest;
      const old = deferred(), fresh = deferred();
      let calls = 0;
      const next = () => (++calls === 1 ? old.promise : fresh.promise);
      stub("utils/request.js", { request: next });
      stub("utils/api.js", { get: next, needsConsent: () => false });
      const p = page("pages/map/index.js");
      const rendered = [];
      p.renderMap = (map) => { rendered.push(map.label); p.map = map; };
      p.onLoad({});
      p.onShow();
      await settle();
      const first = p.loadRequest;
      p.onHide();
      p.onShow();
      await settle();
      const second = p.loadRequest;
      assert.equal(calls, 2);
      const body = (label) => guest ? { data: { label, chapters: [] } } : { label, chapters: [] };
      if (oldFirst) {
        old.resolve(body("old")); await first;
        assert.equal(p.loadRequest, second, "old finally must not clear the fresh request");
        assert.equal(p.data.loading, true);
        fresh.resolve(body("fresh")); await second;
      } else {
        fresh.resolve(body("fresh")); await second;
        old.resolve(body("old")); await first;
      }
      assert.deepEqual(rendered, ["fresh"]);
      assert.equal(p.data.loading, false);
      assert.equal(p.loadRequest, null);
      p.onUnload();
    });
  }
}

test("FE-02 a fresh guest-map failure after foreground stops loading and exposes retry", async () => {
  agreed = false;
  const old = deferred(), fresh = deferred();
  let calls = 0;
  stub("utils/request.js", { request: () => (++calls === 1 ? old.promise : fresh.promise) });
  stub("utils/api.js", {});
  const p = page("pages/map/index.js");
  p.onLoad({}); p.onShow();
  const first = p.loadRequest;
  p.onHide(); p.onShow();
  const second = p.loadRequest;
  fresh.reject(new Error("synthetic network error")); await second;
  old.resolve({ data: { chapters: [] } }); await first;
  assert.equal(p.data.loading, false);
  assert.ok(p.data.error);
  p.onUnload();
});

for (const leaveBeforeLogin of [true, false]) {
  test(`FE-01 first-login OCR survives leaving ${leaveBeforeLogin ? 'before' : 'after'} authentication`, async () => {
    user = '';
    const login = deferred(), scan = deferred();
    let sentAs = '';
    require(file('utils/auth.js')).login = () => login.promise;
    stub('utils/api.js', {
      uploadTo: () => { sentAs = user; return scan.promise; },
      needsConsent: () => false,
    });
    const p = page('pages/grade/index.js');
    p.onLoad({});
    const call = p.read({ tempFilePath: '/synthetic/photo.jpg', size: 1 });
    if (leaveBeforeLogin) p.onUnload();
    user = 'A'; login.resolve({ id: 'A' }); await settle();
    assert.equal(sentAs, 'A');
    if (!leaveBeforeLogin) p.onUnload();
    scan.resolve({ imageId: 'first-photo', homework: 1 });
    await call;
    assert.equal(store['tool_draft:grade:A'].scan.imageId, 'first-photo');
    assert.equal(store['tool_draft:grade:'], undefined);
  });
}

for (const replace of ['before-login', 'after-login', 'other-account']) {
  test(`FE-01 first-login OCR respects a newer ${replace} draft`, async () => {
    user = '';
    const login = deferred(), scan = deferred();
    require(file('utils/auth.js')).login = () => login.promise;
    stub('utils/api.js', { uploadTo: () => scan.promise, needsConsent: () => false });
    const p = page('pages/grade/index.js');
    const tools = require(file('utils/tools.js'));
    p.onLoad({});
    const call = p.read({ tempFilePath: '/synthetic/photo.jpg', size: 1 });
    p.onUnload();
    user = 'A';
    const draft = { problem: 'new exercise', lines: ['new work'] };
    if (replace === 'before-login') tools.keep('grade', draft);
    login.resolve({ id: 'A' }); await settle();
    if (replace === 'other-account') user = 'B';
    if (replace !== 'before-login') tools.keep('grade', draft);
    scan.resolve({ imageId: 'first-photo', homework: 1 });
    await call;
    assert.deepEqual(tools.kept('grade'), draft);
  });
}

for (const fails of [false, true]) {
  test(`FE-01 first-login whole-page ${fails ? 'failure keeps recoverable scan' : 'success clears only its scan'}`, async () => {
    user = '';
    const login = deferred(), pending = deferred();
    let sentAs = '';
    require(file('utils/auth.js')).login = () => login.promise;
    stub('utils/api.js', { post: () => { sentAs = user; return pending.promise; }, needsConsent: () => false });
    const p = page('pages/grade/index.js');
    p.onLoad({});
    const call = p.startPage({ imageId: 'first-photo', homework: 2 });
    p.onUnload();
    user = 'A'; login.resolve({ id: 'A' }); await settle();
    assert.equal(sentAs, 'A');
    assert.equal(store['tool_draft:grade:A'].scan.imageId, 'first-photo');
    if (fails) pending.reject(new Error('synthetic network error'));
    else pending.resolve(thread('first-homework'));
    await call;
    if (fails) assert.equal(store['tool_draft:grade:A'].scan.imageId, 'first-photo');
    else assert.equal(store['tool_draft:grade:A'], undefined);
  });
}

test('FE-01 first-login whole-page preparation does not replace a newer draft written before login completes', async () => {
  user = '';
  const login = deferred(), pending = deferred();
  require(file('utils/auth.js')).login = () => login.promise;
  stub('utils/api.js', { post: () => pending.promise, needsConsent: () => false });
  const p = page('pages/grade/index.js');
  const tools = require(file('utils/tools.js'));
  p.onLoad({});
  const call = p.startPage({ imageId: 'first-photo', homework: 2 });
  p.onUnload();
  user = 'A';
  const draft = { problem: 'new exercise', lines: ['new work'] };
  tools.keep('grade', draft);
  login.resolve({ id: 'A' }); await settle();
  pending.resolve(thread('first-homework'));
  await call;
  assert.deepEqual(tools.kept('grade'), draft);
});

for (const operation of ['read', 'startPage']) {
  test(`FE-01 first-login ${operation} failure shows its error and stops waiting without uploading`, async () => {
    user = '';
    require(file('utils/auth.js')).login = () => Promise.reject(new Error('synthetic login error'));
    let calls = 0;
    stub('utils/api.js', {
      post: () => { calls++; return Promise.resolve(thread('unused')); },
      uploadTo: () => { calls++; return Promise.resolve({ imageId: 'unused' }); },
      needsConsent: () => false,
    });
    const p = page('pages/grade/index.js');
    p.onLoad({});
    await p[operation](operation === 'read' ? { tempFilePath: '/synthetic/photo.jpg', size: 1 } : { imageId: 'first-photo', homework: 2 });
    assert.equal(calls, 0);
    assert.equal(p.data.scanning, false);
    assert.ok(operation === 'read' ? p.data.scanError : p.data.error);
    p.onUnload();
  });
}

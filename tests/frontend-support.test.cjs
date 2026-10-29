"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");

function load(relative, mocks = {}) {
  let page;
  const original = Module._load;
  Module._load = function (request, parent, main) {
    const name = request.split("/").at(-1).replace(".js", "");
    if (Object.hasOwn(mocks, name)) return mocks[name];
    return original.call(this, request, parent, main);
  };
  global.Page = (definition) => { page = definition; };
  delete require.cache[require.resolve(path.join(root, relative))];
  require(path.join(root, relative));
  Module._load = original;
  return page;
}
function vm(page) {
  return { ...page, data: JSON.parse(JSON.stringify(page.data)), setData(next) { Object.assign(this.data, next); } };
}
function auth(user) {
  return { getUser: () => user.value, consentGeneration: () => 1, hasConsent: () => true, login: async () => {} };
}
beforeEach(() => {
  global.wx = { navigateTo() {}, showModal({ success }) { success({ confirm: true }); }, getStorageSync() { return ""; } };
});

test("support chat discards an old account result and never paints a local fallback", async () => {
  const user = { value: { id: "a" } };
  let resolveSession;
  const session = new Promise((resolve) => { resolveSession = resolve; });
  const page = load("pages/support/chat/index.js", {
    share: { withShare: (x) => x }, auth: auth(user), gate: { check: () => true },
    "support-api": { chatSession: () => session, chatDetail: async () => ({ id: "s", turns: [] }) },
    assets: { asset: () => "" }, format: { errorText: (e) => e.message },
  });
  const view = vm(page); view.alive = true; view.epoch = 1;
  const pending = view.open(); user.value = { id: "b" }; resolveSession({ id: "s" }); await pending;
  assert.equal(view.data.sessionId, ""); assert.deepEqual(view.data.turns, []);
});

test("support chat keeps an idempotency key for same-text retry and blocks its eleventh turn", async () => {
  const user = { value: { id: "a" } }; const calls = [];
  const page = load("pages/support/chat/index.js", {
    share: { withShare: (x) => x }, auth: auth(user), gate: { check: () => true },
    "support-api": { key: () => "stable", chatTurn: async (_id, text, key) => { calls.push([text, key]); if (calls.length === 1) throw new Error("网络断开"); return { turnId: "t", answer: "服务端答复", ticketEligible: true }; } },
    assets: { asset: () => "" }, format: { errorText: (e) => e.message },
  });
  const view = vm(page); view.alive = true; view.epoch = 1; view.data.sessionId = "s"; view.data.draft = "订单怎么处理";
  await view.send(); await view.send();
  assert.deepEqual(calls, [["订单怎么处理", "stable"], ["订单怎么处理", "stable"]]);
  assert.equal(view.data.turns[0].answer, "服务端答复");
  view.data.turns = Array.from({ length: 10 }, (_, i) => ({ id: String(i) })); view.data.draft = "第十一句"; await view.send();
  assert.equal(calls.length, 2); assert.match(view.data.error, /10 次/);
});

test("returning to support refreshes the same owner session and ignores a duplicate turn id", async () => {
  const user = { value: { id: "a" } }; let created = 0, details = 0;
  const page = load("pages/support/chat/index.js", {
    share: { withShare: (x) => x }, auth: auth(user), gate: { check: () => true },
    "support-api": {
      chatSession: async () => { created++; return { id: "s" }; },
      chatDetail: async () => { details++; return { id: "s", turns: [{ id: "t", text: "旧问题", answer: "旧回复" }] }; },
      knowledge: async () => [], key: () => "same",
      chatTurn: async () => ({ turnId: "t", answer: "重复回复" }),
    }, assets: { asset: () => "" }, format: { errorText: (e) => e.message },
  });
  const view = vm(page); view.onShow(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  view.onHide(); view.onShow(); await Promise.resolve(); await Promise.resolve();
  assert.equal(created, 1); assert.equal(details, 2); assert.equal(view.data.sessionId, "s");
  view.data.draft = "旧问题"; await view.send(); assert.equal(view.data.turns.length, 1);
});

test("FAQ is read from the service and opening it does not create a chat turn", async () => {
  const user = { value: { id: "a" } }; let created = 0, turns = 0;
  const page = load("pages/support/chat/index.js", {
    share: { withShare: (x) => x }, auth: auth(user), gate: { check: () => true },
    "support-api": {
      chatSession: async () => { created++; return { id: "s" }; }, chatDetail: async () => ({ id: "s", turns: [] }),
      knowledge: async () => [{ id: "refund", title: "退款", answer: "服务端答案" }],
      chatTurn: async () => { turns++; },
    }, assets: { asset: () => "" }, format: { errorText: (e) => e.message },
  });
  const view = vm(page); view.alive = true; view.epoch = 1; await view.open();
  view.faq({ currentTarget: { dataset: { id: "refund" } } });
  assert.equal(view.data.openFaq, "refund"); assert.equal(created, 1); assert.equal(turns, 0);
});

test("a chat reply with compact FAQ metadata keeps the locally loaded FAQ answers", async () => {
  const user = { value: { id: "a" } };
  const page = load("pages/support/chat/index.js", {
    share: { withShare: (x) => x }, auth: auth(user), gate: { check: () => true },
    "support-api": { key: () => "same", chatTurn: async () => ({ turnId: "t", answer: "已答复", faqs: [{ id: "refund", title: "退款" }] }) },
    assets: { asset: () => "" }, format: { errorText: (e) => e.message },
  });
  const view = vm(page); view.alive = true; view.epoch = 1; view.data.sessionId = "s";
  view.data.faqs = [{ id: "refund", title: "退款", answer: "服务端答案" }]; view.data.draft = "订单怎么处理";
  await view.send();
  assert.deepEqual(view.data.faqs, [{ id: "refund", title: "退款", answer: "服务端答案" }]);
});

test("ticket confirmation is owner-guarded and uses one retry key", async () => {
  const user = { value: { id: "a" } }; let submitted = 0, captured;
  let confirm;
  wx.showModal = ({ success }) => { confirm = success; };
  const page = load("pages/support/ticket/index.js", {
    share: { withShare: (x) => x }, auth: auth(user), gate: { check: () => true },
    "support-api": { key: () => "ticket-key", createTicket: async (...args) => { submitted++; captured = args; return { id: "k", status: "open", content: args[1], replies: [] }; } },
    format: { errorText: (e) => e.message, when: () => "今天" },
  });
  const view = vm(page); view.alive = true; view.epoch = 1; view.data.turnId = "eligible"; view.data.content = "请人工处理";
  view.submit(); await Promise.resolve(); await Promise.resolve();
  await confirm({ confirm: true });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(captured, ["eligible", "请人工处理", "ticket-key"]); assert.equal(submitted, 1);
  view.data.turnId = "eligible"; view.data.content = "越权结果"; user.value = { id: "b" }; view.submit(); await Promise.resolve();
  await confirm({ confirm: true });
  await Promise.resolve();
  assert.equal(submitted, 1);
});

test("ticket subscription forwards accept or rejection only after confirmation and skips unconfigured options", async () => {
  for (const [options, response, expected] of [
    [{ enabled: true, templateId: "tpl" }, "accept", { templateId: "tpl", status: "accept" }],
    [{ enabled: true, templateId: "tpl" }, "reject", { templateId: "tpl", status: "reject" }],
    [{ enabled: false }, "accept", undefined],
  ]) {
    const user = { value: { id: "a" } }; let confirm; let subscribeCalls = 0; let captured;
    wx.showModal = ({ success }) => { confirm = success; };
    wx.requestSubscribeMessage = ({ tmplIds, success }) => { subscribeCalls++; success({ [tmplIds[0]]: response }); };
    const page = load("pages/support/ticket/index.js", {
      share: { withShare: (x) => x }, auth: auth(user), gate: { check: () => true },
      "support-api": {
        key: () => "ticket-key", notificationOptions: async () => options,
        createTicket: async (...args) => { captured = args; return { id: "k", status: "open", content: args[1], replies: [] }; },
      }, format: { errorText: (e) => e.message, when: () => "今天" },
    });
    const view = vm(page); view.alive = true; view.epoch = 1; view.scope = "a:1";
    view.notification = options.enabled ? { templateId: "tpl", scope: "a:1" } : null;
    view.data.turnId = "eligible"; view.data.content = "请人工处理";
    view.submit(); await confirm({ confirm: true }); await Promise.resolve(); await Promise.resolve();
    assert.equal(subscribeCalls, options.enabled ? 1 : 0);
    assert.deepEqual(captured[3], expected);
  }
});

test("ticket page clears stale content for a different account and keys each edited submission", async () => {
  const user = { value: { id: "a" } }; const keys = []; let confirm;
  wx.showModal = ({ success }) => { confirm = success; };
  const page = load("pages/support/ticket/index.js", {
    share: { withShare: (x) => x }, auth: auth(user), gate: { check: () => true },
    "support-api": {
      key: () => `key-${keys.length + 1}`,
      createTicket: async (_turn, content, key) => { keys.push([content, key]); throw new Error("网络断开"); },
    }, format: { errorText: (e) => e.message, when: () => "今天" },
  });
  const view = vm(page); view.alive = true; view.epoch = 1; view.account = "a"; view.scope = "a:1";
  view.data.turnId = "turn"; view.data.content = "原说明"; view.submit(); await confirm({ confirm: false });
  assert.equal(view.data.confirming, false, "cancel releases the modal lock");
  view.submit(); await confirm({ confirm: true }); await Promise.resolve();
  view.input({ detail: { value: "改过的说明" } }); view.submit(); await confirm({ confirm: true }); await Promise.resolve();
  assert.deepEqual(keys, [["原说明", "key-1"], ["改过的说明", "key-2"]]);
  user.value = { id: "b" }; view.onShow();
  assert.equal(view.data.turnId, ""); assert.equal(view.data.content, ""); assert.equal(view.data.id, ""); assert.equal(view.data.ticket, null);
});

test("chat binds its scope after login and starts a new server session only when asked", async () => {
  let user = null, created = 0;
  const page = load("pages/support/chat/index.js", {
    share: { withShare: (x) => x },
    auth: { getUser: () => user, consentGeneration: () => 1, hasConsent: () => true, login: async () => { user = { id: "a" }; } },
    gate: { check: () => true },
    "support-api": { chatSession: async () => ({ id: `s-${++created}` }), chatDetail: async (id) => ({ id, turns: [] }), knowledge: async () => [] },
    assets: { asset: () => "" }, format: { errorText: (e) => e.message },
  });
  const view = vm(page); view.onShow(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(view.scope, "a:1"); view.onHide(); view.onShow(); await Promise.resolve(); await Promise.resolve();
  assert.equal(created, 1, "returning keeps the authenticated session");
  view.newSession(); await Promise.resolve(); await Promise.resolve();
  assert.equal(created, 2);
});

test("the ticket form opens only from a server-marked eligible turn and no page links to it otherwise", () => {
  const fs = require("node:fs");
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const chat = read("pages/support/chat/index.wxml");
  assert.match(chat, /<button wx:if="\{\{item\.ticketEligible\}\}"[^>]*bindtap="ticket">提交工单<\/button>/);
  assert.doesNotMatch(chat, /确认提交工单|再由你确认/);
  for (const rel of ["pages/help/index.wxml", "pages/help/index.js", "pages/support/tickets/index.wxml", "pages/support/tickets/index.js"])
    assert.doesNotMatch(read(rel), /support\/ticket\/index\?turnId|提交工单|确认提交/, rel);
  let opened = "";
  wx.navigateTo = ({ url }) => { opened = url; };
  const page = load("pages/support/chat/index.js", {
    share: { withShare: (x) => x }, auth: auth({ value: { id: "a" } }), gate: { check: () => true },
    "support-api": {}, assets: { asset: () => "" }, format: { errorText: (e) => e.message },
  });
  const view = vm(page);
  view.data.turns = [{ id: "first", ticketEligible: false }, { id: "second", ticketEligible: true }];
  view.ticket({ currentTarget: { dataset: { id: "first" } } });
  assert.equal(opened, "");
  view.ticket({ currentTarget: { dataset: { id: "second" } } });
  assert.equal(opened, "/pages/support/ticket/index?turnId=second");
});

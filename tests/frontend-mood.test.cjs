"use strict";
const { beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
let storage;
function mod(file) { return require(path.join(root, file)); }
function page(file) {
  let definition;
  global.Page = (value) => { definition = value; };
  mod(file);
  definition.data = structuredClone(definition.data || {});
  definition.setData = (patch) => Object.assign(definition.data, patch);
  return definition;
}
function session(id) {
  return { token: "test-token", user: { id, nickname: id }, expiresAt: new Date(Date.now() + 60000).toISOString() };
}
function serve(routes) {
  const calls = [];
  wx.request = (options) => {
    const pathname = options.url.replace(/^https?:\/\/[^/]+/, "");
    calls.push({ ...options, pathname });
    const response = routes[`${options.method || "GET"} ${pathname}`];
    if (!response) return options.fail({ errMsg: "request:fail" });
    const [statusCode, data] = response(options);
    options.success({ statusCode, data, header: {} });
  };
  return calls;
}
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }

beforeEach(() => {
  Object.keys(require.cache).filter((key) => key.startsWith(root + path.sep)).forEach((key) => delete require.cache[key]);
  storage = new Map();
  global.wx = {
    // 请求由 serve 替身接管；明确开发环境，避免依赖部署者的生产地址。
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
    getStorageSync: (key) => structuredClone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: (key) => storage.delete(key),
    setNavigationBarColor() {}, setBackgroundColor() {}, setTabBarStyle() {}, setTabBarItem() {},
    navigateTo() {}, navigateBack() {}, showToast() {}, stopPullDownRefresh() {},
    showModal: (options) => options.success({ confirm: true }),
  };
  global.getApp = () => ({ globalData: {} });
});

test("mood pages ship their four files and keep the consent text and required API boundaries", () => {
  for (const pageName of ["mood-consent", "mood-log"])
    for (const extension of ["js", "json", "wxml", "wxss"])
      assert.ok(fs.existsSync(path.join(root, "pages", pageName, `index.${extension}`)));
  const consent = fs.readFileSync(path.join(root, "pages/mood-consent/index.wxml"), "utf8");
  const log = fs.readFileSync(path.join(root, "pages/mood-log/index.js"), "utf8");
  assert.match(consent, /不是心理咨询或医疗建议/);
  assert.doesNotMatch(consent, /境内|境外/);
  assert.match(consent, /委托的大模型服务方/);
  for (const endpoint of ["/v1/mood", "/v1/me/mood-consent", "/v1/chat/threads/"])
    assert.match(log + fs.readFileSync(path.join(root, "pages/mood-consent/index.js"), "utf8"), new RegExp(endpoint.replace(/[/.]/g, "\\$&")));
});

test("mood consent only accepts internal chat or ask return targets and reports the handoff", async () => {
  const auth = mod("utils/auth.js");
  mod("utils/session.js").setSession(session("A"));
  auth.recordConsent();
  const app = { globalData: {} };
  global.getApp = () => app;
  const previous = { data: {}, setData(patch) { Object.assign(this.data, patch); } };
  global.getCurrentPages = () => [previous, {}];
  let backed = 0;
  wx.navigateBack = () => { backed++; };
  const calls = serve({ "PUT /v1/me/mood-consent": () => [200, { data: { consentedAt: "2026-10-12T00:00:00.000Z" } }] });
  const consent = page("pages/mood-consent/index.js");
  consent.onLoad({ next: encodeURIComponent("/pages/ask/index?threadId=t-1") });
  consent.agree();
  await settle();
  assert.equal(calls[0].pathname, "/v1/me/mood-consent");
  assert.equal(backed, 1);
  assert.equal(previous.data.moodConsented, true);
  assert.deepEqual(app.globalData.moodConsentReturn, { moodConsented: true, next: "/pages/ask/index?threadId=t-1", consentedAt: "2026-10-12T00:00:00.000Z" });
  consent.onLoad({ next: encodeURIComponent("https://example.test/") });
  assert.equal(consent.next, "");
});

test("mood consent's 不用了 clears any waiting switch; with no page under it, a yes still reaches the chat", async () => {
  const auth = mod("utils/auth.js");
  mod("utils/session.js").setSession(session("A"));
  auth.recordConsent();
  const app = { globalData: { chat: { threadId: "t-1", pendingMood: true }, ask: { threadId: "t-1", pendingMood: true }, moodConsentReturn: { moodConsented: true } } };
  global.getApp = () => app;
  const moves = [];
  wx.navigateBack = () => moves.push("back");
  wx.navigateTo = ({ url }) => moves.push(url);
  wx.switchTab = ({ url }) => moves.push(`tab:${url}`);
  global.getCurrentPages = () => [{}, {}];
  const consent = page("pages/mood-consent/index.js");
  consent.onLoad({ next: encodeURIComponent("/pages/chat/index?threadId=t-1") });
  consent.cancel();
  assert.deepEqual(moves, ["back"]);
  assert.deepEqual(app.globalData.chat, { threadId: "t-1" });
  assert.deepEqual(app.globalData.ask, { threadId: "t-1" });
  assert.equal(app.globalData.moodConsentReturn, null);
  // Opened with nothing under it: 不用了 still leads somewhere.
  global.getCurrentPages = () => [{}];
  consent.cancel();
  assert.deepEqual(moves, ["back", "tab:/pages/notes/index"]);
  // A yes with nothing under it: the chat opens on the chat page, which makes
  // the switch gated on that yes; a mood chat never goes to 解题.
  serve({ "PUT /v1/me/mood-consent": () => [200, { data: { consentedAt: "2026-10-12T00:00:00.000Z" } }] });
  consent.onLoad({ next: encodeURIComponent("/pages/ask/index?threadId=t-2") });
  consent.agree();
  await settle();
  assert.deepEqual(app.globalData.ask, { threadId: "t-1" }, "nothing is handed to 解题");
  assert.equal(app.globalData.moodConsentReturn.moodConsented, true);
  assert.equal(moves.at(-1), "/pages/chat/index?threadId=t-2");
  // Without a chat to return to: 聊一聊.
  consent.onLoad({});
  consent.agree();
  await settle();
  assert.equal(moves.at(-1), "tab:/pages/talk/index");
});

test("mood log reads account-scoped data and uses the exact bulk deletion confirmation", async () => {
  const auth = mod("utils/auth.js");
  mod("utils/session.js").setSession(session("A"));
  auth.recordConsent();
  let dialog;
  wx.showModal = (options) => { dialog = options; };
  const calls = serve({
    "GET /v1/mood": () => [200, { data: { consentedAt: "now", threads: [{ id: "t1", title: "第一句。后一句", date: "2026-10-11", cards: 1 }], counts: { cards: 2, linkedThreads: 0, brainstorms: 0 }, linkedThreads: [], brainstorms: [] } }],
    "DELETE /v1/mood": () => [200, { data: { deleted: true } }],
  });
  const log = page("pages/mood-log/index.js");
  log.onShow();
  await settle();
  assert.equal(log.data.threads[0].title, "第一句");
  log.deleteAll();
  assert.equal(dialog.title, "删除全部心情内容？");
  // V4.2 G3 (intentional): the delete scope is in the confirmation; the
  // fold itself is just 相关记录.
  assert.equal(dialog.content, "心情对话和2 张心情卡会一起删掉，删了就找不回来了。");
  assert.equal(dialog.confirmText, "删除");
  dialog.success({ confirm: true });
  await settle();
  assert.ok(calls.some((call) => call.method === "DELETE" && call.pathname === "/v1/mood"));
  assert.equal(log.data.counts.cards, 0);
  assert.equal(log.data.hasAny, false);
});

test("mood log folds what else is deleted into one line and opens each list in place", async () => {
  const auth = mod("utils/auth.js");
  mod("utils/session.js").setSession(session("A"));
  auth.recordConsent();
  serve({
    "GET /v1/mood": () => [200, { data: { consentedAt: "now", threads: [], counts: { cards: 2, linkedThreads: 1, brainstorms: 0 }, linkedThreads: [{ id: "l1", title: "带过心情卡", date: "2026-10-11" }], brainstorms: [] } }],
  });
  const log = page("pages/mood-log/index.js");
  log.onShow();
  await settle();
  assert.equal(log.data.hasAny, true);
  assert.equal(log.data.extraText, "2 张心情卡、1 段聊天");
  assert.equal(log.data.extraOpen, false);
  log.toggleExtra();
  log.selectTab({ currentTarget: { dataset: { tab: "linked" } } });
  assert.equal(log.data.tab, "linked");
  log.selectTab({ currentTarget: { dataset: { tab: "linked" } } });
  assert.equal(log.data.tab, "");
  const wxml = fs.readFileSync(path.join(root, "pages/mood-log/index.wxml"), "utf8");
  // No empty "心情对话" card when only mood cards and linked chats exist.
  assert.match(wxml, /<block wx:if="\{\{threads\.length\}\}"><view class="section mood-section"><text class="h3">心情对话<\/text>/);
  assert.match(wxml, /class="mood-row \{\{tab === 'linked' \? 'on' : ''\}\}"/);
  // Deleting all and revoking stay the last two controls, in this order.
  const tail = wxml.slice(wxml.lastIndexOf("</block>"));
  assert.ok(tail.indexOf('bindtap="deleteAll"') < tail.indexOf('bindtap="revokeConsent"'));
});

test("one mood chat can be deleted from a visible button, not only by swiping", async () => {
  const auth = mod("utils/auth.js");
  mod("utils/session.js").setSession(session("A"));
  auth.recordConsent();
  let dialog;
  wx.showModal = (options) => { dialog = options; };
  const calls = serve({
    "GET /v1/mood": () => [200, { data: { consentedAt: "now", threads: [{ id: "t1", title: "一段", date: "2026-10-11", cards: 1 }, { id: "t2", title: "两段", date: "2026-10-11" }], counts: { cards: 1, linkedThreads: 0, brainstorms: 0 }, linkedThreads: [], brainstorms: [] } }],
    "DELETE /v1/chat/threads/t1": () => [200, { data: { deleted: true } }],
  });
  const log = page("pages/mood-log/index.js");
  log.onShow();
  await settle();
  assert.equal(log.data.threads[0].cardsText, "存成了 1 张卡");
  const wxml = fs.readFileSync(path.join(root, "pages/mood-log/index.wxml"), "utf8");
  assert.match(wxml, /<button class="btn-text mood-del" data-id="\{\{item\.id\}\}" catchtap="deleteThread">删除<\/button>/);
  log.deleteThread({ currentTarget: { dataset: { id: "t1" } } });
  assert.equal(dialog.title, "删除这段心情对话？");
  dialog.success({ confirm: true });
  await settle();
  assert.ok(calls.some((call) => call.method === "DELETE" && call.pathname === "/v1/chat/threads/t1"));
  assert.deepEqual(log.data.threads.map((item) => item.id), ["t2"]);
  assert.equal(log.data.extraText, "1 张心情卡");
});

test("问 AI switches a chat to mood only after the consent page says yes", async () => {
  const auth = mod("utils/auth.js");
  mod("utils/session.js").setSession(session("A"));
  auth.recordConsent();
  const app = { globalData: {} };
  global.getApp = () => app;
  const opened = [];
  wx.navigateTo = ({ url }) => opened.push(url);
  let agreed = false;
  const calls = serve({
    "PATCH /v1/chat/threads/t-1": () => agreed
      ? [200, { data: { thread: { id: "t-1", scene: "mood", mode: "guide" } } }]
      : [409, { code: "MOOD_CONSENT_REQUIRED", message: "先看一下心情记录说明" }],
  });
  const ask = page("pages/ask/index.js");
  ask.onLoad();
  ask.data.thread = { id: "t-1", scene: "study", mode: "guide", currentCards: [] };
  await ask.patchThread({ scene: "mood" });
  assert.deepEqual(opened, [`/pages/mood-consent/index?next=${encodeURIComponent("/pages/ask/index?threadId=t-1")}`]);
  // Back without agreeing: nothing is sent again and nothing stays pending.
  ask.moodBack();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(ask.pendingMood, "");
  assert.equal(ask.data.thread.scene, "study");
  // Agreeing: the consent page reports it, and the chat switches once.
  await ask.patchThread({ scene: "mood" });
  agreed = true;
  app.globalData.moodConsentReturn = { moodConsented: true, next: "/pages/ask/index?threadId=t-1" };
  ask.moodBack();
  await settle();
  assert.equal(calls.length, 3);
  assert.equal(ask.data.thread.scene, "mood");
  assert.equal(app.globalData.moodConsentReturn, null);
});

test("问 AI never offers to switch a mood chat to another scene", async () => {
  const auth = mod("utils/auth.js");
  mod("utils/session.js").setSession(session("A"));
  auth.recordConsent();
  const sheets = [], toasts = [];
  wx.showActionSheet = (options) => sheets.push(options);
  wx.showToast = ({ title }) => toasts.push(title);
  const calls = serve({});
  const ask = page("pages/ask/index.js");
  ask.onLoad();
  ask.data.thread = { id: "t-1", scene: "mood", mode: "guide", currentCards: [] };
  ask.moreChat();
  assert.deepEqual(sheets[0].itemList, ["这段在聊：心情", "带上一张卡"]);
  sheets[0].success({ tapIndex: 0 });
  await settle();
  assert.equal(sheets.length, 1);
  assert.deepEqual(toasts, ["心情对话不切换，新开一段就行"]);
  assert.equal(calls.length, 0);
});

test("a mood brainstorm opens a page that exists", () => {
  let url;
  wx.navigateTo = (options) => { url = options.url; };
  const log = page("pages/mood-log/index.js");
  log.openBrainstorm({ currentTarget: { dataset: { id: "b 1" } } });
  assert.equal(url, "/pages/brainstorm/conclude/index?id=b%201");
  const app = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
  const pkg = app.subPackages.find((item) => item.root === "pages/brainstorm");
  assert.ok(pkg.pages.includes("conclude/index"));
});

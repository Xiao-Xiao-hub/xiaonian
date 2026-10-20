"use strict";
// The standalone 聊一聊 page (pages/chat, D099): chats from 随心记 open here.
const { beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const file = (name) => path.join(root, name);
const read = (name) => fs.readFileSync(file(name), "utf8");

let h;
function stub(modulePath, exports) {
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
}
// setData with the mini program's "a[1].b" paths.
function assign(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    const parts = key.match(/[^.[\]]+/g);
    let at = target;
    for (const part of parts.slice(0, -1)) at = at[part];
    at[parts[parts.length - 1]] = value;
  }
}
function definePage(name) {
  let definition;
  global.Page = (value) => {
    definition = value;
  };
  delete require.cache[file(`pages/${name}/index.js`)];
  require(file(`pages/${name}/index.js`));
  definition.data = structuredClone(definition.data || {});
  definition.setData = function (patch) {
    assign(this.data, patch);
  };
  return definition;
}
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
const fail = (code, message) => Object.assign(new Error(message), { code });

beforeEach(() => {
  Object.keys(require.cache)
    .filter((key) => key.startsWith(root + path.sep))
    .forEach((key) => delete require.cache[key]);
  h = {
    app: { globalData: {} },
    calls: [],
    sends: [],
    nav: [],
    toasts: [],
    sheets: [],
    remembered: [],
    routes: {},
    pages: [{}, {}],
  };
  const call = (method) => (url, body) => {
    h.calls.push({ method, url, body });
    const route = h.routes[`${method} ${url.split("?")[0]}`];
    if (!route) return Promise.reject(fail("NOT_FOUND", "没找到"));
    try {
      return Promise.resolve(route(body));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  stub(file("utils/api.js"), {
    get: call("GET"),
    post: call("POST"),
    patch: call("PATCH"),
    put: call("PUT"),
    del: call("DELETE"),
    needsConsent: () => false,
  });
  stub(file("utils/auth.js"), {
    hasConsent: () => true,
    getUser: () => ({ id: "one" }),
    consentGeneration: () => 1,
    login: () => Promise.resolve(),
  });
  stub(file("utils/theme.js"), { themed: (value) => value, TAB_ROUTES: ["pages/notes/index", "pages/deck/index", "pages/learn/index", "pages/talk/index", "pages/profile/index"] });
  stub(file("utils/gate.js"), { state: () => "ok", check: () => true, ask: () => h.nav.push("ask") });
  let n = 0;
  stub(file("utils/stream.js"), {
    clientId: () => `c${++n}`,
    send(url, body, onEvent) {
      const sent = { url, body, onEvent };
      sent.promise = new Promise((resolve, reject) => {
        sent.resolve = resolve;
        sent.reject = reject;
      });
      h.sends.push(sent);
      return { promise: sent.promise, abort() {} };
    },
  });
  // Only 问 AI keeps "the chat to reopen"; this page must never touch it.
  stub(file("utils/learning-space.js"), {
    rememberThread: (...args) => h.remembered.push(args),
    lastThread: () => "",
    forgetThread() {},
  });
  global.getApp = () => h.app;
  global.getCurrentPages = () => h.pages;
  global.wx = {
    navigateTo: ({ url }) => h.nav.push(url),
    navigateBack: () => h.nav.push("back"),
    switchTab: ({ url }) => h.nav.push(`tab:${url}`),
    redirectTo: ({ url }) => h.nav.push(`redirect:${url}`),
    showToast: ({ title }) => h.toasts.push(title),
    showActionSheet: (options) => h.sheets.push(options),
    showModal: (options) => options.success({ confirm: true }),
    pageScrollTo() {},
    getStorageSync: () => null,
    setStorageSync() {},
  };
});

const thread = (extra) => ({ id: "t1", scene: "life", mode: "guide", currentCards: [], ...extra });

test("a jot from 随心记 makes the chat first, then sends the jot in it with the threadId", async () => {
  h.routes["POST /v1/chat/threads"] = () => ({ thread: thread() });
  h.routes["POST /v1/chat/threads/t1/suggest-cards"] = () => ({ cards: [] });
  h.app.globalData.chat = { text: " 最近总是拖延，想想为什么 ", entry: "jot", cards: [{ id: "k1" }], cardIds: ["k1"], pointId: "p1" };
  const page = definePage("chat");
  page.onLoad({});
  page.onShow();
  assert.equal(h.app.globalData.chat, null);
  // The jot shows at once, and nothing is sent before the chat exists.
  assert.deepEqual(page.data.messages.map((m) => m.plain), ["最近总是拖延，想想为什么", ""]);
  assert.equal(page.data.sending, true);
  assert.equal(h.sends.length, 0);
  await settle();
  assert.deepEqual(h.calls[0], {
    method: "POST",
    url: "/v1/chat/threads",
    body: { text: "最近总是拖延，想想为什么", entry: "jot", cardIds: ["k1"], pointId: "p1", tone: "light" },
  });
  assert.equal(h.sends.length, 1);
  const sent = h.sends[0];
  assert.equal(sent.url, "/v1/chat/send");
  assert.equal(sent.body.threadId, "t1");
  assert.equal(sent.body.entry, "jot");
  assert.equal(sent.body.text, "最近总是拖延，想想为什么");
  // One pair of bubbles, not two.
  assert.deepEqual(page.data.messages.map((m) => m.id), ["local_c2", "wait_c2"]);

  // Sent with a threadId, a mood offer comes before the reply and keeps its bubble.
  const question = { id: "q1", role: "user", status: "done", content: "最近总是拖延，想想为什么" };
  sent.onEvent({ e: "scene_candidate", pending: false, thread: thread(), question }, "c2");
  assert.equal(page.data.sceneCandidate, true);
  assert.deepEqual(page.data.messages.map((m) => m.id), ["q1", "wait_c2"]);
  sent.onEvent({ e: "start", thread: thread(), question, replyId: "r1" }, "c2");
  sent.onEvent({ e: "thinking", id: "r1" }, "c2");
  assert.equal(page.data.messages[1].thinking, true);
  sent.onEvent({ e: "blocks", id: "r1", blocks: [{ t: "p", c: [{ t: "text", v: "先说说" }] }] }, "c2");
  assert.equal(page.data.messages[1].thinking, false);
  sent.onEvent({ e: "done", message: { id: "r1", role: "assistant", status: "done", content: "先说说", blocks: [{ t: "p", c: [] }], guide: { options: ["一", "二"] } } }, "c2");
  sent.resolve({ finished: true });
  await settle();
  assert.equal(page.data.sending, false);
  assert.deepEqual(page.data.actions.filter((a) => a.ai).map((a) => a.text), ["一", "二"]);
  assert.deepEqual(h.remembered, []);
});

test("every send carries a threadId, even one typed before any chat", async () => {
  let made = 0;
  h.routes["POST /v1/chat/threads"] = () => {
    made += 1;
    if (made === 1) throw fail("NETWORK", "网络不太好，再试一次");
    return { thread: thread({ id: "t2" }) };
  };
  h.routes["POST /v1/chat/threads/t2/suggest-cards"] = () => ({ cards: [] });
  const page = definePage("chat");
  page.onLoad({});
  page.onShow();
  page.setData({ draft: "今天想聊聊考试" });
  page.submit();
  await settle();
  // Making the chat failed: nothing was sent, the words are back, and it says so.
  assert.equal(h.sends.length, 0);
  assert.equal(page.data.draft, "今天想聊聊考试");
  assert.equal(page.data.error, "网络不太好，再试一次");
  assert.deepEqual(page.data.messages, []);
  page.submit();
  await settle();
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].body.threadId, "t2");
  // A send that fails gives the words back too.
  h.sends[0].reject(fail("STILL_ANSWERING", "上一条还在答，等它答完再发"));
  await settle();
  assert.equal(page.data.draft, "今天想聊聊考试");
  assert.equal(page.data.error, "上一条还在答，等它答完再发");
  for (const sent of h.sends) assert.ok(sent.body.threadId);
});

test("a dropped connection is picked up again from the server", async () => {
  h.routes["GET /v1/chat/threads/t1"] = () => ({
    thread: thread(),
    messages: [
      { id: "q1", role: "user", status: "done", content: "还在吗" },
      { id: "r1", role: "assistant", status: "done", content: "写完了", blocks: [{ t: "p", c: [] }] },
    ],
  });
  h.routes["POST /v1/chat/threads/t1/suggest-cards"] = () => ({ cards: [] });
  const page = definePage("chat");
  page.onLoad({});
  page.onShow();
  page.setData({ thread: thread() });
  page.send({ text: "还在吗", mode: "auto" });
  h.sends[0].reject(fail("NETWORK", "网络断了。回答还在写，过一会儿回来就能看到"));
  await settle();
  assert.equal(page.data.notice, "");
  assert.deepEqual(page.data.messages.map((m) => m.id), ["q1", "r1"]);
  assert.ok(h.calls.some((c) => c.method === "GET" && c.url.startsWith("/v1/chat/threads/t1")));
});

test("the consent page's 不用了 leaves the chat as it was; a yes switches it once", async () => {
  let consented = false;
  const patches = () => h.calls.filter((c) => c.method === "PATCH");
  h.routes["PATCH /v1/chat/threads/t1"] = () => {
    if (!consented) throw fail("MOOD_CONSENT_REQUIRED", "先同意心情记录说明，就能当心情来聊");
    return { thread: thread({ scene: "mood" }) };
  };
  h.routes["GET /v1/chat/threads/t1"] = () => ({ thread: thread(), messages: [] });
  const page = definePage("chat");
  page.onLoad({});
  page.onShow();
  page.setData({ thread: thread() });
  page.moodaccept();
  await settle();
  assert.deepEqual(h.nav, [`/pages/mood-consent/index?next=${encodeURIComponent("/pages/chat/index?threadId=t1")}`]);
  // An older handoff waiting in globalData is cleared too.
  h.app.globalData.chat = { threadId: "t1", pendingMood: true };
  h.app.globalData.ask = { threadId: "t1", pendingMood: true };
  const consent = definePage("mood-consent");
  consent.onLoad({ next: encodeURIComponent("/pages/chat/index?threadId=t1") });
  consent.cancel();
  assert.equal(h.nav[1], "back");
  assert.deepEqual(h.app.globalData.ask, { threadId: "t1" });
  assert.deepEqual(h.app.globalData.chat, { threadId: "t1" });
  page.onShow();
  await settle();
  assert.equal(patches().length, 1);
  assert.equal(page.pendingMood, "");
  assert.equal(page.data.thread.scene, "life");
  // Asked again, and this time agreed: one PATCH, then the chat is a mood chat.
  page.moodaccept();
  await settle();
  consented = true;
  h.app.globalData.moodConsentReturn = { moodConsented: true, next: "/pages/chat/index?threadId=t1" };
  page.onShow();
  await settle();
  assert.equal(patches().length, 3);
  assert.equal(page.data.thread.scene, "mood");
  assert.equal(h.app.globalData.moodConsentReturn, null);
});

test("a mood chat gets no scene menu, and ⋯ works before any chat", async () => {
  h.routes["POST /v1/chat/threads"] = (body) => ({ thread: thread({ id: "t9", mode: body.mode, currentCards: (body.cardIds || []).map((id) => ({ id })) }) });
  const page = definePage("chat");
  page.onLoad({});
  page.onShow();
  page.setData({ thread: thread({ scene: "mood" }), messages: [{ id: "q", role: "user", status: "done", content: "嗯" }] });
  page.more();
  // V4.2 : 开新话题 is always last.
  assert.deepEqual(h.sheets[0].itemList, ["这段在聊：心情", "带上一张卡", "聊完了，存成卡", "开新话题"]);
  h.sheets[0].success({ tapIndex: 0 });
  assert.equal(h.sheets.length, 1);
  assert.deepEqual(h.toasts, ["心情对话不切换，新开一段就行"]);
  assert.equal(h.calls.filter((c) => c.method === "PATCH").length, 0);

  page.setData({ thread: null, messages: [] });
  page.more();
  assert.deepEqual(h.sheets[1].itemList, ["讲一遍", "带上一张卡"]);
  h.sheets[1].success({ tapIndex: 0 });
  await settle();
  assert.deepEqual(h.calls.at(-1).body, { text: "讲一遍", mode: "teach", tone: "light" });
  assert.equal(page.data.thread.mode, "teach");
  // Cards picked before any chat start one with them.
  page.setData({ thread: null });
  page.pickCards();
  assert.equal(h.nav.at(-1), "/pages/card-pick/index?mode=chat&limit=3");
  h.app.globalData.pickedCards = [{ id: "k1", title: "拖延" }];
  page.onShow();
  await settle();
  assert.deepEqual(h.calls.at(-1).body, { text: "拖延", mode: "guide", cardIds: ["k1"], tone: "light" });
  assert.deepEqual(page.data.thread.currentCards, [{ id: "k1" }]);
});

test("a crisis opens the crisis page and leaves no chips under the last reply", () => {
  const page = definePage("chat");
  page.onLoad({});
  page.setData({
    thread: thread(),
    messages: [
      { id: "r0", role: "assistant", status: "done", blocks: [], guide: { options: ["一"] } },
      { id: "local_c1", role: "user", status: "done", blocks: [] },
      { id: "wait_c1", role: "assistant", status: "streaming", blocks: [] },
    ],
  });
  page.onEvent({ e: "crisis", thread: thread(), question: { id: "q1", role: "user", status: "done", content: "…", crisis: true } }, "c1");
  assert.deepEqual(h.nav, ["/pages/crisis/index"]);
  assert.deepEqual(page.data.messages.map((m) => m.id), ["r0", "q1"]);
  assert.deepEqual(page.acts(page.data.thread, page.data.messages), []);
  assert.deepEqual(h.remembered, []);
});

test("storing a chat: collect says where it went, and a closed wrap draft comes back", async () => {
  let wraps = 0;
  h.routes["POST /v1/chat/threads/t1/wrap"] = () => {
    wraps += 1;
    return { cards: [{ title: "草稿" }] };
  };
  const page = definePage("chat");
  page.onLoad({});
  page.setData({ thread: thread(), messages: [{ id: "r1", role: "assistant", status: "done", content: "好", blocks: [] }] });
  page.collect({ detail: { id: "r1" } });
  assert.equal(h.nav.at(-1), "/pages/collect/index");
  assert.equal(h.app.globalData.collect.threadId, "t1");
  // One toast, from collect; no card count before and after here.
  assert.doesNotMatch(read("pages/chat/index.js"), /cards\/stats|showToast\(\{title:"存好了/);
  assert.match(read("pages/collect/index.js"), /存好了，在卡片里/);
  h.app.globalData.collect = null;
  await page.openWrap();
  await settle();
  assert.equal(wraps, 1);
  const draft = h.app.globalData.collect;
  assert.equal(draft.count, 1);
  // 关闭 hands the draft back; while nothing new was said it is opened again as it was.
  h.app.globalData.collect = { ...draft, draft: { cards: [{ title: "改过的" }] } };
  await page.openWrap();
  assert.equal(wraps, 1);
  assert.equal(h.app.globalData.collect.draft.cards[0].title, "改过的");
  h.app.globalData.collect = { ...draft };
  page.setData({ messages: page.data.messages.concat({ id: "u2", role: "user", status: "done", content: "还有", blocks: [] }) });
  await page.openWrap();
  await settle();
  assert.equal(wraps, 2);
  assert.equal(h.app.globalData.collect.count, 2);
});

test("the page: 聊一聊, the AI notice, one ⋯, no scene picker, and never 问 AI's last chat", () => {
  assert.equal(JSON.parse(read("pages/chat/index.json")).navigationBarTitleText, "聊一聊");
  const wxml = read("pages/chat/index.wxml");
  // V4.2 : the conversation itself is utils/chat-room.js, shared with the tab.
  const code = read("pages/chat/index.js") + read("utils/chat-room.js");
  assert.match(wxml, /AI 生成可能有误，注意核实/);
  assert.equal((wxml.match(/bindtap="more"/g) || []).length, 1);
  assert.doesNotMatch(wxml, /bindscene|bindtap="cards"|>卡</);
  assert.doesNotMatch(wxml + code, /收尾|程序|场景|读取失败|发送失败|保存失败|请直接/);
  assert.doesNotMatch(code, /learning-space|rememberThread/);
  // A first jot is never sent on its own: the chat is made first.
  assert.match(code, /\/v1\/chat\/threads", \{\s*text: seed,\s*entry: "jot"[\s\S]*this\.send\(\{ text, entry: "jot"/);
  const panel = read("components/chat-panel/index.wxml");
  assert.match(panel, /在想…/);
});

test("a photographed question opened from a card's source goes to 解题, in place of the chat page", async () => {
  h.routes["GET /v1/chat/threads/t1"] = () => ({
    thread: thread({ scene: "study" }),
    messages: [{ id: "m1", role: "user", kind: "problem", status: "done", content: "求极限" }],
  });
  const page = definePage("chat");
  page.onLoad({});
  h.app.globalData.chat = { threadId: "t1" };
  page.onShow();
  await settle();
  assert.equal(h.nav.at(-1), "redirect:/pages/ask/index");
  assert.deepEqual(h.app.globalData.ask, { threadId: "t1" });
  assert.equal(page.data.thread, null);
});

test("a long-pressed reply goes into 错题本 from the chat page; a non-problem says why", async () => {
  assert.match(read("pages/chat/index.wxml"), /bindmistake="mistake"/);
  assert.match(read("components/chat-panel/index.js"), /chat\.holdItems\(message, this\.data\.thread\)/);
  h.routes["POST /v1/chat/messages/r1/mistake"] = () => ({ mistake: { id: "m1" }, thread: thread({ problem: {} }) });
  const page = definePage("chat");
  page.onLoad({});
  page.setData({ thread: thread(), messages: [] });
  await page.mistake({ detail: { id: "r1" } });
  assert.deepEqual(h.toasts, ["收进错题本了"]);
  assert.ok(page.data.thread.problem);
  h.routes["POST /v1/chat/messages/r1/mistake"] = () => {
    throw fail("NOT_A_PROBLEM", "这条不像一道题，没法收进错题本");
  };
  await page.mistake({ detail: { id: "r1" } });
  assert.equal(page.data.error, "这条不像一道题，没法收进错题本");
});

test("整理成卡 from the notes slot opens the chat and goes straight to its wrap", async () => {
  h.routes["GET /v1/chat/threads/t1"] = () => ({ thread: thread(), messages: [{ id: "q1", role: "user", status: "done", content: "上次的话" }] });
  h.routes["POST /v1/chat/threads/t1/wrap"] = () => ({ id: "wrap-1", cards: [] });
  h.app.globalData.chat = { threadId: "t1", wrap: true };
  const page = definePage("chat");
  page.onLoad({});
  await page.onShow();
  await settle();
  assert.ok(h.calls.some((c) => c.method === "POST" && c.url === "/v1/chat/threads/t1/wrap"));
  assert.equal(h.nav.at(-1), "/pages/collect/index");
});

test("a chat from a brainstorm sends its id with up to three cards", async () => {
  h.routes["POST /v1/chat/threads"] = (body) => ({ thread: thread({ id: "t7", currentCards: body.cardIds.map((id) => ({ id })) }) });
  h.app.globalData.chat = { cards: [{ id: "a", title: "卡一" }, { id: "b" }, { id: "c" }], brainstormId: "bs-1" };
  const page = definePage("chat");
  page.onLoad({});
  page.onShow();
  await settle();
  const create = h.calls.filter((c) => c.method === "POST" && c.url === "/v1/chat/threads").at(-1);
  assert.deepEqual(create.body, { text: "卡一", mode: "guide", cardIds: ["a", "b", "c"], brainstormId: "bs-1", tone: "light" });
});

test("reopening a chat lands on its newest message", async () => {
  h.routes["GET /v1/chat/threads/t1"] = () => ({
    thread: thread(),
    messages: [
      { id: "q1", role: "user", status: "done", content: "上次聊到这里" },
      { id: "r1", role: "assistant", status: "done", content: "好", blocks: [{ t: "p", c: [] }] },
    ],
  });
  h.routes["POST /v1/chat/threads/t1/suggest-cards"] = () => ({ cards: [] });
  const scrolls = [];
  wx.pageScrollTo = (options) => scrolls.push(options.scrollTop);
  const page = definePage("chat");
  page.onLoad({ threadId: "t1" });
  page.onShow();
  page.lastTop = 3000;
  await settle();
  assert.equal(page.data.messages.length, 2);
  page.onPageScroll({ scrollTop: 0 });
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(scrolls.length >= 2, `scrolled ${scrolls.length} times`);
  assert.ok(scrolls.every((top) => top === 1e6));
  page.onUnload();
});

test("an AI reply no longer repeats the question in a box", () => {
  for (const name of ["pages/ask/index.wxml", "components/chat-panel/index.wxml"])
    assert.doesNotMatch(read(name), /guide\.quote/);
});

test("the brainstorm report takes null without a type warning", () => {
  let definition;
  global.Component = (value) => {
    definition = value;
  };
  delete require.cache[file("components/brainstorm-report/index.js")];
  require(file("components/brainstorm-report/index.js"));
  assert.equal(definition.properties.report.type, null);
  assert.equal(definition.properties.report.value, null);
});

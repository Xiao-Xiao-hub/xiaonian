"use strict";
// V4.2 G5 (聊一聊): the tab is the chat itself, with the latest chats as chips,
// the last unfinished one offered once, all of them on 全部对话; drafts stay
// with their chat; next steps come from what was said; a card's 接着聊 goes
// back to its chat; long documents go on from where they stopped.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");
const file = (name) => path.join(root, name);
const read = (name) => fs.readFileSync(file(name), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let h;
const stub = (name, exports) => {
  const p = file(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
function fresh() {
  for (const key of Object.keys(require.cache)) if (key.startsWith(root)) delete require.cache[key];
}
function harness({ routes = {}, user = "u1", storage = {} } = {}) {
  h = { calls: [], nav: [], sent: [], asks: 0, routes, storage, app: { globalData: {} }, user };
  global.getApp = () => h.app;
  global.getCurrentPages = () => [];
  global.wx = {
    getWindowInfo: () => ({ screenHeight: 800, windowHeight: 740 }),
    getStorageSync: (k) => h.storage[k],
    setStorageSync: (k, v) => (h.storage[k] = structuredClone(v)),
    removeStorageSync: (k) => delete h.storage[k],
    pageScrollTo() {},
    nextTick: (fn) => fn(),
    navigateTo: ({ url }) => h.nav.push(url),
    switchTab: ({ url, success }) => {
      h.nav.push(`tab:${url}`);
      if (success) success();
    },
    showModal: ({ success }) => success && success({ confirm: true }),
    showToast: (o) => h.calls.push(`toast:${o.title}`),
    makePhoneCall: ({ phoneNumber }) => h.calls.push(`call ${phoneNumber}`),
    stopPullDownRefresh() {},
  };
  fresh();
  const reply = (method) => (url, body) => {
    h.calls.push([method, url, body]);
    const route = h.routes[`${method} ${url}`];
    if (!route) return Promise.reject(Object.assign(new Error("没有了"), { code: "NOT_FOUND", statusCode: 404 }));
    return Promise.resolve().then(() => (typeof route === "function" ? route(body) : route));
  };
  stub("utils/gate.js", { state: () => "ok", check: () => true, ask: () => h.asks++ });
  stub("utils/auth.js", { getUser: () => ({ id: h.user }), consentGeneration: () => 1, hasConsent: () => true });
  stub("utils/study-clock.js", { track: (x) => ({ studyTouch() {}, ...x }) });
  stub("utils/api.js", {
    get: reply("GET"),
    post: reply("POST"),
    patch: reply("PATCH"),
    del: reply("DEL"),
    uploadTo: (url, p) => {
      h.calls.push(["UP", url, p]);
      return Promise.resolve({ id: `att_${p}`, kind: "file", imageId: null, from: 8000, read: 3000, truncated: false });
    },
    needsConsent: () => false,
  });
  stub("utils/stream.js", {
    clientId: () => `cid${h.sent.length}`,
    send: (url, body) => {
      h.sent.push(body);
      return { promise: new Promise(() => {}), abort() {} };
    },
  });
  return h;
}
function load(page) {
  let def;
  global.Page = (x) => (def = x);
  delete require.cache[file(page)];
  require(file(page));
  def.data = structuredClone(def.data);
  def.setData = (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      const m = /^(\w+)\[(\d+)\](?:\.(\w+))?$/.exec(key);
      if (!m) def.data[key] = value;
      else if (m[3]) def.data[m[1]][Number(m[2])][m[3]] = value;
      else def.data[m[1]][Number(m[2])] = value;
    }
  };
  return def;
}
// The server's shape (ChatService.view): rendered blocks, and on the
// learner's own messages their words as `plain`; never `content`.
const said = (n) =>
  Array.from({ length: n }, (_, i) =>
    i % 2
      ? { id: `m${i}`, role: "assistant", status: "done", blocks: [{ t: "h", l: 2, c: [{ t: "text", v: "回", b: 1 }, { t: "text", v: String(i) }] }] }
      : { id: `m${i}`, role: "user", status: "done", blocks: [{ t: "list", items: [{ c: [{ t: "text", v: `说${i}` }], lv: 0, n: "•" }] }], plain: `- 说${i}` },
  );

// ---- the tab ----------------------------------------------------------------
test("聊一聊: the last unfinished chat is offered once; 接着聊 opens it here, 开新话题 is not asked again", async () => {
  const list = [
    { id: "c1", title: "和室友的事", unfinished: true, lastAt: "2026-10-18T01:00:00.000Z" },
    { id: "c2", title: "周末", unfinished: false, lastAt: "2026-10-17T01:00:00.000Z" },
  ];
  harness({
    routes: {
      "GET /v1/chat/threads?kind=chat&limit=12": () => ({ threads: list }),
      "GET /v1/chat/threads/c1?tone=light": { thread: { id: "c1", title: "和室友的事", scene: "life", mode: "guide" }, messages: said(4) },
    },
  });
  const page = load("pages/talk/index.js");
  page.onLoad({});
  page.onShow();
  await settle();
  assert.deepEqual(page.data.recent.map((t) => t.id), ["c1", "c2"]);
  assert.equal(page.data.replay.id, "c1");
  // The last three lines, marks taken off, mine told apart.
  assert.deepEqual(page.data.replay.lines.map((l) => [l.mine, l.text]), [[false, "回1"], [true, "说2"], [false, "回3"]]);
  page.replayGo();
  await settle();
  assert.equal(page.data.thread.id, "c1");
  assert.equal(page.data.messages.length, 4);
  assert.deepEqual(h.nav, []);
  assert.deepEqual(h.storage["zhiye_talk_replay_seen:u1"], { c1: list[0].lastAt });
  // Back to an empty page: not offered again until something new is said.
  page.newTopic();
  await settle();
  assert.equal(page.data.thread, null);
  assert.equal(page.data.replay, null);
  list[0].lastAt = "2026-10-18T02:00:00.000Z";
  page.loadRecent();
  await settle();
  assert.equal(page.data.replay.id, "c1");
  const gets = h.calls.filter((c) => c[0] === "GET").length;
  page.replayNew();
  assert.equal(page.data.replay, null);
  assert.equal(page.data.thread, null);
  assert.equal(page.data.focus, true);
  assert.equal(h.storage["zhiye_talk_replay_seen:u1"].c1, list[0].lastAt);
  page.loadRecent();
  await settle();
  assert.equal(page.data.replay, null);
  assert.equal(h.calls.filter((c) => c[0] === "GET").length, gets + 1);
  // The page: chips above the input, the replay with its two choices, the clock.
  const wxml = read("pages/talk/index.wxml");
  assert.match(wxml, /class="recent" scroll-x[\s\S]*bindtap="openRecent"/);
  assert.match(wxml, /bindtap="replayGo">接着聊</);
  assert.match(wxml, /bindtap="replayNew">开新话题</);
  assert.match(wxml, /bindtap="openHistory"/);
});

test("聊一聊: a list that fails says so with 重试; a chip title is cut by character", async () => {
  let fail = true;
  harness({
    routes: {
      "GET /v1/chat/threads?kind=chat&limit=12": () => {
        if (fail) throw Object.assign(new Error("网络不太好"), { statusCode: 500 });
        return { threads: [{ id: "e", title: "😀😀😀😀😀😀😀😀😀😀", unfinished: false }] };
      },
    },
  });
  const page = load("pages/talk/index.js");
  page.onLoad({});
  page.onShow();
  await settle();
  assert.ok(page.data.listError);
  fail = false;
  page.loadRecent();
  await settle();
  assert.equal(page.data.listError, "");
  assert.equal(page.data.recent[0].title, `${"😀".repeat(8)}…`);
});

// ---- drafts -----------------------------------------------------------------
test("drafts: words and uploaded files stay with their own chat, per account", async () => {
  harness({
    routes: {
      "GET /v1/chat/threads/t1?tone=light": { thread: { id: "t1", title: "社团", scene: "life", mode: "guide" }, messages: said(2) },
    },
  });
  let page = load("pages/chat/index.js");
  page.onLoad({});
  page.onShow();
  page.input({ detail: { value: "还没想好怎么说" } });
  page.onHide();
  assert.equal(h.storage["zhiye_chat_draft:u1:new"].text, "还没想好怎么说");
  // Closed and opened again: the words are back.
  page.onUnload();
  page = load("pages/chat/index.js");
  page.onLoad({});
  page.onShow();
  assert.equal(page.data.draft, "还没想好怎么说");
  // Another chat has its own (none yet); the new one's words wait.
  page.open("t1");
  await settle();
  assert.equal(page.data.draft, "");
  page.setData({
    draft: "关于社团",
    pending: [{ key: "a1", id: "a1", kind: "image", name: "图.jpg", size: 10, status: "ok", path: "p1" }, { key: "a2", kind: "image", status: "up" }],
  });
  page.keepDraft();
  const kept = h.storage["zhiye_chat_draft:u1:t1"];
  assert.equal(kept.text, "关于社团");
  assert.deepEqual(kept.files.map((f) => f.id), ["a1"]);
  page.newTopic();
  assert.equal(page.data.draft, "还没想好怎么说");
  page.open("t1");
  await settle();
  assert.equal(page.data.draft, "关于社团");
  assert.deepEqual(page.data.pending.map((f) => f.id), ["a1"]);
  // Files older than the server keeps unsent ones: only the words come back.
  h.storage["zhiye_chat_draft:u1:t1"].at = Date.now() - 21 * 60 * 60 * 1000;
  page.setData({ draft: "", pending: [] });
  page.restoreDraft();
  assert.equal(page.data.draft, "关于社团");
  assert.deepEqual(page.data.pending, []);
  // Another account on this phone sees none of it.
  h.user = "u2";
  page = load("pages/chat/index.js");
  page.onLoad({});
  assert.equal(page.data.draft, "");
  // Sent: the draft goes.
  h.user = "u1";
  page = load("pages/chat/index.js");
  page.onLoad({});
  page.onShow();
  page.open("t1");
  await settle();
  page.setData({ pending: [] });
  page.submit();
  assert.equal(h.sent.at(-1).text, "关于社团");
  assert.equal(h.storage["zhiye_chat_draft:u1:t1"], undefined);
});

// ---- next steps from what was said ------------------------------------------
test("next steps: store what came up as its kind, keep the sentence, or stop here", async () => {
  harness({
    routes: {
      "GET /v1/chat/threads/t1?tone=light": {
        thread: { id: "t1", scene: "life", mode: "guide" },
        messages: [
          { id: "u", role: "user", status: "done", blocks: [{ t: "p", c: [{ t: "text", v: "周六想去问问学长" }] }], plain: "周六想去问问学长" },
          {
            id: "r",
            role: "assistant",
            status: "done",
            blocks: [{ t: "p", c: [{ t: "text", v: "听起来你心里已经有点方向了。" }] }],
            guide: { options: ["想想怎么开口"], card: { kind: "todo", title: "周六去问学长" }, spot: "周六想去问问学长", end: true },
          },
        ],
      },
      "PATCH /v1/chat/threads/t1": { thread: { id: "t1", scene: "life", mode: "guide" } },
    },
  });
  const chat = require(file("utils/chat-v2.js"));
  const page = load("pages/chat/index.js");
  page.onLoad({});
  page.open("t1");
  await settle();
  assert.deepEqual(page.data.actions.map((a) => [a.key, a.text]), [
    ["guide-0", "想想怎么开口"],
    ["card", "存成待办"],
    ["spot", "记下刚才那句"],
    ["end", "先聊到这儿"],
  ]);
  // Nothing fixed is added: typing is always there.
  assert.ok(!page.data.actions.some((a) => a.key === "self" || a.key === "park"));
  assert.equal(chat.kindName("knowledge"), "知识点");
  assert.equal(chat.kindName("nope"), "");
  page.panelAction({ detail: { key: "card", value: "r" } });
  assert.equal(h.app.globalData.collect.type, "todo");
  assert.equal(h.app.globalData.collect.title, "周六去问学长");
  assert.equal(h.nav.at(-1), "/pages/collect/index");
  page.panelAction({ detail: { key: "spot", value: "r" } });
  assert.equal(h.app.globalData.collect.mine, "周六想去问问学长");
  page.panelAction({ detail: { key: "end" } });
  await settle();
  const ended = h.calls.find((c) => c[0] === "PATCH");
  assert.deepEqual(ended[2], { ended: true, tone: "light" });
  assert.equal(page.data.notice, "好，先聊到这儿。想接着聊，随时回来。");
  assert.deepEqual(page.data.actions, []);
  // The chat panel no longer repeats what the user said.
  assert.doesNotMatch(read("components/chat-panel/index.wxml"), /你自己说出了|class="spot"/);
});

// ---- a card's 接着聊 ----------------------------------------------------------
test("a card's 接着聊 goes back to the chat it came from, else the latest one with it, else a new one", async () => {
  harness({
    routes: {
      "GET /v1/chat/threads?kind=chat&limit=1&cardId=k2": { threads: [{ id: "t8" }] },
      "GET /v1/chat/threads?kind=chat&limit=1&cardId=k3": { threads: [] },
      "POST /v1/chat/threads": (body) => ({ thread: { id: "t9", title: body.text, scene: "life", mode: "guide", currentCards: [] } }),
    },
  });
  const { chatAboutCard, openChat } = require(file("utils/chat-entry.js"));
  const saved = { id: "k1", origin: "chat", srcId: "t7", title: "从聊天里存的" };
  await chatAboutCard(saved);
  assert.deepEqual(h.app.globalData.chat, { threadId: "t7", cards: [saved] });
  assert.equal(h.calls.length, 0);
  const typed = { id: "k2", origin: "note", title: "写的" };
  await chatAboutCard(typed);
  assert.deepEqual(h.app.globalData.chat, { threadId: "t8", cards: [typed] });
  const never = { id: "k3", origin: "note", title: "没聊过" };
  await chatAboutCard(never);
  assert.deepEqual(h.app.globalData.chat, { cards: [never] });
  const lost = { id: "k4", origin: "note", title: "查不到" };
  await chatAboutCard(lost);
  assert.deepEqual(h.app.globalData.chat, { cards: [lost] });
  assert.deepEqual(h.nav, Array(4).fill("/pages/chat/index"));
  // The chat it came from is gone: a new chat about the card starts.
  h.app.globalData.chat = { threadId: "t7", cards: [saved] };
  const page = load("pages/chat/index.js");
  page.onLoad({});
  page.onShow();
  await settle();
  const made = h.calls.find((c) => c[0] === "POST");
  assert.deepEqual(made[2].cardIds, ["k1"]);
  assert.equal(page.data.thread.id, "t9");
  // From the history page or 随心记: on the tab.
  openChat({ threadId: "t1" }, { tab: true });
  assert.equal(h.nav.at(-1), "tab:/pages/talk/index");
  assert.deepEqual(h.app.globalData.chat, { threadId: "t1" });
  for (const name of ["pages/card/index.js", "components/resume-card/index.js"])
    assert.match(read(name), /chatAboutCard\(/, name);
});

// ---- attachments ------------------------------------------------------------
test("a long document says which part was read and goes on from where it stopped", async () => {
  harness();
  const chat = require(file("utils/chat-v2.js"));
  assert.deepEqual(chat.readPart({ kind: "file", read: 8000, from: 0, truncated: true }), {
    from: 0,
    read: 8000,
    more: true,
    readText: "只读了前 8000 字，后面还有",
  });
  assert.equal(chat.readPart({ kind: "file", read: 3000, from: 8000, truncated: false }).readText, "读了第 8001–11000 字，读完了");
  assert.deepEqual(chat.readPart({ kind: "file", read: 20, from: 0, truncated: false }), { more: false, readText: "" });
  assert.deepEqual(chat.readPart({ kind: "image" }), { more: false, readText: "" });
  const page = load("pages/chat/index.js");
  page.onLoad({});
  page.setData({
    thread: { id: "t1", scene: "study", mode: "guide", currentCards: [] },
    messages: [
      {
        id: "u1",
        role: "user",
        status: "done",
        attachments: [{ key: "a1", id: "a1", kind: "file", name: "长文.pdf", size: 100, path: "wxfile://long", more: true, from: 0, read: 8000 }],
      },
    ],
  });
  page.attachmore({ detail: { key: "a1" } });
  await settle();
  const up = h.calls.find((c) => c[0] === "UP");
  assert.equal(up[1], `/v1/chat/attachments?name=${encodeURIComponent("长文.pdf")}&threadId=t1&from=8000`);
  assert.equal(up[2], "wxfile://long");
  assert.equal(page.data.draft, "接着看后面这部分");
  assert.equal(page.data.pending[0].readText, "读了第 8001–11000 字，读完了");
  // Without the file on this phone there is nothing to go on with.
  page.setData({ pending: [] });
  page.data.messages[0].attachments[0].path = "";
  page.attachmore({ detail: { key: "a1" } });
  assert.deepEqual(page.data.pending, []);
  const att = read("components/chat-attach/index.wxml");
  assert.match(att, /接着读后面/);
  assert.match(att, /点一下再试/);
  assert.match(read("components/chat-attach/index.js"), /wx\.openDocument/);
});

// ---- 全部对话 -----------------------------------------------------------------
test("全部对话: twenty at a time on the cursor, tagged, and found by words of the title", async () => {
  const first = Array.from({ length: 20 }, (_, i) => ({
    id: `t${i}`,
    title: `对话${i}`,
    updatedAt: `2026-10-${String(18 - (i % 9)).padStart(2, "0")}T00:00:00.000Z`,
    unfinished: i === 0,
    wrapReady: i === 1,
    scene: i === 2 ? "mood" : "study",
  }));
  harness({
    routes: {
      "GET /v1/chat/threads?kind=chat&limit=20": { threads: first, next: "2026-10-10T00:00:00.000Z" },
      [`GET /v1/chat/threads?kind=chat&limit=20&before=${encodeURIComponent("2026-10-10T00:00:00.000Z")}`]: { threads: [{ id: "old", title: "很早的" }], next: null },
      [`GET /v1/chat/threads?kind=chat&limit=20&q=${encodeURIComponent("室友")}`]: { threads: [{ id: "r", title: "室友" }], next: null },
    },
  });
  const page = load("pages/chat-history/index.js");
  page.onShow();
  await settle();
  assert.equal(page.data.threads.length, 20);
  assert.deepEqual(page.data.threads.slice(0, 3).map((t) => t.tags), [["没聊完"], ["待存卡"], ["心情"]]);
  page.onReachBottom();
  await settle();
  assert.equal(page.data.threads.length, 21);
  assert.equal(page.data.next, null);
  const n = h.calls.length;
  page.onReachBottom();
  assert.equal(h.calls.length, n);
  page.search({ detail: { value: " 室友 " } });
  await wait(450);
  await settle();
  assert.deepEqual(page.data.threads.map((t) => t.id), ["r"]);
  assert.match(read("pages/chat-history/index.wxml"), /没有更早的了/);
  assert.ok(JSON.parse(read("app.json")).pages.includes("pages/chat-history/index"));
});

// ---- study time, crisis, 随心记 ----------------------------------------------
test("study time counts only a chat about study", () => {
  harness();
  const room = require(file("utils/chat-room.js"))();
  const off = (thread) => room.studyOff.call({ data: { thread } });
  assert.equal(off({ scene: "study" }), false);
  assert.equal(off({ scene: "life" }), true);
  assert.equal(off({ scene: "mood" }), true);
  assert.equal(off(null), true);
});

test("crisis page: 110 and 120 can be called with a tap; the words stay", () => {
  harness();
  const page = load("pages/crisis/index.js");
  page.call({ currentTarget: { dataset: { phone: "110" } } });
  page.call({ currentTarget: { dataset: { phone: "120" } } });
  page.call({ currentTarget: { dataset: { phone: "999" } } });
  assert.deepEqual(h.calls, ["call 110", "call 120"]);
  const wxml = read("pages/crisis/index.wxml");
  assert.match(wxml, /紧急情况请拨 <text[^>]*data-phone="110" bindtap="call">110<\/text> 或 <text[^>]*data-phone="120" bindtap="call">120<\/text>。/);
});

test("随心记: one line goes on with the last unfinished chat (not a mood one) on the tab", async () => {
  harness({
    routes: {
      "GET /v1/chat/threads?kind=chat&limit=5": {
        threads: [
          { id: "m", title: "心里乱", unfinished: true, scene: "mood" },
          { id: "c1", title: "和室友的事", unfinished: true, scene: "life" },
        ],
      },
    },
  });
  const page = load("pages/notes/index.js");
  page.active = () => true;
  page.request = "r";
  await page.loadChat(1, "u1", "r");
  assert.deepEqual(page.data.chatBack, { id: "c1", title: "和室友的事", lastAt: "" });
  page.goOnChat();
  assert.deepEqual(h.app.globalData.chat, { threadId: "c1" });
  assert.equal(h.nav.at(-1), "tab:/pages/talk/index");
  assert.match(read("pages/notes/index.wxml"), /上次没聊完[\s\S]*bindtap="goOnChat"|bindtap="goOnChat"[\s\S]*上次没聊完/);
});

// ---- words ------------------------------------------------------------------
test("the new words stay gentle: no banned phrase, no model name", () => {
  const banned = [...read("../server/src/modules/safety/banned-phrases.ts").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(banned.includes("陪伴"));
  const text = [
    "pages/talk/index.wxml",
    "pages/talk/index.js",
    "pages/chat-history/index.wxml",
    "pages/chat-history/index.js",
    "pages/chat/index.wxml",
    "utils/chat-room.js",
    "components/chat-panel/index.wxml",
    "components/chat-attach/index.wxml",
    "components/chat-attach/index.js",
  ]
    .map(read)
    .join("\n");
  for (const phrase of banned) assert.ok(!text.includes(phrase), phrase);
  assert.doesNotMatch(text, /GPT|Claude|DeepSeek|Qwen|通义|豆包|文心|混元|Kimi|大模型|Jev/i);
  // The mood offer, said gently in all three places (V4.2 FX1: mood cards
  // sit with the others now, so no "单独存放").
  for (const name of ["utils/chat-room.js", "components/chat-panel/index.wxml", "pages/ask/index.js"]) {
    assert.match(read(name), /换了以后这段就一直算心情，存下的是心情卡。/, name);
    assert.doesNotMatch(read(name), /单独存放/, name);
  }
});

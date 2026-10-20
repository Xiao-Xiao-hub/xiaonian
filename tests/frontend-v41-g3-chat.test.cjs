"use strict";
// V4.1 G3 : 聊一聊 lists the chats above one fixed input with ＋; the
// chat page sends photos and documents; 注销 from 隐私政策 clears this phone's flags.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");
const file = (name) => path.join(root, name);
const read = (name) => fs.readFileSync(file(name), "utf8");
const stub = (name, exports) => {
  const p = file(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const realChat = () => {
  delete require.cache[file("utils/chat-v2.js")];
  return require(file("utils/chat-v2.js"));
};

function load(page, setup) {
  let def;
  global.Page = (x) => (def = x);
  setup();
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

// V4.2 : 聊一聊 is the chat itself (utils/chat-room.js); the latest chats
// are chips above the input and all of them are on pages/chat-history.
function talkPage(state, { threads = [], pick = [], source = 1 } = {}) {
  const calls = [];
  const opened = [];
  const storage = {};
  const page = load("pages/talk/index.js", () => {
    global.getApp = () => ({ globalData: {} });
    global.wx = {
      getWindowInfo: () => ({ screenHeight: 800, windowHeight: 740 }),
      getStorageSync: (k) => storage[k],
      setStorageSync: (k, v) => (storage[k] = v),
      removeStorageSync: (k) => delete storage[k],
      pageScrollTo() {},
      nextTick: (fn) => fn(),
      navigateTo: ({ url }) => opened.push(url),
      showModal: ({ success }) => {
        calls.push("modal");
        success({ confirm: true });
      },
    };
    stub("utils/gate.js", { state: () => state, check: () => true, ask: () => calls.push("ask") });
    stub("utils/auth.js", { getUser: () => ({ id: "u1" }), consentGeneration: () => 1, hasConsent: () => state !== "guest" });
    stub("utils/study-clock.js", { track: (x) => x });
    stub("utils/api.js", {
      get: (url) => {
        calls.push(url);
        return Promise.resolve({ threads });
      },
      post: (url) => {
        calls.push(`POST ${url}`);
        return Promise.resolve({});
      },
      uploadTo: (url, p) => {
        calls.push(`UP ${url}`);
        return Promise.resolve({ id: `att_${p}`, kind: "file", imageId: null });
      },
      del: (url) => {
        calls.push(`DEL ${url}`);
        return Promise.resolve({});
      },
      needsConsent: (e) => Boolean(e && e.code === "CONSENT_REQUIRED"),
    });
    stub("utils/chat-entry.js", { openChat: (intent) => opened.push(intent), openAsk: () => opened.push("ask") });
    const chat = realChat();
    stub("utils/chat-v2.js", {
      ...chat,
      chooseSource: () => Promise.resolve(source),
      pickAttachments: (i, room) => {
        calls.push(`pick ${i} ${room}`);
        return Promise.resolve(pick);
      },
    });
  });
  return { page, calls, opened };
}

test("聊一聊: a guest sees the start and the input; send, ＋, a chip and the clock ask to agree", async () => {
  const { page, calls, opened } = talkPage("guest");
  page.onLoad({});
  page.onShow();
  await tick();
  assert.equal(page.data.guest, true);
  assert.deepEqual(page.data.recent, []);
  page.guestTap();
  page.openRecent({ currentTarget: { dataset: { id: "t1" } } });
  page.openHistory();
  assert.deepEqual(calls, ["ask", "ask", "ask"]);
  assert.deepEqual(opened, []);
  const wxml = read("pages/talk/index.wxml").replace(/\s+/g, " ");
  assert.match(wxml, /class="ai-line">AI 生成可能有误，注意核实</);
  assert.match(wxml, /class="start"/);
  assert.match(wxml, /wx:if="\{\{guest\}\}" class="plus tap-area" hover-class="pressed" bindtap="guestTap"/);
  assert.match(wxml, /wx:if="\{\{guest\}\}" class="send tap-area" hover-class="btn-press" bindtap="guestTap"/);
});

test("聊一聊: the latest chats are chips; 全部对话 pages them, a tap goes on, a long press deletes after asking", async () => {
  const { page, calls, opened } = talkPage("ok", {
    threads: [{ id: "t1", title: "极限", last: "先看分母", updatedAt: "2026-10-17T02:00:00Z" }],
  });
  page.onLoad({});
  page.onShow();
  await tick();
  assert.ok(calls.includes("/v1/chat/threads?kind=chat&limit=12"));
  assert.deepEqual(page.data.recent, [{ id: "t1", title: "极限" }]);
  page.openHistory();
  assert.deepEqual(opened, ["/pages/chat-history/index"]);

  const hist = [];
  const all = load("pages/chat-history/index.js", () => {
    global.wx = {
      showModal: ({ success }) => {
        hist.push("modal");
        success({ confirm: true });
      },
      stopPullDownRefresh() {},
    };
    stub("utils/gate.js", { state: () => "ok", check: () => true, ask() {} });
    stub("utils/api.js", {
      get: (url) => {
        hist.push(url);
        return Promise.resolve({ threads: [{ id: "t1", title: "极限", last: "先看分母", updatedAt: "2026-10-17T02:00:00Z" }], next: null });
      },
      del: (url) => {
        hist.push(`DEL ${url}`);
        return Promise.resolve({});
      },
      needsConsent: () => false,
    });
    stub("utils/chat-entry.js", { openChat: (intent, how) => opened.push([intent, how]) });
    realChat();
  });
  all.onShow();
  await tick();
  await tick();
  assert.deepEqual(hist, ["/v1/chat/threads?kind=chat&limit=20"]);
  assert.equal(all.data.threads[0].last, "先看分母");
  all.open({ currentTarget: { dataset: { id: "t1" } } });
  assert.deepEqual(opened.at(-1), [{ threadId: "t1" }, { tab: true }]);
  all.remove({ currentTarget: { dataset: { id: "a/b?c" } } });
  await tick();
  assert.deepEqual(hist.slice(1, 3), ["modal", "DEL /v1/chat/threads/a%2Fb%3Fc"]);
});

test("聊一聊: ＋ picks and the files wait above the input here, with the words", async () => {
  const files = [{ key: "k1", kind: "file", name: "a.pdf", size: 10, path: "wxfile://a" }];
  const { page, opened, calls } = talkPage("ok", { pick: files, source: 2 });
  page.onLoad({});
  page.onShow();
  await tick();
  page.setData({ draft: "看看这个" });
  page.plus();
  await tick();
  await tick();
  assert.ok(calls.includes("pick 2 4"));
  // No other page: they upload at once, without a chat yet.
  assert.deepEqual(opened, []);
  assert.ok(calls.includes(`UP /v1/chat/attachments?name=a.pdf`));
  await tick();
  assert.deepEqual(page.data.pending.map((x) => [x.id, x.status]), [["att_wxfile://a", "ok"]]);
  assert.equal(page.data.draft, "看看这个");
});

test("聊一聊: the input is fixed at the bottom over the keyboard, less the tab bar", () => {
  const { page } = talkPage("ok");
  page.onLoad({});
  page.keyboardHeight({ detail: { height: 300 } });
  assert.equal(page.data.kb, 240);
  page.blur();
  assert.equal(page.data.kb, 0);
  const wxml = read("pages/talk/index.wxml").replace(/\s+/g, " ");
  assert.match(wxml, /class="composer \{\{kb \? 'kb-up' : ''\}\}" style="bottom:\{\{kb\}\}px"/);
  assert.match(wxml, /class="plus tap-area"[^>]*bindtap="plus"/);
  assert.match(wxml, /adjust-position="\{\{false\}\}"/);
  assert.match(wxml, /bindkeyboardheightchange="keyboardHeight"/);
  assert.match(read("pages/chat-history/index.wxml"), /bindlongpress="remove"/);
  assert.match(read("pages/talk/index.wxss"), /\.composer \{\s*position: fixed;/);
});

function chatPage({ upload, intent, reply } = {}) {
  const calls = [];
  const sent = [];
  const app = { globalData: { chat: intent || null } };
  const page = load("pages/chat/index.js", () => {
    global.getApp = () => app;
    global.wx = {
      getStorageSync: () => null,
      setStorageSync() {},
      removeStorageSync() {},
      pageScrollTo() {},
      nextTick: (fn) => fn(),
      showModal: () => calls.push("modal"),
      showToast: (o) => calls.push(`toast:${o.title}`),
    };
    stub("utils/gate.js", { state: () => "ok", check: () => true, ask: () => calls.push("ask") });
    stub("utils/auth.js", { hasConsent: () => true, getUser: () => ({ id: "u1" }) });
    stub("utils/study-clock.js", { track: (x) => x });
    stub("utils/api.js", {
      get: () => Promise.resolve({ thread: { id: "t1", scene: "life", mode: "guide" }, messages: [] }),
      post: (url, body) => {
        calls.push(["POST", url, body]);
        return Promise.resolve(url === "/v1/chat/threads" ? { thread: { id: "t9", scene: "life", mode: "guide" } } : { cards: [] });
      },
      del: (url) => {
        calls.push(`DEL ${url}`);
        return Promise.resolve({});
      },
      uploadTo: (url, p) => {
        calls.push(["UP", url, p]);
        return upload ? upload(url, p) : Promise.resolve({ id: `att_${p}`, kind: "image", imageId: `img_${p}` });
      },
      needsConsent: () => false,
    });
    stub("utils/stream.js", {
      clientId: () => "cid12345",
      send: (url, body) => {
        sent.push(body);
        return { promise: reply ? reply(body) : new Promise(() => {}), abort() {} };
      },
    });
    realChat();
  });
  return { page, calls, sent, app };
}

test("chat page: picked files upload at once, wait above the input and go with the message", async () => {
  const { page, calls, sent } = chatPage();
  page.onLoad({});
  page.setData({ thread: { id: "t1", scene: "life", mode: "guide", currentCards: [] } });
  const chat = realChat();
  page.addFiles([
    chat.attachItem({ kind: "image", name: "图片.jpg", size: 2000, path: "p1" }),
    chat.attachItem({ kind: "file", name: "笔记.docx", size: 3 * 1024 * 1024, path: "p2" }),
  ]);
  assert.equal(page.data.pending.length, 2);
  assert.ok(page.data.pending.every((x) => x.status === "up"));
  // Sending before they are up says so.
  page.submit();
  assert.equal(page.data.notice, "附件还在传，传好了再发");
  await tick();
  const ups = calls.filter((c) => c[0] === "UP");
  assert.equal(ups[0][1], `/v1/chat/attachments?name=${encodeURIComponent("图片.jpg")}&threadId=t1`);
  assert.ok(page.data.pending.every((x) => x.status === "ok"));
  assert.equal(page.data.pending[1].sizeText, "3 MB");
  // No words needed.
  page.submit();
  assert.deepEqual(sent[0].attachmentIds, ["att_p1", "att_p2"]);
  assert.equal(sent[0].threadId, "t1");
  assert.deepEqual(page.data.pending, []);
  const mine = page.data.messages.find((m) => m.role === "user");
  assert.equal(mine.attachments.length, 2);
  // No words: no empty bubble under them.
  assert.equal(mine.bare, true);
  // 再试一次 sends the same message again (same clientId): the server answers it once more.
  assert.equal(page.lastSend.clientId, sent[0].clientId);
  assert.deepEqual(page.lastSend.attachmentIds, ["att_p1", "att_p2"]);
  const wxml = read("pages/chat/index.wxml");
  assert.match(wxml, /<chat-attach wx:if="\{\{pending\.length\}\}" class="tray" items="\{\{pending\}\}" removable="\{\{true\}\}" bindremove="unpend" bindretry="retryattach"\/>/);
  assert.match(wxml, /class="plus tap-area"[^>]*bindtap="plus"/);
});

test("chat page: too big, wrong type or too many say one line; a refused upload leaves the tray", async () => {
  const fail = Object.assign(new Error("扫描版读不出文字，可以用导入"), { code: "FILE_SCANNED", statusCode: 422 });
  const { page, calls } = chatPage({ upload: () => Promise.reject(fail) });
  page.onLoad({});
  const chat = realChat();
  page.addFiles([chat.attachItem({ kind: "image", name: "a.jpg", size: 6 * 1024 * 1024, path: "x" })]);
  assert.equal(page.data.error, "图片超过 5 MB，换一张小一点的");
  page.addFiles([chat.attachItem({ kind: "file", name: "a.xlsx", size: 10, path: "x" })]);
  assert.equal(page.data.error, "这种文件还打不开，换成 Word、PDF、TXT 或 MD 试试");
  page.addFiles([chat.attachItem({ kind: "file", name: "a.pdf", size: 11 * 1024 * 1024, path: "x" })]);
  assert.equal(page.data.error, "文件超过 10 MB，换一份小一点的");
  // The server takes JPG and PNG only: HEIC and GIF are not uploaded.
  for (const name of ["图片.heic", "图片.gif"]) {
    page.addFiles([chat.attachItem({ kind: "image", name, size: 10, path: "x" })]);
    assert.equal(page.data.error, "只能发 JPG 或 PNG 图片");
  }
  assert.equal(chat.attachProblem(chat.attachItem({ kind: "image", name: "图片.jpeg", size: 10 })), "");
  assert.equal(chat.attachProblem(chat.attachItem({ kind: "image", name: "图片.PNG", size: 10 })), "");
  assert.equal(calls.filter((c) => c[0] === "UP").length, 0);
  page.addFiles([chat.attachItem({ kind: "file", name: "scan.pdf", size: 10, path: "s" })]);
  await tick();
  assert.deepEqual(page.data.pending, []);
  assert.equal(page.data.error, "扫描版读不出文字，可以用导入");
  page.setData({ pending: [1, 2, 3, 4].map((i) => ({ key: `k${i}`, status: "ok", id: `a${i}` })) });
  page.plus();
  assert.equal(page.data.error, "一次最多发 4 个附件");
  page.unpend({ detail: { key: "k2" } });
  assert.ok(calls.includes("DEL /v1/chat/attachments/a2"));
  assert.equal(page.data.pending.length, 3);
});

test("chat page: files from 聊一聊 start a new chat named after the document", async () => {
  const chat = realChat();
  const files = [chat.attachItem({ kind: "file", name: "期末复习.pdf", size: 100, path: "f1" })];
  const { page, calls, sent } = chatPage({
    intent: { entry: "jot", text: "", files },
    upload: () => Promise.resolve({ id: "att_f1", kind: "file", imageId: null }),
  });
  page.onLoad({});
  page.onShow();
  assert.equal(page.data.pending.length, 1);
  await tick();
  const up = calls.find((c) => c[0] === "UP");
  assert.doesNotMatch(up[1], /threadId/);
  await tick();
  page.submit();
  await tick();
  const created = calls.find((c) => c[0] === "POST" && c[1] === "/v1/chat/threads");
  assert.equal(created[2].text, "期末复习.pdf");
  assert.equal(created[2].entry, "jot");
  assert.equal(sent[0].text, "");
  assert.deepEqual(sent[0].attachmentIds, ["att_f1"]);
  assert.equal(sent[0].threadId, "t9");
});

test("messages show photos and file blocks; old messages without attachments are unchanged", () => {
  const chat = realChat();
  const shown = chat.attachView(
    [
      { id: "a1", kind: "image", name: "图片.jpg", size: 1000, type: "jpg", imageId: "img1" },
      { id: "a2", kind: "file", name: "笔记.docx", size: 2048, type: "docx", imageId: null },
    ],
    { a1: "local-path" },
  );
  assert.equal(shown[0].path, "local-path");
  assert.equal(shown[1].badge, "DOC");
  assert.equal(shown[1].sizeText, "2 KB");
  assert.deepEqual(chat.attachView(undefined), []);
  const panel = read("components/chat-panel/index.wxml").replace(/\s+/g, " ");
  assert.match(panel, /<chat-attach wx:if="\{\{item\.attachments && item\.attachments\.length\}\}"/);
  assert.match(panel, /class="bubble[^>]*"|wx:if="\{\{!item\.bare\}\}"/);
  const comp = read("components/chat-attach/index.js");
  assert.match(comp, /wx\.previewImage/);
  assert.match(comp, /\/v1\/chat\/images\//);
  const att = read("components/chat-attach/index.wxml");
  assert.match(att, /class="ca-badge"/);
  assert.match(att, /item\.sizeText/);
});

test("注销 from 隐私政策 clears the same four flags as 我的", () => {
  const privacy = read("pages/privacy/index.js");
  const profile = read("pages/profile/index.js");
  // One list in utils/session, read by both pages.
  const session = read("utils/session.js");
  assert.match(session, /const LOCAL_FLAGS = \[[^\]]*"zhiye_onboarded"[^\]]*\]/);
  for (const src of [privacy, profile]) assert.match(src, /const \{ LOCAL_FLAGS \} = session;/);
  const removal = privacy.slice(privacy.indexOf("removeAccount("));
  assert.match(removal, /LOCAL_FLAGS\.forEach\(\(key\) => \{\s*try \{\s*wx\.removeStorageSync\(key\);/);
});

test("new words on these pages stay plain and name no model", () => {
  const text = [
    "pages/talk/index.wxml",
    "pages/chat/index.wxml",
    "components/chat-attach/index.wxml",
    "utils/chat-v2.js",
  ].map(read).join("\n");
  assert.doesNotMatch(text, /GPT|Claude|DeepSeek|Qwen|通义|豆包|文心|混元|Kimi|大模型/i);
});

// 附件与异步行为回归。
test("chat page: documents upload one after another, photos at once", async () => {
  const chat = realChat();
  const waiting = [];
  const { page, calls } = chatPage({
    upload: (url, p) => new Promise((resolve) => waiting.push(() => resolve({ id: `att_${p}`, imageId: null }))),
  });
  page.onLoad({});
  page.addFiles([
    chat.attachItem({ kind: "file", name: "a.pdf", size: 10, path: "f1" }),
    chat.attachItem({ kind: "image", name: "b.jpg", size: 10, path: "p1" }),
    chat.attachItem({ kind: "file", name: "c.docx", size: 10, path: "f2" }),
  ]);
  await tick();
  assert.deepEqual(calls.filter((c) => c[0] === "UP").map((c) => c[2]), ["p1", "f1"]);
  waiting[1]();
  await tick();
  assert.deepEqual(calls.filter((c) => c[0] === "UP").map((c) => c[2]), ["p1", "f1", "f2"]);
});

test("chat page: a quick reply leaves the tray alone; 再试一次 keeps the attachments' message", async () => {
  const { page, sent } = chatPage();
  page.onLoad({});
  page.setData({ thread: { id: "t1", scene: "life", mode: "guide", currentCards: [] }, pending: [{ key: "k1", status: "ok", id: "a1" }] });
  page.panelAction({ detail: { key: "guide-1", value: "接着说" } });
  assert.equal(sent[0].attachmentIds, undefined);
  assert.equal(page.data.pending.length, 1);
  page.setData({ sending: false });
  page.submit();
  const first = sent[1];
  assert.deepEqual(first.attachmentIds, ["a1"]);
  page.setData({ sending: false });
  page.panelAction({ detail: { key: "retry" } });
  assert.equal(sent[2].clientId, first.clientId);
  // The question is already in the chat: only a new waiting reply is added.
  assert.equal(page.data.messages.filter((m) => /^local_/.test(m.id)).length, 0);
  assert.ok(page.data.messages.some((m) => m.id === `wait_${first.clientId}`));
});

// V4.2 : unsent attachments stay with the draft; one lost on the way stays to try again.
test("chat page: leaving keeps uploaded, unsent attachments; a failed upload stays, one tap tries again", async () => {
  let n = 0;
  const { page, calls } = chatPage({
    upload: (url, p) => (++n === 1 ? Promise.reject(Object.assign(new Error("没传上去，检查网络再试"), { code: "NETWORK" })) : Promise.resolve({ id: `att_${p}`, imageId: "img" })),
  });
  page.onLoad({});
  page.setData({ thread: { id: "t1", scene: "life", mode: "guide", currentCards: [] } });
  const chat = realChat();
  page.addFiles([chat.attachItem({ kind: "image", name: "a.jpg", size: 10, path: "p1" })]);
  await tick();
  assert.deepEqual(page.data.pending.map((x) => x.status), ["failed"]);
  page.submit();
  assert.equal(page.data.notice, "有附件没传上，点一下再试，或者删掉");
  page.retryattach({ detail: { key: page.data.pending[0].key } });
  await tick();
  assert.deepEqual(page.data.pending.map((x) => [x.id, x.status]), [["att_p1", "ok"]]);
  page.onUnload();
  assert.deepEqual(calls.filter((c) => typeof c === "string" && c.startsWith("DEL")), []);
});

test("chat page: a send turned away before the message is kept gives the attachments back; after, they are dropped", async () => {
  const failWith = (code) => () => Promise.reject(Object.assign(new Error("不行"), { code, statusCode: 409 }));
  // Turned away before the message was stored (e.g. today's answers used up): still unsent, reusable.
  let { page, calls } = chatPage({ reply: failWith("QUOTA_EXCEEDED") });
  page.onLoad({});
  const tray = [{ key: "k1", status: "ok", id: "a1", kind: "image" }];
  page.setData({ thread: { id: "t1", scene: "life", mode: "guide", currentCards: [] }, pending: tray });
  page.submit();
  await tick();
  assert.deepEqual(page.data.pending.map((x) => x.id), ["a1"]);
  assert.ok(!calls.some((c) => String(c).startsWith("toast:")));
  // The server stored the message (and bound the attachment) before saying it is still answering.
  for (const code of ["STILL_ANSWERING", "ATTACHMENT_NOT_FOUND"]) {
    ({ page, calls } = chatPage({ reply: failWith(code) }));
    page.onLoad({});
    page.setData({ thread: { id: "t1", scene: "life", mode: "guide", currentCards: [] }, pending: tray });
    page.submit();
    await tick();
    assert.deepEqual(page.data.pending, [], code);
    assert.ok(calls.includes("toast:附件要重新选"), code);
    assert.equal(page.data.error, "不行");
  }
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const chat = require(path.join(root, "utils/chat-v2.js"));

function stub(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function loadPage(
  name,
  { api = {}, app = { globalData: {} }, auth = {} } = {},
) {
  let definition;
  global.Page = (value) => {
    definition = value;
  };
  global.getApp = () => app;
  global.wx = {
    hideTabBar() {},
    showTabBar() {},
    navigateBack() {},
    navigateTo() {},
    showToast() {},
    showActionSheet() {},
    showModal() {},
    pageScrollTo() {},
    setNavigationBarColor() {},
    setBackgroundColor() {},
    getStorageSync() {
      return null;
    },
  };
  const file = path.join(root, `pages/${name}/index.js`);
  const apiPath = path.join(root, "utils/api.js"),
    authPath = path.join(root, "utils/auth.js");
  const themePath = path.join(root, "utils/theme.js");
  delete require.cache[file];
  stub(apiPath, { needsConsent: () => false, ...api });
  stub(authPath, {
    hasConsent: () => true,
    getUser: () => ({ id: "one" }),
    ...auth,
  });
  stub(themePath, { themed: (value) => value });
  require(file);
  definition.data = structuredClone(definition.data);
  definition.setData = (patch) => Object.assign(definition.data, patch);
  return definition;
}

test("guide actions respect scene, teach mode, and existing math actions", () => {
  const answer = {
    role: "assistant",
    status: "done",
    guide: { options: ["一", "二", "三", "四", "五"] },
  };
  assert.deepEqual(
    chat
      .actions({ scene: "study", mode: "guide" }, [answer], true)
      .slice(0, 4)
      .map((item) => item.text),
    ["一", "二", "三", "四"],
  );
  // 直接说答案 was dropped in V4.1, in every scene.
  for (const scene of ["life", "study", "mood"])
    assert.ok(
      !chat
        .actions({ scene, mode: "guide" }, [answer], false)
        .some((item) => item.key === "direct"),
    );
  assert.deepEqual(
    chat
      .actions(
        { scene: "life", mode: "teach" },
        [{ role: "assistant", status: "done" }],
        false,
      )
      .map((item) => item.key),
    ["teachDone"],
  );
  assert.deepEqual(
    chat.actions(
      { scene: "life", mode: "teach" },
      [
        {
          role: "assistant",
          status: "done",
          quote: "这是用户讲完后由服务端核对过的一句本人原话",
        },
      ],
      false,
    ),
    [],
  );
  const math = [
    { key: "answer", text: "我算出来了" },
    { key: "solution", text: "看完整解析" },
  ];
  const keys = chat
    .actions(
      { scene: "study", mode: "guide", problem: {} },
      [answer],
      true,
      math,
    )
    .map((item) => item.key);
  assert.ok(keys.includes("answer"));
  assert.ok(keys.includes("solution"));
  assert.ok(keys.includes("park"));
});

test("mine choices only come from user messages and the wrap offer follows four user messages", () => {
  const messages = [
    {
      role: "assistant",
      content: "这是 AI 生成的一句话，绝不能列入我的话候选",
    },
    {
      role: "user",
      guideChoice: true,
      content: "这是点击 AI 选项形成的一句足够长的话",
    },
    { role: "user", content: "这是用户自己写下的一句足够长的话。短句。" },
  ];
  assert.deepEqual(chat.quotes(messages), ["这是用户自己写下的一句足够长的话"]);
  const users = (n) => Array.from({ length: n }, () => ({ role: "user" }));
  assert.equal(chat.shouldOfferWrap(users(4)), true);
  assert.equal(chat.shouldOfferWrap(users(3)), false);
  // No timer: a quiet minute alone never offers it.
  assert.equal(chat.shouldOfferWrap([], 1000, 61000), false);
  // A crisis message does not count as a turn.
  assert.equal(
    chat.shouldOfferWrap(users(3).concat({ role: "user", crisis: 1 })),
    false,
  );
});

test("the chip row shows at most three, keeps the rest under 更多 and 先放着 as a link", () => {
  const answer = {
    id: "r1",
    role: "assistant",
    status: "done",
    blocks: [{ t: "p", c: [] }],
    guide: { options: ["一", "二", "三", "四"] },
  };
  const study = { scene: "study", mode: "guide" };
  const math = [
    { key: "example", text: "举个例子" },
    { key: "simpler", text: "讲得再简单点" },
    { key: "practice", text: "出一道题给我练" },
  ];
  const row = chat.layout(chat.actions(study, [answer], true, math));
  assert.deepEqual(
    row.shown.map((item) => item.key),
    ["guide-0", "guide-1", "example"],
  );
  assert.equal(row.park.key, "park");
  const more = row.more.map((item) => item.key);
  assert.ok(more.length <= 6);
  for (const key of ["guide-2", "guide-3", "simpler", "practice"])
    assert.ok(more.includes(key), key);
  assert.ok(!more.includes("direct"));
  // A problem: the main action first, then two AI options.
  const problem = chat.layout(
    chat.actions({ ...study, problem: {} }, [answer], true, [
      { key: "answer", text: "我算出来了", primary: true },
      { key: "more", text: "再给一步提示" },
      { key: "solution", text: "看完整解析" },
    ]),
  );
  assert.deepEqual(
    problem.shown.map((item) => item.key),
    ["answer", "guide-0", "guide-1"],
  );
  assert.ok(problem.more.some((item) => item.key === "solution"));
  assert.equal(problem.park.key, "park");
});

test("only the newest finished reply offers to be stored as a card", () => {
  const done = (id, extra) => ({ id, role: "assistant", status: "done", ...extra });
  const text = { blocks: [{ t: "p", c: [] }] };
  assert.equal(
    chat.collectTarget([done("a", text), { role: "user" }, done("b", text)]),
    "b",
  );
  assert.equal(
    chat.collectTarget([done("a", text), done("b", { status: "streaming" })]),
    "",
  );
  assert.equal(chat.collectTarget([done("a", { blocks: [] })]), "");
  assert.equal(chat.collectTarget([done("a", { ...text, crisis: 1 })]), "");
  // A judge waiting for its verdict carries nothing yet.
  assert.equal(chat.collectTarget([done("j", { kind: "judge" })]), "");
  assert.equal(
    chat.collectTarget([
      done("j", { kind: "judge", attempt: { result: { verdict: "correct" } } }),
    ]),
    "j",
  );
});

test("问 AI offers 举个例子 / 讲简单点 / 出题练 in a study chat only", async () => {
  let scene = "study";
  const page = loadPage("ask", {
    api: {
      patch: async () => ({ thread: { id: "t1", scene, mode: "guide" } }),
    },
  });
  page.onLoad();
  page.data.thread = { id: "t1", scene: "life", mode: "guide" };
  page.data.messages = [
    { id: "q1", role: "user", status: "done" },
    {
      id: "r1",
      role: "assistant",
      kind: "reply",
      mode: "auto",
      status: "done",
      blocks: [{ t: "p", c: [] }],
      guide: { options: ["一", "二"] },
    },
  ];
  await page.patchThread({ scene });
  let keys = page.data.actions.map((item) => item.key);
  for (const key of ["example", "simpler", "practice"])
    assert.ok(keys.includes(key), key);
  assert.equal(page.data.collectId, "r1");
  scene = "life";
  await page.patchThread({ scene });
  keys = page.data.actions.map((item) => item.key);
  assert.ok(!keys.includes("example") && !keys.includes("practice"));
});

test("出一道题给我练 picks a chapter for a choice question instead of asking in the chat (D112)", async () => {
  const calls = [];
  const page = loadPage("ask", {
    api: {
      get: async (url) => {
        calls.push(url);
        return { chapters: [{ id: "limit", short: "极限" }, { id: "ode", short: "微分方程" }] };
      },
      post: async (url) => {
        calls.push(url);
        return {};
      },
    },
  });
  let sheet = null;
  wx.showActionSheet = (options) => {
    sheet = options;
  };
  page.onLoad();
  page.data.thread = { id: "t1", scene: "study", mode: "guide" };
  await page.act({ detail: { key: "practice" } });
  assert.deepEqual(calls, ["/v1/learn/map"]);
  assert.deepEqual(sheet.itemList, ["极限"]);
});

test("cards picked before any chat start one with them and never wait for the next chat", async () => {
  let created;
  const app = { globalData: {} };
  const page = loadPage("ask", {
    app,
    api: {
      post: async (url, body) => {
        created = { url, body };
        return { thread: { id: "t-new" } };
      },
      get: async () => {
        throw Object.assign(new Error("没找到"), { statusCode: 500 });
      },
    },
  });
  page.onLoad();
  // Going to card-pick and back without picking changes nothing.
  page.pickCards();
  assert.equal(app.globalData.pickedCards, null);
  page.picked();
  assert.equal(created, undefined);
  page.pickCards();
  app.globalData.pickedCards = [{ id: "c1", title: "洛必达的条件" }];
  await page.picked();
  assert.deepEqual(app.globalData.pickedCards, []);
  assert.equal(created.url, "/v1/chat/threads");
  assert.deepEqual(created.body.cardIds, ["c1"]);
  assert.equal(created.body.text, "洛必达的条件");
});

test("wrap editor sends only selected draft keys with edited titles and an exact user quote", async () => {
  let sent;
  const app = {
    globalData: {
      collect: {
        mode: "wrap",
        threadId: "thread-1",
        draft: {
          id: "wrap-1",
          summary: "小结",
          cards: [
            { key: "main", type: "idea", title: "原题", selected: true },
            {
              key: "other",
              type: "question",
              title: "另一个",
              selected: false,
            },
          ],
          next: null,
        },
        quotes: ["这是用户在对话里说过的一句完整原话"],
      },
    },
  };
  const page = loadPage("collect", {
    app,
    api: {
      post: async (url, body) => {
        sent = { url, body };
        return { savedCardIds: ["card-1"] };
      },
    },
  });
  page.onLoad();
  page.chooseQuote({
    currentTarget: { dataset: { quote: app.globalData.collect && "" } },
  });
  page.setData({ mine: "这是用户在对话里说过的一句完整原话" });
  page.cardInput({
    currentTarget: { dataset: { index: 0, key: "title" } },
    detail: { value: "用户改的标题" },
  });
  await page.save();
  assert.equal(sent.url, "/v1/chat/threads/thread-1/wrap");
  assert.deepEqual(sent.body.picks, ["main"]);
  assert.deepEqual(sent.body.edits, [{ key: "main", title: "用户改的标题" }]);
  assert.equal(sent.body.mine, "这是用户在对话里说过的一句完整原话");
});

test("standalone chat keeps the waiting bubble for a mood offer before the reply and has no direct answer (V4.1)", () => {
  const page = loadPage("chat");
  page.onLoad({});
  const question = {
    id: "q1",
    role: "user",
    status: "done",
    content: "最近有点焦虑",
  };
  page.data.messages = [
    { id: "local_c1", role: "user", content: "最近有点焦虑" },
    { id: "wait_c1", role: "assistant", status: "streaming" },
  ];
  // Sent with a threadId, the offer comes first and the reply still follows.
  page.onEvent(
    { e: "scene_candidate", pending: false, thread: { id: "t1", scene: "life" }, question },
    "c1",
  );
  assert.deepEqual(
    page.data.messages.map((item) => item.id),
    ["q1", "wait_c1"],
  );
  assert.equal(page.data.sceneCandidate, true);
  // Only a pending offer gets no reply, so only then the waiting bubble goes.
  page.data.messages = [
    { id: "local_c2", role: "user", content: "最近有点焦虑" },
    { id: "wait_c2", role: "assistant", status: "streaming" },
  ];
  page.onEvent(
    { e: "scene_candidate", pending: true, thread: { id: "t1", scene: "life" }, question },
    "c2",
  );
  assert.deepEqual(
    page.data.messages.map((item) => item.id),
    ["q1"],
  );
  let sent;
  page.send = (input) => {
    sent = input;
  };
  page.panelAction({ detail: { key: "direct" } });
  assert.equal(sent, undefined);
});

test("teach completion saves a verified user quote to the single carried card", async () => {
  const quote = "先检查使用条件，再决定能不能使用洛必达法则";
  let sent;
  const page = loadPage("ask", {
    api: {
      get: async (url) => {
        assert.equal(url, "/v1/cards/card-one");
        return { version: 7 };
      },
      post: async (url, body) => {
        sent = { url, body };
        return { card: { id: "card-one" }, crisis: false };
      },
    },
  });
  page.onLoad();
  page.scope = "one";
  page.data.thread = {
    id: "thread-one",
    mode: "teach",
    currentCards: [{ id: "card-one", title: "洛必达的条件" }],
  };
  page.data.messages = [
    { id: "mine", role: "user", content: quote, plain: quote },
    { id: "done", role: "assistant", quote },
  ];
  await page.teachsave({ detail: { id: "done", quote } });
  assert.deepEqual(sent, {
    url: "/v1/cards/card-one/mine",
    body: { version: 7, text: quote },
  });
});

test("teach quote choices exclude AI choices and a late card read cannot write for another owner", async () => {
  const own = "这是用户自己讲出的完整一句话，长度已经足够";
  assert.deepEqual(
    chat.teachQuotes([
      { role: "assistant", content: "这是 AI 的总结" },
      {
        role: "user",
        guideChoice: true,
        content: "这是点击 AI 选项形成的内容",
      },
      { role: "user", content: `${own}。` },
    ]),
    [own],
  );
  let currentOwner = "one",
    release,
    writes = 0;
  const page = loadPage("chat", {
    auth: { getUser: () => ({ id: currentOwner }) },
    api: {
      get: () => new Promise((resolve) => (release = resolve)),
      post: async () => {
        writes += 1;
        return { crisis: false };
      },
    },
  });
  page.onLoad({});
  page.data.thread = {
    id: "thread-one",
    mode: "teach",
    currentCards: [{ id: "card-one" }],
  };
  page.data.messages = [{ id: "done", role: "assistant", quote: own }];
  const pending = page.teachsave({ detail: { id: "done", quote: own } });
  currentOwner = "two";
  release({ version: 3 });
  await pending;
  assert.equal(writes, 0);
});

test("shared ask UI keeps the AI notice, card controls, guide collection, and removes the old mode switch", () => {
  const wxml = fs.readFileSync(path.join(root, "pages/ask/index.wxml"), "utf8");
  assert.match(wxml, /AI 生成可能有误，注意核实/);
  assert.match(wxml, /chat-panel/);
  // 卡 moved into ⋯ ("带上一张卡"); the header has no scene picker or 收尾.
  assert.doesNotMatch(wxml, /bindtap="pickCards"/);
  assert.doesNotMatch(wxml, /bindscene|chooseScene|收尾|程序/);
  assert.match(wxml, /bindtap="moreChat"[^>]*>\s*⋯/);
  // One ⋯ at a time: the top bar's before any chat, the input row's in one.
  assert.equal((wxml.match(/bindtap="moreChat"/g) || []).length, 2);
  assert.match(wxml, /wx:if="\{\{!thread\}\}"\s*class="tb more"/);
  assert.match(wxml, /wx:if="\{\{thread\}\}"\s*class="tool"/);
  assert.match(wxml, /collectSpot/);
  assert.doesNotMatch(wxml, /先给提示[\s\S]*直接解析/);
  const compact = fs.readFileSync(
    path.join(root, "components/chat-panel/index.wxml"),
    "utf8",
  );
  assert.match(compact, /sceneCandidate/);
  assert.match(compact, /suggestdismiss/);
  assert.match(compact, /wrapDue/);
  assert.match(compact, /＋ 存成卡/);
  assert.doesNotMatch(compact, /收尾|程序/);
  // the kind's icon, as on the card tiles (the type on old servers).
  assert.match(compact, /card-{{item\.kind \|\| item\.type}}\.svg/);
  // V4.2 : the reply no longer quotes the student ("你自己说出了「…」").
  assert.doesNotMatch(compact, /class="spot"|你自己说出了/);
  assert.match(compact, /存成我的话/);
  assert.match(compact, /data-event="teachchange"/);
  assert.match(compact, /data-event="teachpick"/);
  const code = fs.readFileSync(path.join(root, "pages/ask/index.js"), "utf8");
  assert.match(code, /带上一张卡/);
  assert.match(code, /这段在聊：/);
  assert.doesNotMatch(code, /程序|收尾/);
  assert.match(
    code,
    /intent\.entry === "jot"[\s\S]*\/v1\/chat\/threads[\s\S]*this\.send/,
  );
  assert.match(
    code,
    /\/v1\/cards\/\$\{encodeURIComponent\(target\.id\)\}\/mine/,
  );
  assert.match(
    fs.readFileSync(path.join(root, "pages/collect/index.wxml"), "utf8"),
    /AI 生成可能有误，注意核实/,
  );
  const collect = fs.readFileSync(
      path.join(root, "pages/collect/index.wxml"),
      "utf8",
    ),
    collectStyle = fs.readFileSync(
      path.join(root, "pages/collect/index.wxss"),
      "utf8",
    );
  assert.match(collect, /sheet-handle/);
  assert.match(collect, /存下这 '\+selectedCount\+' 张/);
  assert.match(collectStyle, /\.buttons button[\s\S]*width: auto !important/);
});

test("point collection uses a map source and crisis never displays a success receipt", async () => {
  let body,
    success = 0,
    back = 0,
    url;
  const page = loadPage("collect", {
    app: {
      globalData: {
        collect: {
          origin: "map",
          pointId: "limit",
          quote: "卡在把分子分母同时除以同一个量",
          type: "question",
        },
      },
    },
    api: {
      post: async (u, b) => {
        body = b;
        return { crisis: true };
      },
    },
  });
  page.onLoad();
  global.wx.showToast = () => success++;
  global.wx.navigateBack = () => back++;
  global.wx.navigateTo = (x) => (url = x.url);
  await page.save();
  assert.equal(body.origin, "map");
  assert.equal(body.scene, "study");
  assert.equal(body.pointId, "limit");
  assert.equal(body.srcId, undefined);
  assert.equal(url, "/pages/crisis/index");
  assert.equal(success, 0);
  assert.equal(back, 0);
});
test("collect does not save my words after the owner changes while reading a version", async () => {
  let owner = "one",
    release,
    writes = 0;
  const page = loadPage("collect", {
    app: {
      globalData: {
        collect: {
          mode: "mine",
          cardId: "card-one",
          quote: "这是一句本人写出的足够长的理解",
        },
      },
    },
    auth: { getUser: () => ({ id: owner }) },
    api: {
      get: () => new Promise((r) => (release = r)),
      post: async () => {
        writes++;
        return {};
      },
    },
  });
  page.onLoad();
  const pending = page.save();
  owner = "two";
  release({ version: 1 });
  await pending;
  assert.equal(writes, 0);
});

test("问 AI: a guided reply offers exactly 我算出来了 / 再给一步提示 / 看完整解析, a plain one two general chips, an unmarked one the old row", async () => {
  let current;
  const page = loadPage("ask", {
    api: { patch: async () => ({ thread: current }) },
  });
  page.onLoad();
  const row = async (thread, extra) => {
    current = thread;
    page.data.thread = thread;
    page.data.messages = [
      { id: "q1", role: "user", status: "done" },
      {
        id: "r1",
        role: "assistant",
        kind: "reply",
        mode: "auto",
        status: "done",
        blocks: [{ t: "p", c: [] }],
        guide: { options: ["一", "二"] },
        ...extra,
      },
    ];
    await page.patchThread({});
    return page.data.actions;
  };
  const study = { id: "t1", scene: "study", mode: "guide" };
  let actions = await row(study, { guided: true });
  assert.deepEqual(
    actions.map((item) => item.text),
    ["我算出来了", "再给一步提示", "看完整解析"],
  );
  assert.equal(actions[0].primary, true);
  assert.equal(actions[0].key, "answerFree");
  actions = await row({ ...study, problem: {} }, { guided: true });
  assert.equal(actions[0].key, "answer");
  assert.equal(chat.layout(actions).shown.length, 3);
  // 我算出来了 without a problem on file: type the answer as the next message.
  page.act({ detail: { key: "answerFree" } });
  assert.equal(page.data.focus, true);
  assert.equal(page.data.answerHint, true);
  actions = await row(study, { guided: false });
  assert.deepEqual(
    actions.map((item) => item.key),
    ["example", "simpler"],
  );
  // Replies from before the mark keep the old row.
  actions = await row(study, {});
  const keys = actions.map((item) => item.key);
  for (const key of ["guide-0", "example", "practice", "self", "park"])
    assert.ok(keys.includes(key), key);
  assert.ok(chat.layout(actions).shown.length <= 3);
});

test("long press offers 收进错题本 only on a guided reply or in a problem chat, and the ask page files it", async () => {
  const done = { id: "r1", role: "assistant", status: "done" };
  assert.deepEqual(chat.holdItems(done, { scene: "study" }), ["存成卡", "复制"]);
  assert.deepEqual(chat.holdItems({ ...done, guided: false }, {}), ["存成卡", "复制"]);
  assert.deepEqual(chat.holdItems({ ...done, guided: true }, {}), ["存成卡", "收进错题本", "复制"]);
  assert.deepEqual(chat.holdItems(done, { problem: {} }), ["存成卡", "收进错题本", "复制"]);
  assert.deepEqual(chat.holdItems({ id: "q1", role: "user" }, { problem: {} }), ["存成卡", "复制"]);
  // In a chat with a problem, a reply about something else is not its mistake.
  assert.deepEqual(chat.holdItems({ ...done, guided: false, mode: "auto" }, { problem: {} }), ["存成卡", "复制"]);
  assert.deepEqual(chat.holdItems({ ...done, guided: false, mode: "solution" }, { problem: {} }), ["存成卡", "收进错题本", "复制"]);
  const posts = [],
    toasts = [];
  let fail = null;
  const page = loadPage("ask", {
    api: {
      post: async (url, body) => {
        posts.push([url, body]);
        if (fail) throw fail;
        return { mistake: { id: "m1" }, thread: { id: "t1", scene: "study", mistake: { id: "m1", status: "open", dueOn: "2030-01-01" } } };
      },
    },
  });
  global.wx.showToast = ({ title }) => toasts.push(title);
  let sheet;
  global.wx.showActionSheet = (options) => (sheet = options);
  page.onLoad();
  page.data.thread = { id: "t1", scene: "study", mode: "guide" };
  page.data.messages = [
    { id: "r1", role: "assistant", status: "done", guided: true, blocks: [{ t: "p", c: [{ t: "text", v: "第一步" }] }] },
  ];
  page.holdMessage({ currentTarget: { dataset: { id: "r1" } } });
  assert.deepEqual(sheet.itemList, ["存成卡", "收进错题本", "复制"]);
  await sheet.success({ tapIndex: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posts[0], ["/v1/chat/messages/r1/mistake", { tone: "light" }]);
  assert.deepEqual(toasts, ["收进错题本了"]);
  assert.equal(page.data.thread.mistake.id, "m1");
  fail = Object.assign(new Error("这条不像一道题，没法收进错题本"), { code: "NOT_A_PROBLEM" });
  await page.addMistake("r1");
  assert.equal(page.data.error, "这条不像一道题，没法收进错题本");
});

test("解题 starts open: one line, one problem to try, nothing about life (D112)", () => {
  const wxml = fs.readFileSync(path.join(root, "pages/ask/index.wxml"), "utf8");
  assert.match(wxml, /拍照或打字，一步步带你做/);
  assert.doesNotMatch(wxml, /试试这样问|高数|什么都可以问/);
  const js = fs.readFileSync(path.join(root, "pages/ask/index.js"), "utf8");
  assert.match(js, /show: "求 lim\(x→0\) sin3x\/x"/);
  assert.doesNotMatch(js, /帮我排一下这周的复习/);
});

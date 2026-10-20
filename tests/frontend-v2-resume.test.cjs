const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../miniprogram");

function harness(relative, api, component = true) {
  let definition,
    account = "one",
    navigated = [];
  const sheets = [],
    chats = [];
  const context = {
    require(name) {
      if (name.endsWith("/api")) return api;
      if (name.endsWith("/auth"))
        return {
          getUser: () => ({ id: account }),
          hasConsent: () => true,
          login: async () => ({ id: account }),
        };
      if (name.endsWith("/visit")) return { current: () => "same-visit" };
      if (name.endsWith("/clock"))
        return { now: () => Date.UTC(2026, 9, 12, 0, 0, 0) };
      if (name.endsWith("/format"))
        return { errorText: (error) => error.message };
      if (name.endsWith("/theme")) return { themed: (value) => value };
      if (name.endsWith("/gate")) return { state: () => "ok", check: () => true, ask() {} };
      if (name.endsWith("/chat-entry"))
        return { openChat: (intent) => chats.push(intent) };
      if (name.endsWith("/assets"))
        return { asset: (file) => `https://assets.test/${file}` };
      if (name.endsWith("/cards")) return require(path.join(root, "utils/cards.js"));
      if (name.endsWith("/tap")) return require(path.join(root, "utils/tap.js"));
      throw new Error(name);
    },
    wx: {
      navigateTo: ({ url }) => navigated.push(url),
      setNavigationBarTitle() {},
      showToast() {},
      showActionSheet: (options) => sheets.push(options),
      stopPullDownRefresh() {},
    },
    Component: (value) => {
      definition = value;
    },
    Page: (value) => {
      definition = value;
    },
    setTimeout: () => 1,
    clearTimeout() {},
    Date,
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, relative), "utf8"),
    context,
  );
  const instance = {
    ...(component ? definition.methods : definition),
    data: structuredClone(definition.data),
    alive: true,
    triggerEvent() {},
    setData(patch) {
      for (const [key, value] of Object.entries(patch)) {
        const parts = key.split(".");
        let target = this.data;
        for (const p of parts.slice(0, -1))
          target = target[p] || (target[p] = {});
        target[parts.at(-1)] = value;
      }
    },
  };
  return {
    instance,
    definition,
    navigated,
    sheets,
    chats,
    switchUser: (id) => {
      account = id;
    },
  };
}
const item = {
  id: "resume_one",
  state: "shown",
  card: { id: "card_one", type: "idea", title: "选择一件事", version: 2 },
  options: ["定了", "写一句"],
  quoteOn: "2026-10-01",
};

test("lookback and unfinished rows open their source only for the active owner", async () => {
  const h = harness("components/resume-card/index.js", {
    post: async () => ({
      kind: "lookback",
      item: null,
      text: "这一步记在卡里了。",
      url: "/pages/card/index?id=one",
    }),
  });
  await h.instance.load();
  h.instance.openReflection();
  assert.equal(h.navigated[0], "/pages/card/index?id=one");
  h.switchUser("two");
  h.instance.openReflection();
  assert.equal(h.navigated.length, 1);
});

test("opening finished work records the response and follows its task URL", async () => {
  const task = { id: "task", src: "import", title: "这次导入", options: ["看看"], url: "/pages/import/split/index?id=imp1", state: "shown" };
  const calls = [];
  const h = harness("components/resume-card/index.js", {
    post: async (url, body) => { calls.push([url, body]); return url.endsWith("/act") ? { item: { ...task, state: "done" } } : { kind: "item", item: task }; },
  });
  await h.instance.load();
  await h.instance.choose({ currentTarget: { dataset: { text: "看看" } } });
  assert.equal(calls[1][1].action, "answer");
  assert.equal(h.navigated[0], task.url);
  assert.equal(h.instance.data.collapsed, true);
});

test("visit stays stable within thirty minutes and changes after a long absence", () => {
  const location = path.join(root, "utils/visit.js");
  delete require.cache[location];
  const visit = require(location);
  const first = visit.show(1000);
  visit.hide(2000);
  assert.equal(visit.show(1799000), first);
  visit.hide(1800000);
  assert.notEqual(visit.show(3600000), first);
});

test("one visit loads once; late hidden responses are cached but a changed owner discards them", async () => {
  let resolve,
    calls = 0;
  const h = harness("components/resume-card/index.js", {
    post: () => {
      calls++;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const p = h.instance,
    loading = p.load();
  h.definition.pageLifetimes.hide.call(p);
  resolve({ kind: "item", item });
  await loading;
  assert.equal(p.data.item, null);
  h.definition.pageLifetimes.show.call(p);
  assert.equal(p.data.item.id, item.id);
  assert.equal(calls, 1);
  h.switchUser("two");
  const next = p.load();
  h.switchUser("three");
  resolve({ kind: "item", item });
  await next;
  assert.equal(p.data.item, null);
});

test("answer only offers mine; explicit confirmation saves it and undo restores the prompt", async () => {
  const calls = [];
  const h = harness("components/resume-card/index.js", {
    post: async (url, body) => {
      calls.push([url, body]);
      if (url.endsWith("/act"))
        return {
          item: { ...item, state: "done" },
          offerMine: true,
          undoToken: "u",
          undoUntil: new Date(Date.now() + 5000).toISOString(),
        };
      if (url.endsWith("/mine"))
        return { card: { ...item.card, version: 3, mine: body.text } };
      if (url.endsWith("/undo")) return item;
      return { kind: "item", item };
    },
  });
  const p = h.instance;
  await p.load();
  await p.act("answer", "我会先把时间安排弄清楚再决定");
  assert.equal(calls.filter(([url]) => url.endsWith("/mine")).length, 0);
  assert.equal(p.data.receipt.offerMine, true);
  await p.undo();
  assert.equal(p.data.receipt, null);
  assert.equal(p.data.item.state, "shown");
  await p.act("answer", "我会先把时间安排弄清楚再决定");
  await p.saveMine();
  assert.equal(calls.filter(([url]) => url.endsWith("/mine")).length, 1);
  assert.equal(p.data.undoVisible, false);
});

test("an account change between mine and close cannot send a closing mutation", async () => {
  let closeCalls = 0,
    h;
  h = harness("components/resume-card/index.js", {
    post: async (url) => {
      if (url.endsWith("/mine")) {
        h.switchUser("two");
        return { card: { ...item.card, version: 3 } };
      }
      if (url.endsWith("/close")) closeCalls++;
      return { kind: "item", item };
    },
  });
  const p = h.instance;
  await p.load();
  p.setData({
    receipt: { offerClose: true },
    text: "我会先把时间安排弄清楚再决定",
  });
  await p.saveMine();
  assert.equal(closeCalls, 0);
});

test("failed answer keeps the draft; crisis navigates without showing a receipt", async () => {
  let crisis = false;
  const h = harness("components/resume-card/index.js", {
    post: async (url) => {
      if (url.endsWith("/act")) {
        if (crisis) return { crisis: true };
        throw new Error("请求失败");
      }
      return { kind: "item", item };
    },
  });
  const p = h.instance;
  await p.load();
  p.setData({ text: "还想再写一点" });
  await p.submit();
  assert.equal(p.data.text, "还想再写一点");
  assert.equal(p.data.receipt, null);
  crisis = true;
  await p.submit();
  assert.equal(p.data.item, null);
  assert.deepEqual(h.navigated, ["/pages/crisis/index"]);
});

test("settings retain at least one weekday and ignore a different owner's late update", async () => {
  let resolve;
  const settings = {
    mode: "open",
    at: "21:00",
    days: [1],
    types: { study: true, cards: true, mood: true },
    greet: true,
  };
  const h = harness(
    "pages/resume-settings/index.js",
    {
      get: async () => settings,
      put: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
    false,
  );
  const p = h.instance;
  await p.load();
  p.day({ currentTarget: { dataset: { id: 1 } } });
  assert.equal(resolve, undefined);
  const pending = p.save({ ...settings, mode: "off" });
  h.switchUser("two");
  resolve({ ...settings, mode: "off" });
  await pending;
  assert.equal(p.data.settings.mode, "open");
});

test("a receipt asks one thing at a time and its title follows the action", async () => {
  const calls = [];
  let reply = {};
  const h = harness("components/resume-card/index.js", {
    post: async (url, body) => {
      calls.push([url, body]);
      if (url.endsWith("/act"))
        return { item: { ...item, state: "done" }, ...reply };
      if (url.endsWith("/when")) return { card: { ...item.card, version: 3 } };
      if (url.endsWith("/feedback")) return { saved: true };
      return { kind: "item", item };
    },
  });
  const p = h.instance;
  await p.load();
  reply = { askWhen: true, offerClose: true, feedback: true };
  await p.act("answer", "定了");
  assert.equal(p.data.receipt.title, "记下了");
  assert.equal(p.data.receipt.ask, "when");
  assert.equal(p.data.receipt.feedback, false);
  await p.when({ currentTarget: { dataset: { when: "week" } } });
  assert.equal(p.data.receipt.ask, "");
  assert.equal(p.data.receipt.title, "好，这周做");
  await p.act("answer", "解决了");
  assert.equal(p.data.receipt.ask, "close");
  reply = { offerMine: true, feedback: true };
  await p.act("answer", "我会先把时间安排弄清楚再决定");
  assert.equal(p.data.receipt.ask, "mine");
  p.fold();
  assert.equal(calls.filter(([url]) => url.endsWith("/feedback")).length, 0);
  reply = { feedback: true };
  await p.act("answer", "有些想法");
  assert.equal(p.data.receipt.ask, "feedback");
  p.fold();
  assert.equal(calls.filter(([url]) => url.endsWith("/feedback")).length, 1);
  reply = {};
  for (const [action, text, title] of [
    ["skip", undefined, "好，先放着"],
    ["answer", "还在想", "好，先放着"],
    ["never", undefined, "好，不再提这件事"],
    ["remind", undefined, "到时提醒你"],
  ]) {
    await p.act(action, text);
    assert.equal(p.data.receipt.title, title);
    assert.equal(p.data.receipt.ask, "");
  }
});

test("the question keeps one line of the user's words, at most three options and folds never/remind behind the cross", async () => {
  const calls = [];
  const question = {
    id: "resume_two",
    state: "shown",
    src: "card",
    srcId: "card_secret_id",
    title: "",
    quote: "想报羽毛球班",
    options: ["做一题", "还在想", "写一句", "先放着"],
  };
  const h = harness("components/resume-card/index.js", {
    post: async (url, body) => {
      calls.push([url, body]);
      if (url.endsWith("/act")) return { item: { ...question, state: "done" } };
      return { kind: "item", item: question };
    },
  });
  const p = h.instance;
  await p.load();
  assert.equal(p.data.item.title, "这件事");
  assert.equal(p.data.item.said, "想报羽毛球班");
  assert.deepEqual(Array.from(p.data.item.choices), [
    "做一题",
    "还在想",
    "写一句",
  ]);
  p.applyResult({ kind: "item", item: { ...question, title: "想报羽毛球班" } });
  assert.equal(p.data.item.said, "");
  p.closeMenu();
  assert.deepEqual(Array.from(h.sheets[0].itemList), [
    "不再提起",
    "到时提醒我",
    "收起",
  ]);
  h.sheets[0].success({ tapIndex: 1 });
  assert.equal(p.data.remind, true);
  h.sheets[0].success({ tapIndex: 2 });
  assert.equal(p.data.collapsed, true);
  h.sheets[0].success({ tapIndex: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual({ ...calls.at(-1)[1] }, { action: "never" });
  const wxml = fs.readFileSync(
    path.join(root, "components/resume-card/index.wxml"),
    "utf8",
  );
  // v4: 小狸 face, “回顾 · N 天前的卡片”, the type word and 稍后.
  assert.match(wxml, /\{\{item.kicker\}\}/);
  assert.match(wxml, /binderror="faceError"/);
  assert.match(wxml, /bindtap="skip">稍后</);
  assert.doesNotMatch(wxml, /dateText|接着想|盖章|srcId/);
});

// V4.2 G3 (intentional): the client no longer swaps the server's question for
// 这件事完成了吗？. The server words the question by follow-up mode and says
// what each option does (acts); the client shows them as sent.
test("v4.2: the server's question and options show as sent; acts decide what each does", async () => {
  const calls = [];
  let reply = {};
  const card = {
    id: "resume_done",
    state: "shown",
    src: "card",
    kind: "todo",
    canClose: true,
    question: "「周末去图书馆过第三章」做了吗？",
    options: ["做了", "还没", "不用提醒"],
    acts: ["close", "later", "never"],
    card: { id: "c1", type: "idea", kind: "todo", title: "周末去图书馆过第三章", version: 3, createdAt: "2026-10-09T00:00:00Z" },
  };
  const h = harness("components/resume-card/index.js", {
    post: async (url, body) => {
      calls.push([url, body]);
      if (url.endsWith("/act")) return { item: { ...card, state: "done" }, ...reply };
      return { kind: "item", item: card };
    },
  });
  const p = h.instance;
  await p.load();
  assert.equal(p.data.item.question, "「周末去图书馆过第三章」做了吗？");
  assert.deepEqual(Array.from(p.data.item.choices), ["做了", "还没", "不用提醒"]);
  assert.equal(p.data.item.typeName, "待办");
  assert.equal(p.data.item.kicker, "问问进展 · 3 天前的卡片");
  // 还没 already means later, so no separate 稍后.
  assert.equal(p.data.item.later, false);
  await p.choose({ currentTarget: { dataset: { text: "做了" } } });
  assert.deepEqual({ ...calls.at(-1)[1] }, { action: "answer", text: "做了" });
  assert.equal(p.data.receipt.title, "完成了");
  p.setData({ receipt: null, item: { ...p.data.item, state: "shown" } });
  await p.choose({ currentTarget: { dataset: { text: "还没" } } });
  assert.deepEqual({ ...calls.at(-1)[1] }, { action: "answer", text: "还没" });
  // V4.2 FX1 (intentional): the receipt follows the act, here later.
  assert.equal(p.data.receipt.title, "好，过几天再问");
  // An old server (no acts): its own options, 写一句 opens the input.
  p.applyResult({ kind: "item", item: { ...card, kind: "mood", acts: undefined, canClose: false, question: "这件事后来怎么样了？", options: ["好一些了", "差不多", "写一句"] } });
  assert.equal(p.data.item.question, "这件事后来怎么样了？");
  assert.deepEqual(Array.from(p.data.item.choices), ["好一些了", "差不多", "写一句"]);
  p.choose({ currentTarget: { dataset: { text: "写一句" } } });
  assert.equal(p.data.writing, true);
});

test("unfinished rows read like plain words and hide never behind a small menu", async () => {
  const calls = [];
  const h = harness(
    "pages/resume-list/index.js",
    {
      get: async () => [
        {
          id: "a",
          state: "waiting",
          dueOn: "2000-01-01",
          srcId: "point_x",
          question: "想做一题试试吗？",
        },
        {
          id: "b",
          state: "snoozed",
          dueOn: "2999-12-31",
          title: "羽毛球班",
          kind: "todo",
          question: "约好的事做了吗？",
        },
        {
          id: "c",
          state: "dormant",
          dueOn: "2000-01-01",
          title: "旧想法",
          question: "还想往下想吗？",
        },
      ],
      post: async (url, body) => {
        calls.push([url, body]);
        return {};
      },
    },
    false,
  );
  const p = h.instance;
  p.onLoad({});
  await p.load();
  assert.deepEqual(
    p.data.items.map((i) => [i.title, i.meta]),
    [
      // V4.2 G3 (intentional): what comes back and when, not "再问你".
      ["这件事", "今天"],
      ["羽毛球班", "待办 · 12/31"],
      ["旧想法", "先不问了"],
    ],
  );
  p.rowMenu({ currentTarget: { dataset: { id: "b" } } });
  assert.deepEqual(Array.from(h.sheets[0].itemList), ["不再提起"]);
  h.sheets[0].success({ tapIndex: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0][0], "/v1/resume/b/act");
  assert.deepEqual({ ...calls[0][1] }, { action: "never" });
});

test("with nothing to ask back the slot shows a first nudge, else the last chat, else today's fold", async () => {
  let reply;
  const events = [];
  const h = harness("components/resume-card/index.js", { post: async () => reply });
  h.instance.triggerEvent = (name) => events.push(name);
  const show = async (value) => {
    reply = value;
    await h.instance.load(true);
    return h.instance.data.prompt;
  };
  const lastChat = { threadId: "t1", title: "极限的定义", quote: "左右极限要相等吗", at: "2026-10-12T00:00:00Z" };
  // A question to ask back always wins.
  assert.equal(await show({ kind: "item", item, first: true, lastChat }), null);
  assert.equal(h.instance.data.item.id, "resume_one");
  assert.deepEqual({ ...(await show({ kind: "none", item: null, first: true, lastChat })) }, { kind: "first" });
  h.instance.compose();
  assert.deepEqual(events.filter((name) => name !== "state"), ["compose"]);
  const prompt = await show({ kind: "none", item: null, first: false, lastChat });
  assert.equal(prompt.kind, "chat");
  assert.equal(prompt.title, "极限的定义");
  assert.equal(prompt.quote, "左右极限要相等吗");
  // One message only: the title already says it, so the quote is not repeated.
  const once = await show({
    kind: "none", item: null, first: false,
    lastChat: { threadId: "t1", title: "下周要交线代作业，还想准备英语四…", quote: "下周要交线代作业，还想准备英语四级，怎么排", at: "2026-10-12T00:00:00Z" },
  });
  assert.equal(once.quote, "");
  await show({ kind: "none", item: null, first: false, lastChat });
  h.instance.continueChat();
  h.instance.wrapChat();
  assert.deepEqual(JSON.parse(JSON.stringify(h.chats)), [
    { threadId: "t1" },
    { threadId: "t1", wrap: true },
  ]);
  // Older servers send neither field: today's fold stays.
  assert.equal(await show({ kind: "lookback", item: null, text: "这一步记在卡里了。" }), null);
  assert.equal(await show({ kind: "none", item: null, first: false, lastChat: null }), null);
  const wxml = fs.readFileSync(path.join(root, "components/resume-card/index.wxml"), "utf8");
  assert.match(wxml, /想到什么，记一句就好/);
  assert.match(wxml, /上次聊到「\{\{prompt.title\}\}」/);
  assert.match(wxml, /bindtap="continueChat">接着聊</);
  assert.match(wxml, /bindtap="wrapChat">整理成卡</);
  const notes = fs.readFileSync(path.join(root, "pages/notes/index.wxml"), "utf8");
  // the resume card is back on top of the box (10-notes), quiet (no first nudge or last chat there).
  assert.ok(notes.indexOf("<resume-card") < notes.indexOf('class="compose"'));
  assert.match(notes, /<resume-card[^>]* quiet /);
  // Nor 还没想完的 › or a lookback line: with nothing to ask it takes no room.
  assert.match(wxml, /wx:elif="\{\{!quiet && result && result\.text\}\}"/);
  assert.match(notes, /bind:compose="focusCompose"/);
});

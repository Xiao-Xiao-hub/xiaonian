// saving a card shows the AI's title and summary (handwriting behind
// 改一改) and can repeat its reminder 每天 / 每周; the card page sets or stops it.
const test = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const cards = require(path.join(root, "utils/cards.js"));
const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function collect(intent, overrides = {}) {
  let def;
  const calls = [],
    nav = [],
    toasts = [],
    app = { globalData: { collect: intent } };
  const api = {
    get: async (url) => {
      calls.push(["GET", url]);
      return { id: url.split("/").pop(), version: 3 };
    },
    post: async (url, body) => {
      calls.push(["POST", url, body]);
      return url.endsWith("/wrap") ? { savedCardIds: ["k1", "k2"] } : { card: { id: "n" } };
    },
    patch: async (url, body) => {
      calls.push(["PATCH", url, body]);
      return { card: {} };
    },
    needsConsent: () => false,
    ...overrides,
  };
  const sandbox = {
    require: (n) =>
      n.endsWith("/api")
        ? api
        : n.endsWith("/auth")
          ? { getUser: () => ({ id: "u" }), hasConsent: () => true }
          : n.endsWith("/gate")
            ? { check: () => true, ask() {} }
            : cards,
    Page: (x) => (def = x),
    getApp: () => app,
    wx: {
      navigateTo: (x) => nav.push(x.url),
      navigateBack: () => nav.push("back"),
      showToast: (x) => toasts.push(x.title),
    },
  };
  vm.runInNewContext(read("pages/collect/index.js"), sandbox);
  const p = {
    ...def,
    data: structuredClone(def.data),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  };
  p.onLoad();
  return { p, calls, nav, toasts };
}

const wrapIntent = {
  mode: "wrap",
  threadId: "t1",
  draft: {
    id: "d1",
    summary: "聊了极限",
    cards: [
      { key: "a", type: "question", title: "极限是什么", summary: "趋近但不等于", selected: true },
      { key: "b", type: "idea", title: "画图更好懂", summary: "先画再算", selected: true },
    ],
  },
};

test("collect shows the AI title and summary; the handwriting boxes wait behind 改一改", () => {
  const wxml = read("pages/collect/index.wxml");
  const wrap = wxml.slice(wxml.indexOf("wx:if=\"{{mode === 'wrap'}}\""), wxml.indexOf("wx:elif=\"{{mode === 'mine'}}\""));
  // Titles are text until 改一改; the input is the same one as before.
  assert.match(wrap, /<input\s+wx:if="\{\{editOpen\}\}"[^>]*bindinput="cardInput"/);
  assert.match(wrap, /<text wx:else class="candidate-name"/);
  assert.match(wrap, /class="candidate-sum"\s*>\{\{item\.summary\}\}/);
  assert.ok(wrap.indexOf('<block wx:if="{{editOpen}}">') < wrap.indexOf("补一句我的话"));
  assert.ok(wrap.indexOf('<block wx:if="{{editOpen}}">') < wrap.indexOf("如果…就…"));
  const message = wxml.slice(wxml.indexOf("<block wx:else"));
  assert.ok(message.indexOf('<block wx:if="{{editOpen}}"') < message.indexOf(">我的话<"));
  assert.ok(message.indexOf('<block wx:if="{{editOpen}}"') < message.indexOf(">标题<"));
  assert.match(wxml, /data-key="editOpen"[^>]*bindtap="toggle"\s*>改一改</);
  // The mine mode is unchanged: its box shows at once.
  const mine = wxml.slice(wxml.indexOf("wx:elif=\"{{mode === 'mine'}}\""), wxml.indexOf("<block wx:else"));
  assert.doesNotMatch(mine, /editOpen/);
  const h = collect(wrapIntent);
  assert.equal(h.p.data.editOpen, false);
  assert.equal(h.p.data.remindEvery, "");
  // V4.2 G3 (intentional): 按内容 is the default, 不提醒 really stops.
  assert.deepEqual(Array.from(h.p.data.reminds, (r) => r.name), ["按内容", "不提醒", "每天", "每周"]);
  h.p.toggle({ currentTarget: { dataset: { key: "editOpen" } } });
  assert.equal(h.p.data.editOpen, true);
});

test("a message card sends remindEvery only when picked", async () => {
  const intent = { mode: "message", threadId: "t1", messageId: "m1", quote: "我想想" };
  let h = collect(intent);
  await h.p.save();
  assert.equal(h.calls[0][1], "/v1/cards");
  assert.equal(h.calls[0][2].remindEvery, undefined);
  assert.deepEqual(h.toasts, ["存好了，在卡片里"]);
  h = collect({ ...intent });
  h.p.pickRemind({ currentTarget: { dataset: { value: "week" } } });
  await h.p.save();
  assert.equal(h.calls[0][2].remindEvery, "week");
});

// V4.2 G3 (intentional): the reminder goes with the wrap save itself, so
// it cannot fail alone after the cards were saved.
test("a wrap save sends the reminder with the cards; 不提醒 turns follow-ups off", async () => {
  let h = collect(structuredClone(wrapIntent));
  h.p.pickRemind({ currentTarget: { dataset: { value: "day" } } });
  await h.p.save();
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][1], "/v1/chat/threads/t1/wrap");
  assert.equal(h.calls[0][2].remindEvery, "day");
  assert.equal("follow" in h.calls[0][2], false);
  assert.equal(h.nav.at(-1), "back");
  h = collect(structuredClone(wrapIntent));
  h.p.pickRemind({ currentTarget: { dataset: { value: "none" } } });
  await h.p.save();
  assert.equal(h.calls[0][2].follow, "none");
  assert.equal("remindEvery" in h.calls[0][2], false);
  h = collect(structuredClone(wrapIntent));
  await h.p.save();
  assert.equal("follow" in h.calls[0][2] || "remindEvery" in h.calls[0][2], false);
  // A message card: 不提醒 goes as follow none.
  h = collect({ mode: "message", threadId: "t1", messageId: "m1", quote: "我想想" });
  h.p.pickRemind({ currentTarget: { dataset: { value: "none" } } });
  await h.p.save();
  assert.equal(h.calls[0][2].follow, "none");
});

test("a failed wrap save says so and stays; nothing is half saved", async () => {
  const h = collect(structuredClone(wrapIntent), {
    post: async () => {
      throw new Error("没存上，再点一次");
    },
  });
  h.p.pickRemind({ currentTarget: { dataset: { value: "week" } } });
  await h.p.save();
  await tick();
  assert.equal(h.p.data.error, "没存上，再点一次");
  assert.deepEqual(h.nav, []);
});

test("the card page sets 每天 / 每周; the same choice is a no-op; 关掉 sends null", async () => {
  let def;
  const sent = [],
    toasts = [];
  const api = { patch: async (url, body) => sent.push([url, body]) };
  vm.runInNewContext(read("pages/card/index.js"), {
    require: (n) =>
      n.endsWith("/api") ? api : n.endsWith("/study-clock") ? { track: (x) => x } : n.endsWith("/cards") ? cards : n.endsWith("/examples") ? { cards: [] } : {},
    Page: (x) => (def = x),
    getApp: () => ({ globalData: {} }),
    wx: { showToast: (x) => toasts.push(x.title) },
  });
  const tap = async (current, every) => {
    const self = {
      id: "c1",
      data: { detail: { remindEvery: current } },
      async mutate(work, options) {
        await work({ version: 4 });
        options.success();
      },
    };
    await def.saveEvery.call(self, { currentTarget: { dataset: { every } } });
  };
  await tap("", "day");
  await tap("day", "day");
  await tap("day", "week");
  await tap("week", "");
  assert.deepEqual(
    sent.map(([url, body]) => [url, body.version, body.remindEvery]),
    [
      ["/v1/cards/c1", 4, "day"],
      ["/v1/cards/c1", 4, "week"],
      ["/v1/cards/c1", 4, null],
    ],
  );
  assert.deepEqual(toasts, ["每天提醒你", "每周提醒你", "不提醒了"]);
  const wxml = read("pages/card/index.wxml");
  assert.match(wxml, /data-every="day" bindtap="saveEvery">每天</);
  assert.match(wxml, /data-every="week" bindtap="saveEvery">每周</);
  assert.match(wxml, /wx:if="\{\{detail\.remindEvery\}\}" data-every="" bindtap="saveEvery">关掉</);
});

test("card page: block icons, a quote mark before 原话 and drawn icons in the bottom bar", () => {
  const wxml = read("pages/card/index.wxml");
  for (const [block, icon] of [["ask", "bulb"], ["said", "edit"], ["tidy", "file"], ["more", "plus"]])
    assert.match(wxml, new RegExp(`class="dblk ${block}"><view class="bh"><view class="dk dk-${icon}"/>`));
  assert.match(wxml, /<view class="dk dk-quote"\/><text>原话：/);
  const bar = wxml.slice(wxml.indexOf('class="bottom-bar"'));
  assert.doesNotMatch(bar, /[★☆◎⋯]/);
  assert.match(bar, /dk-star' : 'dk-star-o'/);
  const wxss = read("pages/card/index.wxss");
  for (const icon of ["bulb", "edit", "file", "plus", "quote", "star", "star-o", "target", "more"])
    assert.match(wxss, new RegExp(`\\.dk-${icon} \\{ background-image: url\\("data:image/svg\\+xml;base64,`));
  assert.match(wxss, /\.dblk\.tidy \.r-display \{[^}]*background: #fff; color: #1e50c8;/);
});

test("a mood card moves in three steps and never shows as done", () => {
  const pct = (raw) => cards.view({ type: "idea", scene: "mood", ...raw }).pct;
  assert.equal(pct({}), 33);
  assert.equal(pct({ organizedAt: "2026-10-01" }), 67);
  assert.equal(pct({ mine: "好多了" }), 100);
  assert.equal(cards.view({ type: "idea", scene: "mood", mine: "好多了" }).done, false);
});

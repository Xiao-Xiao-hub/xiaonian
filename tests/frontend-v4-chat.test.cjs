// 聊一聊页面回归：颜色标记应被渲染，不能直接作为控制标记文字展示。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");
const file = (name) => path.join(root, name);
const stub = (name, exports) => {
  const p = file(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

function chatPage(state, calls) {
  let def;
  global.Page = (x) => (def = x);
  global.getApp = () => ({ globalData: {} });
  global.wx = { getStorageSync: () => null, pageScrollTo() {} };
  stub("utils/gate.js", { state: () => state, check: () => true, ask: () => calls.push("ask") });
  stub("utils/auth.js", { hasConsent: () => state === "ok", getUser: () => null });
  stub("utils/api.js", {
    get: (url) => {
      calls.push(url);
      return Promise.resolve({
        thread: { id: "t1", scene: "study", mode: "guide", currentCards: [] },
        messages: [{ id: "m1", role: "assistant", status: "done", content: "先看[[k!:分母的阶数]]，再[[w:展开到同阶]]" }],
      });
    },
    post: () => Promise.resolve({ cards: [] }),
    needsConsent: () => false,
  });
  delete require.cache[file("pages/chat/index.js")];
  require(file("pages/chat/index.js"));
  def.data = structuredClone(def.data);
  def.setData = (patch) => Object.assign(def.data, patch);
  return def;
}

test("a reply without server blocks draws its marks instead of showing [[k:…]]", async () => {
  const calls = [];
  const p = chatPage("ok", calls);
  p.onLoad({});
  await p.open("t1");
  const blocks = p.data.messages[0].blocks;
  assert.ok(!JSON.stringify(blocks).includes("[["));
  const runs = blocks[0].c;
  assert.equal(runs.map((x) => x.v).join(""), "先看分母的阶数，再展开到同阶");
  assert.ok(runs.some((x) => x.mk === "key" && x.hi));
  assert.ok(runs.some((x) => x.mk === "way"));
  p.onUnload();
});

test("a guest on 聊一聊 sends nothing and 去同意 asks to agree", () => {
  const calls = [];
  const p = chatPage("guest", calls);
  p.onLoad({});
  p.onShow();
  assert.equal(p.data.consent, false);
  assert.deepEqual(calls, []);
  p.agree();
  assert.deepEqual(calls, ["ask"]);
  const wxml = fs.readFileSync(file("pages/chat/index.wxml"), "utf8");
  assert.match(wxml, /隐私政策/);
  assert.doesNotMatch(wxml, /隐私说明|goHome|\{\{skin\}\}/);
  p.onUnload();
});

test("copying from a held bubble: AI replies get （AI 生成）, my words do not", () => {
  let def;
  const copied = [];
  global.Component = (x) => (def = x);
  global.wx = {
    setClipboardData: ({ data, success }) => {
      copied.push(data);
      if (success) success();
    },
    showActionSheet: ({ itemList, success }) => success({ tapIndex: itemList.indexOf("复制") }),
  };
  stub("utils/chat-v2.js", { holdItems: () => ["复制"], layout: () => ({}), collectTarget: () => "" });
  delete require.cache[file("components/chat-panel/index.js")];
  require(file("components/chat-panel/index.js"));
  const panel = {
    ...def.methods,
    data: {
      thread: { id: "t1" },
      messages: [
        { id: "a", role: "assistant", status: "done", blocks: [], content: "先[[k:约分]]" },
        { id: "u", role: "user", status: "done", blocks: [], content: "我想问约分" },
      ],
    },
    triggerEvent() {},
  };
  panel.hold({ currentTarget: { dataset: { id: "a" } } });
  panel.hold({ currentTarget: { dataset: { id: "u" } } });
  assert.deepEqual(copied, ["先约分（AI 生成）", "我想问约分"]);
});

test("a card carried into the chat opens on tap; × still takes it out (20-chat)", () => {
  let def;
  const nav = [];
  global.Component = (x) => (def = x);
  global.wx = { navigateTo: ({ url }) => nav.push(url) };
  stub("utils/chat-v2.js", { holdItems: () => [], layout: () => ({}), collectTarget: () => "" });
  delete require.cache[file("components/chat-panel/index.js")];
  require(file("components/chat-panel/index.js"));
  def.methods.openCard({ currentTarget: { dataset: { id: "c 1" } } });
  assert.deepEqual(nav, ["/pages/card/index?id=c%201"]);
  const wxml = fs.readFileSync(file("components/chat-panel/index.wxml"), "utf8");
  assert.match(wxml, /class="card-title" data-id="\{\{item\.id\}\}" bindtap="openCard"/);
  assert.match(wxml, /class="card-go" data-id="\{\{item\.id\}\}" bindtap="openCard">›</);
  assert.match(wxml, /class="card-x"\s+data-event="removecard"/);
});

test("my blue bubble swaps every fill that white text would vanish on", () => {
  const css = fs.readFileSync(file("components/chat-panel/index.wxss"), "utf8");
  const mine = css.match(/\.bubble\.mine \{([^}]*)\}/)[1];
  const vars = Object.fromEntries([...mine.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  assert.equal(vars["--ink"], "#ffffff");
  // Fills used behind text in <rich> (code, table heads, hover) and in the marks.
  for (const name of ["--chip", "--marker-wash", "--mk-key", "--mk-key-hi", "--mk-way", "--mk-way-hi"]) {
    assert.match(vars[name] || "", /^rgba\(.+, 0\.\d+\)$/, name);
  }
  assert.ok(vars["--mk-warn"], "--mk-warn");
  // 20-chat: as wide as the words, mine on the right up to 78%.
  const bubble = css.match(/\.bubble \{([^}]*)\}/)[1];
  assert.match(bubble, /width: fit-content;/);
  assert.match(bubble, /max-width: 88%;/);
  assert.match(mine, /max-width: 78%;/);
  assert.match(mine, /margin-left: auto;/);
  const rich = fs.readFileSync(file("components/rich/index.wxss"), "utf8");
  assert.match(rich, /\.r-code \{[^}]*var\(--chip\)/);
  assert.match(rich, /\.r-hover \{[^}]*var\(--marker-wash\)/);
  const app = fs.readFileSync(file("app.wxss"), "utf8");
  for (const [rule, name] of [[".mk.key", "--mk-key"], [".mk.key.hi", "--mk-key-hi"], [".mk.way", "--mk-way"], [".mk.way.hi", "--mk-way-hi"], [".mk.warn", "--mk-warn"]]) {
    const body = app.match(new RegExp(`^${rule.replace(/\./g, "\\.")} \\{([^}]*)\\}`, "m"))[1];
    assert.ok(body.includes(`var(${name},`), rule);
  }
});

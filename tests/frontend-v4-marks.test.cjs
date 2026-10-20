"use strict";
// 验证客户端颜色标记及各页面依赖的公共组件。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");
const mod = (file) => require(path.join(root, file));

test("plain text of blocks drops the marks but keeps the words and formulas", () => {
  const { plain, plainAll, unmark } = mod("utils/blocks.js");
  const p = {
    t: "p",
    c: [
      { t: "text", v: "先看" },
      { t: "text", v: "分母", mk: "key", hi: 1 },
      { t: "math", tex: "x^2", mk: "fx" },
      { t: "text", v: "，旧稿里的[[w:换元]]也去掉" },
    ],
  };
  assert.equal(plain(p), "先看分母$x^2$，旧稿里的换元也去掉");
  assert.equal(plainAll([p, { t: "list", items: [{ n: "1.", c: [{ t: "text", v: "[[x!:别漏]] C" }] }] }]), "先看分母$x^2$，旧稿里的换元也去掉\n\n1. 别漏 C");
  assert.equal(unmark("[[k:a]][[f!:$b$]]c"), "a$b$c");
});

test("the streaming tail hides mark syntax, half-typed openers and the closing bracket", () => {
  const { stripTail } = mod("utils/blocks.js");
  const cases = [
    ["普通文字", "普通文字"],
    ["先看[[k:分母]]再说", "先看分母再说"],
    ["先看[[k!:分", "先看分"],
    ["先看[[k:分母]", "先看分母"],
    ["先看[[k:分母]]，然后[", "先看分母，然后"],
    ["先看[[", "先看"],
    ["先看[[k", "先看"],
    ["先看[[x!", "先看"],
    ["数组 a[1]", "数组 a[1]"],
    ["", ""],
  ];
  for (const [tail, shown] of cases) assert.equal(stripTail(tail), shown, tail);
});

test("a short field with marks becomes one paragraph for the rich component", () => {
  const { markBlocks } = mod("utils/blocks.js");
  assert.deepEqual(markBlocks("先[[k!:约分]]再[[w:求导]]，别[[x:漏项]]"), [
    {
      t: "p",
      c: [
        { t: "text", v: "先" },
        { t: "text", v: "约分", mk: "key", hi: 1 },
        { t: "text", v: "再" },
        { t: "text", v: "求导", mk: "way" },
        { t: "text", v: "，别" },
        { t: "text", v: "漏项", mk: "warn" },
      ],
    },
  ]);
  assert.deepEqual(markBlocks("没有标记"), [{ t: "p", c: [{ t: "text", v: "没有标记" }] }]);
  assert.deepEqual(markBlocks("[[z:不认识]]和[[k:没收尾"), [{ t: "p", c: [{ t: "text", v: "不认识和没收尾" }] }]);
  assert.deepEqual(markBlocks(""), []);
});

test("a formula glued to its punctuation keeps both marks", () => {
  const { glueBlocks } = mod("utils/blocks.js");
  const [p] = glueBlocks([
    { t: "p", c: [{ t: "math", tex: "x", id: "a", mk: "fx", hi: 1 }, { t: "text", v: "，后面", mk: "key" }] },
  ]);
  assert.equal(p.c[0].t, "glue");
  assert.equal(p.c[0].m.mk, "fx");
  assert.equal(p.c[0].mk, "key");
  assert.deepEqual(p.c[1], { t: "text", v: "后面", mk: "key" });
});

test("the rich component draws mark classes and a tapped mark names its kind", () => {
  const wxml = fs.readFileSync(path.join(root, "components/rich/index.wxml"), "utf8");
  assert.match(wxml, /item\.mk \? ' mk ' \+ item\.mk : ''\}\}\{\{item\.hi \? ' hi' : ''\}\}/);
  assert.match(wxml, /\{\{tailText\}\}/);
  const wxss = fs.readFileSync(path.join(root, "app.wxss"), "utf8");
  for (const cls of ["key", "way", "fx", "warn"]) {
    assert.match(wxss, new RegExp(`\\.mk\\.${cls} \\{`));
    assert.match(wxss, new RegExp(`\\.mk\\.${cls}\\.hi \\{`));
    assert.match(wxss, new RegExp(`\\.night \\.mk\\.${cls} \\{`));
  }
  let def;
  const toasts = [];
  global.Component = (d) => (def = d);
  global.wx = { getStorageSync: () => "", showToast: (o) => toasts.push(o.title), getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }) };
  delete require.cache[path.join(root, "components/rich/index.js")];
  mod("components/rich/index.js");
  const self = { data: { tappable: false } };
  def.methods.onMark.call(self, { currentTarget: { dataset: { mk: "warn" } } });
  def.methods.onMark.call(self, { currentTarget: { dataset: {} } });
  def.methods.onMark.call({ data: { tappable: true } }, { currentTarget: { dataset: { mk: "key" } } });
  assert.deepEqual(toasts, ["易错"]);
});

test("v4 shared styles: tokens, no notebook skin, no pink or blue-purple gradient", () => {
  const wxss = fs.readFileSync(path.join(root, "app.wxss"), "utf8");
  assert.match(wxss, /--primary: #2f6bf6;/);
  assert.doesNotMatch(wxss, /\.notebook/);
  assert.doesNotMatch(wxss, /#7154f2|#ff6fa8|#ff8fb1|#e8467c 0%/i);
  for (const cls of [".btn ", ".btn-line ", ".btn-soft ", ".btn-text ", ".chip ", ".seg ", ".utabs ", ".tag ", ".ai-line ", ".pop ", ".scrim ", ".pc ", ".prg ", ".dblk.ask ", ".dblk.said ", ".dblk.tidy ", ".dblk.more ", ".ptitle "])
    assert.ok(wxss.includes(`${cls}{`) || wxss.includes(`${cls.trim()},`), cls);
});

test("asset() points at the public image route", () => {
  global.wx = { getStorageSync: () => "", getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }) };
  const { asset } = mod("utils/assets.js");
  assert.match(asset("xiaoli-hi.webp"), /^https?:\/\/[^/]+(?:\/[^/]+)*\/v1\/assets\/xiaoli-hi\.webp$/);
  assert.doesNotMatch(asset("ic-memo.webp"), /\/\/v1/);
  const hi = fs.statSync(path.join(root, "assets/xiaoli/hi.webp")).size;
  assert.ok(hi <= 35 * 1024, `hi.webp is ${hi} bytes`);
});

test("page-head lays out under the capsule and falls back without it", () => {
  let def;
  global.Component = (d) => (def = d);
  global.wx = {
    getWindowInfo: () => ({ windowWidth: 390, statusBarHeight: 47 }),
    getMenuButtonBoundingClientRect: () => ({ top: 51, height: 32, left: 296 }),
  };
  delete require.cache[path.join(root, "components/page-head/index.js")];
  mod("components/page-head/index.js");
  assert.ok(def.options.addGlobalClass);
  assert.deepEqual(Object.keys(def.properties), ["title", "tint"]);
  const set = (into) => ({ setData: (d) => Object.assign(into, d) });
  const a = {};
  def.lifetimes.attached.call(set(a));
  assert.deepEqual([a.statusTop, a.rowHeight, a.rightGap], [47, 40, 106]);
  global.wx = { getWindowInfo: () => ({ windowWidth: 375, statusBarHeight: 20 }) };
  const b = {};
  def.lifetimes.attached.call(set(b));
  assert.deepEqual([b.statusTop, b.rowHeight, b.rightGap], [20, 44, 104]);
  global.wx = {
    getWindowInfo: () => {
      throw new Error("old base library");
    },
  };
  const c = {};
  def.lifetimes.attached.call(set(c));
  assert.equal(c.statusTop, 20);
  const wxml = fs.readFileSync(path.join(root, "components/page-head/index.wxml"), "utf8");
  assert.match(wxml, /<slot \/>/);
  assert.match(wxml, /class="ptitle"/);
});

test("marks follow the server rules: brackets inside, only their own ]] goes", () => {
  const { markBlocks, stripTail, unmark } = mod("utils/blocks.js");
  assert.deepEqual(markBlocks("[[k:在 [a,b] 上]] 和 [[w:换元]]"), [
    {
      t: "p",
      c: [
        { t: "text", v: "在 [a,b] 上", mk: "key" },
        { t: "text", v: " 和 " },
        { t: "text", v: "换元", mk: "way" },
      ],
    },
  ]);
  assert.deepEqual(markBlocks("[[x!:端点 [x_0,x]]] 要算"), [
    { t: "p", c: [{ t: "text", v: "端点 [x_0,x]", mk: "warn", hi: 1 }, { t: "text", v: " 要算" }] },
  ]);
  assert.equal(unmark("在 [[k:闭区间 [a,b] 上连续]] 才行"), "在 闭区间 [a,b] 上连续 才行");
  assert.equal(stripTail("矩阵 [[1,2],[3,4]] 和 [[k:x]]"), "矩阵 [[1,2],[3,4]] 和 x");
  assert.equal(stripTail("矩阵 [[1,2],[3,4]] 和 [[k:正在"), "矩阵 [[1,2],[3,4]] 和 正在");
  assert.equal(stripTail("在 [[k:区间 [a,b"), "在 区间 [a,b");
  // A cut-off attempt does not take a later line's "]]".
  assert.equal(unmark("[[k:abc\n后面 arr[[1]]"), "abc\n后面 arr[[1]]");
});

test("static fields keep a final [; spaced and escaped openers", () => {
  const { markBlocks, stripTail } = mod("utils/blocks.js");
  assert.deepEqual(markBlocks("x ["), [{ t: "p", c: [{ t: "text", v: "x [" }] }]);
  assert.deepEqual(markBlocks("数组 a[1]"), [{ t: "p", c: [{ t: "text", v: "数组 a[1]" }] }]);
  assert.equal(stripTail("x ["), "x ");
  assert.deepEqual(markBlocks("[[k :空格]]和[[ w:也是]]"), [{ t: "p", c: [{ t: "text", v: "空格和也是" }] }]);
  assert.deepEqual(markBlocks("\\[[k:x]]"), [{ t: "p", c: [{ t: "text", v: "x", mk: "key" }] }]);
  assert.equal(stripTail("先 \\[[k:x]] 再 [[k :y"), "先 x 再 y");
});

test("only marked text nodes listen for taps", () => {
  const wxml = fs.readFileSync(path.join(root, "components/rich/index.wxml"), "utf8");
  const texts = wxml.match(/<text wx:(?:if|elif)="\{\{item\.t === 'text'[^>]*>/g);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /item\.t === 'text' && item\.mk/);
  assert.match(texts[0], /bindtap="onMark"/);
  assert.doesNotMatch(texts[1], /bindtap/);
});

test("border tokens are visible, notebook-only ones stay clear", () => {
  const wxss = fs.readFileSync(path.join(root, "app.wxss"), "utf8");
  assert.match(wxss, /\n {2}--line: #edeef1;/);
  assert.match(wxss, /\n {2}--line-strong: #dfe1e6;/);
  assert.match(wxss, /\n {2}--head-rule: #edeef1;/);
  assert.match(wxss, /\n {2}--ruling: transparent;/);
});

test("a stored notebook skin reads as the default", () => {
  global.wx = { getStorageSync: (key) => (key === "skin" || key === "zhiye_skin" ? "notebook" : "") };
  delete require.cache[path.join(root, "utils/theme.js")];
  const { current, SKINS } = mod("utils/theme.js");
  assert.equal(current().id, SKINS[0].id);
});

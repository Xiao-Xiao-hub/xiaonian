"use strict";
// 通用界面约定回归：知识点文案使用“核心点”，自定义控件具有可访问名称。
// 共用灰度和点击区域由 app.wxss 定义，测试核对各页面是否遵守这些约定。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

// WCAG relative luminance contrast of two #rrggbb colours.
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) =>
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test("learner pages say 核心点, never 主线", () => {
  const files = [
    "pages/map/index.wxml",
    "pages/map/index.js",
    "pages/map/layout.js",
    "pages/map/landscape/index.wxml",
    "pages/knowledge/index.wxml",
    "pages/knowledge/index.js",
    "pages/learn/index.wxml",
    "pages/learn/index.js",
    "pages/chapter/index.wxml",
    "pages/help/index.wxml",
    "pages/help/index.js",
  ];
  for (const rel of files) assert.doesNotMatch(read(rel), /主线/, rel);
  const map = read("pages/map/index.wxml");
  assert.match(map, /核心点做对 <text class="b">/);
  assert.match(map, /book-count">核心点做对/);
  // Every legend row in the sheet has its swatch class.
  const grid = map.match(/<view class="legend-grid">([\s\S]*?)<\/view>/)[1];
  const rows = grid.match(/<text[^>]*>/g);
  assert.ok(rows.length >= 14);
  for (const row of rows) assert.match(row, /class="lg /, row);
  assert.match(grid, /class="lg main">亮蓝线：核心点</);
  assert.match(read("pages/map/index.wxss"), /\.lg\.main::before/);
});

test("learn: 今天 says it is done once, in the header", () => {
  const wxml = read("pages/learn/index.wxml");
  assert.doesNotMatch(wxml, /今天的都做完了/);
  assert.match(read("pages/learn/index.js"), /"今天的做完了"/);
});

test("profile: 近 18 周 names the grid, not 累计学习", () => {
  const wxml = read("pages/profile/index.wxml");
  const head = wxml.match(/<view class="st-hd">[\s\S]*?<\/view>/)[0];
  assert.doesNotMatch(head, /近 18 周/);
  const heat = wxml.indexOf('<view class="heat">');
  const label = wxml.indexOf("近 18 周");
  assert.ok(heat > 0 && label > heat && label < wxml.indexOf('<view class="mo">'));
});

test("custom controls carry an accessible name", () => {
  const named = [
    ["pages/talk/index.wxml", ['aria-label="添加图片或文件"', 'aria-label="发送"', 'aria-label="更多"', 'aria-label="全部对话"']],
    ["pages/chat/index.wxml", ['aria-label="添加图片或文件"', 'aria-label="发送"', 'aria-label="更多"']],
    ["components/chat-attach/index.wxml", ['aria-label="移除附件"']],
    ["pages/notes/index.wxml", ['aria-label="关闭"', 'aria-label="拍照"']],
    ["components/resume-card/index.wxml", ['aria-label="关闭"']],
    ["pages/deck/index.wxml", ['aria-label="筛选"', 'aria-label="更多"', 'aria-label="清除筛选"']],
    ["pages/import/split/index.wxml", ['aria-label="关闭"', 'aria-label="选这张"']],
    ["pages/import/source/index.wxml", ['aria-label="关闭"', 'aria-label="移除文件"']],
    ["pages/brainstorm/process/index.wxml", ['aria-label="删掉这条"', 'aria-label="存成卡"']],
    ["pages/brainstorm/conclude/index.wxml", ['aria-label="删掉这条"']],
  ];
  for (const [rel, labels] of named) {
    const wxml = read(rel);
    for (const label of labels) assert.ok(wxml.includes(label), `${rel} ${label}`);
  }
  // Plus and send: every one of them is named, guest or not.
  for (const rel of ["pages/talk/index.wxml", "pages/chat/index.wxml"]) {
    const tags = read(rel).match(/<view[^>]*class="(plus|send)[ "][^>]*>/g);
    assert.ok(tags.length >= 2, rel);
    for (const tag of tags) assert.match(tag, /aria-label=/, tag);
    for (const tag of tags) assert.match(tag, /aria-role="button"/, tag);
  }
});

test("shared greys read and tap areas reach 44px", () => {
  const css = read("app.wxss");
  // The last --faint wins (tokens are appended).
  const faint = [...css.matchAll(/--faint:\s*(#[0-9a-f]{6})/gi)].pop()[1];
  assert.ok(contrast(faint, "#ffffff") >= 4.5, faint);
  assert.ok(contrast(faint, "#f5f6f8") >= 4.5, faint);
  assert.match(css, /--hit:\s*88rpx/);
  assert.match(css, /\.ai-line \{ color: var\(--faint\); \}/);
  assert.match(css, /\.tap-area::before[^{]*\{[^}]*min-height: var\(--hit\)/);
  // --ghost is left to decoration (chevrons), not text.
  assert.match(read("pages/card/index.wxss"), /\.steps-row \{ color: var\(--faint\); \}/);
  assert.match(read("components/numpad/index.wxss"), /\.np-ph \{ color: var\(--faint\); \}/);
  // The sticky note's greys on its yellow.
  assert.ok(contrast("#7d6a2e", "#fff7d6") >= 4.5);
  assert.match(read("components/resume-card/index.wxss"), /\.x, \.later \{ color: #7d6a2e; \}/);
});

test("done cards stay readable; deletes stand apart", () => {
  const deck = read("pages/deck/index.wxss");
  assert.match(deck, /\.bs-card\.done \{ opacity: 1; \}/);
  assert.match(deck, /\.selbar \.tb\.red \{ margin-left: var\(--gap-danger\); \}/);
  const source = read("pages/import/source/index.wxml");
  assert.match(source, /class="btn-text drop"[^>]*bindtap="dropSegment">删掉</);
  assert.match(read("pages/import/source/index.wxss"), /\.sheet-actions \.drop \{ color: var\(--red-ink\);/);
  // The type and scene choices in the edit sheet sit side by side.
  assert.match(read("pages/import/split/index.wxss"), /\.choice \{[^}]*width: auto !important/);
});

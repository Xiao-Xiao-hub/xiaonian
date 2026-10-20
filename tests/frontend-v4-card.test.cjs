// 卡片详情页面回归：核对内容分块、颜色标记及查看和编辑交互。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function load(state, detail, hits = []) {
  let page;
  global.Page = (value) => (page = value);
  global.getApp = () => ({ globalData: {} });
  global.wx = {
    getStorageSync: () => null,
    showToast() {},
    showModal() {},
    navigateTo() {},
    switchTab() {},
  };
  const file = path.join(root, "pages/card/index.js");
  const stub = (name, exports) => {
    const p = path.join(root, name);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };
  stub("utils/gate.js", { state: () => state, check: () => state !== "none", ask: () => hits.push("ask") });
  stub("utils/api.js", {
    get: (url) => {
      hits.push(url);
      return Promise.resolve(url === "/v1/tags" ? [] : url === "/v1/learn/map" ? { chapters: [] } : detail);
    },
    pending: () => false,
    needsConsent: () => false,
  });
  delete require.cache[file];
  require(file);
  page.data = structuredClone(page.data);
  page.setData = (patch) => Object.assign(page.data, patch);
  return page;
}

const card = {
  id: "c",
  type: "question",
  scene: "study",
  title: "泰勒展开到几阶才够",
  quote: "泰勒展开到底要展开到几阶？",
  mine: "分母几阶，分子就展开到几阶",
  stage: "clear",
  summary: "展到和分母同阶",
  slots: [
    { key: "ask", text: "求极限时展开到和分母同阶", by: "ai" },
    { key: "pitfall", text: "分子两项相减会抵消", by: "ai" },
  ],
  slotsMarked: [
    { key: "ask", text: "求极限时展开到[[k!:和分母同阶]]", by: "ai" },
    { key: "pitfall", text: "[[x:分子两项相减会抵消]]", by: "ai" },
  ],
  tags: [],
  versions: [],
  links: [],
  supplements: [],
  version: 3,
};

test("整理 draws the marked slots; the editor keeps plain text", async () => {
  const p = load("ok", card);
  p.onLoad({ id: "c" });
  p.onShow();
  await flush();
  await flush();
  const rows = p.data.detail.tidyRows;
  assert.equal(rows.length, 2);
  const runs = rows[0].blocks[0].c;
  assert.equal(runs.map((x) => x.v).join(""), "求极限时展开到和分母同阶");
  assert.ok(runs.some((x) => x.mk === "key" && x.hi));
  assert.ok(!JSON.stringify(rows).includes("[["));
  assert.equal(rows[1].blocks[0].c[0].mk, "warn");
  // The editor shows the plain slots.
  assert.equal(p.data.editor.slots[0].text, "求极限时展开到和分母同阶");
  // Progress (V4.2 G3, intentional): no percentage, the next step and the
  // four step words.
  assert.equal(p.data.detail.progress.pct, undefined);
  assert.equal(p.data.detail.progress.next, "下一步：确认已经解决");
  assert.deepEqual(
    p.data.detail.progress.steps.map((s) => [s.name, s.on]),
    [["记下", true], ["整理", true], ["说清", true], ["解决", false]],
  );
});

test("a guest opening a real card sends nothing and is offered the welcome page", () => {
  const hits = [];
  const p = load("guest", card, hits);
  p.onLoad({ id: "c" });
  p.onShow();
  assert.equal(p.data.guestBlocked, true);
  assert.deepEqual(hits, []);
  p.agree();
  assert.deepEqual(hits, ["ask"]);
});

test("the card page uses the v4 words", () => {
  const wxml = fs.readFileSync(path.join(root, "pages/card/index.wxml"), "utf8");
  for (const word of ["提问", "我的话", "整理", "补充", "详情", "关联卡片", "提醒", "来源", "讲一遍", "接着聊", "回答", "下一个", "编辑", "添加", "原话："])
    assert.ok(wxml.includes(word), word);
  for (const old of ["它想问你", "你说的", "帮你理了一下", "更多信息", "讲给 AI 听", "连着的卡", "下次提醒", "{{skin}}", "card-tile"])
    assert.ok(!wxml.includes(old), old);
  assert.match(wxml, /class="dblk ask"/);
  assert.match(wxml, /class="dblk said"/);
  assert.match(wxml, /class="dblk tidy"/);
  assert.match(wxml, /class="dblk more"/);
  assert.match(wxml, /<rich blocks="\{\{item.blocks\}\}"\/>/);
  const json = JSON.parse(fs.readFileSync(path.join(root, "pages/card/index.json"), "utf8"));
  assert.equal(json.usingComponents.rich, "/components/rich/index");
});

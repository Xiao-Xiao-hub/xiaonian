// v4 secondary pages of 随心记 / 卡片: no old notebook skin, every one checks
// the login gate first, and a guest is offered the welcome page instead of
// sending requests.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const pages = [
  "note", "collect", "tags", "card-pick", "resume-settings", "resume-list",
  "import/source", "import/split",
  "brainstorm/pick", "brainstorm/conclude", "brainstorm/process", "brainstorm/result",
  "card", "chat",
];

test("secondary pages drop the notebook skin and check the gate first on show", () => {
  for (const page of pages) {
    const js = read(`pages/${page}/index.js`);
    assert.doesNotMatch(js, /themed|utils\/theme/, page);
    assert.doesNotMatch(read(`pages/${page}/index.wxml`), /\{\{skin\}\}/, page);
    const css = path.join(root, `pages/${page}/index.wxss`);
    if (fs.existsSync(css)) assert.doesNotMatch(fs.readFileSync(css, "utf8"), /\.notebook/, page);
    // V4.2 : the chat page's code is utils/chat-room.js, shared with the tab.
    const code = page === "chat" ? read("utils/chat-room.js") : js;
    assert.match(code, /onShow\(\)\s*\{\s*if\s*\(!gate\.check\(\)\)\s*return;/, page);
  }
});

test("a guest opening tags sends nothing and is asked to agree", () => {
  let def;
  const calls = [];
  global.Page = (x) => (def = x);
  global.getApp = () => ({ globalData: {} });
  global.getCurrentPages = () => [];
  global.wx = { getStorageSync: () => null, setStorageSync() {}, showToast() {} };
  const stub = (name, exports) => {
    const p = path.join(root, name);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };
  stub("utils/gate.js", { state: () => "guest", check: () => true, ask: () => calls.push("ask") });
  const api = new Proxy({}, { get: (_, key) => (key === "needsConsent" ? () => false : (...a) => (calls.push([key, ...a]), Promise.resolve({}))) });
  stub("utils/api.js", api);
  const file = path.join(root, "pages/tags/index.js");
  delete require.cache[file];
  require(file);
  def.data = structuredClone(def.data);
  def.setData = (patch) => Object.assign(def.data, patch);
  if (def.onLoad) def.onLoad({});
  def.onShow();
  assert.deepEqual(calls, ["ask"]);
});

test("collect sends a guest to agree instead of back to 随心记, and says 隐私政策", () => {
  const js = read("pages/collect/index.js");
  assert.match(js, /goConsent\(\) \{\s*gate\.ask\(\);/);
  for (const text of [js, read("pages/collect/index.wxml")]) {
    assert.doesNotMatch(text, /隐私说明|回随心记再点/);
  }
});

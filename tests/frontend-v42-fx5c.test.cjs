"use strict";
// progress only moves on real stages, one tidy rule for the
// wall and the card page, a fixed page head, today's card face in
// onboarding (V8), the mood mark, 拆开 only when it can work, and the labels
// of the look-back reminder. Synthetic data.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const tick = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
function fresh(file) {
  delete require.cache[path.join(root, file)];
  return require(path.join(root, file));
}
global.wx = { getStorageSync: () => "", setStorageSync() {}, removeStorageSync() {} };

// ---- F15: progress --------------------------------------------------------

const STEPS = [
  { key: "cards", label: "看这几张卡" },
  { key: "think", label: "找联系、分组" },
  { key: "tidy", label: "整理结果" },
];
const states = (view) => view.rows.map((row) => row.state);

test("F15: a queued job shows 排队中 with no step done and an empty bar, however long it waits", () => {
  const { progressView } = fresh("utils/job.js");
  const queued = { id: "j", status: "queued", progress: {} };
  for (const ms of [0, 30_000, 180_000, 3_600_000]) {
    const view = progressView(STEPS, queued, { elapsedMs: ms, sinceMs: ms, expectMs: 120_000 });
    assert.equal(view.queued, true);
    assert.deepEqual(states(view), ["todo", "todo", "todo"], `${ms}`);
    assert.equal(view.percent, 0);
  }
});

test("F15: steps are done only on a real stage; time creeps inside the stage and stops short of its end", () => {
  const { progressView } = fresh("utils/job.js");
  // Running without a stage: the first step, never past its end.
  const bare = progressView(STEPS, { id: "j", status: "running" }, { elapsedMs: 3_600_000, sinceMs: 3_600_000, expectMs: 120_000, lastIndex: -1 });
  assert.deepEqual(states(bare), ["now", "todo", "todo"]);
  assert.ok(bare.percent > 0 && bare.percent < 100 / 3, String(bare.percent));
  assert.equal(bare.queued, false);
  // A real stage: the earlier step is done.
  const think = progressView(STEPS, { id: "j", status: "running", progress: { stage: "think", chars: 0, expect: 900 } }, { floor: bare.percent });
  assert.deepEqual(states(think), ["done", "now", "todo"]);
  // The stage is lost (a server restart): it stays, creeping only to its end.
  const lost = progressView(STEPS, { id: "j", status: "running" }, { elapsedMs: 3_600_000, sinceMs: 3_600_000, expectMs: 120_000, lastIndex: think.index, floor: think.percent });
  assert.deepEqual(states(lost), ["done", "now", "todo"]);
  assert.ok(lost.percent < 200 / 3, String(lost.percent));
  // A failure right out of the queue keeps no step done.
  const failed = progressView(STEPS, { id: "j", status: "failed", error: { message: "这次没跑完，可以再试一次" } }, { lastIndex: -1 });
  assert.equal(failed.failed, true);
  assert.deepEqual(states(failed), ["stop", "todo", "todo"]);
  // Waits with no job at all (the vague ones, request still out) tick no
  // step, however long.
  const vague = progressView(STEPS, null, { elapsedMs: 3_600_000, expectMs: 40_000 });
  assert.equal(vague.queued, false);
  assert.deepEqual(states(vague), ["now", "todo", "todo"]);
});

test("F15: <task-progress> says 排队中 next to the time while queued", () => {
  let definition;
  global.Component = (value) => {
    definition = value;
  };
  fresh("components/task-progress/index.js");
  const instance = {
    data: structuredClone(definition.data),
    properties: {
      ...Object.fromEntries(Object.entries(definition.properties).map(([k, v]) => [k, v.value])),
      steps: STEPS,
      job: { id: "j", status: "queued", createdAt: new Date(Date.now() - 180_000).toISOString() },
    },
    setData(patch) {
      Object.assign(this.data, patch);
    },
    triggerEvent() {},
    ...definition.methods,
  };
  instance.update();
  instance.halt();
  assert.match(instance.data.elapsed, /^排队中 · 已用 (2 分 59 秒|3 分|3 分 1 秒)$/);
  assert.deepEqual(instance.data.rows.map((r) => r.state), ["todo", "todo", "todo"]);
  assert.equal(instance.data.percent, 0);
  instance.properties.job = { id: "j", status: "running", createdAt: instance.properties.job.createdAt, progress: { stage: "cards" } };
  instance.update();
  instance.halt();
  assert.match(instance.data.elapsed, /^已用 /);
  assert.deepEqual(instance.data.rows.map((r) => r.state), ["now", "todo", "todo"]);
});

// ---- F22: one tidy rule -----------------------------------------------------

test("F22: an AI tidy reads 已整理 on the wall, as on the card page; mood cards too", () => {
  const cards = fresh("utils/cards.js");
  const base = { id: "c", type: "idea", kind: "idea", scene: "life", title: "早起", stage: "written", slots: [] };
  assert.equal(cards.view(base).stageName, "已记下");
  assert.equal(cards.view({ ...base, summary: "AI 写的摘要", summaryBy: "ai" }).stageName, "已整理");
  assert.equal(cards.view({ ...base, slots: [{ key: "why", text: "因为想早点学习", by: "ai" }] }).stage, "organized");
  assert.equal(cards.view({ ...base, slots: [{ key: "why", text: " " }] }).stage, "written");
  // Older servers without `stage`, and mood cards, follow the same rule.
  const { stage: _drop, ...old } = base;
  assert.equal(cards.view({ ...old, summary: "摘要" }).stage, "organized");
  assert.equal(cards.view({ ...base, scene: "mood", summary: "摘要" }).stageName, "已整理");
  // Stages past it are untouched.
  assert.equal(cards.view({ ...base, summary: "摘要", stage: "clear", mine: "我的话" }).stageName, "已说清");
});

test("F22: the card page draws its steps from the same stage", async () => {
  const storage = new Map();
  const wx = {
    getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ""),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    navigateTo() {},
    redirectTo() {},
    navigateBack() {},
    switchTab() {},
    showModal() {},
    showToast() {},
    showActionSheet() {},
    setNavigationBarTitle() {},
    reLaunch() {},
    stopPullDownRefresh() {},
    pageScrollTo() {},
    vibrateShort() {},
  };
  global.wx = wx;
  const detail = {
    id: "c",
    type: "idea",
    kind: "idea",
    scene: "life",
    version: 2,
    title: "早起",
    quote: "想早起学习",
    summary: "AI 写的摘要",
    summaryBy: "ai",
    stage: "written",
    follow: "chat",
    resume: "on",
    tags: [],
    slots: [],
    open: [],
    supplements: [],
    mergedFrom: [],
    links: [],
    versions: [],
    uses: [],
    createdAt: "2026-10-01T02:00:00Z",
    updatedAt: "2026-10-01T02:00:00Z",
  };
  let def;
  const app = { globalData: {} };
  const stubs = {
    api: {
      get: async (url) => (url.startsWith("/v1/cards/c") ? detail : url === "/v1/tags" ? [] : { data: [], total: 0 }),
      post: async () => ({}),
      patch: async () => ({}),
      put: async () => ({}),
      del: async () => ({}),
      needsConsent: () => false,
    },
    auth: { getUser: () => ({ id: "u1" }), hasConsent: () => true, login: async () => {} },
    gate: { check: () => true, state: () => "ok", ask: () => {} },
    format: { ...require(path.join(root, "utils/format.js")), errorText: (e) => e.message },
    assets: { asset: (n) => `https://assets.test/${n}` },
  };
  vm.runInNewContext(read("pages/card/index.js"), {
    require: (n) => {
      if (n.endsWith("/share")) return { withShare: (page) => page };
      const name = path.basename(n).replace(/\.js$/, "");
      return stubs[name] || require(path.join(root, "utils", `${name}.js`));
    },
    Page: (x) => (def = x),
    getApp: () => app,
    wx,
    setTimeout,
    clearTimeout,
    Date,
    console,
  });
  const p = { ...def, data: structuredClone(def.data) };
  p.setData = function (patch) {
    for (const [k, v] of Object.entries(patch)) if (!k.includes(".") && !k.includes("[")) this.data[k] = v;
  };
  p.onLoad({ id: "c" });
  p.onShow();
  await tick();
  const steps = p.data.detail.progress.steps;
  assert.deepEqual(JSON.parse(JSON.stringify(steps.map((s) => [s.name, s.on]))), [["记下", true], ["整理", true], ["说清", false], ["落地", false]]);
  assert.equal(p.data.detail.progress.next, "下一步：用自己的话说一句");
  global.wx = { getStorageSync: () => "", setStorageSync() {}, removeStorageSync() {} };
});

// ---- 拆开, mood mark ----------------------------------------------------------

test("拆开 shows only on a merged card still as the merge made it (version 1)", () => {
  const wxml = read("pages/card/index.wxml");
  assert.match(wxml, /<button wx:if="\{\{!example && detail\.version === 1\}\}" class="btn-text" bindtap="unmerge">拆开<\/button>/);
});

test("mood cards have a readable 心情 label in both tile and row views", () => {
  const wxml = read("components/card-tile/index.wxml");
  const labels = wxml.match(/<text[^>]*class="mood"[^>]*>心情<\/text>/g) || [];
  assert.equal(labels.length, 2);
  for (const label of labels) assert.match(label, /aria-label="心情"/);
});

// ---- V2: page head ------------------------------------------------------------

test("V2: a tinted page head stays fixed over its own tint band; content scrolls under it", () => {
  const wxml = read("components/page-head/index.wxml");
  const wxss = read("components/page-head/index.wxss");
  assert.match(wxml, /<view wx:if="\{\{tint\}\}" class="ph-space" style="height: \{\{statusTop \+ rowHeight\}\}px;" \/>/);
  assert.match(wxml, /class="ph-bar \{\{tint \? 'ph-fixed ' \+ tint : ''\}\}"/);
  assert.match(wxml, /background-size: 100% ' \+ tintHeight \+ 'px;/);
  const fixed = wxss.match(/\.ph-bar\.ph-fixed \{([^}]*)\}/)[1];
  assert.match(fixed, /position: fixed/);
  assert.match(fixed, /top: 0/);
  // Above the page body (1), under bottom bars (10) and sheet masks (20).
  const z = Number(fixed.match(/z-index: (\d+)/)[1]);
  assert.ok(z > 1 && z < 10, String(z));
  assert.match(read("app.wxss"), /\.mask, \.scrim \{[^}]*z-index: 20/);
  for (const tint of ["blue", "yellow", "mint", "slate"]) {
    const band = wxss.match(new RegExp(`\\.ph-fixed\\.${tint} \\{ background-image: (linear-gradient\\([^;]*\\)); \\}`))[1];
    const wash = wxss.match(new RegExp(`\\.ph-tint\\.${tint} \\{ background: (linear-gradient\\([^;]*\\)); \\}`))[1];
    assert.equal(band, wash, tint);
  }
  // Every scrolling page with the head has a tint; the welcome and onboarding pages do not scroll.
  for (const page of ["deck", "learn", "notes", "profile", "talk"])
    assert.match(read(`pages/${page}/index.wxml`), /<page-head[^>]*tint="(blue|yellow|mint|slate)"/, page);
  for (const page of ["welcome", "onboard"]) assert.match(read(`pages/${page}/index.wxss`), /\.root \{[^}]*height: 100vh/, page);
});

// ---- V8: onboarding -------------------------------------------------------------

test("V8: onboarding draws today's card face, no percentage bars, and one line that matches it", () => {
  const wxml = read("pages/onboard/index.wxml");
  assert.doesNotMatch(wxml, /class="prg|class="val"|%;|utabs|已完成<\/text>/);
  assert.doesNotMatch(wxml, /进度条|淡下来/);
  assert.match(wxml, /<card-tile card="\{\{first\}\}" \/>/);
  assert.match(wxml, /<card-tile wx:for="\{\{col\}\}" wx:key="id" card="\{\{item\}\}" \/>/);
  assert.match(wxml, /<text class="ts">每张卡按自己的方式回头问你：回顾、接着聊，或打个勾<\/text>/);
  assert.equal(JSON.parse(read("pages/onboard/index.json")).usingComponents["card-tile"], "/components/card-tile/index");
  let def;
  global.Page = (x) => (def = x);
  global.getApp = () => ({ globalData: {} });
  fresh("pages/onboard/index.js");
  const { view } = fresh("utils/cards.js");
  const first = view(def.data.first);
  assert.equal(first.typeName, "问题");
  assert.equal(first.stageName, "已整理");
  assert.ok(first.sumParts.some((part) => /mk k/.test(part.cls)));
  const words = def.data.wall.flat().map((card) => {
    const v = view(card);
    return [v.typeName, v.stageName];
  });
  assert.deepEqual(words, [
    ["问题", "已说清"],
    ["灵感", "已记下"],
    ["待办", "做完了"],
    ["知识点", "已整理"],
    ["想法", "已记下"],
  ]);
  const banned = ["陪伴", "陪着你", "治疗", "诊断"];
  for (const word of banned) assert.ok(!wxml.includes(word) && !read("pages/onboard/index.js").includes(word));
});

// ---- F04: the look-back reminder's labels ------------------------------------------

test("F04: a look-back reminder is labelled as one in the 回顾 list and on the card", () => {
  assert.match(read("components/resume-card/index.js"), /look: "回头看看"/);
  assert.match(read("pages/resume-list/index.js"), /look: "回头看看"/);
});

// V4.2 closing shots: help agrees with F22; a failed task shows no bar;
// the import pages leave room above their fixed bottom bars.
test("shots: help says an AI tidy counts as 已整理; failed tasks drop the bar; import pages clear the bottom bar", () => {
  const help = read("pages/help/index.js");
  assert.doesNotMatch(help, /AI 自己理的不算/);
  assert.match(help, /你理的、AI 理的都算/);
  assert.match(read("components/task-progress/index.wxml"), /<view wx:if="\{\{!failed\}\}" class="prg tp-prg/);
  assert.match(read("pages/import/source/index.wxml"), /<task-progress [^>]*error="\{\{task\.error\}\}"/);
  for (const file of ["pages/import/source/index.wxss", "pages/import/split/index.wxss"])
    assert.match(read(file), /padding: 0 28rpx calc\(200rpx \+ env\(safe-area-inset-bottom\)\)/);
});

test("a wait without a job ticks no step; a vague one says its steps in one line", () => {
  const { progressView } = require(path.join(root, "utils/job.js"));
  const steps = [{ key: "make", label: "出一道题" }, { key: "check", label: "核对答案" }];
  const long = progressView(steps, null, { elapsedMs: 120000, expectMs: 40000 });
  assert.deepEqual(long.rows.map((row) => row.state), ["now", "todo"]);
  assert.ok(long.percent < 100);
  const vague = progressView(steps, null, { elapsedMs: 120000, expectMs: 40000, vague: true });
  assert.deepEqual(vague.rows, [{ key: "make", label: "出一道题 · 核对答案", state: "now", note: "" }]);
  const failed = progressView(steps, null, { elapsedMs: 5000, vague: true, error: "没出好" });
  assert.equal(failed.rows[0].state, "stop");
  assert.match(read("components/task-progress/index.js"), /vague: this\.properties\.vague/);
});

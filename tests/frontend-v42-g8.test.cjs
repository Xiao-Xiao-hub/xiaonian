// 验证我的资料、资料详情、旧笔记、隐私、帮助、欢迎和新手引导页面。
// 使用合成页面状态与接口替身检查交互边界，不调用真实服务。
const test = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path");
const read = (file) =>
  fs.readFileSync(path.join(__dirname, "../miniprogram", file), "utf8");
const settle = () => new Promise((r) => setTimeout(r, 0));
const plain = (x) => JSON.parse(JSON.stringify(x));

// Runs one page with its requires replaced by `deps` (by the last path part).
function load(file, deps, wx = {}, extra = {}) {
  let definition;
  vm.runInNewContext(read(file), {
    Page: (x) => (definition = x),
    require: (n) => n.endsWith("/share") ? { withShare: (page) => page } : deps[n.split("/").at(-1)] || {},
    getApp: () => ({ globalData: {} }),
    getCurrentPages: () => [],
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    wx: {
      navigateTo() {},
      switchTab() {},
      showToast() {},
      getStorageSync: () => "",
      setStorageSync() {},
      removeStorageSync() {},
      ...wx,
    },
    ...extra,
  });
  const p = {
    ...definition,
    data: structuredClone(definition.data),
    setData(value, done) {
      for (const [k, v] of Object.entries(value)) {
        const keys = k.split(".");
        let o = this.data;
        while (keys.length > 1) o = o[keys.shift()];
        o[keys[0]] = v;
      }
      if (done) done();
    },
  };
  return p;
}
const format = { errorText: (e) => e.message, when: () => "今天", KIND: { note: "资料", problem: "题目" }, citeText: () => "" };

// ---- 我的资料 -------------------------------------------------------------
function library(serve) {
  const gets = [];
  const api = {
    get: (url) => {
      gets.push(url);
      return serve(url);
    },
    needsConsent: () => false,
  };
  const p = load("pages/library/index.js", { api, gate: { check: () => true }, format });
  return { p, gets };
}
const rows = (from, n) =>
  Array.from({ length: n }, (_, i) => ({ id: `m${from + i}`, kind: "note", status: "confirmed", title: `第 ${from + i} 份`, updatedAt: "" }));

test("我的资料: 30 at a time, the next page on reaching the bottom, until it runs out", async () => {
  const { p, gets } = library(async (url) => {
    const offset = Number((url.match(/offset=(\d+)/) || [])[1] || 0);
    return rows(offset, Math.max(0, Math.min(30, 45 - offset)));
  });
  await p.load();
  assert.equal(p.data.items.length, 30);
  assert.equal(p.data.more, true);
  assert.equal(gets[0], "/v1/materials?limit=30");
  await p.onReachBottom();
  assert.equal(gets[1], "/v1/materials?limit=30&offset=30");
  assert.equal(p.data.items.length, 45);
  assert.equal(p.data.items[44].id, "m44");
  assert.equal(p.data.more, false);
  await p.onReachBottom();
  assert.equal(gets.length, 2, "nothing more to ask for");
  const wxml = read("pages/library/index.wxml");
  assert.match(wxml, /wx:if="\{\{more\}\}" class="more"[^>]*bindtap="loadMore"/);
});

test("我的资料: a server without paging sends page one again, and the list stops there", async () => {
  const { p } = library(async () => rows(0, 30));
  await p.load();
  await p.loadMore();
  assert.equal(p.data.items.length, 30);
  assert.equal(p.data.more, false);
});

test("我的资料: only the newest filter or search fills the list", async () => {
  const waiting = [];
  const { p } = library((url) => new Promise((resolve) => waiting.push({ url, resolve })));
  p.setData({ q: "", kind: "" });
  const first = p.load();
  p.setKind({ currentTarget: { dataset: { kind: "problem" } } });
  // The newer answer arrives first, then the old one.
  waiting[1].resolve([{ id: "p1", kind: "problem", status: "confirmed", updatedAt: "" }]);
  await settle();
  waiting[0].resolve(rows(0, 3));
  await first;
  await settle();
  assert.deepEqual(plain(p.data.items.map((i) => i.id)), ["p1"]);
  assert.equal(p.data.loading, false);
  // A next page asked for under the old filter is dropped too.
  p.setData({ more: true });
  const more = p.loadMore();
  p.setKind({ currentTarget: { dataset: { kind: "" } } });
  waiting[2].resolve(rows(100, 30));
  waiting[3].resolve(rows(0, 2));
  await more;
  await settle();
  assert.deepEqual(plain(p.data.items.map((i) => i.id)), ["m0", "m1"]);
});

test("我的资料: an empty filter says so and offers 看全部", async () => {
  const { p, gets } = library(async () => []);
  p.setKind({ currentTarget: { dataset: { kind: "problem" } } });
  await settle();
  const wxml = read("pages/library/index.wxml");
  assert.match(wxml, /<block wx:elif="\{\{kind\}\}">\s*<text class="h3 block">这一类还没有<\/text>\s*<text class="link" bindtap="showAll">看全部<\/text>/);
  p.showAll();
  assert.equal(p.data.kind, "");
  assert.equal(gets.at(-1), "/v1/materials?limit=30");
});

// ---- 资料详情 -------------------------------------------------------------
function material({ state, post, wait } = {}) {
  const storage = {},
    posts = [];
  const base = {
    material: { id: "mat1", title: "极限", current: { paragraphs: ["第一段"] } },
    explain: null,
    answers: [],
    jobs: {},
    review: null,
  };
  const api = {
    get: async () => structuredClone({ ...base, ...(typeof state === "function" ? state() : state) }),
    post: async (url, body) => {
      posts.push([url, body]);
      return post ? post(url, body) : { job: { id: "j1", status: "queued", createdAt: new Date().toISOString() } };
    },
    waitJob: wait || (async (job) => ({ ...job, status: "succeeded" })),
    pending: (job) => Boolean(job && ["queued", "running"].includes(job.status)),
    jobMessage: (job) => (job.status === "unknown" ? "不确定成没成功" : "没成功，再试一次"),
    needsConsent: () => false,
  };
  const p = load(
    "pages/material/index.js",
    { api, auth: { getUser: () => ({ id: "u1" }) }, gate: { check: () => true }, format, review: { setReview() {} }, clock: { now: () => Date.now() }, "study-clock": { track: (d) => d } },
    {
      getStorageSync: (k) => storage[k] || "",
      setStorageSync: (k, v) => (storage[k] = v),
      removeStorageSync: (k) => delete storage[k],
    },
  );
  p.alive = true;
  p.data.id = "mat1";
  return { p, storage, posts };
}
const explained = (data) => ({ explain: { id: "e1", version: 1, data: { points: [{ title: "一" }], ...data } } });

test("资料详情 (高): 原文没讲到 shows with up to three points, without any 展开", () => {
  const wxml = read("pages/material/index.wxml");
  assert.match(wxml, /<text wx:if="\{\{explain\.data\.limits && !explain\.data\.insufficient\}\}" class="hint limits">原文没讲到：/);
  assert.doesNotMatch(wxml, /allPoints && explain\.data\.limits/);
});

test("资料详情: 考考我 only once there is an explanation with enough to go on", () => {
  const wxml = read("pages/material/index.wxml");
  assert.match(wxml, /<button wx:if="\{\{explain && !explain\.data\.insufficient && !waiting\.explain\}\}" class="btn quiz"/);
  // Too little text: 补充原文 is the main button.
  assert.match(wxml, /<button class="btn" hover-class="btn-press" bindtap="edit">补充原文<\/button>/);
  assert.doesNotMatch(wxml, /半分钟内/);
});

test("资料详情: the wait line shows the job's state and the time waited; a cut-off wait offers 看看进展", async () => {
  let release;
  const { p } = material({
    state: explained(),
    wait: (job) => new Promise((resolve, reject) => (release = { resolve, reject, job })),
  });
  p.data.material = { id: "mat1" };
  const done = p.follow("explain", Promise.resolve({ id: "j1", status: "queued", createdAt: new Date(Date.now() - 65000).toISOString() }));
  await settle();
  assert.equal(p.data.waiting.explain, true);
  assert.equal(p.data.waitLine.explain, "排着队，等了 1 分钟");
  release.reject(Object.assign(new Error("还在处理，过一会儿回来看看"), { code: "WAIT_TIMEOUT" }));
  await done;
  assert.equal(p.data.waiting.explain, false);
  assert.equal(p.data.slow.explain, true);
  const wxml = read("pages/material/index.wxml");
  assert.match(wxml, /<text wx:if="\{\{slow\.explain\}\}" class="link" bindtap="reload">看看进展<\/text>/);
  assert.match(wxml, /\{\{waitLine\.explain \? waitLine\.explain \+ '。' : ''\}\}可以先离开，回来接着看/);
});

test("资料详情: a question stays until its answer is in; a failed one comes back after leaving", async () => {
  // Fails: the question stays in the box and on this phone.
  const failing = material({ state: explained(), wait: async (job) => ({ ...job, status: "failed" }) });
  failing.p.data.question = "为什么等于 1？";
  await failing.p.ask();
  assert.equal(failing.p.data.question, "为什么等于 1？");
  assert.equal(failing.p.data.errors.ask, "没成功，再试一次");
  assert.equal(failing.storage["zhiye_material_ask:mat1:u1"], "为什么等于 1？");
  assert.match(read("pages/material/index.wxml"), /<text wx:elif="\{\{question\}\}" class="link" bindtap="ask">再问一次<\/text>/);
  // Coming back later: the job failed, so the question is put back with why.
  const back = material({ state: { ...explained(), jobs: { explain: { status: "succeeded" }, ask: { id: "j9", status: "failed" } } } });
  back.storage["zhiye_material_ask:mat1:u1"] = "为什么等于 1？";
  const state = await back.p.load();
  back.p.resume(state);
  assert.equal(back.p.data.question, "为什么等于 1？");
  assert.equal(back.p.data.errors.ask, "没成功，再试一次");
  // Answered: the box empties and nothing is kept.
  const ok = material({ state: explained() });
  ok.p.data.question = "为什么等于 1？";
  await ok.p.ask();
  assert.equal(ok.p.data.question, "");
  assert.equal(ok.storage["zhiye_material_ask:mat1:u1"], undefined);
  const answered = material({ state: { ...explained(), answers: [{ id: "a1", data: { question: "为什么等于 1？" } }], jobs: { explain: { status: "succeeded" }, ask: { status: "succeeded" } } } });
  answered.storage["zhiye_material_ask:mat1:u1"] = "为什么等于 1？";
  answered.p.resume(await answered.p.load());
  assert.equal(answered.p.data.question, "");
  assert.equal(answered.storage["zhiye_material_ask:mat1:u1"], undefined);
});

// ---- 旧笔记详情 -----------------------------------------------------------
function oldNote(note, jobs = []) {
  const gets = [],
    sheets = [];
  const api = {
    get: async (url) => {
      gets.push(url);
      if (url.startsWith("/v1/jobs/")) return jobs.shift();
      if (url === "/v1/me/usage") return {};
      if (url === "/v1/learn/map") return { chapters: [] };
      return structuredClone(note);
    },
    post: async () => ({}),
    pending: (job) => Boolean(job && ["queued", "running"].includes(job.status)),
    jobMessage: () => "没成功，再试一次",
    needsConsent: () => false,
  };
  const p = load(
    "pages/note/index.js",
    {
      api,
      gate: { check: () => true, state: () => "ok" },
      auth: { getUser: () => ({ id: "u1" }), hasConsent: () => true },
      format,
      clock: { now: () => Date.now() },
    },
    { showActionSheet: (o) => sheets.push(o.itemList), showModal() {} },
  );
  p.onLoad({ id: "n1" });
  return { p, gets, sheets };
}
const noteBody = (extra) => ({
  id: "n1",
  title: "旧笔记",
  text: "原话",
  createdAt: "2026-10-01T00:00:00.000Z",
  supplements: [],
  revision: 1,
  resultVersion: 1,
  result: { items: [{ id: "i1", group: "clear", text: "清楚的一条" }], question: { prompt: "问", options: [] }, nextStep: { text: "下一步" } },
  resultStale: false,
  aiJob: null,
  ...extra,
});

test("旧笔记: a read-only note hides 改标题, 补充 and 理一理 and keeps only 删掉", async () => {
  const { p, sheets } = oldNote(noteBody({ readOnly: true }));
  await p.onShow();
  assert.equal(p.data.readOnly, true);
  p.openMore();
  assert.deepEqual(plain(sheets.pop()), ["删掉这张卡"]);
  p.edit();
  assert.equal(p.data.editing, false);
  p.itemMenu({ currentTarget: { dataset: { id: "i1" } } });
  assert.equal(sheets.length, 0);
  const wxml = read("pages/note/index.wxml");
  assert.match(wxml, /<text wx:if="\{\{readOnly\}\}" class="hint read-only">这是旧版随心记，现在只能看和删。<\/text>/);
  assert.match(wxml, /<view wx:if="\{\{!readOnly\}\}" class="sheet supplement-compose">/);
  assert.match(wxml, /<view wx:if="\{\{!note\.result && !readOnly\}\}" class="organize-actions">/);
  // Without the flag (writable server, or an older one) nothing changes.
  const writable = oldNote(noteBody());
  await writable.p.onShow();
  writable.p.openMore();
  assert.deepEqual(plain(writable.sheets.pop()), ["改标题", "让 AI 再理一遍", "删掉这张卡"]);
});

test("旧笔记: only the groups that hold something are shown", async () => {
  const { p } = oldNote(noteBody());
  await p.onShow();
  assert.deepEqual(plain(p.data.groups.map((g) => [g.id, g.items.length])), [["clear", 1], ["decide", 0], ["verify", 0]]);
  const wxml = read("pages/note/index.wxml");
  assert.match(wxml, /<block wx:for="\{\{groups\}\}" wx:key="id" wx:for-item="group">\s*<view wx:if="\{\{group\.items\.length\}\}" class="outline-group/);
  assert.doesNotMatch(wxml, /这里还没有。/);
});

test("旧笔记: while it is being organized the line shows the real state and the time waited", async () => {
  const createdAt = new Date(Date.now() - 12000).toISOString();
  const { p } = oldNote(noteBody({ result: null, aiJob: { id: "j1", status: "queued", createdAt } }), [
    { id: "j1", status: "running", createdAt },
  ]);
  await p.onShow();
  assert.match(p.data.jobText, /^排着队，等了 1[23] 秒。原话存好了/);
  await new Promise((r) => setTimeout(r, 1600));
  assert.match(p.data.jobText, /^正在理，等了 1[345] 秒。/);
  p.onUnload();
});

// ---- 隐私与导出 -----------------------------------------------------------
test("隐私: export shows 准备中…, deleting says the export has no photos, a recorded 撤回 says so", () => {
  const wxml = read("pages/privacy/index.wxml");
  assert.match(wxml, /\{\{exporting \? '准备中…' : 'JSON 文件，不含原图'\}\}/);
  const js = read("pages/privacy/index.js");
  assert.equal(js.match(/先导出一份；导出的是 JSON 文件，不含原图。/g).length, 2);
  assert.match(js, /wx\.showToast\(\{ title: "撤回了，已退出", icon: "none" \}\)/);
});

// ---- 帮助 -----------------------------------------------------------------
test("帮助: a real 意见反馈, no colour that the mark no longer has, no promises the old tools do not keep", () => {
  const wxml = read("pages/help/index.wxml");
  assert.match(wxml, /<text class="title">意见反馈<\/text>[\s\S]*?<button class="fb-btn" open-type="feedback" aria-label="意见反馈" \/>/);
  const js = read("pages/help/index.js");
  assert.doesNotMatch(js, /紫点/);
  assert.doesNotMatch(js, /各算各的/);
  assert.doesNotMatch(js, /拿不准的时候先问你要不要再试/);
  // one budget by actual use replaced the shared counts.
  assert.match(js, /\/v1\/support\/knowledge/);
  const quotaKnowledge = fs.readFileSync(path.resolve(__dirname, "../server/src/modules/support/knowledge.ts"), "utf8");
  assert.match(quotaKnowledge, /AI 帮你做的事都从同一份额度里扣，按实际用量算/);
});

// ---- 欢迎和新手引导 -------------------------------------------------------
// the demo card is now today's card face (a card-tile, no
// percentage bar); its stage word follows the one tidy rule, so it
// reads 已整理 like the wall does. The face itself is checked in
// frontend-v42-fx5c.test.cjs.
test("新手引导: the demo card is a concrete limit drawn as today's card face", () => {
  const wxml = read("pages/onboard/index.wxml");
  const first = wxml.slice(0, wxml.indexOf("</swiper-item>"));
  assert.doesNotMatch(first, /0\/0|洛必达|泰勒|width: \d+%/);
  assert.match(first, /<card-tile card="\{\{first\}\}" \/>/);
  const js = read("pages/onboard/index.js");
  assert.match(js, /sin 3x 比 x 的极限/);
  assert.doesNotMatch(js, /0\/0|洛必达|泰勒/);
});

test("新手引导: 跳过 also marks it seen; opening alone does not", () => {
  const storage = {};
  const p = load(
    "pages/onboard/index.js",
    { gate: { check: () => true }, assets: { asset: (f) => f } },
    { setStorageSync: (k, v) => (storage[k] = v), reLaunch() {} },
  );
  p.onLoad({});
  assert.equal(storage.zhiye_onboarded, undefined);
  p.finish();
  assert.equal(storage.zhiye_onboarded, "1");
});

test("欢迎: the privacy text is in body colour with no fade, and 不同意 says it leads to a look around", () => {
  const wxss = read("pages/welcome/index.wxss");
  assert.match(wxss, /\.ptext \{[^}]*color: var\(--body\)/);
  assert.doesNotMatch(wxss, /\.pv::after/);
  const wxml = read("pages/welcome/index.wxml");
  assert.match(wxml, /bindtap="refuse">不同意，先看看<\/text>/);
  assert.match(wxml, /<view class="yx-hit" bindtap="closeYouth" aria-role="button" aria-label="关闭"><view class="yx" \/><\/view>/);
});

"use strict";
// brainstorm edits survive reloads and leaving the page, a report
// written before changes says so and can be written again, differences read
// by what they are, conclusions keep the kind the AI suggested, the pick page
// follows the 心情卡 setting, and result items open their cards.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function put(file, exports) {
  const full = path.join(root, file);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}
// One storage for every page loaded with it, like the phone's.
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getStorageSync: (key) => (map.has(key) ? structuredClone(map.get(key)) : ""),
    setStorageSync: (key, value) => map.set(key, structuredClone(value)),
    removeStorageSync: (key) => map.delete(key),
  };
}
function loadPage(name, api, storage = makeStorage()) {
  let definition;
  const navigation = [],
    app = { globalData: {} };
  global.Page = (value) => {
    definition = value;
  };
  global.getApp = () => app;
  global.getCurrentPages = () => [definition];
  global.wx = {
    getStorageSync: storage.getStorageSync,
    setStorageSync: storage.setStorageSync,
    removeStorageSync: storage.removeStorageSync,
    showToast: (value) => navigation.push(["toast", value.title]),
    navigateTo: (value) => navigation.push(["navigate", value.url]),
    redirectTo: (value) => navigation.push(["redirect", value.url]),
    switchTab: (value) => navigation.push(["tab", value.url]),
    navigateBack: () => navigation.push(["back"]),
    showActionSheet: ({ success }) => success({ tapIndex: 0 }),
    showModal: ({ success }) => success && success({ confirm: true }),
  };
  put("utils/api.js", {
    needsConsent: () => false,
    pending: (job) => Boolean(job && ["queued", "running"].includes(job.status)),
    get: () => Promise.resolve({}),
    post: () => Promise.reject(new Error("unexpected post")),
    put: () => Promise.reject(new Error("unexpected put")),
    del: () => Promise.resolve({}),
    ...api,
  });
  put("utils/auth.js", { getUser: () => ({ id: "u1" }), hasConsent: () => true });
  put("utils/gate.js", { state: () => "ok", check: () => true, ask() {} });
  put("utils/theme.js", { themed: (value) => value });
  for (const file of ["utils/job.js", "pages/brainstorm/view.js", `pages/brainstorm/${name}/index.js`])
    delete require.cache[path.join(root, file)];
  require(path.join(root, `pages/brainstorm/${name}/index.js`));
  definition.data = structuredClone(definition.data);
  definition.setData = (patch) => Object.assign(definition.data, patch);
  return { page: definition, navigation, app, storage };
}
const view = () => {
  delete require.cache[path.join(root, "pages/brainstorm/view.js")];
  return require(path.join(root, "pages/brainstorm/view.js"));
};

const fixture = (extra = {}) => ({
  id: "bs-1",
  scene: "study",
  size: "medium",
  status: "ready",
  createdAt: "2026-10-18T00:00:00Z",
  cards: Array.from({ length: 6 }, (_, index) => ({
    id: `c${index + 1}`,
    version: 1,
    type: index % 2 ? "question" : "idea",
    kind: index === 0 ? "todo" : undefined,
    title: `卡片 ${index + 1}`,
    titleBy: "user",
    text: `内容 ${index + 1}`,
  })),
  facts: { commonPrereqs: [], mistakeCauses: [], sawAnswer: 0 },
  result: {
    title: "这几张卡",
    groups: [
      { id: "g1", name: "先懂", common: "都说先懂概念", cards: [1, 2, 3], slot: "why" },
      { id: "g2", name: "先做", common: "都说先做题", cards: [4, 5, 6], slot: "steps" },
    ],
    tensions: [
      { id: "t1", a: 1, b: 2, note: "定义考不考", kind: "verify" },
      { id: "t2", a: 1, b: 4, note: "先刷题还是先整理", kind: "choose" },
      { id: "t3", a: 3, b: 5, note: "一个看例题一个看定义", kind: "differ" },
    ],
    more: [{ id: "m1", type: "question", title: "定义考不考", from: [1] }],
    ifs: [{ id: "i1", if: "定义能说清", from: [1, 2] }],
    directions: [{ id: "r1", title: "先整理定义", why: "几张都提到", from: [1, 2] }],
    drafts: [{ id: "d1", text: "这周先把定义整理一遍", from: [1, 2], kind: "todo" }],
  },
  picks: {},
  ...extra,
});
const report = (extra = {}) => ({
  sections: {
    links: [{ text: "两组都在说先后", cards: [{ id: "c1", title: "卡片 1" }] }],
    improve: [],
    expand: [],
    advice: [{ text: "先查一下考纲", cards: [] }],
  },
  createdAt: "2026-10-18T00:00:00Z",
  stale: false,
  ...extra,
});
const prime = (page) => {
  page.onLoad({ id: "bs-1" });
  page.alive = true;
  page.epoch = 1;
  page.account = "u1";
};
const editEvent = (kind, index, field, value) => ({
  currentTarget: { dataset: { kind, index, field } },
  detail: { value },
});

test("process edits survive an onShow reload and leaving the page, and go once saved", async () => {
  const storage = makeStorage(),
    puts = [];
  const first = loadPage("process", {}, storage);
  prime(first.page);
  first.page.apply(fixture());
  first.page.edit(editEvent("group", 0, "name", "先弄懂"));
  first.page.edit(editEvent("tension", 0, "note", "考纲里有没有"));
  // onShow reads the server again: the edit is still there.
  first.page.apply(fixture());
  assert.equal(first.page.groups[0].name, "先弄懂");
  assert.equal(first.page.data.item.groups[0].nameView.text, "先弄懂");
  assert.equal(first.page.tensions[0].note, "考纲里有没有");

  // Left and opened again: a new page instance finds the draft.
  const again = loadPage(
    "process",
    {
      put: (url, body) => {
        puts.push([url, body]);
        return Promise.resolve({ brainstorm: fixture({ picks: body }) });
      },
    },
    storage,
  );
  prime(again.page);
  again.page.apply(fixture());
  assert.equal(again.page.groups[0].name, "先弄懂");
  await again.page.next();
  assert.equal(puts[0][0], "/v1/brainstorms/bs-1/picks");
  assert.equal(puts[0][1].groups[0].name, "先弄懂");
  assert.match(again.navigation.at(-1)[1], /conclude\/index\?id=bs-1/);
  // The server has them now; nothing of the process page is left in the draft.
  const draft = storage.map.get("zhiye_bs_draft:u1:bs-1");
  assert.ok(!draft || !("groups" in draft));

  // A draft from another result (ids not in it) is not laid over.
  const { withDraft } = view();
  const other = withDraft(fixture(), { groups: [{ id: "x9", name: "别的", cards: [1] }] });
  assert.equal(other.picks.groups, undefined);
  // Saved brainstorms ignore drafts.
  const saved = withDraft(fixture({ status: "saved" }), { title: "草稿" });
  assert.equal(saved.picks.title, undefined);
});

test("any two groups can trade cards, even with three cards", () => {
  const { page, navigation } = loadPage("process", {});
  prime(page);
  const small = fixture({ size: "small" });
  small.cards = small.cards.slice(0, 3);
  small.result.groups = [
    { id: "g1", name: "一", common: "甲", cards: [1, 2] },
    { id: "g2", name: "二", common: "乙", cards: [3] },
  ];
  small.result.tensions = [];
  page.apply(small);
  assert.equal(page.data.canMove, true);
  page.moveCard({ currentTarget: { dataset: { card: 1, group: 0 } } });
  assert.ok(!navigation.some((entry) => entry[0] === "toast"));
});

test("a report written before group edits is marked and written again after saving them", async () => {
  const puts = [],
    posts = [];
  const { page } = loadPage("process", {
    get: () => Promise.resolve(fixture({ report: report() })),
    put: (url, body) => {
      puts.push(body);
      return Promise.resolve({ brainstorm: fixture({ picks: body }) });
    },
    post: (url, body) => {
      posts.push([url, body]);
      return Promise.resolve({ job: { id: "rj", status: "queued" } });
    },
  });
  prime(page);
  page.apply(fixture({ report: report() }));
  assert.equal(page.data.reportStale, false);
  assert.equal(page.data.detailsOpen, false);
  // A more-question or the extra ask is not what the report reads.
  page.edit(editEvent("more", 0, "title", "考纲怎么看"));
  assert.equal(page.data.reportStale, false);
  // Moving a card is.
  page.edit(editEvent("group", 1, "common", "都想先做题再回头"));
  assert.equal(page.data.reportStale, true);
  await page.refreshReport();
  await flush();
  assert.equal(puts.length, 1);
  assert.equal(puts[0].groups[1].common, "都想先做题再回头");
  assert.deepEqual(posts[0][0], "/v1/brainstorms/bs-1/report");
  assert.equal(posts[0][1].refresh, true);
  assert.equal(page.data.reportTask.job.id, "rj");
  // The old report stays on screen while the new one is written.
  assert.ok(page.data.report);
  page.onUnload();

  // A report the server marks stale (saved elsewhere) asks without a save.
  const second = loadPage("process", {
    post: (url, body) => {
      posts.push([url, body]);
      return Promise.resolve({ job: null, report: report() });
    },
  });
  prime(second.page);
  second.page.apply(fixture({ report: report({ stale: true }) }));
  assert.equal(second.page.data.reportStale, true);
  await second.page.refreshReport();
  assert.equal(posts.at(-1)[1].refresh, true);
  assert.equal(second.page.data.reportStale, false);
  const wxml = fs.readFileSync(path.join(root, "pages/brainstorm/process/index.wxml"), "utf8");
  assert.match(wxml, /reportStale/);
  assert.match(wxml, /bindtap="refreshReport"/);
});

test("differences read by what they are, and answers name the card", () => {
  const { itemView, TENSION_KINDS } = view();
  const item = itemView(
    fixture({
      picks: {
        tensions: [
          { id: "t1", a: 1, b: 2, note: "定义考不考", kind: "verify", choice: "a" },
          { id: "t2", a: 1, b: 4, note: "先刷题还是先整理", kind: "choose", choice: "b" },
          { id: "t3", a: 3, b: 5, note: "一个看例题一个看定义", kind: "differ" },
          { id: "t4", a: 2, b: 3, note: "旧的一条", choice: "a" },
        ],
      },
    }),
  );
  const [verify, choose, differ, legacy] = item.tensions;
  assert.equal(verify.kindName, TENSION_KINDS.verify.name);
  assert.deepEqual(verify.stances.map((entry) => entry.id), ["a", "b", "unsure"]);
  assert.match(verify.stances.find((entry) => entry.selected).name, /卡片 1.*对/);
  assert.equal(choose.kindName, "要选一个");
  assert.deepEqual(choose.stances.map((entry) => entry.id), ["a", "b", "depends", "unsure"]);
  assert.match(choose.stances.find((entry) => entry.selected).name, /^选「卡片 4」/);
  assert.equal(differ.kindName, "角度不同");
  assert.deepEqual(differ.stances, []);
  // A result from before has no kind and keeps the old wording.
  assert.equal(legacy.kindName, "这两张说的不一样");
  assert.equal(legacy.stances.length, 4);
  // A long title is shortened by character, not cut through an emoji.
  const emoji = fixture();
  emoji.cards[0].title = "😀".repeat(20);
  const cut = itemView({ ...emoji, picks: { tensions: [{ id: "t1", a: 1, b: 2, note: "x", kind: "verify" }] } });
  const name = cut.tensions[0].stances[0].name;
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(name), name);
});

test("the conclusion keeps the kind the AI suggested and what the user typed", async () => {
  const storage = makeStorage(),
    puts = [];
  const first = loadPage("conclude", {}, storage);
  prime(first.page);
  first.page.apply(fixture());
  // The draft sentence is a 待办, so the conclusion is offered as one.
  assert.equal(first.page.data.conclusionType, "todo");
  assert.equal(first.page.data.conclusionTypeName, view().KINDS.todo);
  // Opening the page alone writes no draft.
  assert.equal(storage.map.size, 0);
  first.page.useDraft({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(first.page.conclusion.kind, "todo");
  assert.equal(first.page.conclusion.type, "idea");
  first.page.conclusionInput({ detail: { value: "这周先把定义整理一遍，再刷题" } });
  first.page.titleInput && first.page.titleInput({ detail: { value: "先整理定义" } });

  // Back from the next page (onShow reload) and after leaving: still there.
  first.page.apply(fixture());
  assert.equal(first.page.conclusion.text, "这周先把定义整理一遍，再刷题");
  const again = loadPage(
    "conclude",
    {
      put: (url, body) => {
        puts.push(body);
        return Promise.resolve({ brainstorm: fixture({ picks: body }) });
      },
      post: () =>
        Promise.resolve({ brainstorm: fixture({ status: "saved" }), cards: [] }),
    },
    storage,
  );
  prime(again.page);
  again.page.apply(fixture());
  assert.equal(again.page.conclusion.text, "这周先把定义整理一遍，再刷题");
  assert.equal(again.page.conclusion.kind, "todo");
  // Two characters are enough.
  again.page.conclusionInput({ detail: { value: "查表" } });
  await again.page.save({ currentTarget: { dataset: { mode: "result" } } });
  assert.equal(puts[0].conclusion.text, "查表");
  assert.equal(puts[0].conclusion.kind, "todo");
  assert.equal(storage.map.has("zhiye_bs_draft:u1:bs-1"), false);

  // A study brainstorm without any suggestion falls back to 思路 as before.
  const { itemView } = view();
  const plain = fixture();
  plain.result.drafts = [{ id: "d1", text: "先看结构", from: [1] }];
  assert.equal(itemView(plain).conclusionType, "method");
});

test("the result page opens source cards, says when the picture scrolls, and retries or refreshes its report", async () => {
  const posts = [];
  const { page, navigation } = loadPage("result", {
    post: (url, body) => {
      posts.push([url, body]);
      return Promise.resolve({ job: null, report: report() });
    },
  });
  prime(page);
  const saved = fixture({
    status: "saved",
    picks: { conclusion: { text: "先整理定义", kind: "todo", type: "idea" } },
    report: report({ stale: true }),
  });
  saved.result.groups.push({ id: "g3", name: "三", common: "丙", cards: [] });
  page.apply(saved, []);
  assert.equal(page.data.item.graph.scrolls, true);
  page.openSource({ currentTarget: { dataset: { id: "c3" } } });
  assert.deepEqual(navigation.at(-1), ["navigate", "/pages/card/index?id=c3"]);
  page.openSource({ currentTarget: { dataset: {} } });
  assert.equal(navigation.length, 1);
  // Stale: 重新看看 asks for a fresh one.
  assert.equal(page.data.reportStale, true);
  await page.refreshReport();
  assert.equal(posts[0][1].refresh, true);
  assert.equal(page.data.reportStale, false);
  assert.ok(page.data.report);

  // A failed report job waits for 再试一次 instead of vanishing.
  const failed = loadPage("result", {
    get: () =>
      Promise.resolve(
        fixture({
          status: "saved",
          outCardIds: [],
          reportJob: { id: "rj", status: "failed", error: { message: "这次没写完" } },
        }),
      ),
    post: (url, body) => {
      posts.push([url, body]);
      return Promise.resolve({ job: null, report: report() });
    },
  });
  failed.page.onLoad({ id: "bs-1" });
  failed.page.onShow();
  await flush();
  await flush();
  assert.equal(failed.page.data.reportTask.job.status, "failed");
  await failed.page.retryReport();
  assert.equal(posts.at(-1)[0], "/v1/brainstorms/bs-1/report");
  assert.equal(posts.at(-1)[1].refresh, undefined);
  assert.equal(failed.page.data.reportTask, null);
  assert.ok(failed.page.data.report);

  const wxml = fs.readFileSync(path.join(root, "pages/brainstorm/result/index.wxml"), "utf8");
  assert.match(wxml, /class="graph-card[^>]*bindtap="openSource"/);
  assert.match(wxml, /graph\.scrolls/);
  assert.match(wxml, /<task-progress/);
});

test("the pick page leaves mood cards out only when the user hid them", async () => {
  const run = async (stored, query = { clientId: "x" }) => {
    const urls = [];
    const storage = makeStorage(stored === undefined ? {} : { "zhiye_show_mood:u1": stored });
    const { page } = loadPage(
      "pick",
      {
        get: (url) => {
          urls.push(url);
          return Promise.resolve(url === "/v1/tags" ? [] : { items: [], total: 0, nextCursor: null });
        },
      },
      storage,
    );
    page.onLoad(query);
    page.onShow();
    await flush();
    await flush();
    return { page, urls };
  };
  const shown = await run(undefined);
  assert.deepEqual(shown.page.data.scenes.map((item) => item.id), ["study", "life", "mood"]);
  const list = shown.urls.find((url) => url.startsWith("/v1/cards"));
  assert.ok(list && !/scene=/.test(list), list);

  const hidden = await run("0");
  assert.deepEqual(hidden.page.data.scenes.map((item) => item.id), ["study", "life"]);
  const hiddenList = hidden.urls.find((url) => url.startsWith("/v1/cards"));
  assert.match(hiddenList, /scene=study%2Clife/);
  // A scene picked by hand wins.
  hidden.page.setData({
    scenes: hidden.page.data.scenes.map((item) => ({ ...item, selected: item.id === "life" })),
  });
  assert.match(hidden.page.queryUrl(), /scene=life(&|$)/);
  // Kinds are the seven card kinds, sent as kind=.
  assert.equal(hidden.page.data.types.length, 7);
  hidden.page.setData({
    types: hidden.page.data.types.map((item) => ({ ...item, selected: item.id === "todo" })),
  });
  assert.match(hidden.page.queryUrl(), /kind=todo/);
  assert.doesNotMatch(hidden.page.queryUrl(), /[?&]type=/);
  // Cards handed over from elsewhere come as they are.
  const handed = await run("0", { clientId: "x", ids: "c1,c2" });
  assert.doesNotMatch(handed.page.queryUrl(), /scene=/);
});

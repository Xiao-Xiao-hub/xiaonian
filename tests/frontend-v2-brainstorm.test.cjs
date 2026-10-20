"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
function put(file, exports) {
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
function setPath(target, key, value) {
  const parts = key.split(".");
  let current = target;
  for (let i = 0; i < parts.length - 1; i++)
    current = current[parts[i]] = current[parts[i]] || {};
  current[parts.at(-1)] = value;
}
function loadPage(name, api, extra = {}) {
  let definition,
    user = { id: "u1" };
  const navigation = [],
    app = { globalData: {} };
  global.Page = (value) => {
    definition = value;
  };
  global.getApp = () => app;
  global.getCurrentPages = () => [definition];
  global.wx = {
    showToast: (value) => navigation.push(["toast", value.title]),
    navigateTo: (value) => navigation.push(["navigate", value.url]),
    redirectTo: (value) => navigation.push(["redirect", value.url]),
    switchTab: (value) => {
      navigation.push(["tab", value.url]);
      if (value.success) value.success();
    },
    navigateBack: () => navigation.push(["back"]),
    showActionSheet: ({ success }) => success({ tapIndex: 1 }),
    showModal: ({ success, complete }) => {
      success && success({ confirm: true });
      complete && complete();
    },
    ...extra,
  };
  put(path.join(root, "utils/api.js"), {
    needsConsent: () => false,
    del: () => Promise.resolve({ deleted: true }),
    ...api,
  });
  put(path.join(root, "utils/auth.js"), {
    getUser: () => user,
    hasConsent: () => true,
  });
  put(path.join(root, "utils/theme.js"), { themed: (value) => value });
  put(path.join(root, "utils/gate.js"), { state: () => "ok", check: () => true, ask() {} });
  const file = path.join(root, `pages/brainstorm/${name}/index.js`);
  delete require.cache[file];
  require(file);
  definition.data = structuredClone(definition.data);
  definition.setData = (patch) =>
    Object.entries(patch).forEach(([key, value]) =>
      key.includes(".")
        ? setPath(definition.data, key, value)
        : (definition.data[key] = value),
    );
  return {
    page: definition,
    navigation,
    app,
    setUser(value) {
      user = value;
    },
  };
}

const cards = Array.from({ length: 43 }, (_, index) => ({
  id: `c${index + 1}`,
  type: index % 2 ? "question" : "idea",
  scene: "study",
  title: `卡片 ${index + 1}`,
  titleBy: "user",
  tags: [],
}));
function readyFixture() {
  return {
    id: "bs-1",
    scene: "study",
    size: "medium",
    status: "ready",
    createdAt: "2026-10-09T00:00:00Z",
    cards: cards.slice(0, 6).map((card, index) => ({
      id: card.id,
      version: 1,
      type: card.type,
      title: card.title,
      titleBy: "user",
      text: `内容 ${index + 1}`,
    })),
    facts: {
      commonPrereqs: [{ id: "p1", name: "无穷小比较", count: 3 }],
      mistakeCauses: [{ cause: "条件没检查", count: 3 }],
      sawAnswer: 2,
    },
    result: {
      title: "第 1 章卡在哪",
      groups: [
        { id: "g1", name: "共同点", common: "都在检查条件", cards: [1, 2, 3] },
        { id: "g2", name: "另一组", common: "想整理步骤", cards: [4, 5, 6] },
      ],
      tensions: [{ id: "t1", a: 1, b: 2, note: "两种说法相反" }],
      more: [
        { id: "m1", type: "question", title: "条件是什么", from: [1] },
        { id: "m2", type: "spark", title: "画成表", from: [3] },
      ],
      ifs: [{ id: "i1", if: "条件能说明白", from: [1, 2] }],
      directions: [
        { id: "r1", title: "先检查结构", why: "卡片都提到结构", from: [1, 2] },
      ],
      drafts: [{ id: "d1", text: "先检查结构，再决定方法", from: [1, 2] }],
      ask: { q: "哪一步最容易忘？", options: ["第一步", "第二步"] },
    },
    picks: {},
    outCardIds: [],
    jobId: "job-1",
    job: { id: "job-1", status: "succeeded", progress: null },
  };
}

test("pick resolves a dynamic batch across card pages, arrives with the batch picked and sends only those cards", async () => {
  const calls = [];
  const api = {
    get(url) {
      if (url.startsWith("/v1/brainstorms/suggest"))
        return Promise.resolve({
          items: [
            {
              key: "chapter:x",
              kind: "chapter",
              sourceId: "x",
              title: "极限这一章",
              cardIds: ["c41", "c42", "c43"],
              count: 3,
            },
          ],
        });
      if (url === "/v1/tags") return Promise.resolve([]);
      if (url.includes("cursor=next"))
        return Promise.resolve({
          data: cards.slice(40),
          total: 43,
          cursor: "",
        });
      return Promise.resolve({
        data: cards.slice(0, 40),
        total: 43,
        cursor: "next",
      });
    },
    post(url, body) {
      calls.push([url, body]);
      return Promise.resolve({ brainstorm: { id: "bs-new" } });
    },
  };
  const { page, navigation } = loadPage("pick", api);
  page.onLoad({ batch: "chapter", sourceId: "x" });
  page.alive = true;
  page.epoch = 1;
  page.account = "u1";
  await page.loadBatch();
  assert.deepEqual(
    page.data.cards.map((card) => card.id),
    ["c41", "c42", "c43"],
  );
  assert.equal(page.data.fixed, true);
  assert.deepEqual(page.data.selected, ["c41", "c42", "c43"]);
  page.toggle({ detail: { card: { id: "c42" } } });
  assert.deepEqual(page.data.selected, ["c41", "c43"]);
  await page.selectAll();
  assert.equal(page.data.selected.length, 3);
  await page.start();
  assert.deepEqual([...calls[0][1].cardIds].sort(), ["c41", "c42", "c43"]);
  assert.match(navigation.at(-1)[1], /process\/index\?id=bs-new/);
});

test("process keeps stable ids while editing groups, choices, selected new cards and the optional question", async () => {
  const writes = [],
    fixture = readyFixture();
  const api = {
    get: () => Promise.resolve({ brainstorm: fixture }),
    put(url, body) {
      writes.push([url, structuredClone(body)]);
      return Promise.resolve({ brainstorm: { ...fixture, picks: body } });
    },
  };
  const { page, navigation } = loadPage("process", api);
  page.onLoad({ id: fixture.id });
  page.alive = true;
  page.epoch = 1;
  page.account = "u1";
  page.apply(fixture);
  page.edit({
    currentTarget: { dataset: { kind: "group", index: 0, field: "name" } },
    detail: { value: "我改的组" },
  });
  page.stance({ currentTarget: { dataset: { index: 0, value: "depends" } } });
  page.toggleMore({ currentTarget: { dataset: { index: 1 } } });
  page.editAsk({
    currentTarget: { dataset: { field: "q" } },
    detail: { value: "我还要确认什么？" },
  });
  await page.next();
  const body = writes[0][1];
  assert.equal(body.groups[0].id, "g1");
  assert.equal(body.groups[0].name, "我改的组");
  assert.equal(body.tensions[0].id, "t1");
  assert.equal(body.tensions[0].choice, "depends");
  assert.equal(body.more[1].id, "m2");
  assert.equal(body.more[1].selected, true);
  assert.equal(body.ask.q, "我还要确认什么？");
  assert.match(navigation.at(-1)[1], /conclude\/index\?id=bs-1/);
});

test("process asks before removing, explains why small groups stay put, keeps the extra question in the menu and leaves after a save", async () => {
  const fixture = readyFixture(),
    modals = [];
  let confirm = false;
  const { page, navigation, app } = loadPage(
    "process",
    { get: () => Promise.resolve({ brainstorm: fixture }) },
    {
      showModal: (options) => {
        modals.push(options);
        options.success({ confirm });
      },
    },
  );
  page.onLoad({ id: fixture.id });
  page.alive = true;
  page.epoch = 1;
  page.account = "u1";
  page.apply(fixture);
  assert.equal(page.data.canMove, true);
  page.toggleEdit({ currentTarget: { dataset: { key: "g1" } } });
  assert.equal(page.data.editing.g1, true);
  page.remove({ currentTarget: { dataset: { kind: "group", index: 0 } } });
  assert.equal(modals[0].title, "删掉这组？");
  assert.ok(modals[0].confirmText.length <= 4 && modals[0].cancelText.length <= 4);
  assert.equal(page.data.item.groups.length, 2);
  confirm = true;
  page.remove({ currentTarget: { dataset: { kind: "group", index: 0 } } });
  assert.equal(page.data.item.groups.length, 1);
  // One group left: tapping a card says why nothing moves.
  page.moveCard({ currentTarget: { dataset: { card: 4, group: 0 } } });
  assert.deepEqual(navigation.at(-1), ["toast", "只有一组，不用挪"]);
  // The menu's first entry opens the extra question.
  assert.equal(page.data.askOpen, false);
  global.wx.showActionSheet = ({ itemList, success }) => {
    assert.deepEqual(itemList, ["再问自己一句", "这次不想了"]);
    success({ tapIndex: 0 });
  };
  page.openMenu();
  assert.equal(page.data.askOpen, true);
  assert.equal(page.data.detailsOpen, true);
  // Back from the saved result skips this page.
  page.onHide();
  app.globalData.brainstormSaved = fixture.id;
  page.onShow();
  assert.deepEqual(navigation.at(-1), ["back"]);
  assert.equal(app.globalData.brainstormSaved, null);

  const small = loadPage("process", {});
  small.page.onLoad({ id: "bs-small" });
  small.page.alive = true;
  small.page.epoch = 1;
  small.page.account = "u1";
  small.page.apply({ ...readyFixture(), size: "small", cards: readyFixture().cards.slice(0, 4) });
  // V4.2 : a small brainstorm with two groups can move cards too.
  assert.equal(small.page.data.canMove, true);
});

test("process sends AI text back when an edited field is left empty", async () => {
  const fixture = readyFixture(),
    writes = [];
  const { page } = loadPage("process", {
    put(url, body) {
      writes.push(body);
      return Promise.resolve({ brainstorm: fixture });
    },
  });
  page.onLoad({ id: fixture.id });
  page.alive = true;
  page.epoch = 1;
  page.account = "u1";
  page.apply(fixture);
  page.edit({
    currentTarget: { dataset: { kind: "group", index: 1, field: "common" } },
    detail: { value: "  " },
  });
  page.edit({
    currentTarget: { dataset: { kind: "tension", index: 0, field: "note" } },
    detail: { value: "" },
  });
  await page.next();
  assert.equal(writes[0].groups[1].common, "想整理步骤");
  assert.equal(writes[0].tensions[0].note, "两种说法相反");
});

test("process can resume a running job before any model result exists", () => {
  const { page } = loadPage("process", {});
  page.onLoad({ id: "bs-running" });
  page.alive = true;
  page.epoch = 1;
  page.account = "u1";
  page.apply({
    id: "bs-running",
    scene: "study",
    size: "small",
    status: "running",
    cards: cards.slice(0, 3),
    facts: { commonPrereqs: [], mistakeCauses: [], sawAnswer: 0 },
    result: null,
    picks: {},
    job: {
      id: "job-running",
      status: "running",
      progress: { chars: 600, expect: 1500 },
    },
  });
  assert.equal(page.data.ready, false);
  assert.equal(page.data.item.count, 3);
  // No character counts while it thinks.
  assert.equal(page.data.progress, "在帮你理一理…");
  assert.doesNotMatch(page.data.progress, /\d/);
});

test("conclusion keeps user input on failure, then saves a ten-character conclusion and chosen AI card idempotently", async () => {
  const fixture = readyFixture(),
    puts = [],
    posts = [];
  let fail = true;
  fixture.picks = {
    more: fixture.result.more.map((entry, index) => ({
      ...entry,
      selected: index === 0,
    })),
  };
  const api = {
    put(url, body) {
      puts.push(structuredClone(body));
      return Promise.resolve({ brainstorm: { ...fixture, picks: body } });
    },
    post(url, body) {
      posts.push(body);
      return fail
        ? Promise.reject(new Error("网络断开"))
        : Promise.resolve({
            brainstorm: {
              ...fixture,
              status: "saved",
              outCardIds: ["new1", "new2"],
            },
            cards: [
              {
                id: "new1",
                type: "method",
                scene: "study",
                title: "我的结论",
                titleBy: "user",
              },
            ],
          });
    },
  };
  const { page, navigation, app } = loadPage("conclude", api);
  page.onLoad({ id: fixture.id });
  page.alive = true;
  page.epoch = 1;
  page.account = "u1";
  page.apply(fixture);
  const conclusion = "先检查运算结构再决定使用哪种方法";
  page.conclusionInput({ detail: { value: conclusion } });
  page.thenInput({
    currentTarget: { dataset: { index: 0 } },
    detail: { value: "按条件选择方法" },
  });
  await page.save({ currentTarget: { dataset: { mode: "result" } } });
  assert.equal(page.data.item.conclusion, conclusion);
  assert.match(page.data.error, /网络断开/);
  fail = false;
  await page.save({ currentTarget: { dataset: { mode: "result" } } });
  assert.equal(puts.at(-1).conclusion.text, conclusion);
  assert.equal(puts.at(-1).ifs[0].then, "按条件选择方法");
  assert.equal(posts[0].clientId, posts[1].clientId);
  assert.match(navigation.at(-1)[1], /result\/index\?id=bs-1/);
  await page.save({ currentTarget: { dataset: { mode: "chat" } } });
  // back from the chat leads home, not to the finished brainstorm.
  assert.deepEqual(navigation.slice(-2), [
    ["tab", "/pages/notes/index"],
    ["navigate", "/pages/chat/index"],
  ]);
  assert.equal(app.globalData.chat.cards[0].id, "new1");
  assert.equal(app.globalData.brainstormSaved, "bs-1");
});

test("conclusion asks for a sentence instead of saving nothing, and a type picked first never makes an empty conclusion", async () => {
  const fixture = readyFixture(),
    puts = [],
    posts = [];
  const api = {
    put(url, body) {
      puts.push(structuredClone(body));
      return Promise.resolve({ brainstorm: { ...fixture, picks: body } });
    },
    post(url, body) {
      posts.push(body);
      return Promise.resolve({
        brainstorm: { ...fixture, status: "saved", outCardIds: ["new1"] },
        cards: [{ id: "new1", type: "idea", scene: "study", title: "结论" }],
      });
    },
  };
  const { page, navigation } = loadPage("conclude", api);
  page.onLoad({ id: fixture.id });
  page.alive = true;
  page.epoch = 1;
  page.account = "u1";
  page.apply(fixture);
  assert.equal(page.data.conclusionTypeName, "思路");
  // The sheet mock taps the second entry, 想法.
  page.pickType();
  assert.equal(page.data.conclusionTypeName, "想法");
  assert.equal(page.conclusion, null);
  assert.equal(page.payload(false).conclusion, null);
  await page.save({ currentTarget: { dataset: { mode: "result" } } });
  assert.equal(page.data.error, "先写一句你现在的想法");
  assert.equal(page.data.focusConclusion, true);
  await page.save({ currentTarget: { dataset: { mode: "chat" } } });
  assert.equal(posts.length, 0);
  // V4.2 : a short sentence is fine; only one character is too little.
  page.conclusionInput({ detail: { value: "先" } });
  assert.equal(page.conclusion.type, "idea");
  await page.save({ currentTarget: { dataset: { mode: "result" } } });
  assert.equal(page.data.error, "再多写几个字");
  assert.equal(puts.length, 0);
  page.conclusionInput({ detail: { value: "先看运算结构，再决定用哪种方法" } });
  await page.save({ currentTarget: { dataset: { mode: "result" } } });
  assert.equal(puts.at(-1).conclusion.type, "idea");
  assert.equal(posts.length, 1);
  assert.match(navigation.at(-1)[1], /result\/index\?id=bs-1/);
});

test("late result detail from another owner is ignored and example completes all three steps without writes", async () => {
  let resolveDetail;
  const delayed = new Promise((resolve) => {
    resolveDetail = resolve;
  });
  const resultPage = loadPage("result", { get: () => delayed });
  resultPage.page.onLoad({ id: "bs-1" });
  resultPage.page.alive = true;
  resultPage.page.epoch = 1;
  resultPage.page.account = "u1";
  const pending = resultPage.page.load();
  resultPage.setUser({ id: "u2" });
  resolveDetail({ brainstorm: { ...readyFixture(), status: "saved" } });
  await pending;
  assert.equal(resultPage.page.data.item, null);

  let calls = 0;
  const processPage = loadPage("process", {
    get: () => {
      calls += 1;
      return Promise.reject(new Error("unexpected"));
    },
    put: () => {
      calls += 1;
      return Promise.reject(new Error("unexpected"));
    },
  });
  processPage.page.onLoad({ example: "1" });
  processPage.page.onShow();
  assert.equal(processPage.page.data.item.example, true);
  assert.equal(processPage.page.data.ready, true);
  assert.equal(processPage.page.data.item.cards.length, 4);
  assert.equal(processPage.page.data.item.groups.length, 2);
  processPage.page.next();
  assert.equal(calls, 0);
  assert.match(processPage.navigation.at(-1)[1], /conclude\/index\?example=1/);
});

test("result lays out grouped cards and separates the conclusion card from new cards", () => {
  const fixture = readyFixture();
  fixture.picks = {
    conclusion: {
      text: "先检查运算结构再决定使用哪种方法",
      type: "method",
    },
    tensions: fixture.result.tensions.map((entry) => ({
      ...entry,
      choice: "depends",
    })),
  };
  fixture.outCardIds = ["out-conclusion", "out-new"];
  const { page } = loadPage("result", {});
  page.apply(fixture, [
    {
      id: "out-conclusion",
      type: "method",
      scene: "study",
      title: "先检查运算结构",
      titleBy: "user",
      mine: fixture.picks.conclusion.text,
      slots: [{ key: "when", text: "先看结构", by: "ai" }],
      open: [{ key: "t1", text: "两个条件怎么选", by: "ai" }],
      tags: [],
    },
    {
      id: "out-new",
      type: "question",
      scene: "study",
      title: "条件是什么",
      titleBy: "ai",
      tags: [],
    },
  ]);
  assert.equal(page.data.item.graph.groups.length, 2);
  assert.equal(page.data.item.graph.ties.length, 1);
  assert.match(page.data.item.graph.trunkStyle, /width:/);
  // Card nodes fit a 16-character title; the group name clears the first card.
  const node = page.data.item.graph.groups[0].cards[0].graphStyle;
  assert.match(node, /width:220rpx;height:130rpx/);
  assert.match(node, /top:132rpx/);
  assert.equal(page.data.conclusionCard.id, "out-conclusion");
  assert.equal(page.data.conclusionCard.slotViews[0].text, "先看结构");
  assert.equal(page.data.conclusionCard.slotViews[0].label, undefined);
  assert.equal(page.data.conclusionCard.openViews[0].label, "还没想明白的");
  assert.equal(page.data.item.tensions[0].stanceName, "看情况");
  assert.deepEqual(
    page.data.newCards.map((card) => card.id),
    ["out-new"],
  );
});

test("result leads back to the 卡片 tab and can carry the saved cards into a chat", () => {
  const fixture = readyFixture();
  fixture.status = "saved";
  fixture.outCardIds = ["out-new"];
  const { page, navigation, app } = loadPage("result", {});
  page.onLoad({ id: fixture.id });
  page.apply(fixture, [
    { id: "out-new", type: "question", scene: "study", title: "条件是什么", tags: [] },
  ]);
  page.goHome();
  assert.deepEqual(navigation.at(-1), ["tab", "/pages/deck/index"]);
  page.chat();
  assert.deepEqual(navigation.slice(-2), [
    ["tab", "/pages/notes/index"],
    ["navigate", "/pages/chat/index"],
  ]);
  assert.equal(app.globalData.chat.cards[0].id, "out-new");
});

test("brainstorm pages retain final visual copy, editable fields, AI marks and a compact result graph", () => {
  const read = (name, ext) =>
    fs.readFileSync(
      path.join(root, `pages/brainstorm/${name}/index.${ext}`),
      "utf8",
    );
  const pick = read("pick", "wxml"),
    process = read("process", "wxml"),
    conclude = read("conclude", "wxml"),
    result = read("result", "wxml");
  const view = fs.readFileSync(
    path.join(root, "pages/brainstorm/view.js"),
    "utf8",
  );
  assert.match(pick, /全选/);
  assert.match(pick, /再挑/);
  assert.match(pick, /开始头脑风暴/);
  assert.match(process, /从卡里看出的/);
  // V4.2 : the box title follows what kind of difference it is; old
  // results keep the old title.
  assert.match(process, /\{\{item\.kindName\}\}/);
  assert.match(view, /这两张说的不一样/);
  assert.match(view, /要查一查/);
  assert.match(view, /要选一个/);
  assert.match(process, /openMenu/);
  assert.doesNotMatch(process, /程序|再问自己一句<\/text>\s*<text bindtap="removeAsk"|>取消</);
  assert.match(view, /看情况/);
  assert.match(view, /更对/);
  assert.match(conclude, /你现在怎么想？/);
  assert.match(conclude, /存下来/);
  assert.match(conclude, /存成：/);
  assert.doesNotMatch(conclude, /10 个字以上/);
  assert.match(conclude, /看看 AI 怎么说/);
  assert.match(conclude, /带去对话/);
  assert.match(result, /graph/);
  assert.match(result, /class="trunk"/);
  assert.match(result, /tie tie-v/);
  assert.match(result, />你的结论</);
  assert.match(result, />顺手多记的几张</);
  assert.match(result, /我的结论/);
  assert.match(result, /回卡片/);
  for (const name of ["pick", "process", "conclude", "result"])
    assert.match(read(name, "json"), /"navigationBarTitleText": "头脑风暴"/);
  for (const source of [pick, process, conclude, result])
    assert.match(source, /AI 生成可能有误，注意核实/);
  assert.match(process, /ai-dot/);
  assert.match(conclude, /ai-dot/);
  assert.match(result, /ai-dot/);
});

const reportFixture = () => ({
  sections: {
    links: [{ text: "三张都在说先看结构", cards: [{ id: "c1", title: "卡片 1" }, { id: "c2", title: "卡片 2" }] }],
    improve: [],
    expand: [{ text: "可以画成一张对照表", cards: [] }],
    advice: [{ text: "下次先写条件", cards: [{ id: "c3", title: "卡片 3" }] }],
  },
  createdAt: "2026-10-14T00:00:00Z",
});
const pendingApi = (extra) => ({
  pending: (job) => Boolean(job && ["queued", "running"].includes(job.status)),
  jobMessage: (job) => (job && job.error && job.error.message) || "没成功，再试一次",
  ...extra,
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

// V4.2 : report jobs are watched through utils/job.js (polls
// /v1/jobs/:id every 1.5 s), so these tests drive setTimeout by hand.
const jobGet = (jobs, other) => (url) =>
  url.startsWith("/v1/jobs/")
    ? Promise.resolve(jobs[url.slice("/v1/jobs/".length)])
    : other(url);

test("process asks for the report once ready, shows it first in order and hides empty sections", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = readyFixture();
  let reads = 0;
  const posts = [],
    polls = [];
  const { page, navigation, app } = loadPage(
    "process",
    pendingApi({
      get: jobGet({ rj: { id: "rj", status: "succeeded", result: {} } }, () => {
        reads += 1;
        return Promise.resolve(reads === 1 ? fixture : { ...fixture, report: reportFixture() });
      }),
      post: (url, body) => {
        posts.push([url, body]);
        return Promise.resolve({ job: { id: "rj", status: "queued" } });
      },
    }),
  );
  page.onLoad({ id: "bs-1" });
  page.onShow();
  assert.equal(page.data.report, null);
  await flush();
  await flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0], "/v1/brainstorms/bs-1/report");
  assert.match(posts[0][1].clientId, /^report-/);
  assert.equal(posts[0][1].refresh, undefined);
  assert.equal(page.data.reportTask.job.id, "rj");
  assert.deepEqual(page.data.reportSteps.map((step) => step.key), ["write", "check"]);
  t.mock.timers.tick(1500);
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(page.data.reportLoading, false);
  assert.equal(page.data.reportTask, null);
  assert.deepEqual(
    page.data.report.map((section) => section.name),
    ["怎么连起来", "还能往哪想", "下一步"],
  );
  assert.deepEqual(page.data.report[0].items[0].cards.map((card) => card.id), ["c1", "c2"]);
  // V4.2 : a report that arrives while the groups are on screen leaves
  // them open (nothing jumps away mid-edit); they still fold on a tap.
  assert.equal(page.data.detailsOpen, true);
  page.toggleDetails();
  assert.equal(page.data.detailsOpen, false);
  // 和 AI 聊聊 carries the brainstorm and its first three cards.
  page.chat();
  assert.deepEqual(navigation.at(-1), ["navigate", "/pages/chat/index"]);
  assert.equal(app.globalData.chat.brainstormId, "bs-1");
  assert.deepEqual(app.globalData.chat.cards.map((card) => card.id), ["c1", "c2", "c3"]);
  page.onUnload();
});

test("process reuses a stored report or a running report job, and a failed one waits for 再试一次", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stored = readyFixture();
  stored.report = reportFixture();
  let posts = 0;
  const first = loadPage("process", pendingApi({
    get: () => Promise.resolve(stored),
    post: () => (posts++, Promise.resolve({ job: null })),
  }));
  first.page.onLoad({ id: "bs-1" });
  first.page.onShow();
  await flush();
  assert.equal(posts, 0);
  assert.equal(first.page.data.report.length, 3);
  assert.equal(first.page.data.reportTask, null);
  // Groups and comparisons fold under a report that was already there.
  assert.equal(first.page.data.detailsOpen, false);

  const running = readyFixture();
  running.reportJob = { id: "rj2", status: "running", progress: { stage: "write" } };
  const polled = [];
  const second = loadPage("process", pendingApi({
    get: (url) => {
      if (url === "/v1/jobs/rj2") {
        polled.push(url);
        return Promise.resolve({ id: "rj2", status: "failed", error: { message: "没想出来" } });
      }
      return Promise.resolve(running);
    },
    post: () => (posts++, Promise.resolve({ job: null })),
  }));
  second.page.onLoad({ id: "bs-1" });
  second.page.onShow();
  await flush();
  await flush();
  assert.equal(second.page.data.reportTask.job.progress.stage, "write");
  t.mock.timers.tick(1500);
  for (let i = 0; i < 4; i++) await flush();
  assert.deepEqual(polled, ["/v1/jobs/rj2"]);
  assert.equal(posts, 0);
  assert.equal(second.page.data.reportLoading, false);
  // The failed job stays on screen with its message and 重试.
  assert.equal(second.page.data.reportTask.job.status, "failed");
  assert.equal(second.page.data.reportTask.job.error.message, "没想出来");
  assert.equal(second.page.data.report, null);
  second.page.onUnload();

  const failed = readyFixture();
  failed.reportJob = { id: "rj3", status: "failed", error: { message: "没成功" } };
  const bodies = [];
  const third = loadPage("process", pendingApi({
    get: () => Promise.resolve(failed),
    post: (url, body) => (bodies.push(body), Promise.resolve({ job: null, report: reportFixture() })),
  }));
  third.page.onLoad({ id: "bs-1" });
  third.page.onShow();
  await flush();
  assert.equal(bodies.length, 0);
  assert.equal(third.page.data.reportTask.job.id, "rj3");
  await third.page.retryReport();
  assert.equal(bodies.length, 1);
  assert.equal(third.page.data.report.length, 3);
  assert.equal(third.page.data.reportTask, null);
});

test("the example shows no report and no chat, and the result page shows the report", () => {
  const example = loadPage("process", pendingApi({ post: () => assert.fail("no write") }));
  example.page.onLoad({ example: "1" });
  example.page.onShow();
  assert.equal(example.page.data.report, null);
  assert.equal(example.page.data.isExample, true);
  example.page.chat();
  assert.equal(example.app.globalData.chat, undefined);

  const fixture = readyFixture();
  fixture.status = "saved";
  fixture.report = reportFixture();
  fixture.report.sections.links = [];
  const { page, app } = loadPage("result", {});
  page.onLoad({ id: fixture.id });
  page.apply(fixture, [{ id: "out-1", type: "idea", scene: "study", title: "新卡", tags: [] }]);
  assert.deepEqual(page.data.report.map((section) => section.key), ["expand", "advice"]);
  page.chat();
  assert.equal(app.globalData.chat.brainstormId, "bs-1");
  fixture.report = { sections: { links: [], improve: [], expand: [], advice: [] } };
  page.apply(fixture, []);
  assert.equal(page.data.report, null);
});

test("report copy and actions stay on the brainstorm pages", () => {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const process = read("pages/brainstorm/process/index.wxml"),
    result = read("pages/brainstorm/result/index.wxml"),
    component = read("components/brainstorm-report/index.wxml");
  assert.match(process, /steps="\{\{reportSteps\}\}"/);
  assert.match(process, /重新看看/);
  assert.match(result, /steps="\{\{reportSteps\}\}"/);
  assert.match(result, /重新看看/);
  assert.match(process, /和 AI 聊聊/);
  assert.match(process, /写结论/);
  assert.match(process, /<brainstorm-report report="\{\{report\}\}"/);
  assert.match(result, /<brainstorm-report report="\{\{report\}\}"/);
  assert.match(component, /bindtap="openCard"/);
  for (const file of ["process", "result"]) {
    assert.match(read(`pages/brainstorm/${file}/index.json`), /components\/brainstorm-report\/index/);
    assert.match(read(`pages/brainstorm/${file}/index.json`), /components\/task-progress\/index/);
  }
});

test("the result page picks up a report that was still being written", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = readyFixture();
  fixture.status = "saved";
  fixture.outCardIds = [];
  fixture.reportJob = { id: "rj", status: "running" };
  let reads = 0;
  const { page } = loadPage("result", pendingApi({
    get: jobGet({ rj: { id: "rj", status: "succeeded" } }, () => {
      reads += 1;
      return Promise.resolve(reads === 1 ? fixture : { ...fixture, report: reportFixture(), reportJob: null });
    }),
  }));
  page.onLoad({ id: fixture.id });
  page.onShow();
  await flush();
  await flush();
  assert.equal(page.data.reportTask.job.id, "rj");
  t.mock.timers.tick(1500);
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(page.data.report.length, 3);
  assert.equal(page.data.reportTask, null);
  page.onUnload();
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");
const apiPath = path.join(root, "utils/api.js");
const gatePath = path.join(root, "utils/gate.js");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function load(file, api, app = { globalData: {} }, wxExtra = {}) {
  let page;
  global.Page = (value) => {
    page = value;
  };
  global.getApp = () => app;
  global.getCurrentPages = () => [];
  global.wx = {
    getStorageSync() {
      return null;
    },
    setNavigationBarColor() {},
    setBackgroundColor() {},
    showToast() {},
    showModal() {},
    navigateTo() {},
    navigateBack() {},
    switchTab() {},
    ...wxExtra,
  };
  delete require.cache[file];
  require.cache[gatePath] = {
    id: gatePath,
    filename: gatePath,
    loaded: true,
    exports: { state: () => "ok", check: () => true, ask() {} },
  };
  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: api,
  };
  require(file);
  page.data = structuredClone(page.data);
  page.setData = (patch) => Object.assign(page.data, patch);
  return page;
}

const card = (extra = {}) => ({
  id: "c",
  type: "question",
  scene: "study",
  title: "泰勒展开到几阶",
  titleBy: "ai",
  summary: "先核对展开阶数",
  summaryBy: "ai",
  mine: null,
  quote: "为什么要展开到三阶？",
  quoteOn: "2026-10-09",
  slots: [{ key: "ask", text: "该展开到几阶", by: "ai" }],
  open: [
    { key: "denominator", cat: "verify", text: "分母四阶怎么办", by: "ai" },
  ],
  next: null,
  organizedAt: null,
  closedAt: null,
  origin: "chat",
  srcId: "thread-1",
  messageId: "message-1",
  mistakeId: null,
  sawAnswer: false,
  useCount: 2,
  pointId: "limit-taylor",
  resume: "on",
  crisis: false,
  version: 2,
  createdAt: "2026-10-09T00:00:00Z",
  updatedAt: "2026-10-09T00:00:00Z",
  stage: "written",
  tags: [{ id: "tag-1", name: "极限", color: 0, by: "user" }],
  versions: [],
  links: [],
  uses: [],
  retest: null,
  followup: { q: "分母四阶时呢？", options: ["展开四阶", "展开五阶"] },
  aiJob: null,
  ...extra,
});

function cardApi(detail, hits = []) {
  return {
    get(url) {
      if (url === "/v1/tags")
        return Promise.resolve([
          { id: "tag-1", name: "极限", color: 0, by: "user" },
        ]);
      if (url === "/v1/learn/map")
        return Promise.resolve({
          chapters: [
            { points: [{ id: "limit-taylor", name: "泰勒公式求极限" }] },
          ],
        });
      return Promise.resolve(typeof detail === "function" ? detail() : detail);
    },
    post(url, body) {
      hits.push(["post", url, body]);
      return Promise.resolve({
        card: card({ version: body.version + 1 }),
        crisis: false,
      });
    },
    put(url, body) {
      hits.push(["put", url, body]);
      return Promise.resolve({});
    },
    patch(url, body) {
      hits.push(["patch", url, body]);
      return Promise.resolve({});
    },
    del(url, body) {
      hits.push(["delete", url, body]);
      return Promise.resolve({});
    },
    pending(job) {
      return Boolean(job && ["queued", "running"].includes(job.status));
    },
    waitJob(job) {
      return Promise.resolve(job);
    },
    jobMessage() {
      return "处理结果未知，重试可能再次产生调用费用";
    },
    needsConsent() {
      return false;
    },
  };
}

test("card detail consumes the flattened API contract and exposes real source fields", async () => {
  const p = load(path.join(root, "pages/card/index.js"), cardApi(card()));
  p.onLoad({ id: "c" });
  p.onShow();
  await flush();
  await flush();
  assert.equal(p.data.card.id, "c");
  assert.equal(p.data.card.messageId, "message-1");
  assert.equal(p.data.detail.sourceName, "聊天");
  assert.equal(p.data.detail.pointName, "泰勒公式求极限");
  // V4.2 FX5c : an AI tidy reads 已整理 here as on the wall.
  assert.deepEqual(p.data.card.stageDots, [true, true, false, false]);
  assert.equal(p.data.detail.slotsView[0].text, "该展开到几阶");
  assert.equal("label" in p.data.detail.slotsView[0], false);
});

test("card detail asks one thing at a time and the input appears only after 想到了", async () => {
  const hits = [],
    p = load(path.join(root, "pages/card/index.js"), cardApi(card(), hits));
  p.onLoad({ id: "c" });
  p.onShow();
  await flush();
  await flush();
  assert.deepEqual(
    p.data.detail.asks.map((item) => [item.kind, item.text]),
    [
      ["open", "分母四阶怎么办"],
      ["followup", "分母四阶时呢？"],
    ],
  );
  assert.equal(p.data.answering, "");
  p.startAnswer({ currentTarget: { dataset: { id: "denominator" } } });
  assert.equal(p.data.answering, "denominator");
  p.answerInput({
    currentTarget: { dataset: { id: "denominator" } },
    detail: { value: "先比一比阶数" },
  });
  await p.answer({
    currentTarget: {
      dataset: { kind: "open", key: "denominator", action: "done" },
    },
  });
  const hit = hits.find(([, url]) => url.endsWith("/answer"));
  assert.deepEqual(hit[2], {
    version: 2,
    kind: "open",
    key: "denominator",
    action: "done",
    text: "先比一比阶数",
  });
  assert.equal(p.data.answering, "");
  await p.answer({
    currentTarget: {
      dataset: { kind: "followup", key: "", action: "thinking" },
    },
  });
  assert.equal(hits.filter(([, url]) => url.endsWith("/answer")).length, 2);
  assert.equal(hits[hits.length - 1][2].text, undefined);
});

test("an answered AI follow-up is not asked again until the next tidy", async () => {
  const answered = card({
    versions: [
      {
        id: 3,
        kind: "followup",
        by: "user",
        data: { kind: "followup", action: "answer", text: "展开四阶" },
        createdAt: "2026-10-11T00:00:00Z",
      },
      {
        id: 2,
        kind: "slots",
        by: "ai",
        data: {},
        createdAt: "2026-10-10T00:00:00Z",
      },
    ],
  });
  let p = load(path.join(root, "pages/card/index.js"), cardApi(answered));
  p.onLoad({ id: "c" });
  p.onShow();
  await flush();
  await flush();
  assert.deepEqual(
    p.data.detail.asks.map((item) => item.kind),
    ["open"],
  );
  const retidied = card({
    versions: [
      {
        id: 4,
        kind: "slots",
        by: "ai",
        data: {},
        createdAt: "2026-10-12T00:00:00Z",
      },
      ...answered.versions,
    ],
  });
  p = load(path.join(root, "pages/card/index.js"), cardApi(retidied));
  p.onLoad({ id: "c" });
  p.onShow();
  await flush();
  await flush();
  assert.deepEqual(
    p.data.detail.asks.map((item) => item.kind),
    ["open", "followup"],
  );
});

test("my words open the input only on tap and short text explains the limit", async () => {
  const hits = [],
    p = load(path.join(root, "pages/card/index.js"), cardApi(card(), hits));
  p.onLoad({ id: "c" });
  p.onShow();
  await flush();
  await flush();
  assert.equal(p.data.mineEditing, false);
  p.editMine();
  assert.equal(p.data.mineEditing, true);
  // V4.2 G3 (intentional): two characters are enough; one is not.
  p.mineInput({ detail: { value: "短" } });
  await p.saveMine();
  assert.match(p.data.error, /再多写一个字/);
  assert.equal(hits.length, 0);
  p.cancelMine();
  assert.equal(p.data.mineEditing, false);
  assert.equal(p.data.error, "");
});

test("card detail bottom bar opens chat entries and folds the rest into ⋯", async () => {
  let opened, sheet;
  const app = { globalData: {} },
    p = load(path.join(root, "pages/card/index.js"), cardApi(card()), app, {
      navigateTo(value) {
        opened = value.url;
      },
      showActionSheet(options) {
        sheet = options;
      },
    });
  p.onLoad({ id: "c" });
  p.onShow();
  await flush();
  await flush();
  p.chat();
  assert.equal(opened, "/pages/chat/index");
  assert.equal(app.globalData.chat.cards[0].id, "c");
  assert.equal(app.globalData.chat.teach, undefined);
  p.teach();
  assert.equal(app.globalData.chat.teach, true);
  assert.equal(app.globalData.chat.scene, "study");
  p.openSource();
  assert.deepEqual(app.globalData.chat, {
    threadId: "thread-1",
    messageId: "message-1",
  });
  p.openActions();
  // A study card waits for a retest before it can be closed.
  assert.deepEqual(sheet.itemList, [
    "收藏",
    "再理一遍",
    "改一改",
    "连上另一张卡",
    "删掉这张",
  ]);
  p.data.detail = { ...p.data.detail, learning: false };
  assert.deepEqual(
    p.actionItems().map((item) => item[0]),
    ["收藏", "再理一遍", "改一改", "连上另一张卡", "想明白了，收好", "删掉这张"],
  );
  sheet.success({ tapIndex: 2 });
  assert.equal(p.data.edit, true);
  assert.equal(p.data.editMore, false);
});

test("mood cards have no 讲给 AI 听 and cannot be closed", async () => {
  const app = { globalData: {} },
    p = load(
      path.join(root, "pages/card/index.js"),
      cardApi(card({ scene: "mood", type: "idea", pointId: null })),
      app,
    );
  p.onLoad({ id: "c" });
  p.onShow();
  await flush();
  await flush();
  p.teach();
  assert.equal(app.globalData.chat, undefined);
  assert.equal(
    p.actionItems().some((item) => item[0] === "想明白了，收好"),
    false,
  );
});

test("learning method closure uses the server proof and explicit use action", async () => {
  const hits = [],
    p = load(
      path.join(root, "pages/card/index.js"),
      cardApi(
        card({
          type: "method",
          mine: "先把分子分母整理为同阶再计算",
          learningProofId: 17,
        }),
        hits,
      ),
    );
  p.onLoad({ id: "c" });
  p.onShow();
  await flush();
  await flush();
  p.toggleClose();
  assert.equal(p.data.closeOpen, true);
  await p.submitClose();
  const hit = hits.find(([, url]) => url.endsWith("/learning-close"));
  assert.ok(hit);
  assert.equal(hit[2].proofId, 17);
  assert.equal(hit[2].used, true);
  assert.equal(hit[2].version, 2);
  assert.equal(
    hits.some(([, url]) => url.endsWith("/close")),
    false,
  );
});

// V4.2 G3 (intentional): the editor sends only what changed, and the
// 以后还问你吗 row left the editor (the 之后 row on the card replaces it).
test("card editor sends only the changed slots and next step with the current version", async () => {
  const hits = [],
    p = load(path.join(root, "pages/card/index.js"), cardApi(card(), hits));
  p.onLoad({ id: "c" });
  p.onShow();
  await flush();
  await flush();
  p.openEditor();
  p.data.editor.nextIf = "复习到这里";
  p.data.editor.nextThen = "再做一道题";
  p.data.editor.nextOn = "2026-10-20";
  p.data.editor.slots[0].text = "该展开到第几阶";
  await p.saveEdit();
  const hit = hits.find(([method]) => method === "patch");
  assert.equal(hit[2].version, 2);
  assert.deepEqual(hit[2].slots, [{ key: "ask", text: "该展开到第几阶" }]);
  assert.deepEqual(hit[2].next, {
    if: "复习到这里",
    then: "再做一道题",
    on: "2026-10-20",
  });
  assert.deepEqual(Object.keys(hit[2]).sort(), ["next", "slots", "version"]);
});

test("answer only stores my words after a separate confirmation and uses the refreshed version", async () => {
  let current = card(),
    modal;
  const hits = [],
    api = cardApi(() => current, hits);
  api.post = (url, body) => {
    hits.push(["post", url, body]);
    if (url.endsWith("/answer")) {
      current = card({
        version: 3,
        organizedAt: "2026-10-12T00:00:00Z",
        stage: "organized",
      });
      return Promise.resolve({ card: current, crisis: false, offerMine: true });
    }
    current = card({ version: 4, mine: body.text, stage: "clear" });
    return Promise.resolve({ card: current, crisis: false });
  };
  const p = load(
    path.join(root, "pages/card/index.js"),
    api,
    { globalData: {} },
    {
      showModal(options) {
        modal = options;
      },
    },
  );
  p.onLoad({ id: "c" });
  p.onShow();
  await flush();
  await flush();
  p.data.answerDrafts.denominator = "我会先比较分母与余项的阶数";
  await p.answer({
    currentTarget: {
      dataset: { kind: "open", key: "denominator", action: "answer" },
    },
  });
  assert.equal(hits.filter(([, url]) => url.endsWith("/mine")).length, 0);
  modal.success({ confirm: true });
  await flush();
  await flush();
  const mine = hits.find(([, url]) => url.endsWith("/mine"));
  assert.equal(mine[2].version, 3);
  assert.equal(mine[2].text, "我会先比较分母与余项的阶数");
});

test("an unknown tidy result requires confirmation before retrying", async () => {
  let modal;
  const hits = [],
    api = cardApi(card({ aiJob: { id: "job-1", status: "unknown" } }), hits);
  api.post = (url, body) => {
    hits.push(["post", url, body]);
    return Promise.resolve({
      job: { id: "job-2", status: "succeeded" },
      reused: false,
    });
  };
  const p = load(
    path.join(root, "pages/card/index.js"),
    api,
    { globalData: {} },
    {
      showModal(options) {
        modal = options;
      },
    },
  );
  p.onLoad({ id: "c" });
  p.onShow();
  await flush();
  await flush();
  p.tidy();
  assert.equal(hits.length, 0);
  modal.success({ confirm: true });
  await flush();
  await flush();
  assert.equal(hits[0][2].retryUnknown, true);
});

test("a card still being tidied is followed until its tags arrive", async () => {
  let reads = 0,
    waits = 0;
  const api = cardApi(() =>
    ++reads === 1
      ? card({ tags: [], aiJob: { id: "job-1", status: "running" } })
      : card({ aiJob: { id: "job-1", status: "succeeded" } }),
  );
  api.waitJob = (job) => {
    waits++;
    return Promise.resolve({ ...job, status: "succeeded" });
  };
  const p = load(path.join(root, "pages/card/index.js"), api);
  p.onLoad({ id: "c" });
  p.onShow();
  for (let i = 0; i < 6; i++) await flush();
  assert.equal(waits, 1);
  assert.equal(p.data.card.tags[0].name, "极限");
  assert.equal(p.data.busy, false);
});

test("example cards are read-only and never call the API", () => {
  let calls = 0;
  const api = cardApi(card());
  api.get = () => {
    calls++;
    return Promise.resolve(card());
  };
  const p = load(path.join(root, "pages/card/index.js"), api);
  p.onLoad({ example: "example-question" });
  p.onShow();
  assert.equal(p.data.example, true);
  assert.equal(p.data.card.id, "example-question");
  assert.equal(calls, 0);
  p.saveMine();
  p.tidy();
  p.remove();
  assert.equal(calls, 0);
});

test("tag editing sends the selected one of eight colors and preserves input on failure", async () => {
  const file = path.join(root, "pages/tags/index.js"),
    calls = [];
  const api = {
    get: () =>
      Promise.resolve([
        { id: "t", name: "极限", color: 0, by: "ai", count: 2 },
      ]),
    post: () => Promise.resolve({}),
    patch: (url, body) => {
      calls.push([url, body]);
      return Promise.reject(new Error("暂时失败"));
    },
    del: () => Promise.resolve({}),
    needsConsent: () => false,
  };
  const p = load(file, api);
  p.onShow();
  await flush();
  p.startEdit({ currentTarget: { dataset: { tag: p.data.tags[0] } } });
  p.editInput({ detail: { value: "泰勒" } });
  p.editColor({ currentTarget: { dataset: { color: 7 } } });
  await p.saveEdit();
  assert.deepEqual(calls[0][1], { name: "泰勒", color: 7 });
  assert.equal(p.data.editName, "泰勒");
  assert.equal(p.data.editColor, 7);
  assert.equal(p.data.error, "暂时失败");
});

test("tags list comes first, creating opens on demand, and both palettes show color names", async () => {
  const fs = require("node:fs"),
    file = path.join(root, "pages/tags/index.js"),
    posts = [];
  let modal;
  const api = {
    get: () =>
      Promise.resolve([
        { id: "t", name: "极限", color: 0, by: "ai", count: 2 },
      ]),
    post: (url, body) => {
      posts.push(body);
      return Promise.resolve({});
    },
    patch: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
    needsConsent: () => false,
  };
  const p = load(file, api, undefined, {
    showModal(options) {
      modal = options;
    },
  });
  p.onShow();
  await flush();
  assert.equal(p.data.creating, false);
  p.startCreate();
  assert.equal(p.data.creating, true);
  await p.create();
  assert.equal(p.data.error, "先写个名字");
  p.input({ detail: { value: "泰勒" } });
  await p.create();
  assert.deepEqual(posts[0], { name: "泰勒", color: 0 });
  assert.equal(p.data.creating, false);
  p.remove({ currentTarget: { dataset: { tag: p.data.tags[0] } } });
  assert.match(modal.content, /#极限/);
  const wxml = fs.readFileSync(
    path.join(root, "pages/tags/index.wxml"),
    "utf8",
  );
  assert.match(wxml, /\{\{tone\.name\}\}/);
  assert.doesNotMatch(wxml, /tone\.index\+1/);
  assert.match(wxml, /AI 加的/);
  assert.doesNotMatch(wxml, /大模型/);
  assert.ok(wxml.indexOf('wx:for="{{tags}}"') < wxml.indexOf("tag-create"));
});

function withConsent(run) {
  const authPath = path.join(root, "utils/auth.js"),
    saved = require.cache[authPath];
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: { hasConsent: () => true, getUser: () => ({ id: "one" }) },
  };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (saved) require.cache[authPath] = saved;
      else delete require.cache[authPath];
    });
}

test("collect keeps the wrap draft on 关闭 and asks for consent instead of failing silently", async () => {
  const posts = [];
  let backs = 0;
  const draft = {
    id: "wrap-1",
    summary: "小结",
    cards: [{ key: "main", type: "idea", title: "原题", selected: true }],
    next: { if: "明天复习", then: "做两道题" },
  };
  const app = {
    globalData: {
      collect: { mode: "wrap", threadId: "thread-1", draft, quotes: [] },
    },
  };
  const p = load(
    path.join(root, "pages/collect/index.js"),
    {
      post: (url, body) => {
        posts.push([url, body]);
        return Promise.resolve({});
      },
      needsConsent: () => false,
    },
    app,
    {
      navigateBack() {
        backs++;
      },
    },
  );
  p.onLoad();
  assert.equal(p.data.mineOpen, false);
  assert.equal(p.data.nextOpen, false);
  assert.equal(p.data.cards[0].typeName, "想法");
  p.cardInput({
    currentTarget: { dataset: { index: 0, key: "title" } },
    detail: { value: "改过的标题" },
  });
  p.close();
  assert.equal(posts.length, 0);
  assert.equal(backs, 1);
  const back = app.globalData.collect;
  assert.equal(back.mode, "wrap");
  assert.equal(back.draft.id, "wrap-1");
  assert.equal(back.draft.cards[0].title, "改过的标题");
  assert.equal(back.draft.cards[0].typeName, undefined);
  assert.deepEqual(back.draft.next, { if: "明天复习", then: "做两道题" });
  p.data.consent = false;
  p.save();
  assert.equal(posts.length, 0);
  assert.match(p.data.error, /同意/);
});

test("collect lets the server choose the card type and shows the point by name", () =>
  withConsent(async () => {
    const posts = [];
    const app = {
      globalData: {
        collect: {
          mode: "message",
          threadId: "thread-1",
          messageId: "m1",
          scene: "study",
          quote: "为什么要展开到三阶？",
          pointId: "limit-taylor",
        },
      },
    };
    const p = load(
      path.join(root, "pages/collect/index.js"),
      {
        get: () =>
          Promise.resolve({
            chapters: [
              { points: [{ id: "limit-taylor", name: "泰勒公式求极限" }] },
            ],
          }),
        post: (url, body) => {
          posts.push(body);
          return Promise.resolve({ card: { id: "c" } });
        },
        needsConsent: () => false,
      },
      app,
    );
    p.onLoad();
    p.onShow();
    await flush();
    assert.equal(p.data.typeName, "AI 帮你挑");
    assert.equal(p.data.pointName, "泰勒公式求极限");
    p.toggle({ currentTarget: { dataset: { key: "pointOff" } } });
    await p.save();
    // V4.2 G3 (intentional): the picked kind goes as kind.
    assert.equal(posts[0].kind, undefined);
    assert.equal(posts[0].pointId, undefined);
    p.chooseType({ currentTarget: { dataset: { type: "method" } } });
    assert.equal(p.data.typeName, "思路");
    p.toggle({ currentTarget: { dataset: { key: "pointOff" } } });
    await p.save();
    assert.equal(posts[1].kind, "method");
    assert.equal(posts[1].pointId, "limit-taylor");
  }));

test("card retest receipt keeps uncertain and absent predictions distinct and opens map focus", () => {
  let url;
  const p = load(path.join(root, "pages/card/index.js"), {}, undefined, {
    navigateTo: (value) => {
      url = value.url;
    },
  });
  assert.match(
    p.retestText({
      due_on: "2026-10-14",
      result: "wrong",
      predicted: "unsure",
    }),
    /10.14.*没把握.*没做出/,
  );
  assert.doesNotMatch(
    p.retestText({ result: "right", predicted: null }),
    /你预测/,
  );
  assert.match(
    p.retestText({ result: "hinted", predicted: "yes" }),
    /看过提示/,
  );
  assert.equal(p.retestText({ state: "dropped" }), "");
  p.data.card = card();
  p.openPoint();
  assert.equal(url, "/pages/map/index?id=limit-taylor");
});

test("short dates read on the Beijing calendar", () => {
  const { monthDay } = require(path.join(root, "utils/format.js"));
  assert.equal(monthDay("2026-10-04T23:30:00.000Z"), "10/5");
  assert.equal(monthDay("2026-10-05T15:59:00.000Z"), "10/5");
  assert.equal(monthDay("2026-10-05"), "10/5");
  assert.equal(monthDay("10-05"), "10/5");
  assert.equal(monthDay(""), "");
});

test("supplements list under the card, save with one clientId per draft and reload on a stale version", async () => {
  const hits = [];
  let failNext = false;
  const api = cardApi(
    card({
      createdAt: "2026-10-09T01:05:00Z",
      supplements: [{ text: "后来发现要先换元", createdAt: "2026-10-10T02:00:00Z" }],
      // AI words moved here by a type change or a merge, shown with them.
      aiSupplements: [{ text: "步骤：先换元", by: "ai", createdAt: "2026-10-09T02:00:00Z" }],
      versions: [{ id: "v1", kind: "supplement", by: "user", data: { text: "后来发现要先换元" }, createdAt: "2026-10-10T02:00:00Z" }],
    }),
    hits,
  );
  const post = api.post;
  api.post = (url, body) => {
    if (failNext) {
      failNext = false;
      hits.push(["post", url, body]);
      return Promise.reject(Object.assign(new Error("改过了"), { code: "CARD_CHANGED" }));
    }
    return post(url, body);
  };
  const p = load(path.join(root, "pages/card/index.js"), api);
  p.onLoad({ id: "c" });
  p.onShow();
  await flush();
  await flush();
  assert.equal(p.data.detail.savedAt, "2026-10-09 09:05");
  assert.equal(p.data.detail.versions[0].label, "补充了一句");
  assert.deepEqual(
    p.data.detail.supplements.map((item) => [item.date, item.text, item.ai]),
    [
      ["10/9", "步骤：先换元", true],
      ["10/10", "后来发现要先换元", false],
    ],
  );
  const wxml = require("node:fs").readFileSync(path.join(root, "pages/card/index.wxml"), "utf8");
  assert.match(
    wxml,
    /wx:for="\{\{detail\.supplements\}\}"[^]*?<text wx:if="\{\{item\.ai\}\}" class="ai-dot">/,
  );
  p.openSupplement();
  p.supplementInput({ detail: { value: "  还要注意定义域  " } });
  failNext = true;
  await p.saveSupplement();
  await flush();
  assert.match(p.data.error, /刚有变化/);
  assert.equal(p.data.supplementDraft, "  还要注意定义域  ");
  await p.saveSupplement();
  await flush();
  const sent = hits.filter((hit) => hit[1] === "/v1/cards/c/supplements");
  assert.equal(sent.length, 2);
  assert.equal(sent[1][2].text, "还要注意定义域");
  assert.equal(sent[1][2].version, 2);
  assert.equal(sent[0][2].clientId, sent[1][2].clientId);
  assert.equal(p.data.supplementOpen, false);
  // Older servers send no supplements.
  const old = load(path.join(root, "pages/card/index.js"), cardApi(card()));
  old.onLoad({ id: "c" });
  old.onShow();
  await flush();
  await flush();
  assert.deepEqual(old.data.detail.supplements, []);
  assert.equal(old.data.detail.remindText, "不提醒");
});

test("下次提醒 shows my date or the automatic one and saves only the date", async () => {
  const hits = [];
  const p = load(
    path.join(root, "pages/card/index.js"),
    cardApi(card({ nextResumeOn: "2030-01-05" }), hits),
  );
  p.onLoad({ id: "c" });
  p.onShow();
  await flush();
  await flush();
  assert.equal(p.data.detail.remindOn, "2030-01-05");
  assert.equal(p.data.detail.remindText, "1月5日");
  assert.match(p.data.today, /^\d{4}-\d{2}-\d{2}$/);
  await p.remindChange({ detail: { value: "2030-02-01" } });
  assert.deepEqual(hits.at(-1), [
    "patch",
    "/v1/cards/c",
    { version: 2, remindOn: "2030-02-01" },
  ]);
  await p.clearRemind();
  // V4.2 G3 (intentional): 不提醒 also stops the repeat.
  assert.deepEqual(hits.at(-1)[2], { version: 2, remindOn: null, resume: "off", remindEvery: null });
  const mine = load(
    path.join(root, "pages/card/index.js"),
    cardApi(card({ remindOn: "2030-03-01", nextResumeOn: "2030-01-05" }), hits),
  );
  mine.onLoad({ id: "c" });
  mine.onShow();
  await flush();
  await flush();
  assert.equal(mine.data.detail.remindOn, "2030-03-01");
  await mine.clearRemind();
  assert.deepEqual(hits.at(-1)[2], { version: 2, remindOn: null, resume: "off", remindEvery: null });
});

test("收藏 in the card's ⋯ menu flips the favorite without a version", async () => {
  const hits = [];
  const p = load(path.join(root, "pages/card/index.js"), cardApi(card({ favorite: true }), hits));
  p.onLoad({ id: "c" });
  p.onShow();
  await flush();
  await flush();
  assert.equal(p.actionItems()[0][0], "取消收藏");
  await p.toggleFavorite();
  assert.deepEqual(hits.at(-1), ["put", "/v1/cards/c/favorite", { favorite: false }]);
});

test("tags page: a 收藏 row when the server counts favorites, and rows open 随心记 filtered", async () => {
  const app = { globalData: {} },
    tabs = [];
  const api = {
    get: (url) =>
      Promise.resolve(
        url === "/v1/cards/stats"
          ? { total: 3, favorites: 2 }
          : [{ id: "t", name: "极限", color: 0, by: "ai", count: 2 }],
      ),
    needsConsent: () => false,
  };
  const p = load(path.join(root, "pages/tags/index.js"), api, app, {
    switchTab: (value) => tabs.push(value.url),
  });
  p.onShow();
  await flush();
  await flush();
  assert.equal(p.data.favorites, 2);
  p.openFavorites();
  assert.deepEqual(app.globalData.cardFilter, { favorite: true });
  p.openTag({ currentTarget: { dataset: { tag: p.data.tags[0] } } });
  assert.deepEqual(app.globalData.cardFilter, { tag: "t", tagName: "极限" });
  assert.deepEqual(tabs, ["/pages/deck/index", "/pages/deck/index"]);
  // An older server has no count: the row stays hidden.
  api.get = (url) =>
    Promise.resolve(url === "/v1/cards/stats" ? { total: 3 } : []);
  p.onShow();
  await flush();
  await flush();
  assert.equal(p.data.favorites, null);
});

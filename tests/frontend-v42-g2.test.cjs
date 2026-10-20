"use strict";
// V4.2 G2 · 导入: seven kinds on the confirm page, editable summaries and
// segments, drafts that survive leaving, the text past the limit, PDF start
// page, and the capture page's late result. Synthetic data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function put(modulePath, exports) {
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
}
function setPath(target, key, value) {
  const parts = key.split(".");
  let current = target;
  for (let i = 0; i < parts.length - 1; i++) current = current[parts[i]] = current[parts[i]] || {};
  current[parts.at(-1)] = value;
}
const apiBase = {
  pending: (job) => Boolean(job && ["queued", "running"].includes(job.status)),
  jobMessage: (job) => (job && job.error && job.error.message) || "处理失败，请重试",
  needsConsent: () => false,
  get: () => Promise.resolve(null),
  post: () => Promise.reject(new Error("unexpected")),
  patch: () => Promise.resolve({}),
  del: () => Promise.resolve({}),
  uploadTo: () => Promise.reject(new Error("unexpected")),
};
// One storage shared by the page instances of a test, like the phone's.
function loadPage(file, api, { storage = new Map(), wxExtra = {} } = {}) {
  let definition;
  const navigation = [];
  global.Page = (value) => {
    definition = value;
  };
  global.getApp = () => ({ globalData: {} });
  global.wx = {
    getStorageSync: (key) => (storage.has(key) ? storage.get(key) : ""),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: (key) => storage.delete(key),
    setNavigationBarTitle() {},
    showToast() {},
    navigateTo: (value) => navigation.push(["navigate", value.url]),
    redirectTo: (value) => navigation.push(["redirect", value.url]),
    switchTab: (value) => navigation.push(["tab", value.url]),
    navigateBack: () => navigation.push(["back"]),
    showModal: ({ success }) => success && success({ confirm: true }),
    ...wxExtra,
  };
  put(path.join(root, "utils/api.js"), { ...apiBase, ...api });
  put(path.join(root, "utils/auth.js"), { getUser: () => ({ id: "u1" }), hasConsent: () => true });
  put(path.join(root, "utils/gate.js"), { state: () => "ok", check: () => true, ask() {} });
  put(path.join(root, "utils/format.js"), {
    errorText: (error) => error.message || "失败",
    countChars: (text) => String(text || "").replace(/\s/g, "").length,
  });
  for (const name of [file, "pages/import/view.js", "utils/pick.js"])
    delete require.cache[path.join(root, name)];
  require(path.join(root, file));
  definition.data = structuredClone(definition.data);
  definition.setData = (patch) =>
    Object.entries(patch).forEach(([key, value]) =>
      key.includes(".") ? setPath(definition.data, key, value) : (definition.data[key] = value),
    );
  return { page: definition, navigation, storage };
}

function picking(candidates, segments) {
  return {
    id: "imp-g2",
    source: "paste",
    own: true,
    status: "picking",
    segments: segments || [
      { n: 1, text: "极限的定义要会写。数列极限用 ε-N 语言描述，函数极限用 ε-δ 语言描述。" },
      { n: 2, text: "下周三前把第一章习题做完。" },
      { n: 3, text: "别人的一句话。" },
    ],
    candidates,
    job: null,
  };
}
const CANDIDATES = [
  { id: "c1", type: "method", kind: "knowledge", scene: "study", title: "极限的定义", summary: "数列和函数极限的两种写法", src: [1], tags: [] },
  { id: "c2", type: "idea", kind: "todo", scene: "study", title: "做完第一章习题", summary: "下周三前完成", src: [2], tags: [] },
];

test("view: seven kinds, the kind shown on a candidate, sentences of a text", () => {
  global.wx = { getStorageSync: () => "" };
  delete require.cache[path.join(root, "pages/import/view.js")];
  const view = require(path.join(root, "pages/import/view.js"));
  assert.deepEqual(Object.keys(view.TYPES), ["spark", "idea", "question", "method", "todo", "knowledge", "note"]);
  assert.equal(view.KIND_TYPE.knowledge, "method");
  const shown = view.candidateView(CANDIDATES[0], {}, true, false);
  assert.equal(shown.typeName, "知识点");
  assert.equal(shown.kind, "knowledge");
  assert.match(shown.typeIcon, /card-knowledge/);
  // A candidate split before V4.2 has only its type.
  assert.equal(view.candidateView({ type: "question", src: [] }).typeName, "问题");
  assert.deepEqual(view.sentences("第一句。第二句！\n第三句"), ["第一句。", "第二句！", "第三句"]);
  // Storage that throws is not an error.
  global.wx = {
    getStorageSync() {
      throw new Error("no storage");
    },
    setStorageSync() {
      throw new Error("full");
    },
  };
  assert.equal(view.draftGet("source", "u1"), null);
  view.draftSet("source", "u1", { text: "x" });
});

test("confirm page: kind, scene and source on each card; kind and summary can be changed and are sent", async () => {
  const posts = [];
  const fixture = picking(CANDIDATES);
  const h = loadPage("pages/import/split/index.js", {
    get: () => Promise.resolve(fixture),
    post: (url, body) => {
      posts.push([url, body]);
      return Promise.resolve({ import: { ...fixture, status: "saved" }, cards: [{ id: "k1" }, { id: "k2" }] });
    },
  });
  h.page.onLoad({ id: fixture.id });
  h.page.onShow();
  await flush();
  const [first, second] = h.page.data.candidates;
  assert.equal(first.typeName, "知识点");
  assert.equal(first.sceneName, "学习");
  assert.equal(first.srcLabel, "出自第 1 段");
  assert.equal(second.typeName, "待办");
  assert.deepEqual(h.page.data.typeChoices.map((choice) => choice.name), ["灵感", "想法", "问题", "思路", "待办", "知识点", "随手记"]);
  h.page.openEdit({ currentTarget: { dataset: { id: "c1" } } });
  assert.equal(h.page.data.edit.kind, "knowledge");
  h.page.chooseType({ currentTarget: { dataset: { id: "question" } } });
  h.page.editSummary({ detail: { value: "两种极限定义各自怎么写" } });
  h.page.saveEdit();
  assert.equal(h.page.data.candidates[0].typeName, "问题");
  assert.equal(h.page.data.candidates[0].summary, "两种极限定义各自怎么写");
  await h.page.saveCards();
  const [changed, untouched] = posts[0][1].selections;
  assert.deepEqual(changed, {
    candidateId: "c1",
    type: "question",
    kind: "question",
    summary: "两种极限定义各自怎么写",
    scene: "study",
  });
  // An untouched candidate: its four-way type, the server keeps its kind.
  assert.deepEqual(untouched, { candidateId: "c2", type: "idea", scene: "study" });
  const wxml = fs.readFileSync(path.join(root, "pages/import/split/index.wxml"), "utf8");
  assert.match(wxml, /class="kind-chip">\{\{item\.typeName\}\}/);
  assert.match(wxml, /bindinput="editSummary"/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, "pages/import/split/index.wxss"), "utf8"),
    /\.candidate-summary \{[^}]*nowrap/,
  );
});

test("confirm page: edits and ticks survive leaving and come back; saving clears them", async () => {
  const storage = new Map();
  const fixture = picking(CANDIDATES);
  const api = {
    get: () => Promise.resolve(fixture),
    post: (url) =>
      Promise.resolve(
        url.endsWith("/rest")
          ? { import: { id: "imp-next", status: "read" } }
          : { import: { ...fixture, status: "saved" }, cards: [{ id: "k1" }] },
      ),
  };
  const first = loadPage("pages/import/split/index.js", api, { storage });
  first.page.onLoad({ id: fixture.id });
  first.page.onShow();
  await flush();
  first.page.openEdit({ currentTarget: { dataset: { id: "c2" } } });
  first.page.editTitle({ detail: { value: "周三前做完习题" } });
  first.page.saveEdit();
  first.page.toggleCandidate({ currentTarget: { dataset: { id: "c1" } } });
  first.page.onUnload();
  assert.ok(storage.has("zhiye_import_pick:imp-g2:u1"));

  const again = loadPage("pages/import/split/index.js", api, { storage });
  again.page.onLoad({ id: fixture.id });
  again.page.onShow();
  await flush();
  assert.deepEqual(Array.from(again.page.selected), ["c2"]);
  assert.equal(again.page.data.candidates[1].title, "周三前做完习题");
  assert.equal(again.page.data.own, true);
  await again.page.saveCards();
  assert.equal(storage.has("zhiye_import_pick:imp-g2:u1"), false);
  // After saving, the text past the limit can still be imported next.
  again.page.adopt({ ...fixture, status: "saved", restChars: 800 });
  await again.page.importRest();
  assert.deepEqual(again.navigation.at(-1), ["redirect", "/pages/import/source/index?id=imp-next"]);
});

test("我的话 offers only sentences of the card's own text, 10–300 characters", async () => {
  const fixture = picking(
    CANDIDATES.concat({ id: "c3", type: "idea", scene: "life", title: "一句话", summary: "很短", src: [3], tags: [] }),
  );
  const h = loadPage("pages/import/split/index.js", { get: () => Promise.resolve(fixture) });
  h.page.onLoad({ id: fixture.id });
  h.page.onShow();
  await flush();
  h.page.chooseMine({ currentTarget: { dataset: { id: "c1" } } });
  assert.deepEqual(
    h.page.data.sourceSheet.lines.map((line) => line.text),
    ["数列极限用 ε-N 语言描述，函数极限用 ε-δ 语言描述。"],
  );
  h.page.selectSourceLine({ currentTarget: { dataset: { i: 0, n: 1 } } });
  assert.equal(h.page.edits.c1.mine, "数列极限用 ε-N 语言描述，函数极限用 ε-δ 语言描述。");
  // Nothing fits: says so instead of a list that fails on save.
  h.page.chooseMine({ currentTarget: { dataset: { id: "c3" } } });
  assert.equal(h.page.data.sourceSheet.empty, true);
  assert.equal(h.page.data.sourceSheet.emptyText, "这张卡的原文里没有合适的句子");
});

test("a sentence picked by hand: one sentence, a title within 16 characters, kind confirmed", async () => {
  const posts = [];
  const fixture = picking([], [
    { n: 1, text: "导数是函数在一点处变化快慢的度量，几何上是切线的斜率。求导之前先看定义域。" },
  ]);
  const h = loadPage("pages/import/split/index.js", {
    get: () => Promise.resolve(fixture),
    post: (url, body) => {
      posts.push(body);
      return Promise.resolve({ import: { ...fixture, status: "saved" }, cards: [{ id: "m1" }] });
    },
  });
  h.page.onLoad({ id: fixture.id });
  h.page.onShow();
  await flush();
  h.page.startManual();
  assert.equal(h.page.data.sourceSheet.lines.length, 2);
  h.page.selectSourceLine({ currentTarget: { dataset: { i: 1 } } });
  // The sheet opens to confirm the kind.
  assert.equal(h.page.data.edit.id, "manual-1-1");
  h.page.chooseType({ currentTarget: { dataset: { id: "method" } } });
  h.page.saveEdit();
  // Picking another sentence replaces the first (one is saved at a time).
  h.page.startManual();
  h.page.selectSourceLine({ currentTarget: { dataset: { i: 0 } } });
  h.page.closeEdit();
  assert.equal(h.page.rawCandidates.length, 1);
  h.page.startManual();
  h.page.selectSourceLine({ currentTarget: { dataset: { i: 1 } } });
  h.page.chooseType({ currentTarget: { dataset: { id: "todo" } } });
  h.page.saveEdit();
  await h.page.saveCards();
  const [selection] = posts[0].selections;
  assert.equal(posts[0].selections.length, 1);
  assert.equal(selection.quote, "求导之前先看定义域。");
  assert.equal(selection.kind, "todo");
  assert.equal(selection.type, "idea");
  assert.ok(selection.title.length <= 16);
});

test("read text: a segment opens in full, can be fixed, split at a blank line, merged or dropped", async () => {
  const patches = [];
  const item = {
    id: "imp-r",
    source: "paste",
    status: "read",
    chars: 30,
    segments: [
      { n: 1, text: "第一段原文。" },
      { n: 2, text: "第二段原文，写错了一个字。" },
      { n: 3, text: "第三段原文。" },
    ],
    pages: [],
    job: null,
  };
  const h = loadPage("pages/import/source/index.js", {
    get: () => Promise.resolve(item),
    patch: (url, body) => {
      patches.push(body);
      return Promise.resolve({ import: item });
    },
  });
  h.page.onLoad({ id: item.id });
  h.page.onShow();
  await flush();
  h.page.openSegment({ currentTarget: { dataset: { n: 2 } } });
  assert.equal(h.page.data.segmentEdit.text, "第二段原文，写错了一个字。");
  h.page.segmentInput({ detail: { value: "第二段原文，改好了。\n\n后半段单独成段。" } });
  await h.page.saveSegment();
  assert.deepEqual(patches[0].segments, [
    { text: "第一段原文。", from: 1 },
    { text: "第二段原文，改好了。", from: 2 },
    { text: "后半段单独成段。", from: 2 },
    { text: "第三段原文。", from: 3 },
  ]);
  h.page.openSegment({ currentTarget: { dataset: { n: 3 } } });
  await h.page.mergeSegment();
  assert.deepEqual(patches[1].segments, [
    { text: "第一段原文。", from: 1 },
    { text: "第二段原文，写错了一个字。\n第三段原文。", from: 2 },
  ]);
  h.page.openSegment({ currentTarget: { dataset: { n: 1 } } });
  await h.page.dropSegment();
  assert.deepEqual(patches[2].segments.map((segment) => segment.from), [2, 3]);
  const wxml = fs.readFileSync(path.join(root, "pages/import/source/index.wxml"), "utf8");
  assert.match(wxml, /bindtap="openSegment"/);
  assert.match(wxml, /空一行就分成两段/);
  assert.doesNotMatch(wxml, /18000/);
});

test("the text past the limit is offered as the next import; unread formula pictures are named", async () => {
  const posts = [];
  const item = {
    id: "imp-long",
    source: "docx",
    fileName: "讲义.docx",
    status: "read",
    chars: 19800,
    truncated: true,
    limit: 20000,
    restChars: 1200,
    unread: { formulas: 2, images: 1 },
    segments: [{ n: 1, text: "很长的讲义。" }],
    pages: [],
    job: null,
  };
  const h = loadPage("pages/import/source/index.js", {
    get: () => Promise.resolve(item),
    post: (url, body) => {
      posts.push([url, body]);
      return Promise.resolve({ import: { ...item, id: "imp-next", restChars: 0, truncated: false, unread: null } });
    },
  });
  h.page.onLoad({ id: item.id });
  h.page.onShow();
  await flush();
  assert.match(h.page.data.keptLine, /还剩 1200 字/);
  assert.equal(h.page.data.restLine, "接着导剩下的");
  assert.equal(h.page.data.unreadLine, "有 2 个公式是图片格式，没读出来，1 张图片没读");
  await h.page.importRest();
  assert.equal(posts[0][0], "/v1/imports/imp-long/rest");
  assert.match(posts[0][1].clientId, /^rest-/);
  assert.equal(h.page.data.item.id, "imp-next");
  assert.equal(h.page.data.keptLine, "");
});

test("a PDF waits for its start page; past 20 pages it goes on from the next page", async () => {
  const uploads = [];
  const h = loadPage(
    "pages/import/source/index.js",
    {
      uploadTo: (url) => {
        uploads.push(url);
        return Promise.resolve({
          import: {
            id: `pdf-${uploads.length}`,
            source: "pdf",
            fileName: "课本.pdf",
            status: "read",
            truncated: uploads.length === 1,
            pageRange: uploads.length === 1 ? { from: 3, to: 22 } : { from: 23, to: 30 },
            segments: [{ n: 1, text: "一页正文。" }],
            pages: [],
            job: null,
          },
        });
      },
    },
    {
      wxExtra: {
        chooseMessageFile: ({ success }) =>
          success({ tempFiles: [{ name: "课本.pdf", path: "book.pdf", size: 100 }] }),
      },
    },
  );
  h.page.onLoad({});
  h.page.onShow();
  await h.page.chooseFile();
  assert.equal(uploads.length, 0, "nothing is read before 开始读");
  h.page.startInput({ detail: { value: "3" } });
  await h.page.readSource();
  assert.match(uploads[0], /start=3/);
  assert.equal(h.page.data.keptLine, "读到第 22 页为止");
  assert.equal(h.page.data.nextPage, 23);
  await h.page.readMore();
  assert.match(uploads[1], /start=23/);
  assert.equal(h.page.data.item.id, "pdf-2");
});

test("pasted text and photos already sent survive leaving the page", async () => {
  const storage = new Map();
  const first = loadPage("pages/import/source/index.js", {}, { storage });
  first.page.onLoad({});
  first.page.onShow();
  first.page.textInput({ detail: { value: "一段还没读的笔记" } });
  first.page.onHide();
  const back = loadPage("pages/import/source/index.js", {}, { storage });
  back.page.onLoad({});
  back.page.onShow();
  assert.equal(back.page.data.text, "一段还没读的笔记");
  // Up to 60000 characters can be pasted; past 20000 the counter says what happens.
  back.page.textInput({ detail: { value: "字".repeat(61000) } });
  assert.equal(back.page.data.text.length, 60000);
  const wxml = fs.readFileSync(path.join(root, "pages/import/source/index.wxml"), "utf8");
  assert.match(wxml, /maxlength="60000"/);
  assert.match(wxml, /charCount>20000/);

  // Two photos: the first is sent, then the page is closed.
  const photoStorage = new Map();
  const uploads = [];
  let fail = true;
  const api = {
    uploadTo: (url) => {
      uploads.push(url);
      if (url.includes("index=1") && fail) return Promise.reject(new Error("网络断开"));
      return Promise.resolve({ import: { id: "imp-p", source: "photo", status: "reading", segments: [], pages: [], job: null } });
    },
  };
  const photos = loadPage("pages/import/source/index.js", api, {
    storage: photoStorage,
    wxExtra: {
      chooseMedia: ({ success }) =>
        success({ tempFiles: [{ tempFilePath: "p1.jpg", size: 10 }, { tempFilePath: "p2.jpg", size: 10 }] }),
    },
  });
  photos.page.onLoad({});
  photos.page.onShow();
  await photos.page.choosePhotos({ currentTarget: { dataset: { source: "photo" } } });
  photos.page.onUnload();
  const cid = new URLSearchParams(uploads[0].split("?")[1]).get("clientId");
  fail = false;
  const resumed = loadPage("pages/import/source/index.js", api, { storage: photoStorage });
  resumed.page.onLoad({});
  resumed.page.onShow();
  assert.equal(resumed.page.data.files.length, 2);
  // V4.2 FX1 (intentional): the rest is sent by itself, no 开始读 needed.
  await flush();
  // Only the missing photo is sent, under the same clientId.
  assert.equal(uploads.length, 3);
  assert.match(uploads[2], /index=1&count=2/);
  assert.equal(new URLSearchParams(uploads[2].split("?")[1]).get("clientId"), cid);
  assert.equal(photoStorage.size, 0, "the draft is gone once read");
});

test("capture: a late result does not replace the page that is open now; long text goes to 导入", async () => {
  let resolve;
  const storage = new Map();
  const h = loadPage(
    "pages/capture/index.js",
    { post: () => new Promise((done) => (resolve = done)), upload: () => Promise.reject(new Error("x")) },
    { storage },
  );
  h.page.onLoad({ kind: "note" });
  h.page.onShow();
  h.page.useText();
  h.page.onText({ detail: { value: "一段要学的资料" } });
  h.page.submit();
  h.page.onUnload();
  resolve({ id: "m1" });
  await flush();
  assert.deepEqual(h.navigation, []);
  // Typed text comes back after leaving without sending.
  const typed = loadPage("pages/capture/index.js", {}, { storage });
  typed.page.onLoad({ kind: "note" });
  typed.page.onText({ detail: { value: "没发出去的资料" } });
  typed.page.onUnload();
  const back = loadPage("pages/capture/index.js", {}, { storage });
  back.page.onLoad({ kind: "note" });
  assert.equal(back.page.data.text, "没发出去的资料");
  assert.equal(back.page.data.mode, "text");
  back.page.openImport();
  assert.deepEqual(back.navigation, [["navigate", "/pages/import/source/index"]]);
  assert.equal(storage.get("zhiye_import_source:u1").text, "没发出去的资料");
});

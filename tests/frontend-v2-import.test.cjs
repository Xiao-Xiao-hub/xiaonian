"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");

function put(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}
function setPath(target, key, value) {
  const parts = key.split(".");
  let current = target;
  for (let i = 0; i < parts.length - 1; i++)
    current = current[parts[i]] = current[parts[i]] || {};
  current[parts.at(-1)] = value;
}
function loadPage(name, api, wxExtra = {}) {
  let definition;
  let user = { id: "u1" };
  const navigation = [];
  const app = { globalData: {} };
  global.Page = (value) => {
    definition = value;
  };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: () => "",
    setNavigationBarColor() {},
    setBackgroundColor() {},
    showToast() {},
    navigateTo: (value) => navigation.push(["navigate", value.url]),
    redirectTo: (value) => navigation.push(["redirect", value.url]),
    switchTab: (value) => navigation.push(["tab", value.url]),
    navigateBack: () => navigation.push(["back"]),
    showModal: ({ success }) => success && success({ confirm: true }),
    ...wxExtra,
  };
  put(path.join(root, "utils/api.js"), api);
  put(path.join(root, "utils/auth.js"), {
    getUser: () => user,
    hasConsent: () => true,
  });
  put(path.join(root, "utils/theme.js"), { themed: (value) => value });
  put(path.join(root, "utils/gate.js"), { state: () => "ok", check: () => true, ask() {} });
  put(path.join(root, "utils/format.js"), {
    errorText: (error) => error.message || "失败",
    countChars: (text) => String(text || "").replace(/\s/g, "").length,
  });
  const file = path.join(root, `pages/import/${name}/index.js`);
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
    app,
    navigation,
    setUser(value) {
      user = value;
    },
  };
}

const apiBase = {
  pending: (job) => Boolean(job && ["queued", "running"].includes(job.status)),
  jobMessage: (job) =>
    (job && job.error && job.error.message) || "处理失败，请重试",
  needsConsent: () => false,
  del: () => Promise.resolve({ deleted: true }),
  patch: () => Promise.resolve({}),
};

test("source page uploads 1-3 photos one by one with a stable client and keeps the read result", async () => {
  const uploads = [];
  const fixture = {
    id: "imp-1",
    source: "photo",
    status: "read",
    chars: 12,
    segments: [{ n: 1, text: "左右极限相等" }],
    pages: [{ n: 1, ok: true }],
    job: null,
  };
  const api = {
    ...apiBase,
    post: () => Promise.reject(new Error("unexpected")),
    get: () => Promise.resolve(fixture),
    uploadTo(url, filePath) {
      uploads.push([url, filePath]);
      return Promise.resolve({
        import:
          uploads.length === 2
            ? fixture
            : { ...fixture, status: "reading", job: null },
      });
    },
  };
  const { page } = loadPage("source", api, {
    chooseMedia({ success }) {
      success({
        tempFiles: [
          { tempFilePath: "a.jpg", size: 1024 },
          { tempFilePath: "b.jpg", size: 2048 },
        ],
      });
    },
  });
  page.onLoad({});
  page.onShow();
  // Picking starts reading by itself; no second tap.
  await page.choosePhotos({ currentTarget: { dataset: { source: "photo" } } });
  assert.equal(uploads.length, 2);
  assert.match(uploads[0][0], /source=photo&index=0&count=2&own=0$/);
  assert.match(uploads[1][0], /source=photo&index=1&count=2&own=0$/);
  assert.equal(
    new URL(`https://local${uploads[0][0]}`).searchParams.get("clientId"),
    new URL(`https://local${uploads[1][0]}`).searchParams.get("clientId"),
  );
  assert.equal(page.data.item.segments[0].text, "左右极限相等");
  assert.equal(page.data.files.length, 2);
});

test("source page keeps a detail response that arrives while hidden (V4.1) and preserves pasted input on failure", async () => {
  let resolveDetail;
  const detail = new Promise((resolve) => {
    resolveDetail = resolve;
  });
  const api = {
    ...apiBase,
    get: () => detail,
    post: () => Promise.reject(new Error("网络断开")),
    uploadTo: () => Promise.reject(new Error("unexpected")),
  };
  const { page } = loadPage("source", api);
  page.onLoad({ id: "imp-late" });
  page.onShow();
  page.textInput({ detail: { value: "原来的文字" } });
  page.onHide();
  resolveDetail({ id: "imp-late", status: "read", segments: [] });
  await detail;
  await new Promise((resolve) => setImmediate(resolve));
  // Hiding (a picker, the app in the background) no longer drops it.
  assert.equal(page.data.item.id, "imp-late");
  page.importId = "";
  page.onShow();
  await page.readSource();
  assert.equal(page.data.text, "原来的文字");
  assert.match(page.data.error, /网络断开/);
});

function pickingFixture(candidates) {
  return {
    id: "imp-2",
    source: "text",
    fileName: "高数笔记",
    own: false,
    status: "picking",
    segments: [
      { n: 1, text: "可去间断点左右极限相等" },
      { n: 2, text: "先做基础题" },
    ],
    candidates,
    job: null,
  };
}

test("split page edits a selected candidate, confirms the point and sends only an explicit mine quote", async () => {
  const calls = [];
  const fixture = pickingFixture([
    {
      id: "cand-1",
      type: "question",
      scene: "study",
      title: "可去间断点怎么判断",
      summary: "左右极限存在且相等",
      src: [1],
      tags: ["极限"],
      pointId: "p-1",
      pointName: "间断点及其分类",
      pointConfidence: 0.9,
      selected: true,
      crisis: false,
    },
    { id: "risk", crisis: true, selected: true, src: [] },
  ]);
  const api = {
    ...apiBase,
    get: () => Promise.resolve(fixture),
    post(url, body) {
      calls.push([url, body]);
      return Promise.resolve({
        import: { ...fixture, status: "saved" },
        cards: [{ id: "card-1" }],
        crisis: false,
      });
    },
  };
  const { page } = loadPage("split", api);
  page.onLoad({ id: fixture.id });
  page.alive = true;
  page.epoch = 1;
  await page.load();
  assert.deepEqual(Array.from(page.selected), ["cand-1"]);
  page.toggleOwn({ detail: { value: true } });
  page.openEdit({ currentTarget: { dataset: { id: "cand-1" } } });
  page.editTitle({ detail: { value: "我改过的判断方法" } });
  page.editTags({ detail: { value: "极限，间断点" } });
  page.saveEdit();
  page.acceptPoint({ currentTarget: { dataset: { id: "cand-1" } } });
  page.chooseMine({ currentTarget: { dataset: { id: "cand-1" } } });
  page.selectSourceLine({ currentTarget: { dataset: { n: 1 } } });
  await page.saveCards();
  const selection = calls[0][1].selections[0];
  assert.deepEqual(selection, {
    candidateId: "cand-1",
    type: "question",
    scene: "study",
    title: "我改过的判断方法",
    tags: ["极限", "间断点"],
    mine: "可去间断点左右极限相等",
    pointId: "p-1",
  });
  assert.equal(page.data.savedCards[0].id, "card-1");
});

test("zero-card imports can save an exact source quote as a manual candidate", async () => {
  const calls = [];
  const fixture = pickingFixture([]);
  const api = {
    ...apiBase,
    get: () => Promise.resolve(fixture),
    post(url, body) {
      calls.push([url, body]);
      return Promise.resolve({
        import: { ...fixture, status: "saved" },
        cards: [{ id: "manual-card" }],
        crisis: false,
      });
    },
  };
  const { page } = loadPage("split", api);
  page.onLoad({ id: fixture.id });
  page.alive = true;
  page.epoch = 1;
  await page.load();
  page.startManual();
  page.selectSourceLine({ currentTarget: { dataset: { n: 2 } } });
  await page.saveCards();
  const selection = calls[0][1].selections[0];
  assert.equal(selection.quote, "先做基础题");
  assert.equal(selection.candidateId, undefined);
  assert.equal(selection.type, "spark");
});

test("import pages keep final limits, source citations, AI marks and background-return copy", () => {
  const source = fs.readFileSync(
    path.join(root, "pages/import/source/index.wxml"),
    "utf8",
  );
  const sourceJs = fs.readFileSync(
    path.join(root, "pages/import/source/index.js"),
    "utf8",
  );
  const split = fs.readFileSync(
    path.join(root, "pages/import/split/index.wxml"),
    "utf8",
  );
  // Limits show where they matter: the photo menu, errors and the PDF row.
  for (const text of ["20 页", "20000"]) assert.match(source, new RegExp(text));
  for (const text of ["3 张", "5 MB", "10 MB"])
    assert.match(sourceJs, new RegExp(text));
  assert.match(source, /placeholder="把要整理的东西贴进来"/);
  assert.match(source, /或者拍照、选文件 ›/);
  assert.match(source, /下一步：拆成卡/);
  // The character count appears once.
  assert.equal(source.match(/item\.chars/g).length, 1);
  assert.match(source, /可以先离开/);
  assert.match(split, /srcLabel/);
  const { candidateView, pageLine, jobLine } = require(
    path.join(root, "pages/import/view.js"),
  );
  assert.equal(pageLine({ pageRange: { from: 3, to: 5 } }), "第 3–5 页");
  assert.equal(
    candidateView({ src: [2, 4] }, {}, true, false).srcLabel,
    "出自第 2、4 段",
  );
  assert.doesNotMatch(
    jobLine({ progress: { chars: 300, expect: 900, thinking: true } }, "split"),
    /\d/,
  );
  assert.match(split, /ai-dot/);
  assert.match(split, /从原文选一句/);
  assert.match(split, /原文是我自己写的/);
  assert.match(split, /这段在聊/);
  assert.doesNotMatch(split, /场景|#[0-9a-fA-F]{3,6}/);
  // Card faces carry the check, title, summary, 改 › and  the
  // kind, scene and source line; tags, points and 我的话 stay in 改 ›.
  const face = split.slice(
    split.indexOf('class="candidate-list"'),
    // the split wait is <task-progress> now.
    split.indexOf("<task-progress"),
  );
  assert.doesNotMatch(face, /tags|pointName|acceptMood|chooseMine/);
  assert.match(face, /typeName/);
});

test("source page offers photos, screenshots and files from one line", () => {
  const picks = [];
  const { page } = loadPage("source", apiBase, {
    showActionSheet({ itemList, success }) {
      assert.equal(itemList.length, 3);
      success({ tapIndex: picks.length === 0 ? 1 : 2 });
    },
    chooseMedia(options) {
      picks.push(["media", options.sourceType.join(",")]);
    },
    chooseMessageFile() {
      picks.push(["file"]);
    },
  });
  page.onLoad({});
  page.onShow();
  page.chooseSource();
  page.chooseSource();
  assert.deepEqual(picks, [["media", "album"], ["file"]]);
});

test("a chat file is routed by its extension and reading starts right away", async () => {
  const uploads = [],
    toasts = [];
  let picked;
  const api = {
    ...apiBase,
    get: () => Promise.resolve(null),
    uploadTo(url) {
      uploads.push(url);
      return Promise.resolve({ import: { id: "imp", status: "reading", job: null } });
    },
  };
  const { page } = loadPage("source", api, {
    chooseMessageFile(options) {
      assert.equal(options.type, "all");
      assert.equal(options.extension, undefined);
      options.success({ tempFiles: [picked] });
    },
    showToast: (value) => toasts.push(value.title),
  });
  page.onLoad({});
  page.onShow();
  picked = { name: "聊天.png", path: "a.png", size: 10 };
  await page.chooseFile();
  assert.match(uploads[0], /^\/v1\/imports\/photo\?.*source=screenshot&index=0&count=1/);
  page.importId = "";
  page.setData({ item: null, files: [] });
  picked = { name: "笔记.docx", path: "b.docx", size: 10 };
  await page.chooseFile();
  assert.match(uploads[1], /^\/v1\/imports\/file\?/);
  page.importId = "";
  page.setData({ item: null, files: [] });
  picked = { name: "表.xlsx", path: "c.xlsx", size: 10 };
  await page.chooseFile();
  assert.equal(uploads.length, 2);
  assert.deepEqual(toasts, ["只支持图片、txt、md、docx、pdf"]);
});

test("pickers explain a denied permission or a missing privacy declaration and stay quiet on cancel", async () => {
  const modals = [];
  let errMsg;
  const { page } = loadPage(
    "source",
    { ...apiBase, get: () => Promise.resolve(null) },
    {
      chooseMedia: ({ fail }) => fail({ errMsg }),
      chooseMessageFile: ({ fail }) => fail({ errMsg }),
      showModal: (value) => modals.push(value.content),
    },
  );
  page.onLoad({});
  page.onShow();
  errMsg = "chooseMedia:fail cancel";
  await page.choosePhotos({ currentTarget: { dataset: { source: "photo" } } });
  assert.equal(modals.length, 0);
  errMsg = "chooseMedia:fail auth deny";
  await page.choosePhotos({ currentTarget: { dataset: { source: "photo" } } });
  errMsg = "chooseMessageFile:fail api scope is not declared in the privacy agreement";
  await page.chooseFile();
  assert.deepEqual(modals, [
    "没能打开相册或文件，去右上角 ⋯ → 设置 里看看权限",
    "小程序还没开通这项权限，先用粘贴文字",
  ]);
  for (const name of ["pages/ask/index.js", "pages/capture/index.js"])
    assert.match(
      fs.readFileSync(path.join(root, name), "utf8"),
      /chooseMedia\(\{[\s\S]*?fail: pickFailed/,
    );
});

test("opening import with pick= opens that picker exactly once", () => {
  const picks = [];
  const { page } = loadPage("source", apiBase, {
    chooseMedia: (options) => picks.push(["media", options.sourceType.join(",")]),
    chooseMessageFile: () => picks.push(["file"]),
  });
  page.onLoad({ pick: "photo" });
  page.onShow();
  page.onReady();
  page.onReady();
  page.onLoad({ pick: "file" });
  page.onReady();
  page.onReady();
  page.onLoad({});
  page.onReady();
  assert.deepEqual(picks, [["media", "album,camera"], ["file"]]);
});

test("split asks once after saving whether to file the cards under their points", async () => {
  const fixture = pickingFixture([
    {
      id: "c1",
      type: "question",
      scene: "study",
      title: "可去间断点",
      summary: "左右极限相等",
      src: [1],
      tags: [],
      pointId: "p-1",
      pointName: "间断点及其分类",
      pointConfidence: 0.9,
    },
    {
      id: "c2",
      type: "idea",
      scene: "study",
      title: "先做基础题",
      summary: "顺序",
      src: [2],
      tags: [],
      pointId: "p-2",
      pointConfidence: 0.3,
    },
  ]);
  const patches = [];
  const api = {
    ...apiBase,
    get: async () => fixture,
    patch: async (url, body) => {
      patches.push([url, body]);
      return {};
    },
    post: async () => ({
      import: {
        ...fixture,
        status: "saved",
        candidates: fixture.candidates.map((candidate, index) => ({
          ...candidate,
          savedCardId: `card-${index + 1}`,
        })),
      },
      cards: [
        { id: "card-1", version: 1, title: "可去间断点", pointId: null },
        { id: "card-2", version: 1, title: "先做基础题", pointId: null },
      ],
    }),
  };
  const { page } = loadPage("split", api);
  page.onLoad({ id: fixture.id });
  page.alive = true;
  page.epoch = 1;
  await page.load();
  // 原文是我自己写的 is a tap toggle inside 改 ›.
  page.toggleOwn({});
  assert.equal(page.data.own, true);
  page.toggleOwn({});
  assert.equal(page.data.own, false);
  await page.saveCards();
  assert.deepEqual(
    page.data.pointAsk.map((entry) => [entry.cardId, entry.pointName]),
    [["card-1", "间断点及其分类"]],
  );
  await page.acceptPoints();
  assert.deepEqual(patches, [
    ["/v1/cards/card-1", { version: 1, pointId: "p-1" }],
  ]);
  assert.equal(page.data.pointAsk.length, 0);
  assert.equal(page.data.pointsDone, true);
  // Reopening a saved import does not ask again.
  page.adopt({ ...fixture, status: "saved" });
  assert.equal(page.data.pointAsk.length, 0);
});

test("unedited AI fields keep provenance, own changes persist before save, and restored saved cards remain available", async () => {
  const fixture = pickingFixture([
    {
      id: "c1",
      type: "idea",
      scene: "life",
      title: "AI起草标题",
      summary: "摘要",
      src: [1],
      tags: ["极限"],
    },
  ]);
  const calls = [];
  const api = {
    ...apiBase,
    get: async () => fixture,
    patch: async (url, body) => {
      calls.push(["own", body]);
      return { import: { ...fixture, own: body.own } };
    },
    post: async (url, body) => {
      calls.push(["save", body]);
      return {
        import: { ...fixture, status: "saved", savedCards: [{ id: "card-1" }] },
        cards: [{ id: "card-1" }],
      };
    },
  };
  const { page } = loadPage("split", api);
  page.onLoad({ id: fixture.id });
  page.alive = true;
  page.epoch = 1;
  await page.load();
  page.toggleOwn({ detail: { value: true } });
  await page.saveCards();
  assert.equal(calls[0][0], "own");
  const pick = calls[1][1].selections[0];
  assert.equal(pick.title, undefined);
  assert.equal(pick.tags, undefined);
  page.adopt({ ...fixture, status: "saved", savedCards: [{ id: "card-1" }] });
  assert.equal(page.data.savedCards[0].id, "card-1");
});

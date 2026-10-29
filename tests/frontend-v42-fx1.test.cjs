"use strict";
// client fixes from the independent review — imports left while
// sending, 随心记's box and its chat line, chats deleted or switched while a
// reply comes, and receipts that follow what the option did. Synthetic data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../miniprogram");
const file = (name) => path.join(root, name);
const read = (name) => fs.readFileSync(file(name), "utf8");
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
};

function put(name, exports) {
  const p = file(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
function setPath(target, key, value) {
  const parts = key.split(".");
  let current = target;
  for (let i = 0; i < parts.length - 1; i++) current = current[parts[i]] = current[parts[i]] || {};
  current[parts.at(-1)] = value;
}

// ---- the import pages ----------------------------------------------------------
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
// One storage shared by the page instances of a test, like the phone's. `gone`
// lists the picked files no longer on the phone.
function loadPage(name, api, { storage = new Map(), gone = [], wxExtra = {} } = {}) {
  let definition;
  const navigation = [];
  const modals = [];
  global.Page = (value) => {
    definition = value;
  };
  global.getApp = () => ({ globalData: {} });
  global.wx = {
    getStorageSync: (key) => (storage.has(key) ? storage.get(key) : ""),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: (key) => storage.delete(key),
    getFileSystemManager: () => ({
      accessSync(p) {
        if (gone.includes(p)) throw new Error("no such file");
      },
    }),
    setNavigationBarTitle() {},
    showToast() {},
    navigateTo: (value) => navigation.push(["navigate", value.url]),
    redirectTo: (value) => navigation.push(["redirect", value.url]),
    switchTab: (value) => navigation.push(["tab", value.url]),
    navigateBack: () => navigation.push(["back"]),
    showModal: (options) => {
      modals.push(options);
      if (options.success) options.success({ confirm: true });
    },
    ...wxExtra,
  };
  put("utils/api.js", { ...apiBase, ...api });
  put("utils/auth.js", { getUser: () => ({ id: "u1" }), hasConsent: () => true });
  put("utils/gate.js", { state: () => "ok", check: () => true, ask() {} });
  put("utils/format.js", {
    errorText: (error) => error.message || "失败",
    countChars: (text) => String(text || "").replace(/\s/g, "").length,
    monthDay: (value) => (String(value || "").match(/^\d{4}-(\d{2})-(\d{2})/) || []).slice(1).map(Number).join("/"),
  });
  for (const n of [name, "pages/import/view.js", "utils/pick.js", "utils/job.js"]) delete require.cache[file(n)];
  require(file(name));
  definition.data = structuredClone(definition.data);
  definition.setData = (patch) =>
    Object.entries(patch).forEach(([key, value]) =>
      key.includes(".") ? setPath(definition.data, key, value) : (definition.data[key] = value),
    );
  return { page: definition, navigation, storage, modals };
}
const query = (url) => new URLSearchParams(url.split("?")[1]);
const PICKED = [
  { path: "p1.jpg", name: "图片 1", size: 10, sizeText: "10 B", ext: "IMG" },
  { path: "p2.jpg", name: "图片 2", size: 10, sizeText: "10 B", ext: "IMG" },
  { path: "p3.jpg", name: "图片 3", size: 10, sizeText: "10 B", ext: "IMG" },
];
// An import still waiting for pictures: page 1 arrived, 2 and 3 never did.
const stuck = (extra = {}) => ({
  id: "imp-s",
  source: "photo",
  status: "reading",
  segments: [],
  pages: [1, 2, 3].map((n) => ({ n, scan: true, ok: false })),
  received: [1],
  job: null,
  failedJob: null,
  needsOcr: { pages: 3, available: 20 },
  retryPages: 1,
  ...extra,
});
const reading = { ...stuck(), received: [1, 2, 3], job: { id: "job-1", kind: "import_read", status: "queued" } };

test("item 1: left while sending, the pictures go on by themselves (from the page and from 随心记)", async () => {
  // The first page sends picture 1, then is closed while picture 2 is on its way.
  const storage = new Map();
  const uploads = [];
  let hold;
  const first = loadPage(
    "pages/import/source/index.js",
    {
      uploadTo: (url) => {
        uploads.push(url);
        if (query(url).get("index") === "1") return new Promise((resolve) => (hold = resolve));
        return Promise.resolve({ import: stuck() });
      },
    },
    {
      storage,
      wxExtra: {
        chooseMedia: ({ success }) =>
          success({ tempFiles: PICKED.map((f) => ({ tempFilePath: f.path, size: 10 })) }),
      },
    },
  );
  first.page.onLoad({});
  first.page.onShow();
  first.page.choosePhotos({ currentTarget: { dataset: { source: "photo" } } });
  await flush();
  assert.equal(uploads.length, 2);
  // Not "可以先离开" while the pictures are being sent.
  assert.equal(first.page.data.sending, true);
  assert.match(read("pages/import/source/index.wxml"), /<text wx:if="\{\{!sending\}\}" class="progress-note">可以先离开/);
  first.page.onUnload();
  hold({ import: stuck() });
  await flush();
  const cid = query(uploads[0]).get("clientId");
  const kept = storage.get("zhiye_import_source:u1");
  assert.deepEqual(kept.upload, { cid, source: "photo", done: 1, id: "imp-s" });
  assert.equal(kept.files.length, 3);

  // Back from 随心记's strip (?id=): the missing two go, same clientId; no 认这几页.
  const sent = [];
  const back = loadPage(
    "pages/import/source/index.js",
    {
      get: (url) => Promise.resolve(url === "/v1/imports/imp-s" ? stuck() : { items: [] }),
      uploadTo: (url) => {
        sent.push(url);
        return Promise.resolve({ import: query(url).get("index") === "2" ? reading : stuck({ received: [1, 2] }) });
      },
    },
    { storage },
  );
  back.page.onLoad({ id: "imp-s" });
  back.page.onShow();
  await flush();
  assert.deepEqual(sent.map((url) => query(url).get("index")), ["1", "2"]);
  assert.ok(sent.every((url) => query(url).get("clientId") === cid));
  assert.equal(back.modals.length, 0, "no 认这几页 / 跳过 for pictures that never arrived");
  assert.equal(back.page.importId, "imp-s");
  assert.equal(back.page.data.task.job.id, "job-1");
  assert.equal(storage.has("zhiye_import_source:u1"), false, "the draft goes once reading started");

  // Back to the page itself (no id), with the draft: the rest goes without 开始读.
  storage.set("zhiye_import_source:u1", { ...kept, upload: { ...kept.upload, done: 2 } });
  const again = [];
  const self = loadPage(
    "pages/import/source/index.js",
    {
      get: () => Promise.resolve({ items: [] }),
      uploadTo: (url) => {
        again.push(url);
        return Promise.resolve({ import: reading });
      },
    },
    { storage },
  );
  self.page.onLoad({});
  self.page.onShow();
  await flush();
  assert.deepEqual(again.map((url) => query(url).get("index")), ["2"]);
  assert.equal(query(again[0]).get("clientId"), cid);
  assert.equal(self.page.data.task.job.id, "job-1");

  // The server lost what it had (kept an hour): every missing page goes again.
  storage.set("zhiye_import_source:u1", { ...kept, upload: { ...kept.upload, done: 2 } });
  const all = [];
  const late = loadPage(
    "pages/import/source/index.js",
    {
      get: () => Promise.resolve(stuck({ received: [] })),
      uploadTo: (url) => {
        all.push(url);
        return Promise.resolve({ import: reading });
      },
    },
    { storage },
  );
  late.page.onLoad({ id: "imp-s" });
  late.page.onShow();
  await flush();
  assert.deepEqual(all.map((url) => query(url).get("index")), ["0", "1", "2"]);
});

test("item 1: the pictures are gone from the phone — the import is given up and they are picked again", async () => {
  const storage = new Map();
  storage.set("zhiye_import_source:u1", {
    text: "",
    sourceType: "photo",
    files: PICKED,
    startPage: 1,
    upload: { cid: "c-1", source: "photo", done: 1, id: "imp-s" },
  });
  const posts = [];
  let picked = 0;
  const h = loadPage(
    "pages/import/source/index.js",
    {
      get: () => Promise.resolve(stuck()),
      post: (url) => {
        posts.push(url);
        return Promise.resolve({ import: stuck({ status: "abandoned" }) });
      },
      uploadTo: () => Promise.reject(new Error("nothing is sent")),
    },
    {
      storage,
      gone: ["p2.jpg"],
      wxExtra: {
        chooseMedia: ({ fail }) => {
          picked++;
          fail({ errMsg: "chooseMedia:fail cancel" });
        },
      },
    },
  );
  h.page.onLoad({ id: "imp-s" });
  h.page.onShow();
  await flush();
  assert.deepEqual(posts, ["/v1/imports/imp-s/abandon"], "abandoned first");
  assert.equal(h.modals.length, 0, "no 认这几页 / 跳过");
  assert.equal(h.page.data.item, null);
  assert.equal(h.page.data.repick, "photo");
  assert.equal(h.page.data.files.length, 0);
  assert.equal(h.page.importId, "");
  assert.equal(storage.get("zhiye_import_source:u1").upload, null);
  await h.page.repickPhotos();
  assert.equal(picked, 1, "the picker opens again");
  const wxml = read("pages/import/source/index.wxml");
  assert.match(wxml, /上次的图片没传完，再选一次吧。<text wx:if="\{\{!busy\}\}" class="link" bindtap="repickPhotos">重新选<\/text>/);

  // No draft on this phone at all (another phone, or cleared): the same.
  const bare = new Map();
  const posted = [];
  const other = loadPage(
    "pages/import/source/index.js",
    {
      get: () => Promise.resolve(stuck({ source: "screenshot" })),
      post: (url) => {
        posted.push(url);
        return Promise.resolve({});
      },
    },
    { storage: bare },
  );
  other.page.onLoad({ id: "imp-s" });
  other.page.onShow();
  await flush();
  assert.deepEqual(posted, ["/v1/imports/imp-s/abandon"]);
  assert.equal(other.page.data.repick, "screenshot");

  // From the page itself after a restart: files gone, the known import is given up.
  const restart = new Map([
    [
      "zhiye_import_source:u1",
      { text: "一段贴好的字", sourceType: "photo", files: PICKED, startPage: 1, upload: { cid: "c-1", source: "photo", done: 1, id: "imp-s" } },
    ],
  ]);
  const dropped = [];
  const self = loadPage(
    "pages/import/source/index.js",
    {
      get: () => Promise.resolve({ items: [] }),
      post: (url) => {
        dropped.push(url);
        return Promise.resolve({});
      },
    },
    { storage: restart, gone: ["p1.jpg", "p2.jpg", "p3.jpg"] },
  );
  self.page.onLoad({});
  self.page.onShow();
  await flush();
  assert.deepEqual(dropped, ["/v1/imports/imp-s/abandon"]);
  assert.equal(self.page.data.repick, "photo");
  assert.equal(self.page.data.text, "一段贴好的字", "pasted words stay");
  assert.equal(restart.get("zhiye_import_source:u1").files.length, 0);
});

test("item 1: an import whose pictures all arrived keeps the old flow; the strip says when pictures did not", async () => {
  const h = loadPage("pages/import/source/index.js", {
    get: () => Promise.resolve(stuck({ received: [1, 2, 3], retryPages: 3 })),
  });
  h.page.onLoad({ id: "imp-s" });
  h.page.onShow();
  await flush();
  assert.equal(h.modals.length, 1, "all there: 认这几页 as before");
  assert.equal(h.page.data.repick, "");

  global.Component = () => {};
  put("utils/api.js", apiBase);
  put("utils/gate.js", { state: () => "ok" });
  delete require.cache[file("components/task-strip/index.js")];
  const { stripRows } = require(file("components/task-strip/index.js"));
  const rows = stripRows(
    {
      items: [
        { id: "a", status: "reading", source: "photo", title: "错题", pages: { done: 0, total: 3 }, retryPages: 1, job: null, updatedAt: "2" },
        { id: "b", status: "reading", source: "photo", title: "笔记", pages: { done: 1, total: 3 }, retryPages: 2, job: { kind: "import_read", status: "unknown" }, updatedAt: "1" },
      ],
    },
    null,
  );
  assert.deepEqual(rows.map((row) => row.state), ["图片没传完，点开接着传", "没跑完，点开重试"]);
});

test("item 11: text or a file sent again before an answer keeps its clientId, also after leaving", async () => {
  const storage = new Map();
  const posts = [];
  let fail = true;
  const api = {
    get: () => Promise.resolve({ items: [] }),
    post: (url, body) => {
      posts.push(body);
      if (fail) return Promise.reject(new Error("网络断开"));
      return Promise.resolve({ import: { id: "imp-t", source: "paste", status: "read", segments: [{ n: 1, text: "一段笔记" }], pages: [] } });
    },
  };
  const first = loadPage("pages/import/source/index.js", api, { storage });
  first.page.onLoad({});
  first.page.onShow();
  first.page.textInput({ detail: { value: "一段笔记" } });
  await first.page.readSource();
  await first.page.readSource();
  assert.equal(posts[0].clientId, posts[1].clientId);
  first.page.onUnload();
  // Left and back: the same clientId from the draft.
  const back = loadPage("pages/import/source/index.js", api, { storage });
  back.page.onLoad({});
  back.page.onShow();
  fail = false;
  await back.page.readSource();
  assert.equal(posts[2].clientId, posts[0].clientId);
  assert.equal(back.page.data.item.id, "imp-t");
  assert.equal(storage.has("zhiye_import_source:u1"), false);
  // Other words are another import.
  fail = true;
  const next = loadPage("pages/import/source/index.js", api, { storage });
  next.page.onLoad({});
  next.page.onShow();
  next.page.textInput({ detail: { value: "另一段" } });
  await next.page.readSource();
  next.page.textInput({ detail: { value: "另一段，改过" } });
  await next.page.readSource();
  assert.notEqual(posts[3].clientId, posts[0].clientId);
  assert.notEqual(posts[4].clientId, posts[3].clientId);

  // A file: the same clientId on retry; another start page is another import.
  const files = [];
  const doc = loadPage(
    "pages/import/source/index.js",
    {
      get: () => Promise.resolve({ items: [] }),
      uploadTo: (url) => {
        files.push(query(url));
        return Promise.reject(new Error("网络断开"));
      },
    },
    { storage: new Map() },
  );
  doc.page.onLoad({});
  doc.page.onShow();
  doc.page.useFile({ tempFiles: [{ name: "笔记.pdf", path: "n.pdf", size: 100 }] }, doc.page.epoch, "u1");
  await doc.page.readSource();
  await doc.page.readSource();
  assert.equal(files[0].get("clientId"), files[1].get("clientId"));
  doc.page.startInput({ detail: { value: "3" } });
  await doc.page.readSource();
  assert.notEqual(files[2].get("clientId"), files[0].get("clientId"));
});

test("item 9: 用导入整理这段 does not replace a draft that is still on its way", () => {
  const storage = new Map();
  const load = () => {
    const h = loadPage("pages/capture/index.js", {}, { storage });
    h.page.account = "u1";
    h.page.setData({ text: "资料里的一段话" });
    return h;
  };
  const sending = { text: "", sourceType: "photo", files: PICKED, startPage: 1, upload: { cid: "c", source: "photo", done: 1, id: "imp-s" } };
  storage.set("zhiye_import_source:u1", sending);
  load().page.openImport();
  assert.deepEqual(storage.get("zhiye_import_source:u1"), sending);
  const waiting = { text: "发出去还没回的字", sourceType: "text", files: [], startPage: 1, pending: { cid: "t", kind: "text" } };
  storage.set("zhiye_import_source:u1", waiting);
  load().page.openImport();
  assert.deepEqual(storage.get("zhiye_import_source:u1"), waiting);
  // Words only: this goes after them, once.
  storage.set("zhiye_import_source:u1", { text: "之前贴的", sourceType: "text", files: [], startPage: 1, own: true });
  const h = load();
  h.page.openImport();
  h.page.openImport();
  assert.equal(storage.get("zhiye_import_source:u1").text, "之前贴的\n\n资料里的一段话");
  assert.equal(storage.get("zhiye_import_source:u1").own, true);
  storage.delete("zhiye_import_source:u1");
  load().page.openImport();
  assert.equal(storage.get("zhiye_import_source:u1").text, "资料里的一段话");
});

test("item 10: the pick draft goes when the import is given up, saved elsewhere or deleted", async () => {
  const storage = new Map([["zhiye_import_pick:imp-9:u1", { edits: {}, selected: ["c1"] }]]);
  const h = loadPage(
    "pages/import/source/index.js",
    {
      get: () => Promise.resolve({ items: [{ id: "imp-9", status: "picking", title: "错题" }] }),
      post: () => Promise.resolve({ import: { id: "imp-9", status: "abandoned" } }),
    },
    { storage },
  );
  h.page.onLoad({});
  h.page.onShow();
  await flush();
  await h.page.resumeDrop();
  assert.equal(storage.has("zhiye_import_pick:imp-9:u1"), false);

  for (const status of ["saved", "abandoned"]) {
    storage.set("zhiye_import_pick:imp-9:u1", { edits: {}, selected: ["c1"] });
    const split = loadPage(
      "pages/import/split/index.js",
      { get: () => Promise.resolve({ id: "imp-9", status, source: "paste", segments: [], candidates: [], savedCards: [], job: null }) },
      { storage },
    );
    split.page.onLoad({ id: "imp-9" });
    split.page.onShow();
    await flush();
    assert.equal(storage.has("zhiye_import_pick:imp-9:u1"), false, status);
  }
  storage.set("zhiye_import_pick:imp-9:u1", { edits: {}, selected: ["c1"] });
  const gone = loadPage(
    "pages/import/split/index.js",
    { get: () => Promise.reject(Object.assign(new Error("这次导入找不到了"), { code: "NOT_FOUND" })) },
    { storage },
  );
  gone.page.onLoad({ id: "imp-9" });
  gone.page.onShow();
  await flush();
  assert.equal(storage.has("zhiye_import_pick:imp-9:u1"), false);
});

// ---- 随心记, 聊一聊 -------------------------------------------------------------
let h;
function fresh() {
  for (const key of Object.keys(require.cache)) if (key.startsWith(root)) delete require.cache[key];
}
function harness({ routes = {}, storage = {} } = {}) {
  h = { calls: [], nav: [], sent: [], streams: [], routes, storage, app: { globalData: {} } };
  global.getApp = () => h.app;
  global.getCurrentPages = () => [];
  global.wx = {
    getWindowInfo: () => ({ screenHeight: 800, windowHeight: 740 }),
    getStorageSync: (k) => h.storage[k],
    setStorageSync: (k, v) => (h.storage[k] = structuredClone(v)),
    removeStorageSync: (k) => delete h.storage[k],
    pageScrollTo() {},
    nextTick: (fn) => fn(),
    navigateTo: ({ url }) => h.nav.push(url),
    switchTab: ({ url, success }) => {
      h.nav.push(`tab:${url}`);
      if (success) success();
    },
    reLaunch: ({ url }) => h.nav.push(`relaunch:${url}`),
    showModal: (o) => {
      h.calls.push(["modal", o.title, o.content]);
      if (o.success) o.success({ confirm: true });
    },
    showToast: (o) => h.calls.push(`toast:${o.title}`),
    stopPullDownRefresh() {},
  };
  fresh();
  const reply = (method) => (url, body) => {
    h.calls.push([method, url, body]);
    const route = h.routes[`${method} ${url}`];
    if (!route) return Promise.reject(Object.assign(new Error("没有了"), { code: "NOT_FOUND", statusCode: 404 }));
    return Promise.resolve().then(() => (typeof route === "function" ? route(body) : route));
  };
  put("utils/gate.js", { state: () => "ok", check: () => true, ask() {} });
  put("utils/auth.js", {
    getUser: () => ({ id: "u1" }),
    consentGeneration: () => 1,
    hasConsent: () => true,
    login: () => Promise.resolve({ id: "u1" }),
  });
  put("utils/study-clock.js", { track: (x) => ({ studyTouch() {}, ...x }) });
  put("utils/api.js", {
    get: reply("GET"),
    post: reply("POST"),
    patch: reply("PATCH"),
    del: reply("DEL"),
    put: reply("PUT"),
    uploadTo: () => Promise.reject(new Error("no upload")),
    needsConsent: () => false,
  });
  put("utils/stream.js", {
    clientId: () => `cid${h.sent.length}`,
    send: (url, body, onEvent) => {
      h.sent.push(body);
      let settle;
      const promise = new Promise((resolve, reject) => (settle = { resolve, reject }));
      const stream = { body, onEvent, settle, aborted: false };
      h.streams.push(stream);
      return {
        promise,
        abort() {
          stream.aborted = true;
          settle.reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" }));
        },
      };
    },
  });
  return h;
}
function load(page) {
  let def;
  global.Page = (x) => (def = x);
  delete require.cache[file(page)];
  require(file(page));
  def.data = structuredClone(def.data);
  def.setData = (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      const m = /^(\w+)\[(\d+)\](?:\.(\w+))?$/.exec(key);
      if (!m) def.data[key] = value;
      else if (m[3]) def.data[m[1]][Number(m[2])][m[3]] = value;
      else def.data[m[1]][Number(m[2])] = value;
    }
  };
  return def;
}
const card = (id, text) => ({ id, type: "idea", kind: "note", title: text, quote: text, stage: "written", follow: "none", scene: "life" });

test("item 2: 先记下 keeps what was typed while saving, in the box and in the draft", async () => {
  let release;
  harness({
    storage: { zhiye_onboarded: "1" },
    routes: {
      "GET /v1/cards": { data: [], total: 1 },
      "GET /v1/chat/threads?kind=chat&limit=5": { threads: [] },
      "POST /v1/cards": () => new Promise((resolve) => (release = resolve)),
    },
  });
  const page = load("pages/notes/index.js");
  page.onLoad();
  page.onShow();
  await flush();
  page.onText({ detail: { value: "第一句" } });
  const saving = page.save();
  await flush();
  page.onText({ detail: { value: "第一句\n又想到一句" } });
  release({ card: card("k1", "第一句"), crisis: false });
  await saving;
  assert.equal(page.data.text, "又想到一句");
  assert.equal(h.storage["zhiye_notes_draft:u1"].text, "又想到一句");
  assert.equal(h.storage["zhiye_notes_draft:u1"].clientId, "", "the new words are a new save");
  // Nothing typed meanwhile: the box and the draft are empty.
  page.onText({ detail: { value: "又想到一句" } });
  const plain = page.save();
  await flush();
  release({ card: card("k2", "又想到一句"), crisis: false });
  await plain;
  assert.equal(page.data.text, "");
  assert.equal(h.storage["zhiye_notes_draft:u1"], undefined);
  // The sent words themselves changed: nothing is dropped.
  page.onText({ detail: { value: "原来的话" } });
  const changed = page.save();
  await flush();
  page.onText({ detail: { value: "原来改过的话" } });
  release({ card: card("k3", "原来的话"), crisis: false });
  await changed;
  assert.equal(page.data.text, "原来改过的话");
  // Left while saving: back on 随心记, only the later words are there.
  page.onText({ detail: { value: "离开前的话" } });
  const away = page.save();
  await flush();
  page.onText({ detail: { value: "离开前的话 后来补的" } });
  page.onHide();
  release({ card: card("k4", "离开前的话"), crisis: false });
  await away;
  page.onShow();
  assert.equal(page.data.text, "后来补的");
  assert.equal(h.storage["zhiye_notes_draft:u1"].text, "后来补的");
});

test("item 5: 随心记's 接着聊 line follows the tab's seen mark, and going on marks it", async () => {
  const threads = [
    { id: "c1", title: "和室友的事", unfinished: true, scene: "life", lastAt: "2026-10-18T01:00:00.000Z" },
    { id: "c2", title: "周末去哪", unfinished: true, scene: "life", lastAt: "2026-10-17T01:00:00.000Z" },
  ];
  harness({
    storage: { "zhiye_talk_replay_seen:u1": { c1: "2026-10-18T01:00:00.000Z" } },
    routes: { "GET /v1/chat/threads?kind=chat&limit=5": () => ({ threads }) },
  });
  const page = load("pages/notes/index.js");
  page.active = () => true;
  page.request = "r";
  await page.loadChat(1, "u1", "r");
  assert.equal(page.data.chatBack.id, "c2", "c1 was already offered on the tab");
  page.goOnChat();
  assert.deepEqual(h.storage["zhiye_talk_replay_seen:u1"], { c1: "2026-10-18T01:00:00.000Z", c2: "2026-10-17T01:00:00.000Z" });
  assert.equal(h.nav.at(-1), "tab:/pages/talk/index");
  await page.loadChat(1, "u1", "r");
  assert.equal(page.data.chatBack, null);
  // Something new said in c1: offered again.
  threads[0].lastAt = "2026-10-18T05:00:00.000Z";
  await page.loadChat(1, "u1", "r");
  assert.equal(page.data.chatBack.id, "c1");
  // The tab writes the same mark.
  assert.match(read("pages/talk/index.js"), /const SEEN = "zhiye_talk_replay_seen";/);
});

test("item 8: words handed to 聊一聊 leave the box once the chat page has them, not before", async () => {
  harness({
    storage: { zhiye_onboarded: "1" },
    routes: {
      "GET /v1/cards": { data: [], total: 1 },
      "GET /v1/chat/threads?kind=chat&limit=5": { threads: [] },
    },
  });
  const page = load("pages/notes/index.js");
  page.onLoad();
  page.onShow();
  await flush();
  page.onText({ detail: { value: "想聊聊这件事" } });
  page.chat();
  assert.equal(h.app.globalData.chat.text, "想聊聊这件事");
  page.onHide();
  // The chat page never took it (e.g. it did not open): the words stay.
  page.onShow();
  assert.equal(page.data.text, "想聊聊这件事");
  assert.equal(h.storage["zhiye_notes_draft:u1"].text, "想聊聊这件事");
  // Now it does.
  page.chat();
  page.onHide();
  h.app.globalData.chat = null;
  page.onShow();
  assert.equal(page.data.text, "");
  assert.equal(h.storage["zhiye_notes_draft:u1"], undefined);
});

const threadA = { id: "a", title: "A", scene: "life", mode: "guide" };
const threadB = { id: "b", title: "B", scene: "life", mode: "guide" };
const msgs = (id) => [
  { id: `${id}1`, role: "user", status: "done", content: "说过的话" },
  { id: `${id}2`, role: "assistant", status: "done", content: "回过的话" },
];

test("item 4: a chat deleted in 全部对话 is not sent to; the tab starts afresh and keeps the words", async () => {
  harness({
    routes: {
      "GET /v1/chat/threads?kind=chat&limit=12": { threads: [] },
      "GET /v1/chat/threads/a?tone=light": { thread: threadA, messages: msgs("a") },
      "GET /v1/chat/threads?kind=chat&limit=20": { threads: [{ id: "a", title: "A" }], next: null },
      "DEL /v1/chat/threads/a": {},
      "POST /v1/chat/threads/a/suggest-cards": { cards: [] },
    },
  });
  const tab = load("pages/talk/index.js");
  tab.onLoad({});
  h.app.globalData.chat = { threadId: "a" };
  tab.onShow();
  await flush();
  assert.equal(tab.data.thread.id, "a");
  tab.input({ detail: { value: "还没发的话" } });
  tab.onHide();
  // 全部对话: long press, delete.
  const history = load("pages/chat-history/index.js");
  history.onShow();
  await flush();
  history.remove({ currentTarget: { dataset: { id: "a" } } });
  await flush();
  assert.deepEqual(history.data.threads, []);
  // Back on the tab: no chat open, the words are still there, nothing goes to "a".
  tab.onShow();
  await flush();
  assert.equal(tab.data.thread, null);
  assert.equal(tab.data.draft, "还没发的话");
  assert.equal(h.storage["zhiye_chat_draft:u1:a"], undefined);
  assert.equal(h.storage["zhiye_chat_draft:u1:new"].text, "还没发的话");
  assert.match(read("pages/mood-log/index.js"), /chatDeleted\(id\)/);

  // Deleted elsewhere (another phone): the send's NOT_FOUND starts afresh too.
  const page = load("pages/chat/index.js");
  page.onLoad({});
  h.app.globalData.chat = { threadId: "a" };
  page.onShow();
  await flush();
  page.input({ detail: { value: "接着说" } });
  page.submit();
  h.streams.at(-1).settle.reject(Object.assign(new Error("这段对话找不到了，可能已经删掉"), { code: "NOT_FOUND" }));
  await flush();
  assert.equal(page.data.thread, null);
  assert.equal(page.data.draft, "接着说");
  assert.equal(page.data.sending, false);
  assert.equal(page.data.error, "这段对话找不到了，可能已经删掉");
});

test("item 7: a reply still coming for another chat does not change the one on screen", async () => {
  harness({
    routes: {
      "GET /v1/chat/threads?kind=chat&limit=12": { threads: [] },
      "GET /v1/chat/threads/a?tone=light": { thread: threadA, messages: msgs("a") },
      "GET /v1/chat/threads/b?tone=light": { thread: threadB, messages: msgs("b") },
      "POST /v1/chat/threads/a/suggest-cards": { cards: [] },
      "POST /v1/chat/threads/b/suggest-cards": { cards: [] },
    },
  });
  const tab = load("pages/talk/index.js");
  tab.onLoad({});
  h.app.globalData.chat = { threadId: "a" };
  tab.onShow();
  await flush();
  tab.input({ detail: { value: "再问一句" } });
  tab.submit();
  assert.equal(tab.data.sending, true);
  // 全部对话 waits while the reply comes.
  tab.openHistory();
  assert.deepEqual(h.nav, []);
  assert.match(read("pages/talk/index.wxml"), /class="hist tap-area \{\{sending \? 'off' : ''\}\}"/);
  // Opened from 随心记's line meanwhile: chat b.
  h.app.globalData.chat = { threadId: "b" };
  tab.onShow();
  await flush();
  assert.equal(tab.data.thread.id, "b");
  const stream = h.streams.at(-1);
  stream.onEvent({ e: "start", thread: { ...threadA, title: "A 改名" }, question: { id: "q", role: "user", status: "done", content: "再问一句" }, replyId: "r" });
  stream.onEvent({ e: "thread", thread: threadA });
  stream.onEvent({ e: "blocks", id: "r", blocks: [{ t: "p", text: "回" }] });
  assert.equal(tab.data.thread.id, "b");
  assert.deepEqual(tab.data.messages.map((m) => m.id), ["b1", "b2"]);
  stream.settle.resolve({ finished: true });
  await flush();
  assert.equal(tab.data.sending, false);
  assert.equal(tab.data.thread.id, "b");
  assert.equal(h.calls.filter((c) => c[1] === "/v1/chat/threads/a?tone=light").length, 1, "a is not opened again");
  // A crisis in the other chat still opens the crisis page.
  stream.onEvent({ e: "crisis", thread: threadA, question: { id: "q" } });
  assert.equal(h.nav.at(-1), "/pages/crisis/index");
  tab.openHistory();
  assert.equal(h.nav.at(-1), "/pages/chat-history/index");
});

test("item 3: the mood switch no longer says mood is kept apart", () => {
  const banned = [...read("../server/src/modules/safety/banned-phrases.ts").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const name of ["utils/chat-room.js", "components/chat-panel/index.wxml", "pages/ask/index.js"]) {
    const text = read(name);
    assert.doesNotMatch(text, /单独存放/, name);
    assert.match(text, /换了以后这段就一直算心情，存下的是心情卡。/, name);
    for (const phrase of banned) assert.ok(!text.includes(phrase), `${name}: ${phrase}`);
  }
  assert.match(read("components/chat-panel/index.wxml"), /想换成聊心情吗？换了以后这段就一直算心情，存下的是心情卡。/);
  assert.match(read("utils/chat-room.js"), /"换了以后这段就一直算心情，存下的是心情卡。想聊别的，新开一段就好。"/);
});

// ---- resume-card ----------------------------------------------------------------
function resumeCard(item, reply = {}) {
  let definition;
  const context = {
    require(name) {
      if (name.endsWith("/share")) return { withShare: (page) => page };
      if (name.endsWith("/api"))
        return {
          post: async (url) => (url.endsWith("/act") ? { item: { ...item, state: "done" }, ...reply } : { kind: "item", item }),
          get: async () => ({}),
        };
      if (name.endsWith("/auth")) return { getUser: () => ({ id: "one" }), hasConsent: () => true, login: async () => ({}) };
      if (name.endsWith("/visit")) return { current: () => "v" };
      if (name.endsWith("/clock")) return { now: () => Date.UTC(2026, 9, 12) };
      if (name.endsWith("/format")) return { errorText: (error) => error.message };
      if (name.endsWith("/chat-entry")) return { openChat() {}, chatAboutCard() {} };
      if (name.endsWith("/assets")) return { asset: (f) => f };
      if (name.endsWith("/cards")) return require(file("utils/cards.js"));
      if (name.endsWith("/tap")) return require(file("utils/tap.js"));
      throw new Error(name);
    },
    wx: { navigateTo() {}, showToast() {}, showActionSheet() {} },
    Component: (value) => (definition = value),
    setTimeout: () => 1,
    clearTimeout() {},
    Date,
  };
  vm.runInNewContext(read("components/resume-card/index.js"), context);
  const instance = {
    ...definition.methods,
    data: structuredClone(definition.data),
    alive: true,
    triggerEvent() {},
    setData(patch) {
      for (const [key, value] of Object.entries(patch)) {
        const parts = key.split(".");
        let target = this.data;
        for (const p of parts.slice(0, -1)) target = target[p] || (target[p] = {});
        target[parts.at(-1)] = value;
      }
    },
  };
  return instance;
}

test("item 6: the receipt says what the option did, and 让 AI 再理一遍 only after an answer", async () => {
  const todo = {
    id: "r1",
    state: "shown",
    src: "card",
    kind: "todo",
    canClose: true,
    question: "「交线代作业」做了吗？",
    options: ["做了", "还没", "不用提醒"],
    acts: ["close", "later", "never"],
    card: { id: "c1", type: "idea", kind: "todo", title: "交线代作业", version: 1 },
  };
  const wxml = read("components/resume-card/index.wxml");
  assert.match(wxml, /wx:if="\{\{receipt.action==='answer' && item.card && !aiUnavailable\}\}" class="link" bindtap="tidy">让 AI 再理一遍/);
  for (const [text, title, action] of [
    ["做了", "完成了", "answer"],
    ["还没", "好，过几天再问", "skip"],
    ["不用提醒", "好，不再提醒", "never"],
  ]) {
    const p = resumeCard(todo);
    await p.load();
    await p.choose({ currentTarget: { dataset: { text } } });
    assert.equal(p.data.receipt.title, title, text);
    assert.equal(p.data.receipt.action, action, text);
    assert.equal(p.data.receipt.ask, "", text);
  }
  // A recall card: 记住了 is an answer; 不用提醒 is not.
  const recall = { ...todo, kind: "recall", options: ["记住了", "有点忘", "不用提醒"], acts: ["remember", "forgot", "never"], card: { ...todo.card, kind: "knowledge" } };
  const p = resumeCard(recall);
  await p.load();
  await p.choose({ currentTarget: { dataset: { text: "记住了" } } });
  assert.equal(p.data.receipt.title, "记下了");
  assert.equal(p.data.receipt.action, "answer");
  const q = resumeCard(recall);
  await q.load();
  await q.choose({ currentTarget: { dataset: { text: "不用提醒" } } });
  assert.equal(q.data.receipt.title, "好，不再提醒");
  // The × menu's 不再提起 keeps its words.
  const r = resumeCard(todo);
  await r.load();
  await r.never();
  assert.equal(r.data.receipt.title, "好，不再提这件事");
  // An older server (no acts): 还在想 is not an answer either.
  const old = resumeCard({ ...todo, acts: undefined, options: ["有些想法", "还在想", "写一句"] });
  await old.load();
  await old.choose({ currentTarget: { dataset: { text: "还在想" } } });
  assert.equal(old.data.receipt.title, "好，先放着");
  assert.equal(old.data.receipt.action, "skip");
});

"use strict";
// the import page after the final acceptance — a scan's rest and
// more pages both offered, pages with no words named and never re-read
// by themselves, every unfinished import one tap away, cleared
// pictures or PDF picked again for the missing pages only, 我的话
// counted as the server counts (item 10) and bigger kind/scene choices.
// Synthetic data only; responses are in the server's shape (imports/service.ts
// view(), open(); jobs/runner.ts publicJob).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
function loadPage(name, api, { wxExtra = {} } = {}) {
  let definition;
  const navigation = [];
  const modals = [];
  const storage = new Map();
  global.Page = (value) => {
    definition = value;
  };
  global.getApp = () => ({ globalData: {} });
  global.wx = {
    getStorageSync: (key) => (storage.has(key) ? storage.get(key) : ""),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: (key) => storage.delete(key),
    getFileSystemManager: () => ({ accessSync() {} }),
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
  for (const n of [name, "pages/import/view.js", "utils/pick.js", "utils/job.js", "utils/import-row.js"])
    delete require.cache[file(n)];
  require(file(name));
  definition.data = structuredClone(definition.data);
  definition.setData = (patch) =>
    Object.entries(patch).forEach(([key, value]) =>
      key.includes(".") ? setPath(definition.data, key, value) : (definition.data[key] = value),
    );
  return { page: definition, navigation, modals };
}
// An import as GET /v1/imports/:id returns it (the fields the page reads).
const scanned = (extra = {}) => ({
  id: "imp-1",
  source: "screenshot",
  fileName: null,
  own: false,
  status: "read",
  segments: [{ n: 1, text: "第一页认出来的一段正文。", page: 1 }],
  pages: [1, 2, 3].map((n) => ({ n, scan: true, ok: n === 1 })),
  candidates: [],
  chars: 11,
  pageRange: { from: 1, to: 3 },
  truncated: false,
  partial: true,
  needsOcr: null,
  job: { id: "job-1", kind: "import_read", status: "succeeded", result: { pages: 3, failed: [2, 3] }, error: null },
  failedJob: null,
  retryPages: 2,
  received: [1, 2, 3],
  missingPages: [],
  limit: 20000,
  restChars: 0,
  unread: null,
  ...extra,
});
const show = async (page, item) => {
  page.onLoad({ id: item.id });
  page.onShow();
  await flush();
};

test("F01: a scan with text past the limit and more pages offers both, and never says all was read", async () => {
  const pdf = scanned({
    source: "pdf",
    fileName: "讲义.pdf",
    truncated: true,
    restChars: 6200,
    pageRange: { from: 1, to: 20 },
    pages: Array.from({ length: 20 }, (_, i) => ({ n: i + 1, scan: true, ok: true, ...(i === 19 ? { truncated: true } : {}) })),
    partial: false,
    job: null,
  });
  const h = loadPage("pages/import/source/index.js", { get: () => Promise.resolve(pdf) });
  await show(h.page, pdf);
  assert.equal(h.page.data.keptLine, "先读了前 20000 字以内的整段，还剩 6200 字；这次读到第 20 页");
  assert.equal(h.page.data.restLine, "接着导剩下的");
  assert.equal(h.page.data.nextPage, 21);
  // Pictures past the limit: the rest as with pasted text.
  const photos = scanned({ truncated: true, restChars: 7000, partial: false, pages: [1, 2, 3].map((n) => ({ n, scan: true, ok: true })) });
  const p = loadPage("pages/import/source/index.js", { get: () => Promise.resolve(photos) });
  await show(p.page, photos);
  assert.equal(p.page.data.keptLine, "先读了前 20000 字以内的整段，还剩 7000 字");
  assert.equal(p.page.data.restLine, "接着导剩下的");
  assert.equal(p.page.data.nextPage, 0);
  const wxml = read("pages/import/source/index.wxml");
  assert.match(wxml, /bindtap="importRest">\{\{restLine\}\}/);
  assert.match(wxml, /bindtap="readMore">接着读第/);
});

test("F03: pages with no words are named; a free failed read waits for the learner's 重试", async () => {
  // Mixed: page 1 read, pages 2 and 3 gave no words.
  const mixed = scanned();
  const h = loadPage("pages/import/source/index.js", { get: () => Promise.resolve(mixed) });
  await show(h.page, mixed);
  assert.equal(h.page.data.partialLine, "第 2、3 页没认出字，读出来的还在");
  // Nothing read at all: the job failed (IMPORT_NO_TEXT) and the import is
  // still reading, without a job.
  const posts = [];
  const none = scanned({
    status: "reading",
    segments: [],
    pages: [1, 2].map((n) => ({ n, scan: true, ok: false })),
    job: null,
    failedJob: {
      id: "job-2",
      kind: "import_read",
      status: "failed",
      result: null,
      error: { code: "IMPORT_NO_TEXT", message: "这几页没认出字，可以再试一次" },
    },
    needsOcr: { pages: 2, available: 2 },
    retryPages: 2,
  });
  const e = loadPage("pages/import/source/index.js", {
    get: () => Promise.resolve(none),
    post: (url, body) => {
      posts.push([url, body]);
      return Promise.resolve({ import: { ...none, job: { id: "job-3", kind: "import_read", status: "queued" } } });
    },
  });
  await show(e.page, none);
  // Said once: on the failed task (with 重试), not again in a notice.
  assert.equal(e.page.data.partialLine, "");
  assert.equal(e.page.data.task.error, "第 1、2 页没认出字，可以再试一次");
  assert.equal(e.page.data.task.job.error.message, "这几页没认出字，可以再试一次");
  assert.equal(e.modals.length, 0, "no 认这几页 question for a read that failed");
  await flush();
  assert.deepEqual(posts, [], "nothing is read again by itself");
  await e.page.retryTask();
  assert.deepEqual(posts, [["/v1/imports/imp-1/read", { pages: 2 }]]);
  e.page.onUnload();
  // Pages only skipped are "not read", not "no words".
  const skipped = scanned({ source: "pdf", job: null, retryPages: 0, missingPages: [2, 3] });
  const s = loadPage("pages/import/source/index.js", { get: () => Promise.resolve(skipped) });
  await show(s.page, skipped);
  assert.equal(s.page.data.partialLine, "有几页没读出来（第 2、3 页），读出来的还在");
  // 随心记's strip says so too.
  delete require.cache[file("utils/import-row.js")];
  const { importRow } = require(file("utils/import-row.js"));
  const row = importRow({ id: "imp-1", status: "reading", source: "photo", title: "照片", pages: { done: 0, total: 2 }, retryPages: 2, job: none.failedJob });
  assert.equal(row.state, "没认出字，点开看看");
  assert.equal(row.retry, true);
});

test("F10: cleared pictures are picked again for the missing pages only, then only those are read", async () => {
  const uploads = [];
  const posts = [];
  const picked = [];
  const item = scanned({ retryPages: 0, missingPages: [2, 3] });
  const after = scanned({ retryPages: 2, missingPages: [] });
  const h = loadPage(
    "pages/import/source/index.js",
    {
      get: () => Promise.resolve(item),
      uploadTo: (url, filePath) => {
        uploads.push([url, filePath]);
        return Promise.resolve({ import: after });
      },
      post: (url, body) => {
        posts.push([url, body]);
        return Promise.resolve({ import: { ...after, status: "reading", job: { id: "job-4", kind: "import_read", status: "queued" } } });
      },
    },
    {
      wxExtra: {
        chooseMedia: (options) => {
          picked.push(options);
          options.success({ tempFiles: [{ tempFilePath: "new2.jpg", size: 10 }, { tempFilePath: "new3.jpg", size: 10 }] });
        },
      },
    },
  );
  await show(h.page, item);
  assert.equal(h.page.data.repickLine, "重新选这几页的图片");
  // 重读 with nothing left to read goes to the picker instead of a 410.
  await h.page.rereadPages();
  assert.equal(picked[0].count, 2);
  assert.deepEqual(uploads, [
    ["/v1/imports/imp-1/page?n=2", "new2.jpg"],
    ["/v1/imports/imp-1/page?n=3", "new3.jpg"],
  ]);
  assert.deepEqual(posts, [["/v1/imports/imp-1/read", { pages: 2 }]]);
  h.page.onUnload();

  // A PDF: the same file again, then its unread pages are read.
  const pdfUploads = [];
  const pdfPosts = [];
  const pdf = scanned({ source: "pdf", fileName: "讲义.pdf", status: "reading", job: null, retryPages: 0, missingPages: [2, 3] });
  const p = loadPage(
    "pages/import/source/index.js",
    {
      get: () => Promise.resolve(pdf),
      uploadTo: (url) => {
        pdfUploads.push(url);
        return Promise.resolve({ import: { ...pdf, retryPages: 2, missingPages: [] } });
      },
      post: (url, body) => {
        pdfPosts.push([url, body]);
        return Promise.resolve({ import: { ...pdf, job: { id: "job-5", kind: "import_scan_pdf", status: "queued" } } });
      },
    },
    {
      wxExtra: {
        chooseMessageFile: ({ success }) => success({ tempFiles: [{ name: "讲义.pdf", path: "book.pdf", size: 100 }] }),
      },
    },
  );
  await show(p.page, pdf);
  assert.equal(p.page.data.repickLine, "重新选这个文件");
  await p.page.repickMissing();
  assert.deepEqual(pdfUploads, ["/v1/imports/imp-1/page"]);
  assert.deepEqual(pdfPosts, [["/v1/imports/imp-1/read", { pages: 2 }]]);
  p.page.onUnload();
  const wxml = read("pages/import/source/index.wxml");
  assert.match(wxml, /bindtap="repickMissing">\{\{repickLine\}\}/);
});

test("F09: every unfinished import is one tap away; each opens where it stopped or is given up", async () => {
  const gets = [];
  const posts = [];
  // GET /v1/imports?open=1&all=1 rows (imports/service.ts open()).
  const rows = [
    { id: "imp-a", status: "read", source: "paste", title: "极限笔记", pages: null, candidates: 0, retryPages: 0, job: null, updatedAt: "2026-10-18T01:00:00.000Z" },
    { id: "imp-b", status: "picking", source: "docx", title: "导数.docx", pages: null, candidates: 5, retryPages: 0, job: null, updatedAt: "2026-10-10T01:00:00.000Z" },
    { id: "imp-c", status: "reading", source: "photo", title: "拍的照片", pages: { done: 1, total: 3 }, candidates: 0, retryPages: 2, job: { id: "j", kind: "import_read", status: "failed", error: { code: "JOB_FAILED", message: "这次没跑完，可以再试一次" } }, updatedAt: "2026-09-01T01:00:00.000Z" },
  ];
  const h = loadPage("pages/import/source/index.js", {
    get: (url) => {
      gets.push(url);
      return Promise.resolve(url.startsWith("/v1/imports?") ? { items: rows } : null);
    },
    post: (url) => {
      posts.push(url);
      return Promise.resolve({ import: { id: "imp-c", status: "abandoned" } });
    },
  });
  h.page.onLoad({});
  h.page.onShow();
  await flush();
  assert.deepEqual(gets, ["/v1/imports?open=1&all=1"]);
  assert.deepEqual(h.page.data.resume, { id: "imp-a", status: "read", title: "极限笔记" });
  assert.deepEqual(
    h.page.data.openRows.map((row) => [row.id, row.title, row.state]),
    [
      ["imp-a", "极限笔记", "读好了，接着拆卡"],
      ["imp-b", "导数.docx", "可以挑卡了"],
      ["imp-c", "拍的照片", "没跑完，点开重试"],
    ],
  );
  // each row says when it was last touched.
  assert.deepEqual(h.page.data.openRows.slice(0, 2).map((row) => row.when), ["10/18", "10/10"]);
  assert.match(read("pages/import/source/index.wxml"), /\{\{item\.state\}\}\{\{item\.when \? ' · ' \+ item\.when : ''\}\}/);
  h.page.showOpenList();
  assert.equal(h.page.data.listOpen, true);
  // The month-old one is given up from the list.
  await h.page.dropFromList({ currentTarget: { dataset: { id: "imp-c" } } });
  assert.deepEqual(posts, ["/v1/imports/imp-c/abandon"]);
  assert.deepEqual(h.page.data.openRows.map((row) => row.id), ["imp-a", "imp-b"]);
  assert.equal(h.page.data.listOpen, true);
  // One waiting for its cards opens the pick page.
  h.page.openFromList({ currentTarget: { dataset: { id: "imp-b" } } });
  assert.equal(h.page.importId, "imp-b");
  assert.equal(h.page.data.listOpen, false);
  assert.deepEqual(h.navigation, [["redirect", "/pages/import/split/index?id=imp-b"]]);
  const wxml = read("pages/import/source/index.wxml");
  assert.match(wxml, /bindtap="showOpenList">全部没完成的/);
  assert.match(wxml, /bindtap="openFromList"/);
  assert.match(wxml, /bindtap="dropFromList">放弃</);
});

test("item 10: 我的话 is counted as the server counts (ends trimmed, at most 300)", () => {
  const spaced = `${"这句话里".repeat(40)}${" ".repeat(150)}结束了。`;
  const fine = "我觉得极限其实就是在问，越来越靠近的时候会停在哪里。";
  const h = loadPage("pages/import/split/index.js", {});
  h.page.setData({
    own: true,
    item: { id: "imp-1", source: "paste", segments: [{ n: 1, text: `${spaced}${fine}` }] },
    candidates: [{ id: "c1", src: [1], srcLabel: "出自第 1 段" }],
  });
  h.page.showSource("c1", "mine");
  assert.deepEqual(h.page.data.sourceSheet.lines.map((line) => line.text), [fine]);
});

test("the kind and scene choices take the shared tap height and keep their spacing", () => {
  const wxss = read("pages/import/split/index.wxss");
  assert.match(wxss, /\.choice \{ min-height: var\(--hit\);/);
  assert.match(wxss, /\.choice-row \{ gap: 16rpx; \}\n\.choice \{ min-height: var\(--hit\)/);
});

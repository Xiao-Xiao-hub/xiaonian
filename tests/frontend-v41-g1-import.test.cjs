"use strict";
// V4.1 G1 · 导入: on a phone the picker hides the page (onHide) and shows it
// again (onShow) before or after its success callback. Neither may drop the
// pick or the request; only closing the page or changing the account does.
const test = require("node:test");
const assert = require("node:assert/strict");
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
const flush = () => new Promise((resolve) => setImmediate(resolve));

function loadPage(api, options = {}) {
  let definition;
  let user = { id: "u1" };
  const navigation = [],
    modals = [],
    toasts = [],
    pickers = [];
  global.Page = (value) => {
    definition = value;
  };
  global.getApp = () => ({ globalData: {} });
  global.wx = {
    getStorageSync: () => "",
    showToast: (value) => toasts.push(value.title),
    redirectTo: (value) => navigation.push(["redirect", value.url]),
    navigateBack: () => navigation.push(["back"]),
    showModal: (value) => modals.push(value),
    // The test decides when (and whether) the picker answers.
    chooseMedia: (value) => pickers.push(["media", value]),
    chooseMessageFile: (value) => pickers.push(["file", value]),
  };
  put(path.join(root, "utils/api.js"), {
    pending: (job) => Boolean(job && ["queued", "running"].includes(job.status)),
    jobMessage: (job) => (job && job.error && job.error.message) || "处理失败，请重试",
    needsConsent: () => false,
    get: () => Promise.resolve(null),
    post: () => Promise.reject(new Error("unexpected")),
    uploadTo: () => Promise.reject(new Error("unexpected")),
    del: () => Promise.resolve({}),
    patch: () => Promise.resolve({}),
    ...api,
  });
  put(path.join(root, "utils/auth.js"), { getUser: () => user, hasConsent: () => true });
  put(path.join(root, "utils/gate.js"), {
    state: () => options.state || "ok",
    check: () => true,
    ask() {},
  });
  put(path.join(root, "utils/format.js"), {
    errorText: (error) => error.message || "失败",
    countChars: (text) => String(text || "").replace(/\s/g, "").length,
  });
  for (const name of ["pages/import/source/index.js", "utils/pick.js", "pages/import/view.js"])
    delete require.cache[path.join(root, name)];
  require(path.join(root, "pages/import/source/index.js"));
  definition.data = structuredClone(definition.data);
  definition.setData = (patch) => Object.assign(definition.data, patch);
  return {
    page: definition,
    navigation,
    modals,
    toasts,
    pickers,
    setUser(value) {
      user = value;
    },
  };
}
const photo = (name = "a.jpg") => ({ tempFiles: [{ tempFilePath: name, size: 1024 }] });
const readItem = { id: "imp-1", source: "photo", status: "read", chars: 5, segments: [{ n: 1, text: "极限" }], pages: [{ n: 1, ok: true }], job: null };

test("picker → onHide → onShow → success: the photo is read and shown", async () => {
  const uploads = [];
  const h = loadPage({
    uploadTo: (url) => {
      uploads.push(url);
      return Promise.resolve({ import: readItem });
    },
  });
  h.page.onLoad({});
  h.page.onShow();
  const picked = h.page.choosePhotos({ currentTarget: { dataset: { source: "photo" } } });
  h.page.onHide();
  h.page.onShow();
  h.pickers[0][1].success(photo());
  await picked;
  await flush();
  assert.equal(uploads.length, 1);
  assert.equal(h.page.data.item.id, "imp-1");
  assert.equal(h.page.data.error, "");
  assert.equal(h.page.data.busy, false);
});

test("picker → onHide → success → onShow: reading is not dropped, not reset, not sent twice", async () => {
  const uploads = [];
  let finish;
  const h = loadPage({
    uploadTo: (url) => {
      uploads.push(url);
      return new Promise((resolve) => {
        finish = () => resolve({ import: readItem });
      });
    },
  });
  h.page.onLoad({});
  h.page.onShow();
  const picked = h.page.choosePhotos({ currentTarget: { dataset: { source: "screenshot" } } });
  h.page.onHide();
  h.pickers[0][1].success(photo());
  await flush();
  assert.equal(uploads.length, 1);
  assert.equal(h.page.data.busy, true);
  // Back on screen while the upload is still running: the spinner stays and
  // 开始读 is not offered again.
  h.page.onShow();
  assert.equal(h.page.data.busy, true);
  assert.match(h.page.data.progress, /上传/);
  finish();
  await picked;
  await flush();
  assert.equal(uploads.length, 1);
  assert.equal(h.page.data.item.id, "imp-1");
  assert.equal(h.page.data.busy, false);
});

test("a chat file: hide, show and success in either order still uploads it", async () => {
  for (const order of [["hide", "show", "success"], ["hide", "success", "show"]]) {
    const uploads = [];
    const h = loadPage({
      uploadTo: (url) => {
        uploads.push(url);
        return Promise.resolve({ import: { ...readItem, source: "file", fileName: "笔记.docx" } });
      },
    });
    h.page.onLoad({});
    h.page.onShow();
    const picked = h.page.chooseFile();
    for (const step of order) {
      if (step === "hide") h.page.onHide();
      if (step === "show") h.page.onShow();
      if (step === "success")
        h.pickers[0][1].success({ tempFiles: [{ name: "笔记.docx", path: "b.docx", size: 10 }] });
    }
    await picked;
    await flush();
    assert.equal(uploads.length, 1, order.join(","));
    assert.match(uploads[0], /^\/v1\/imports\/file\?/);
    assert.equal(h.page.data.item.fileName, "笔记.docx");
  }
});

test("随心记's 拍照 / 相册 / 文件 (pick=) open the picker on ready and survive the hide", async () => {
  for (const [pick, kind] of [["photo", "media"], ["screenshot", "media"], ["file", "file"]]) {
    const uploads = [];
    const h = loadPage({
      uploadTo: (url) => {
        uploads.push(url);
        return Promise.resolve({ import: readItem });
      },
    });
    h.page.onLoad({ pick });
    h.page.onShow();
    h.page.onReady();
    assert.equal(h.pickers.length, 1);
    assert.equal(h.pickers[0][0], kind);
    h.page.onHide();
    h.page.onShow();
    h.pickers[0][1].success(
      kind === "file" ? { tempFiles: [{ name: "x.pdf", path: "x.pdf", size: 10 }] } : photo(),
    );
    await flush();
    await flush();
    // a PDF waits for its start page and 开始读.
    if (kind === "file") {
      assert.equal(uploads.length, 0, pick);
      await h.page.readSource();
      await flush();
    }
    assert.equal(uploads.length, 1, pick);
    assert.equal(h.page.data.item.id, "imp-1", pick);
  }
  // A guest is not shown a picker at all.
  const guest = loadPage({}, { state: "guest" });
  guest.page.onLoad({ pick: "photo" });
  guest.page.onReady();
  assert.equal(guest.pickers.length, 0);
});

test("a failed upload or a failed read says so instead of doing nothing", async () => {
  const h = loadPage({ uploadTo: () => Promise.reject(new Error("上传失败（502）")) });
  h.page.onLoad({});
  h.page.onShow();
  const picked = h.page.choosePhotos({ currentTarget: { dataset: { source: "photo" } } });
  h.page.onHide();
  h.pickers[0][1].success(photo());
  h.page.onShow();
  await picked;
  await flush();
  assert.equal(h.page.data.error, "上传失败（502）");
  assert.equal(h.page.data.progress, "");
  assert.equal(h.page.data.busy, false);

  // The server answers without an import: still a line, not a spinner forever.
  const empty = loadPage({ uploadTo: () => Promise.resolve(null) });
  empty.page.onLoad({});
  empty.page.onShow();
  const done = empty.page.chooseFile();
  empty.pickers[0][1].success({ tempFiles: [{ name: "a.txt", path: "a.txt", size: 3 }] });
  await done;
  await flush();
  assert.equal(empty.page.data.error, "没读到内容，再试一次");
  assert.equal(empty.page.data.progress, "");

  // The reading job fails.
  const job = { id: "job-1", status: "running" };
  const failing = loadPage({
    uploadTo: () => Promise.resolve({ import: { ...readItem, status: "reading", job } }),
    get: (url) =>
      Promise.resolve(
        url.startsWith("/v1/jobs/")
          ? { ...job, status: "failed", error: { message: "这页没读出来" } }
          : null,
      ),
  });
  failing.page.onLoad({});
  failing.page.onShow();
  const read = failing.page.chooseFile();
  failing.pickers[0][1].success({ tempFiles: [{ name: "a.md", path: "a.md", size: 3 }] });
  await read;
  // the shared watcher polls; the failure shows in <task-progress>
  // with 重试 instead of the error line.
  await new Promise((resolve) => setTimeout(resolve, 1700));
  await flush();
  assert.equal(failing.page.data.task.job.status, "failed");
  assert.equal(failing.page.data.task.job.error.message, "这页没读出来");
  assert.equal(failing.page.data.waiting, false);
  failing.page.onUnload();
});

test("while hidden the job is not polled and 拆卡 waits; onShow picks both up again", async () => {
  const gets = [];
  const job = { id: "job-1", status: "running" };
  const h = loadPage({
    uploadTo: () => Promise.resolve({ import: { ...readItem, status: "reading", job } }),
    get: (url) => {
      gets.push(url);
      return Promise.resolve({ ...readItem, status: "picking" });
    },
  });
  h.page.onLoad({});
  h.page.onShow();
  const picked = h.page.chooseFile();
  h.page.onHide();
  h.pickers[0][1].success({ tempFiles: [{ name: "a.md", path: "a.md", size: 3 }] });
  await picked;
  await flush();
  assert.equal(h.page.data.item.status, "reading");
  // no watcher is started while hidden.
  assert.equal(h.page.watcher, undefined);
  // Something ready to split while hidden: no redirect yet.
  h.page.adopt({ ...readItem, status: "picking" });
  assert.deepEqual(h.navigation, []);
  h.page.onShow();
  await flush();
  // the import entry also asks once for an unfinished import.
  assert.deepEqual(gets.filter((url) => !url.includes("open=1")), ["/v1/imports/imp-1"]);
  assert.deepEqual(h.navigation, [["redirect", "/pages/import/split/index?id=imp-1"]]);
});

test("closing the page or another account still drops a late result", async () => {
  let finish;
  const h = loadPage({
    uploadTo: () =>
      new Promise((resolve) => {
        finish = () => resolve({ import: readItem });
      }),
  });
  h.page.onLoad({});
  h.page.onShow();
  const picked = h.page.choosePhotos({ currentTarget: { dataset: { source: "photo" } } });
  h.pickers[0][1].success(photo());
  await flush();
  h.page.onUnload();
  finish();
  await picked;
  await flush();
  assert.equal(h.page.data.item, null);

  const other = loadPage({
    uploadTo: () =>
      new Promise((resolve) => {
        finish = () => resolve({ import: readItem });
      }),
  });
  other.page.onLoad({});
  other.page.onShow();
  const late = other.page.choosePhotos({ currentTarget: { dataset: { source: "photo" } } });
  other.page.onHide();
  other.pickers[0][1].success(photo());
  await flush();
  other.setUser({ id: "u2" });
  other.page.onShow();
  finish();
  await late;
  await flush();
  assert.equal(other.page.data.item, null);
  assert.equal(other.page.data.busy, false);
  assert.match(other.page.data.error, /换了账号/);
});

test("pasting text still goes straight to reading", async () => {
  const posts = [];
  const h = loadPage({
    post: (url, body) => {
      posts.push([url, body]);
      return Promise.resolve({ import: { ...readItem, source: "paste" } });
    },
  });
  h.page.onLoad({});
  h.page.onShow();
  h.page.textInput({ detail: { value: "左右极限相等时极限存在" } });
  await h.page.readSource();
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0], "/v1/imports");
  assert.equal(posts[0][1].text, "左右极限相等时极限存在");
  assert.equal(h.page.data.item.source, "paste");
});

test("a lost session during the upload (failed re-login) still clears the spinner and says so", async () => {
  let fail;
  const h = loadPage({
    uploadTo: () =>
      new Promise((_, reject) => {
        fail = () => reject(new Error("登录过期了，再试一次"));
      }),
  });
  h.page.onLoad({});
  h.page.onShow();
  const picked = h.page.choosePhotos({ currentTarget: { dataset: { source: "photo" } } });
  h.pickers[0][1].success(photo());
  await flush();
  h.setUser(null);
  fail();
  await picked;
  await flush();
  assert.equal(h.page.data.busy, false);
  assert.equal(h.page.data.error, "登录过期了，再试一次");
});

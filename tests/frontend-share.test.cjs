"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");
let withShare, listener, menus, redirects, removals;

beforeEach(() => {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(root + path.sep)) delete require.cache[key];
  }
  listener = null;
  menus = [];
  redirects = [];
  removals = 0;
  global.getApp = () => ({ globalData: {} });
  global.wx = {
    getStorageSync() {
      return "";
    },
    showShareMenu(options) {
      menus.push(options);
    },
    onCopyUrl(fn) {
      listener = fn;
    },
    offCopyUrl() {
      listener = null;
      removals++;
    },
    reLaunch(options) {
      redirects.push(options.url);
    },
  };
  ({ withShare } = require(path.join(root, "utils/share.js")));
});

test("all registered pages expose native sharing without invoking page business", () => {
  const app = require(path.join(root, "app.json"));
  const pages = [
    ...app.pages,
    ...app.subPackages.flatMap((p) => p.pages.map((q) => `${p.root}/${q}`)),
  ];
  assert.equal(pages.length, 55);
  for (const route of pages) {
    let page;
    global.Page = (options) => {
      page = options;
    };
    require(path.join(root, `${route}.js`));
    assert.equal(typeof page.onShareAppMessage, "function", route);
    assert.equal(
      typeof page.onShareTimeline,
      route === "pages/help/index" ? "function" : "undefined",
      route,
    );
    const metadata = page.onShareAppMessage.call({
      data: { title: "私人笔记", id: "private-id" },
    });
    assert.deepEqual(
      metadata,
      {
        title: "晓念随心记",
        path: "/pages/notes/index",
        imageUrl: "/assets/xiaoli/share.jpg",
      },
      route,
    );
    assert.ok(fs.existsSync(path.join(root, metadata.imageUrl)));
    if (page.onShareTimeline)
      assert.deepEqual(
        page.onShareTimeline(),
        {
          title: "晓念随心记",
          query: "xnShare=1",
          imageUrl: "/assets/xiaoli/share.jpg",
        },
        route,
      );
  }
});

test("original menu and copy callback preserve hooks, context and return values", () => {
  const events = [];
  const page = withShare({
    onLoad(query) {
      events.push([this, query]);
      return "load";
    },
    onShow() {
      events.push(this);
      return "show";
    },
    onHide() {
      return "hide";
    },
    onUnload() {
      return "unload";
    },
  });
  page.route = "pages/card/index";
  assert.equal(page.onLoad({ id: "private-id" }), "load");
  assert.equal(page.onShow(), "show");
  assert.equal(events[0][0], page);
  assert.equal(events[1], page);
  assert.deepEqual(menus, [{ menus: ["shareAppMessage"] }]);
  assert.deepEqual(listener(), { title: "晓念随心记", query: "xnShare=1" });
  assert.equal(page.onHide(), "hide");
  assert.equal(listener, null);
  assert.equal(page.onUnload(), "unload");
  assert.equal(removals, 1);
});

test("hiding or unloading an older page cannot remove the current page's copy handler", () => {
  const first = withShare({}),
    second = withShare({});
  first.onShow();
  second.onShow();
  const current = listener;
  first.onHide();
  first.onUnload();
  assert.equal(listener, current);
  second.onHide();
  assert.equal(listener, null);
  first.onShow();
  assert.deepEqual(listener(), { title: "晓念随心记", query: "xnShare=1" });
});

test("copied links and timeline shares redirect private/subpackage pages before loading records", () => {
  for (const route of [
    "pages/card/index",
    "pages/talk/index",
    "pages/import/split/index",
    "pages/brainstorm/result/index",
  ]) {
    const page = withShare({
      onLoad() {
        assert.fail("must not fetch private records");
      },
      onShow() {
        assert.fail("must not run private page");
      },
      onReady() {
        assert.fail("must not open a picker");
      },
      onHide() {
        assert.fail("must not save a draft");
      },
      onUnload() {
        assert.fail("must not save a draft on unload");
      },
    });
    page.route = route;
    page.onLoad({ xnShare: "1" });
    page.onShow();
    page.onReady();
    page.onHide();
    page.onUnload();
    assert.equal(redirects.at(-1), "/pages/notes/index");
  }
  let loaded = false;
  const home = withShare({
    onLoad() {
      loaded = true;
    },
  });
  home.route = "pages/notes/index";
  home.onLoad({ xnShare: "1" });
  assert.equal(loaded, true, "the home landing must not loop");
  assert.equal(redirects.length, 4);
});

test("older clients keep page behavior when optional native APIs are absent", () => {
  delete wx.onCopyUrl;
  delete wx.offCopyUrl;
  delete wx.showShareMenu;
  const page = withShare({
    onShow() {
      return 42;
    },
  });
  assert.equal(page.onShow(), 42);
  assert.doesNotThrow(() => {
    page.onHide();
    page.onUnload();
  });
});

test("timeline sharing is enabled only for existing help content and works in single-page mode", () => {
  let loads = 0;
  const page = withShare(
    {
      onLoad() {
        loads++;
      },
    },
    true,
  );
  page.route = "pages/help/index";
  page.onShow();
  assert.deepEqual(menus, [{ menus: ["shareAppMessage", "shareTimeline"] }]);
  page.onHide();
  menus.length = 0;
  wx.getLaunchOptionsSync = () => ({ scene: 1154 });
  page.onLoad({ xnShare: "1" });
  page.onShow();
  assert.equal(loads, 1);
  assert.deepEqual(redirects, []);
  assert.deepEqual(menus, []);
  assert.equal(listener, null);
  // The same help path copied as a normal link still opens the app's home.
  wx.getLaunchOptionsSync = () => ({ scene: 1001 });
  page.onLoad({ xnShare: "1" });
  assert.deepEqual(redirects, ["/pages/notes/index"]);
});

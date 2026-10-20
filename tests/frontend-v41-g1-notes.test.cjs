"use strict";
// V4.1 G1 · 随心记 top card (look back > tidy > hello, nothing before the
// count is in), the tour (once per phone, again from 帮助) and the welcome
// page's packaged 小狸.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const NOW = Date.UTC(2026, 9, 17, 4, 0, 0); // 2026-10-17 12:00 Beijing

function notes({ state = "ok", storage = {}, cards = [], total, open, globalData = {} } = {}) {
  let def;
  const nav = [],
    urls = [];
  const api = {
    get: async (url) => {
      urls.push(url);
      // /v1/cards?closed=0: the open cards (only asked for when more pages exist).
      if (open && url.includes("closed=0")) return { data: open, cursor: "", total: open.length };
      return { data: cards, cursor: "", total: total === undefined ? cards.length : total };
    },
    post: async () => ({}),
    needsConsent: () => false,
  };
  const sandbox = {
    require: (n) =>
      n.endsWith("/api")
        ? api
        : n.endsWith("/auth")
          ? { getUser: () => ({ id: "u1" }), hasConsent: () => state === "ok", login: async () => {} }
          : n.endsWith("/gate")
            ? { state: () => state, check: () => state !== "none", ask() {} }
            : n.endsWith("/format")
              ? { errorText: (e) => e.message }
              : n.endsWith("/assets")
                ? { asset: (name) => `https://assets.test/${name}` }
                : n.endsWith("/clock")
                  ? { now: () => NOW }
                  : n.endsWith("/chat-entry")
                    ? { openChat() {}, openAsk() {} }
                    : n.endsWith("/examples")
                      ? require(path.join(root, "utils/examples.js"))
                      : require(path.join(root, "utils/cards.js")),
    Page: (x) => (def = x),
    getApp: () => ({ globalData }),
    wx: {
      navigateTo: (x) => nav.push(["navigate", x.url]),
      reLaunch: (x) => nav.push(["relaunch", x.url]),
      switchTab: (x) => nav.push(["tab", x.url]),
      getStorageSync: (k) => storage[k] || "",
      setStorageSync: (k, v) => (storage[k] = v),
      stopPullDownRefresh() {},
    },
    setTimeout: () => 1,
    clearTimeout() {},
    Date,
  };
  vm.runInNewContext(read("pages/notes/index.js"), sandbox);
  const p = {
    ...def,
    data: structuredClone(def.data),
    setData(patch) {
      Object.assign(this.data, patch);
    },
    selectComponent: () => null,
  };
  return { p, nav, urls, storage };
}
// What the template's hello condition says, from the page's data.
const helloShown = (d) =>
  Boolean(d.cardsLoaded && !d.allTotal && !d.helloClosed && (!d.consent || (d.resumeKnown && !d.resumeShown)));

test("no hello card before the card count is in, so a returning user sees no flash", async () => {
  const h = notes({ storage: { zhiye_onboarded: "1" }, cards: [{ id: "c1", type: "idea", title: "一张" }] });
  h.p.onLoad();
  const showing = h.p.onShow();
  // Request in flight: count unknown, nothing on top.
  assert.equal(h.p.data.cardsLoaded, false);
  assert.equal(helloShown(h.p.data), false);
  h.p.resumeState({ detail: { shown: false } });
  assert.equal(helloShown(h.p.data), false);
  await showing;
  assert.equal(h.p.data.cardsLoaded, true);
  assert.equal(h.p.data.allTotal, 1);
  assert.equal(helloShown(h.p.data), false);
  const wxml = read("pages/notes/index.wxml");
  assert.match(
    wxml,
    /wx:if="\{\{cardsLoaded && !allTotal && !helloClosed && \(!consent \|\| \(resumeKnown && !resumeShown\)\)\}\}" class="sticky hi"/,
  );
});

test("no cards: the hello card once the look-back has answered with nothing due", async () => {
  const h = notes({ storage: { zhiye_onboarded: "1" } });
  h.p.onLoad();
  await h.p.onShow();
  assert.equal(helloShown(h.p.data), false, "waits for resume-card");
  h.p.resumeState({ detail: { shown: false } });
  assert.equal(helloShown(h.p.data), true);
  // Something due takes the top instead.
  h.p.resumeState({ detail: { shown: true } });
  assert.equal(helloShown(h.p.data), false);
  // Closed stays closed.
  h.p.resumeState({ detail: { shown: false } });
  h.p.closeHello();
  assert.equal(helloShown(h.p.data), false);
  assert.equal(h.storage.zhiye_notes_hello_closed, "1");
});

test("unfinished cards: tidy the newest 已记下 one first; 稍后 hides it for today only", async () => {
  const cards = [
    { id: "done", type: "idea", title: "完成了", mine: "我自己的话写在这里", closedAt: "2026-10-10" },
    { id: "mood", type: "idea", scene: "mood", title: "心情" },
    { id: "organized", type: "method", title: "已经理过", organizedAt: "2026-10-12" },
    { id: "written", type: "question", title: "极限还不会" },
  ];
  const h = notes({ storage: { zhiye_onboarded: "1" }, cards });
  h.p.onLoad();
  await h.p.onShow();
  assert.deepEqual(
    { ...h.p.data.tidy },
    { id: "written", title: "极限还不会", typeName: "问题", typeClass: "question", stageName: "已记下", stage: "written" },
  );
  // No 已记下 one: V4.2 G3 (intentional) asks nothing, since a card already
  // organized or said clearly does not need 整理一下 again.
  const other = notes({ storage: { zhiye_onboarded: "1" }, cards: cards.slice(0, 3) });
  other.p.onLoad();
  await other.p.onShow();
  assert.equal(other.p.data.tidy, null);
  // An 已记下 card the AI already tidied (summary or slots) is not asked either.
  const tidied = notes({
    storage: { zhiye_onboarded: "1" },
    cards: [{ id: "ai", type: "idea", title: "理过了", summary: "AI 理过的摘要" }, { id: "slots", type: "idea", title: "有槽位", slots: [{ key: "claim", text: "先复习" }] }],
  });
  tidied.p.onLoad();
  await tidied.p.onShow();
  assert.equal(tidied.p.data.tidy, null);
  // All finished: no tidy card, and with cards no hello either.
  const none = notes({ storage: { zhiye_onboarded: "1" }, cards: cards.slice(0, 1) });
  none.p.onLoad();
  await none.p.onShow();
  assert.equal(none.p.data.tidy, null);
  // 稍后.
  h.p.tidyLater();
  assert.equal(h.p.data.tidy, null);
  assert.equal(h.storage.zhiye_notes_tidy_later, "2026-10-17");
  await h.p.load();
  assert.equal(h.p.data.tidy, null, "not again today");
  h.storage.zhiye_notes_tidy_later = "2026-10-16";
  await h.p.load();
  assert.equal(h.p.data.tidy.id, "written", "back the next day");
  // Only the first page came back and it has no 已记下 card: the open cards
  // are asked for once, and an older 已记下 one there wins.
  const paged = notes({
    storage: { zhiye_onboarded: "1" },
    cards: cards.slice(0, 3),
    total: 41,
    open: [{ id: "old-written", type: "idea", title: "很久以前记的" }],
  });
  paged.p.onLoad();
  await paged.p.onShow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(paged.urls.filter((u) => u.includes("closed=0")), ["/v1/cards?closed=0"]);
  assert.equal(paged.p.data.tidy.id, "old-written");
  // Everything fits on one page: no second request.
  assert.ok(!h.urls.some((u) => u.includes("closed=0")));
});

test("resume-card: something due wins, else the tidy card (整理一下 / 稍后), and it reports which", async () => {
  let definition;
  const nav = [],
    events = [];
  let reply = { kind: "none", item: null };
  const context = {
    require(name) {
      if (name.endsWith("/api")) return { post: async () => reply };
      if (name.endsWith("/auth")) return { getUser: () => ({ id: "u1" }), hasConsent: () => true };
      if (name.endsWith("/visit")) return { current: () => "v1" };
      if (name.endsWith("/clock")) return { now: () => NOW };
      if (name.endsWith("/format")) return { errorText: (e) => e.message };
      if (name.endsWith("/chat-entry")) return { openChat() {} };
      if (name.endsWith("/assets")) return { asset: (f) => `https://assets.test/${f}` };
      if (name.endsWith("/cards")) return require(path.join(root, "utils/cards.js"));
      if (name.endsWith("/tap")) return require(path.join(root, "utils/tap.js"));
      throw new Error(name);
    },
    wx: { navigateTo: ({ url }) => nav.push(url), showActionSheet() {}, showToast() {} },
    Component: (value) => (definition = value),
    setTimeout: () => 1,
    clearTimeout() {},
    Date,
  };
  vm.runInNewContext(read("components/resume-card/index.js"), context);
  const c = {
    ...definition.methods,
    data: { ...structuredClone(definition.data), quiet: true, tidy: { id: "c 1", title: "极限还不会" } },
    alive: true,
    triggerEvent: (name, detail) => events.push(JSON.parse(JSON.stringify([name, detail || null]))),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  };
  await c.load(true);
  assert.equal(c.data.known, true);
  assert.equal(c.data.item, null);
  assert.deepEqual(events.at(-1), ["state", { shown: false }]);
  c.tidyOpen();
  assert.deepEqual(nav, ["/pages/card/index?id=c%201"]);
  c.tidyLater();
  assert.equal(events.at(-1)[0], "tidylater");
  reply = {
    kind: "item",
    item: { id: "r1", state: "shown", card: { id: "c2", type: "idea", title: "周末去图书馆" }, options: ["定了"] },
  };
  await c.load(true);
  assert.deepEqual(events.at(-1), ["state", { shown: true }]);
  const wxml = read("components/resume-card/index.wxml");
  const tidyAt = wxml.indexOf('wx:elif="{{known && tidy}}"');
  assert.ok(tidyAt > wxml.indexOf('wx:if="{{item && !collapsed}}"'));
  assert.ok(tidyAt > wxml.indexOf('wx:elif="{{item && collapsed}}"'));
  assert.match(wxml.slice(tidyAt), /bindtap="tidyOpen">整理一下<\/button><view class="later tap-area" bindtap="tidyLater">稍后<\/view>/);
  // On top of the page, above the box, as in 10-notes.
  const page = read("pages/notes/index.wxml");
  assert.ok(page.indexOf("<resume-card") < page.indexOf('class="sticky hi"'));
  assert.ok(page.indexOf('class="sticky hi"') < page.indexOf('class="compose"'));
  assert.match(page, /<resume-card [^>]*tidy="\{\{tidy\}\}" bind:state="resumeState" bind:tidylater="tidyLater"/);
  // A failure while the page is hidden is asked again on the next show,
  // instead of leaving the top card unknown for this visit.
  let failNext = true;
  const flaky = {
    ...context,
    require: (name) =>
      name.endsWith("/api")
        ? {
            post: async () => {
              if (failNext) {
                failNext = false;
                throw new Error("offline");
              }
              return { kind: "none", item: null };
            },
          }
        : context.require(name),
  };
  vm.runInNewContext(read("components/resume-card/index.js"), flaky);
  const d = {
    ...definition.methods,
    data: { ...structuredClone(definition.data), quiet: true, tidy: null },
    alive: true,
    triggerEvent: (name, detail) => events.push(JSON.parse(JSON.stringify([name, detail || null]))),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  };
  const pending = d.load();
  d.alive = false; // hidden before the answer
  await pending;
  assert.equal(d.data.known, false);
  d.alive = true;
  await d.load();
  assert.equal(d.data.known, true, "asked again on show");
});

test("the tour: 随心记 opens it once for anyone agreed who has not seen it; never for a guest", async () => {
  const fresh = notes({ storage: {} });
  fresh.p.onLoad();
  await fresh.p.onShow();
  assert.deepEqual(fresh.nav, [["relaunch", "/pages/onboard/index"]]);
  assert.deepEqual(fresh.urls, [], "nothing loaded before the tour");
  const seen = notes({ storage: { zhiye_onboarded: "1" } });
  seen.p.onLoad();
  await seen.p.onShow();
  assert.deepEqual(seen.nav, []);
  const guest = notes({ state: "guest", storage: {} });
  guest.p.onLoad();
  await guest.p.onShow();
  assert.deepEqual(guest.nav, []);
  // The tour already ran in this run but the flag could not be saved: no loop.
  const unsaved = notes({ storage: {}, globalData: { onboardShown: true } });
  unsaved.p.onLoad();
  await unsaved.p.onShow();
  assert.deepEqual(unsaved.nav, []);
});

function onboard(query, pages = 1) {
  let def;
  const storage = {},
    nav = [];
  const sandbox = {
    require: (n) =>
      n.endsWith("/gate")
        ? { check: () => true }
        : { asset: (f) => `https://assets.test/${f}` },
    Page: (x) => (def = x),
    getCurrentPages: () => Array.from({ length: pages }),
    wx: {
      setStorageSync: (k, v) => (storage[k] = v),
      reLaunch: (x) => nav.push(["relaunch", x.url]),
      navigateBack: () => nav.push(["back"]),
    },
  };
  vm.runInNewContext(read("pages/onboard/index.js"), sandbox);
  const p = {
    ...def,
    data: structuredClone(def.data),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  };
  p.onLoad(query);
  return { p, storage, nav };
}

test("帮助 › 再看一遍新手引导 opens the tour, which goes back to 帮助 at the end", () => {
  const wxml = read("pages/help/index.wxml");
  const start = wxml.indexOf("新手入门"),
    next = wxml.indexOf("产品资料");
  assert.ok(wxml.slice(start, next).includes('bindtap="openTour"><text class="copy title">再看一遍新手引导</text>'));
  let opened;
  let def;
  vm.runInNewContext(read("pages/help/index.js"), {
    Page: (x) => (def = x),
    wx: { navigateTo: (x) => (opened = x.url) },
  });
  def.openTour();
  assert.equal(opened, "/pages/onboard/index?from=help");
  const fromHelp = onboard({ from: "help" }, 3);
  // written at the end (开始使用 or 跳过), not on opening.
  assert.equal(fromHelp.storage.zhiye_onboarded, undefined);
  fromHelp.p.next();
  fromHelp.p.next();
  fromHelp.p.next();
  assert.equal(fromHelp.storage.zhiye_onboarded, "1");
  assert.deepEqual(fromHelp.nav, [["back"]]);
  fromHelp.p.finish();
  assert.deepEqual(fromHelp.nav.at(-1), ["back"]);
  // From the welcome page or 随心记: on to 随心记.
  const first = onboard({}, 1);
  first.p.finish();
  assert.deepEqual(first.nav, [["relaunch", "/pages/notes/index"]]);
});

test("注销 clears this phone's flags so whoever starts again is new here", () => {
  const js = read("pages/profile/index.js");
  const flags = read("utils/session.js");
  for (const key of ["zhiye_onboarded", "zhiye_notes_hello_closed", "zhiye_notes_tidy_later", "ask_tip_seen"])
    assert.match(flags, new RegExp(`"${key}"`));
  assert.match(js, /const \{ LOCAL_FLAGS \} = session;/);
  const at = js.indexOf('.del("/v1/me"');
  const done = js.slice(at, js.indexOf("账号注销了", at));
  assert.match(done, /auth\.clearConsent\(\);[\s\S]*LOCAL_FLAGS\.forEach\(\(key\) => \{[\s\S]*wx\.removeStorageSync\(key\)/);
});

test("welcome: 小狸 is a packaged png under 60 KB, the webp is left out of the package, one fallback", () => {
  const wxml = read("pages/welcome/index.wxml");
  assert.match(wxml, /<image wx:if="\{\{hi\.src\}\}" class="xl" src="\{\{hi\.src\}\}" webp="\{\{hi\.webp\}\}" mode="aspectFit" binderror="hiError" \/>/);
  const png = fs.statSync(path.join(root, "assets/xiaoli/hi.png"));
  assert.ok(png.size <= 60 * 1024, `${png.size}`);
  const config = JSON.parse(read("project.config.json"));
  assert.deepEqual(config.packOptions.ignore, [{ type: "file", value: "assets/xiaoli/hi.webp" }]);
  // No other packaged webp is referenced.
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  const local = walk(root)
    .filter((f) => /\.(wxml|wxss|js|json)$/.test(f) && !f.endsWith("project.config.json"))
    .filter((f) => /["'(]\/?assets\/[^"')]*\.webp/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(local, []);
  let def;
  vm.runInNewContext(read("pages/welcome/index.js"), {
    require: (n) =>
      n.endsWith("/assets") ? { asset: (f) => `https://assets.test/${f}` } : {},
    Page: (x) => (def = x),
    wx: {},
  });
  const p = {
    ...def,
    data: structuredClone(def.data),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  };
  assert.deepEqual({ ...p.data.hi }, { src: "/assets/xiaoli/hi.png", webp: false });
  p.hiError();
  assert.deepEqual({ ...p.data.hi }, { src: "https://assets.test/xiaoli-hi.webp", webp: true });
  p.hiError();
  assert.deepEqual({ ...p.data.hi }, { src: "", webp: false });
});

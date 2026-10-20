// 我的页面回归：核对学习时间热力图、个人设置和账号操作入口。
const test = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path");
const read = (file) =>
  fs.readFileSync(path.join(__dirname, "../miniprogram", file), "utf8");

function fixture({ state = "ok", study, missing = [], fail = [], nickname = "小林" } = {}) {
  let definition, modal;
  const requests = [],
    puts = [],
    dels = [],
    enabled = [],
    asks = [];
  const responses = {
    "/v1/chat/usage": { answers: { used: 2, limit: 20 }, photos: { used: 0, limit: 20 } },
    "/v1/me/usage": { date: "2026-10-16", ai: { used: 0, limit: 200 }, ocr: { used: 0, limit: 60 } },
    "/v1/learn/map": {
      chapters: [],
      summary: { level: 10, correct: 23, xp: 330, book: { rank: "重点段", reached: 3, of: 6 } },
    },
    "/v1/cards/stats": { total: 36 },
    "/v1/cards/stats?scene=study,life": { total: 30 },
    "/v1/me/suggest-cards": { enabled: true },
    "/v1/me/prefs": { personalized: true, studyTime: true },
    "/v1/me/study-time": study || {
      enabled: true,
      // A Friday.
      day: "2026-10-16",
      today: 25,
      days: [
        { day: "2026-10-16", minutes: 25 },
        { day: "2026-10-15", minutes: 15 },
        { day: "2026-10-14", minutes: 61 },
        { day: "2026-10-13", minutes: 60 },
        { day: "2026-10-12", minutes: 30 },
        { day: "2026-06-15", minutes: 1 },
        // Outside the 18 weeks: ignored by the map.
        { day: "2026-06-14", minutes: 99 },
      ],
      totalMinutes: 2180,
      totalDays: 42,
      currentStreak: 5,
      bestStreak: 14,
    },
  };
  const api = {
    get: async (url) => {
      requests.push(url);
      if (missing.includes(url))
        // As utils/request.js rejects; an old server's 404 has no code of ours.
        throw Object.assign(new Error("请求失败（404）"), { statusCode: 404 });
      if (fail.includes(url)) throw Object.assign(new Error("网络不太顺"), { code: "NETWORK" });
      return structuredClone(responses[url]);
    },
    put: async (url, body) => {
      puts.push([url, body]);
      return { personalized: true, studyTime: true, ...body };
    },
    del: async (url) => {
      dels.push(url);
      responses["/v1/me/study-time"] = {
        enabled: true, day: "2026-10-16", today: 0, days: [],
        totalMinutes: 0, totalDays: 0, currentStreak: 0, bestStreak: 0,
      };
      return { deleted: 7 };
    },
    needsConsent: () => false,
  };
  const deps = {
    api,
    auth: {
      hasConsent: () => state === "ok",
      getUser: () => ({ id: "u1", nickname }),
      login: async () => {},
      consentGeneration: () => 1,
    },
    gate: { state: () => state, check: () => state !== "none", ask: () => asks.push(1) },
    session: {},
    profile: require("../miniprogram/utils/profile.js"),
    format: { errorText: (e) => e.message },
    assets: { asset: (name) => `https://x/v1/assets/${name}` },
    "study-clock": { setEnabled: (on) => enabled.push(on) },
    "learning-space": { stickers: () => [] },
    learn: { backTo() {}, ROUTES: {} },
    cards: require("../miniprogram/utils/cards.js"),
    budget: require("../miniprogram/utils/budget.js"),
  };
  vm.runInNewContext(read("pages/profile/index.js"), {
    Page: (x) => (definition = x),
    require: (n) => deps[n.split("/").at(-1)],
    getApp: () => ({ globalData: {} }),
    setTimeout,
    clearTimeout,
    wx: {
      navigateTo() {},
      switchTab() {},
      showModal: (x) => (modal = x),
    },
  });
  const p = {
    ...definition,
    data: structuredClone(definition.data),
    setData(value, done) {
      for (const [k, v] of Object.entries(value)) {
        const keys = k.split(".");
        let o = this.data;
        while (keys.length > 1) o = o[keys.shift()];
        o[keys[0]] = v;
      }
      if (done) done();
    },
  };
  p.alive = true;
  return { p, requests, puts, dels, enabled, asks, modal: () => modal };
}
// Values made inside the page's vm context: compare them as plain data.
const plain = (x) => JSON.parse(JSON.stringify(x));
const settle = () => new Promise((r) => setTimeout(r, 0));

test("a server rolled back to v3.3 (no prefs, no 学习时长) still shows 我的, without those rows", async () => {
  const { p, enabled } = fixture({ missing: ["/v1/me/prefs", "/v1/me/study-time"] });
  p.onShow();
  await settle();
  await settle();
  assert.equal(p.data.error, "");
  assert.equal(p.data.stats.total, 36);
  assert.equal(p.data.learn.level, 10);
  assert.equal(p.data.prefs, false);
  assert.equal(p.data.study, null);
  // Unknown is not off: the clock is left as it was.
  assert.deepEqual(enabled, []);
  const wxml = read("pages/profile/index.wxml");
  assert.match(wxml, /wx:if="\{\{prefs\}\}" class="li"><text class="li-l">个性化学习推荐/);
  assert.match(wxml, /wx:if="\{\{prefs\}\}" class="li"><text class="li-l">学习时长统计/);
  assert.match(wxml, /wx:if="\{\{study\}\}" class="li" bindtap="deleteStudyTime"/);
  // The course tag of 60-me (Lv · 段位 · 高数上).
  assert.match(wxml, /<text>高数上<\/text><\/view>/);
  const ok = fixture();
  ok.p.onShow();
  await settle();
  await settle();
  assert.equal(ok.p.data.prefs, true);
  assert.deepEqual(plain(ok.enabled), [true]);
});

test("学习时间: 累计天数, two streaks and an 18-week map that ends with today's week", async () => {
  const { p } = fixture();
  p.onShow();
  await settle();
  await settle();
  const s = p.data.study;
  assert.deepEqual([s.total, s.current, s.best, s.todayMin], [42, 5, 14, 25]);
  // days, not hours or minutes (the user asked for 累计天数).
  const nums = read("pages/profile/index.wxml").match(/<view class="nums">[\s\S]*?<\/view>\s*<view class="heat">/)[0];
  assert.equal((nums.match(/class="num"/g) || []).length, 3);
  assert.match(nums, /\{\{study\.total\}\}<text class="num-u">天<\/text><\/view><text class="num-k">累计学习<\/text>/);
  assert.doesNotMatch(nums, /小时|分钟/);
  assert.equal(s.columns.length, 18);
  for (const col of s.columns) assert.equal(col.cells.length, 7);
  const last = s.columns[17].cells;
  // Monday on top: 10-12 is a Monday, today (Friday) is the fifth cell.
  assert.equal(last[0].day, "2026-10-12");
  assert.equal(last[4].day, "2026-10-16");
  assert.deepEqual(plain(last.map((c) => [c.td, c.fu])), [
    [false, false], [false, false], [false, false], [false, false],
    [true, false], [false, true], [false, true],
  ]);
  // 30 / 60 / 61 / 15 / 25 minutes → levels 2 / 3 / 4 / 1 / 2; future cells blank.
  assert.deepEqual(plain(last.slice(0, 5).map((c) => c.lv)), [2, 3, 4, 1, 2]);
  // The first column starts 17 weeks before that Monday.
  assert.equal(s.columns[0].cells[0].day, "2026-06-15");
  assert.equal(s.columns[0].cells[0].lv, 1);
  const all = s.columns.flatMap((c) => c.cells);
  assert.equal(all.filter((c) => c.td).length, 1);
  assert.ok(!all.some((c) => c.day === "2026-06-14"));
  assert.equal(all.filter((c) => c.lv > 0).length, 6);
  // Month names sit over the week a month begins in.
  assert.equal(s.months.length, 18);
  assert.equal(s.months[17 - 2], "10月"); // week of 09-28 holds 10-01
  assert.equal(s.months.filter(Boolean).length, 5);
  assert.deepEqual(
    [p.data.learn.level, p.data.learn.rank, p.data.learn.correct, p.data.learn.xp, p.data.stats.total],
    [10, "重点段", 23, 330, 36],
  );
});

test("five levels: none, ≤15, ≤30, ≤60 and more than an hour", async () => {
  const days = [0, 1, 15, 16, 30, 31, 60, 61].map((minutes, i) => ({
    day: `2026-10-0${i + 1}`,
    minutes,
  }));
  const { p } = fixture({
    study: { enabled: true, day: "2026-10-08", today: 61, days, totalMinutes: 214, currentStreak: 7, bestStreak: 7 },
  });
  await p.load();
  const cells = p.data.study.columns.flatMap((c) => c.cells);
  const lv = (day) => cells.find((c) => c.day === day).lv;
  assert.deepEqual(
    days.map((d) => lv(d.day)),
    [0, 1, 1, 2, 2, 3, 3, 4],
  );
  // A v4.1 server sends no totalDays: the days it sent are counted.
  assert.equal(p.data.study.total, 8);
});

test("tapping a day shows its minutes under the map; today and the future do not", async () => {
  const { p } = fixture();
  await p.load();
  const tap = (w, i) => p.pickDay({ currentTarget: { dataset: { w, i } } });
  tap(17, 2);
  assert.deepEqual({ ...p.data.picked }, { day: "2026-10-14", label: "10月14日", min: 61 });
  tap(17, 2);
  assert.equal(p.data.picked, null, "a second tap goes back to today");
  tap(17, 1);
  tap(17, 4);
  assert.equal(p.data.picked, null, "today is the default line");
  tap(17, 6);
  assert.equal(p.data.picked, null);
  const wxml = read("pages/profile/index.wxml");
  assert.match(wxml, /今天 <text class="hf-b">\{\{study\.todayMin\}\}<\/text> 分钟/);
  assert.match(wxml, /只给自己看，不排行，不和别人比。/);
  assert.match(wxml, /少<\/text>(<view class="hk l\d" \/>){5}<text>多/);
});

test("the two prefs switches save through /v1/me/prefs and the clock follows 学习时长统计", async () => {
  const { p, puts, enabled } = fixture();
  await p.load();
  assert.deepEqual(enabled, [true]);
  await p.togglePref({ currentTarget: { dataset: { k: "studyTime" } }, detail: { value: false } });
  assert.deepEqual(plain(puts.at(-1)), ["/v1/me/prefs", { studyTime: false }]);
  assert.equal(p.data.studyTime, false);
  assert.equal(p.data.study.enabled, false);
  assert.deepEqual(enabled, [true, false]);
  await p.togglePref({ currentTarget: { dataset: { k: "personalized" } }, detail: { value: false } });
  assert.deepEqual(plain(puts.at(-1)), ["/v1/me/prefs", { personalized: false }]);
  assert.equal(p.data.personalized, false);
});

test("删除学习时长记录 asks once, deletes and reloads the map", async () => {
  const { p, dels, modal } = fixture();
  await p.load();
  p.deleteStudyTime();
  assert.match(modal().title, /删除学习时长记录/);
  modal().success({ confirm: false });
  assert.equal(dels.length, 0);
  p.deleteStudyTime();
  modal().success({ confirm: true });
  await settle();
  await settle();
  await settle();
  assert.deepEqual(dels, ["/v1/me/study-time"]);
  assert.equal(p.data.study.total, 0);
  assert.equal(p.data.study.columns.flatMap((c) => c.cells).filter((c) => c.lv).length, 0);
});

test("a guest sees 帮助 and 隐私政策 without any request; account actions ask to agree", async () => {
  const { p, requests, asks } = fixture({ state: "guest" });
  p.onShow();
  await settle();
  assert.equal(p.data.guest, true);
  assert.equal(requests.length, 0);
  assert.equal(p.data.study, null);
  p.openMoodLog();
  p.exportData();
  p.openTags();
  assert.equal(asks.length, 3);
  const wxml = read("pages/profile/index.wxml");
  const guestPart = wxml.slice(wxml.lastIndexOf("wx:else"));
  assert.match(guestPart, /openHelp/);
  assert.match(guestPart, /openPrivacy/);
  assert.match(guestPart, /隐私政策/);
  assert.match(wxml, /<guest-bar \/>/);
  assert.match(wxml, /<page-head tint="slate" \/>/);
  const json = JSON.parse(read("pages/profile/index.json"));
  assert.equal(json.navigationStyle, "custom");
  assert.ok(json.usingComponents["guest-bar"] && json.usingComponents["page-head"]);
});

test("profile icons come from asset() and nothing in the main package is added", () => {
  const js = read("pages/profile/index.js");
  const wxml = read("pages/profile/index.wxml");
  for (const name of ["card-index-dividers", "glowing-star", "sports-medal", "sun-behind-cloud", "label", "alarm-clock", "inbox-tray", "open-book"])
    assert.ok(js.includes(`asset("ic-${name}.webp")`), name);
  for (const img of wxml.match(/<image[^>]*src="\{\{icons\.[^>]*>/g)) {
    assert.match(img, /webp="\{\{true\}\}"/);
    assert.match(img, /binderror=/);
  }
});

test("错题本: 错过 N 次 shows from the first miss, as on 60-me#wrongbook", () => {
  const wxml = read("pages/mistakes/index.wxml");
  assert.match(wxml, /<text wx:if="\{\{item\.wrong > 0\}\}">错过 \{\{item\.wrong\}\} 次<\/text>/);
  assert.doesNotMatch(wxml, /item\.wrong > 1/);
});

test("V4.2: one failing request keeps the other parts and what was shown before", async () => {
  const { p } = fixture({ fail: ["/v1/cards/stats", "/v1/me/prefs"] });
  // Nothing known yet: a dash, not a zero.
  const wxml = read("pages/profile/index.wxml");
  assert.match(wxml, /\{\{stats \? stats\.total : '—'\}\}/);
  assert.match(wxml, /\{\{learn \? learn\.correct : '—'\}\}/);
  assert.match(wxml, /\{\{learn \? learn\.xp : '—'\}\}/);
  await p.load();
  assert.equal(p.data.error, "网络不太顺");
  assert.equal(p.data.stats, null);
  assert.equal(p.data.learn.level, 10);
  assert.equal(p.data.study.total, 42);
  assert.equal(p.data.usage.length, 4);
  // Failing is not missing: the switches are not taken away as on a v3.3 server.
  assert.equal(p.data.prefs, false);
  p.data.prefs = true;
  p.data.stats = { total: 36 };
  const again = await p.load();
  assert.equal(again, undefined);
  assert.equal(p.data.prefs, true, "a failed prefs read keeps the rows");
  assert.equal(p.data.stats.total, 36, "a failed stats read keeps the count");
});

test("V4.2: the initial is the first character, also for an emoji or a rare character", async () => {
  for (const [nickname, initial] of [["😀小林", "😀"], ["𠮷野", "𠮷"], ["小林", "小"], ["微信用户", ""]]) {
    const { p } = fixture({ nickname });
    await p.load();
    assert.equal(p.data.initial, initial, nickname);
  }
});

test("V4.2: 导出 shows 准备中… while the file is made; 注销 says the export has no photos", async () => {
  const wxml = read("pages/profile/index.wxml");
  assert.match(wxml, /\{\{exporting \? '准备中…' : '导出'\}\}/);
  const js = read("pages/profile/index.js");
  assert.match(js, /先导出一份；导出的是 JSON 文件，不含原图。/);
});

test("V4.2: with 心情卡 hidden the card count leaves them out, and the switch reloads it", async () => {
  const stored = { "zhiye_show_mood:u1": "0" };
  global.wx = {
    getStorageSync: (key) => stored[key] || "",
    setStorageSync: (key, value) => (stored[key] = value),
  };
  try {
    const { p, requests } = fixture();
    await p.load();
    assert.ok(requests.includes("/v1/cards/stats?scene=study,life"), requests.join("\n"));
    assert.equal(p.data.stats.total, 30);
    p.owner = "u1";
    requests.length = 0;
    p.toggleMood({ detail: { value: true } });
    await settle();
    await settle();
    assert.ok(requests.includes("/v1/cards/stats"), requests.join("\n"));
    assert.equal(p.data.stats.total, 36);
  } finally {
    delete global.wx;
  }
});

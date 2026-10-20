const test = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path");
function fixture() {
  let definition,
    owner = "one",
    resolvePut;
  const requests = [],
    nav = [],
    stickers = [],
    app = { globalData: {} };
  const responses = {
    "/v1/chat/usage": {
      answers: { used: 1, limit: 60 },
      photos: { used: 0, limit: 20 },
    },
    "/v1/me/usage": {
      date: "2026-10-12",
      ai: { used: 0, limit: 200 },
      ocr: { used: 0, limit: 60 },
      notes: { used: 1, limit: 30 },
      brainstorm: { used: 0, limit: 10 },
      import: { used: 0, limit: 10 },
    },
    "/v1/learn/map": { chapters: [], summary: { level: 3 } },
    "/v1/cards/stats": {
      total: 5,
      closed: 2,
      clear: 3,
      tagCount: 1,
      closedByType: { idea: 2 },
      predicted: 4,
      actual: 2,
    },
    "/v1/me/suggest-cards": { enabled: false },
    "/v1/me/prefs": { personalized: true, studyTime: true },
    "/v1/me/study-time": {
      enabled: true,
      day: "2026-10-12",
      today: 0,
      days: [],
      totalMinutes: 0,
      currentStreak: 0,
      bestStreak: 0,
    },
  };
  const api = {
    get: async (url) => {
      requests.push(url);
      return responses[url];
    },
    put: () => new Promise((resolve) => (resolvePut = resolve)),
    needsConsent: () => false,
  };
  const deps = {
    api,
    auth: {
      hasConsent: () => true,
      signedIn: () => true,
      getUser: () => ({ id: owner, nickname: owner }),
      login: async () => {},
    },
    session: {},
    profile: require("../miniprogram/utils/profile.js"),
    gate: { state: () => "ok", check: () => true, ask() {} },
    assets: { asset: (name) => name },
    "study-clock": { setEnabled() {} },
    format: { errorText: (e) => e.message },
    "learning-space": { stickers: () => stickers },
    learn: { backTo() {}, ROUTES: {} },
    cards: require("../miniprogram/utils/cards.js"),
    budget: require("../miniprogram/utils/budget.js"),
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../miniprogram/pages/profile/index.js"),
      "utf8",
    ),
    {
      Page: (x) => (definition = x),
      require: (n) => deps[n.split("/").at(-1)],
      getApp: () => app,
      setTimeout,
      clearTimeout,
      wx: {
        switchTab: (x) => nav.push(x.url),
        navigateTo: (x) => nav.push(x.url),
      },
    },
  );
  const p = {
    ...definition,
    data: structuredClone(definition.data),
    setData(value) {
      Object.assign(this.data, value);
    },
  };
  p.alive = true;
  p.loadVersion = 0;
  return {
    p,
    requests,
    responses,
    stickers,
    nav,
    app,
    changeOwner: (value) => (owner = value),
    resolve: (value) => resolvePut(value),
  };
}
test("profile shows owned card totals, seven actual allowance buckets and recommendation setting", async () => {
  const { p, requests } = fixture();
  await p.load();
  assert.equal(p.data.stats.total, 5);
  assert.equal(p.data.usage.length, 7);
  assert.deepEqual(
    [...p.data.usage.map((c) => c.left)],
    [59, 20, 200, 60, 29, 10, 10],
  );
  assert.equal(p.data.lowUsage, "", "no allowance is close to running out");
  assert.equal(p.data.suggestCards, false);
  assert.equal(p.data.name, "one");
  assert.equal(p.data.left, 59, "今天还能用 shows the 问 AI count");
  assert.equal(requests.length, 8);
  assert.ok(requests.includes("/v1/auth/me"), "refresh profile data from the current account");
  // Allowances stay folded under 今天还能用 until opened.
  assert.equal(p.data.usageOpen, false);
  p.openUsage();
  assert.equal(p.data.usageOpen, true);
});
test("profile mentions only the allowance closest to running out, in one line", async () => {
  const f = fixture();
  f.responses["/v1/chat/usage"].answers = { used: 55, limit: 60 };
  f.responses["/v1/me/usage"].brainstorm = { used: 10, limit: 10 };
  await f.p.load();
  assert.equal(f.p.data.lowUsage, "今天的头脑风暴次数用完了，明天再来");
  f.responses["/v1/me/usage"].brainstorm = { used: 0, limit: 10 };
  await f.p.load();
  assert.equal(f.p.data.lowUsage, "今天的聊天还能用 5 次");
  f.responses["/v1/chat/usage"].answers = { used: 0, limit: 60 };
  f.responses["/v1/me/usage"].notes = { used: 28, limit: 30 };
  await f.p.load();
  assert.equal(f.p.data.lowUsage, "今天的 AI 理卡还能用 2 次");
});
test("V4.2 G4: with a budget, 我的 shows today's and this week's used percentages and when they come back", async () => {
  const f = fixture();
  const day = new Date(Date.now() + 3600000).toISOString();
  const week = new Date(Date.now() + 3 * 86400000).toISOString();
  f.responses["/v1/me/usage"].budget = { day: { pct: 35, resetAt: day }, week: { pct: 12, resetAt: week } };
  await f.p.load();
  assert.equal(f.p.data.budget, "今天已用 35% · 本周已用 12%");
  assert.deepEqual(
    JSON.parse(JSON.stringify(f.p.data.usage.map((c) => [c.k, c.pct, c.share, c.reset]))),
    [["今天", 35, 35, "明天 0 点恢复"], ["本周", 12, 12, "下周一 0 点恢复"]],
  );
  assert.equal(f.p.data.left, null, "no count row");
  assert.equal(f.p.data.lowUsage, "", "below 80%: no line");
  f.responses["/v1/me/usage"].budget.day.pct = 84;
  await f.p.load();
  assert.equal(f.p.data.lowUsage, "今天已用 84%，明天 0 点恢复");
  f.responses["/v1/me/usage"].budget.week.pct = 100;
  await f.p.load();
  assert.equal(f.p.data.lowUsage, "这周的额度用完了，下周一 0 点恢复");
  const wxml = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/profile/index.wxml"), "utf8");
  assert.match(wxml, /budget \? '额度' : '今天还能用'/);
  assert.match(wxml, /已用 <text>\{\{item.pct\}\}<\/text>%/);
  assert.doesNotMatch(wxml, /¥|元/, "no yuan for learners");
});
test("profile greets without the placeholder WeChat nickname; the stickers are on 学习 now (D112)", async () => {
  const f = fixture();
  f.changeOwner("微信用户");
  f.stickers.push(
    { id: "limit", name: "极限", rank: "基础段", earned: true, hidden: false },
    { id: "ode", name: "微分方程", rank: "重点段", earned: true, hidden: true },
  );
  await f.p.load();
  assert.equal(f.p.data.name, "");
  assert.equal(f.p.data.stickers, undefined);
});
test("a late recommendation toggle cannot overwrite a newly selected account", async () => {
  const f = fixture();
  f.p.data.suggestCards = true;
  const pending = f.p.toggleSuggest({ detail: { value: false } });
  f.changeOwner("two");
  f.resolve({ enabled: false });
  await pending;
  assert.equal(f.p.data.suggestCards, true);
});
test("the card count opens the whole card wall with every filter cleared", () => {
  const { p, app, nav } = fixture();
  app.globalData.cardFilter = null;
  p.openCards();
  assert.deepEqual(JSON.parse(JSON.stringify(app.globalData.cardFilter)), {});
  assert.equal(nav[0], "/pages/deck/index");
});
test("profile copy keeps one name per feature and lists every setting", () => {
  const wxml = fs.readFileSync(
    path.join(__dirname, "../miniprogram/pages/profile/index.wxml"),
    "utf8",
  );
  const js = fs.readFileSync(
    path.join(__dirname, "../miniprogram/pages/profile/index.js"),
    "utf8",
  );
  for (const old of ["接续", "收尾", "学习库", "今日用量", "你自己写下的我的话", "Lv."])
    assert.ok(!wxml.includes(old) && !js.includes(old), old);
  for (const handler of [
    "openResume",
    "toggleSuggest",
    "togglePref",
    "toggleUsage",
    "exportData",
    "openPrivacy",
    "deleteStudyTime",
    "deleteAccount",
    "openMoodLog",
    "openTags",
    "openHelp",
    "openCards",
  ])
    assert.ok(wxml.includes(`"${handler}"`), handler);
  // 段位与贴纸, 我的资料 and 学习记录 moved to 学习.
  for (const moved of ["toggleLearn", "toggleStickers", "openLibrary", "openChapter", "以为会", "学习记录", "段位", "我的资料"])
    assert.ok(!wxml.includes(moved) && !js.includes(moved), moved);
  // 换皮肤 is gone (v4); 隐私说明 is now 隐私政策.
  assert.doesNotMatch(wxml + js, /chooseSkin|换皮肤|theme|隐私说明|回头问我/);
  assert.match(wxml, /隐私政策/);
});
function load(file, deps = {}, globals = {}) {
  let definition;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../miniprogram", file), "utf8"),
    {
      Page: (x) => (definition = x),
      require: (n) =>
        deps[n.split("/").at(-1)] ||
        (n.endsWith("/theme") ? { themed: (x) => x } : {}),
      ...globals,
    },
  );
  const p = {
    ...definition,
    data: structuredClone(definition.data),
    setData(value) {
      Object.assign(this.data, value);
    },
  };
  return p;
}
const read = (file) =>
  fs.readFileSync(path.join(__dirname, "../miniprogram", file), "utf8");
test("runtime surfaces and help consistently use the short product name", () => {
  const config = require("../miniprogram/utils/config.js");
  const app = JSON.parse(read("app.json"));
  const project = JSON.parse(read("project.config.json"));
  assert.equal(config.APP_NAME, "晓念");
  assert.equal(app.window.navigationBarTitleText, "晓念");
  assert.equal(project.projectname, "晓念");
  assert.match(project.description, /^晓念：/);

  const help = load("pages/help/index.js");
  const intro = help.data.about.find((item) => item.id === "intro");
  assert.equal(intro.title, "晓念是什么");
  assert.match(intro.text, /^晓念用 AI 帮你学习：/);
  assert.doesNotMatch(JSON.stringify(help.data), /晓念随心记/);

  for (const file of ["pages/home/index.json", "pages/crisis/index.json"])
    assert.equal(JSON.parse(read(file)).navigationBarTitleText, "晓念");
  for (const file of ["pages/welcome/index.wxml", "pages/privacy/index.wxml", "pages/profile/index.js"])
    assert.doesNotMatch(read(file), /晓念随心记/);

  const admin = fs.readFileSync(path.join(__dirname, "../admin/index.html"), "utf8");
  assert.match(admin, /<title>晓念 · 运营管理台<\/title>/);
  assert.match(admin, /class="brand-symbol" aria-hidden="true">晓<\/span/);
  assert.match(admin, /class="paper-sticker">晓<\/span/);
  assert.doesNotMatch(admin, /晓念随心记/);
});
test("help opens with three steps and keeps every rule behind a question", () => {
  const nav = [];
  const p = load("pages/help/index.js", {}, {
    wx: { navigateTo: (x) => nav.push(x.url) },
  });
  assert.equal(p.data.open.start, true);
  assert.deepEqual(
    [...p.data.steps],
    // not every card comes back, so the third step says which ones do.
    ["说一句或写一句", "AI 帮你理一理，存成一张卡", "需要回头看的，过几天它会回来问一句"],
  );
  assert.deepEqual(
    [...p.data.sections.map((s) => s.id)],
    // V4.2 : 聊一聊怎么用 (the tab, history, chips and replay); the
    // three study tools after the map.
    ["cards", "talk", "resume", "learn", "tools", "rank", "quota"],
  );
  // 反馈与隐私 holds feedback and privacy only.
  assert.deepEqual([...p.data.privacy.map((s) => s.id)], ["privacy"]);
  for (const section of [...p.data.sections, ...p.data.privacy]) {
    assert.match(section.title, /？$/);
    assert.equal(Boolean(p.data.open[section.id]), false, section.id);
  }
  p.toggle({ currentTarget: { dataset: { id: "resume" } } });
  assert.equal(p.data.open.resume, true);
  assert.equal(p.data.open.start, true, "opening a question keeps the steps");
  p.openPrivacy();
  assert.equal(nav[0], "/pages/privacy/index");
  // 帮助中心 : three groups in the meeting's order, then the hotline.
  assert.deepEqual([...p.data.basics.map((s) => s.id)], ["account"]);
  assert.deepEqual([...p.data.about.map((s) => s.id)], ["intro", "idea"]);
  for (const item of [...p.data.basics, ...p.data.about]) {
    assert.ok(item.text.length > 20, item.id);
    assert.equal(Boolean(p.data.open[item.id]), false, item.id);
  }
  const wxml = read("pages/help/index.wxml");
  const order = ["新手入门", "三步上手", "{{basics}}", "产品资料", "{{about}}", "学习与卡片", "{{sections}}", "反馈与隐私", 'open-type="feedback"', "{{privacy}}", "openPrivacy", "求助热线"].map((w) => wxml.indexOf(w));
  assert.ok(order.every((at, i) => at > (i ? order[i - 1] : -1)), order.join(","));
  assert.match(wxml, /bindtap="openHotline"/);
  p.openHotline();
  assert.equal(nav[1], "/pages/crisis/index");
  assert.match(read("pages/help/index.json"), /"帮助中心"/);
  const source = read("pages/help/index.js");
  // 额度 is the learner's word for the budget now (我的 › 额度).
  for (const word of ["接续", "冷启动", "休眠", "槽位", "程序", "复测", "主线", "支线", "大模型", "收尾"])
    assert.ok(!source.includes(word), word);
  assert.doesNotMatch(source, /次数|几次|算一次/, "no counts left in help");
  // V4.2 : the list is called 回顾和提醒.
  assert.match(source, /“回顾和提醒”/);
  assert.doesNotMatch(source + read("pages/help/index.wxml"), /回头问我|讲给 AI 听|隐私说明|四个点|几个点/);
  // The stage words are the ones the cards show (utils/cards.js STAGES).
  for (const word of ["已记下", "已整理", "已说清", "已完成"]) assert.ok(source.includes(word), word);
  // Repeating reminders  are in the answer about 提醒.
  assert.match(source, /“重复”里选“每天”“每周”/);
  assert.match(read("pages/resume-settings/index.json"), /"提醒"/);
});
test("隐私政策 links the three documents and drops the old wording", () => {
  const wxml = read("pages/privacy/index.wxml");
  const js = read("pages/privacy/index.js");
  for (const doc of ["user-agreement", "privacy-policy", "children-privacy"]) assert.ok(js.includes(doc), doc);
  for (const name of ["用户协议", "隐私政策", "儿童隐私政策"]) assert.ok(js.includes(`"${name}"`), name);
  assert.match(wxml, /撤回授权并退出登录/);
  assert.match(wxml, /导出我的数据/);
  assert.doesNotMatch(wxml + js, /境内|境外|隐私说明|智谱|TypeSafe/);
  assert.match(read("pages/privacy/index.json"), /"隐私政策"/);
  let modal;
  const p = load(
    "pages/privacy/index.js",
    { config: { PRIVACY_VERSION: "v" }, auth: {}, gate: { age: () => "adult" }, session: { getSession: () => null } },
    { wx: { showModal: (x) => (modal = x) } },
  );
  p.revoke();
  assert.match(modal.content, /“我的资料”/);
  assert.doesNotMatch(modal.content, /“资料”/);
});
test("me pages avoid banned phrases, model names and request ids", () => {
  const banned = [
    ...read("../server/src/modules/safety/banned-phrases.ts").matchAll(
      /"([^"]+)"/g,
    ),
  ].map((m) => m[1]);
  assert.ok(banned.length > 5);
  for (const page of ["profile", "help", "privacy", "mood-log"])
    for (const ext of ["js", "wxml"]) {
      const text = read(`pages/${page}/index.${ext}`);
      for (const phrase of banned) assert.ok(!text.includes(phrase), `${page}: ${phrase}`);
      assert.doesNotMatch(text, /GLM|glm-|DeepSeek|GPT|Qwen|Claude|Gemini|请求编号|（请求/, page);
    }
});

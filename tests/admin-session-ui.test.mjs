import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as model from "../admin/model.mjs";

// Execute the real browser controller with a minimal DOM. This checks request
// ownership and content construction, not layout or native browser rendering.
const source = readFileSync(
  new URL("../admin/app.js", import.meta.url),
  "utf8",
).replace(/^import\s*\{[\s\S]*?\}\s*from\s*"\.\/model\.mjs";\s*/, "");
class Element {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.className = "";
    this.ownText = "";
    this.classList = {
      add: (...names) => {
        this.className += ` ${names.join(" ")}`;
      },
      toggle: (name, enabled) => {
        const items = this.className
          .split(" ")
          .filter((item) => item && item !== name);
        if (enabled) items.push(name);
        this.className = items.join(" ");
      },
    };
  }
  set textContent(value) {
    this.ownText = String(value);
    this.children = [];
  }
  get textContent() {
    return (
      this.ownText + this.children.map((child) => child.textContent).join("")
    );
  }
  set innerHTML(_) {
    throw new Error("Raw HTML is forbidden in the console");
  }
  append(...children) {
    for (const child of children) {
      this.children.push(child);
      child.parent = this;
    }
  }
  replaceChildren(...children) {
    this.ownText = "";
    this.children = [];
    this.append(...children);
  }
  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  focus() {
    this.focused = true;
  }
  remove() {
    this.parent.children = this.parent.children.filter(
      (child) => child !== this,
    );
  }
  querySelectorAll(selector) {
    const classes = selector.split(",").map((item) => item.replace(/^\./, ""));
    const nodes = [];
    const visit = (element) => {
      element.children.forEach((child) => {
        if (classes.some((name) => child.className.split(" ").includes(name)))
          nodes.push(child);
        visit(child);
      });
    };
    visit(this);
    return nodes;
  }
}
const readySession = () => ({
  data: {
    authenticated: true,
    expiresAt: "2026-10-04T00:15:00Z",
    absoluteExpiresAt: "2026-10-04T08:00:00Z",
    idleTimeoutSec: 900,
  },
});
const jobs = () => ({
  data: {
    from: "2026-09-28",
    kinds: [
      {
        kind: "note_organize",
        succeeded: 2,
        failed: 0,
        unknown: 0,
        queued: 0,
        running: 0,
        avgSec: 1,
        p95Sec: 1.5,
      },
    ],
    recent: [],
    queue: {
      queued: 0,
      running: 0,
      oldestQueuedSec: null,
      oldestRunningSec: null,
    },
  },
});
const usage = () => ({
  data: {
    date: "2026-10-04",
    buckets: [
      {
        bucket: "notes",
        limit: 10,
        jobs: 2,
        users: 1,
        nearLimit: 0,
        atLimit: 0,
      },
    ],
    ledger: {
      period: "today",
      startedAt: "2026-10-04T00:00:00Z",
      totals: {
        calls: 2,
        promptTokens: 100,
        completionTokens: 20,
        unknown: 0,
        unreported: 0,
      },
      cumulative: { calls: 2 },
      providers: [],
      trend: [
        {
          date: "2026-10-04",
          calls: 2,
          promptTokens: 100,
          completionTokens: 20,
          unknown: 0,
        },
      ],
    },
    cost: {
      status: "unavailable",
      amount: null,
      currency: null,
      note: "以供应商账单为准",
    },
    coverage: { limitations: ["从升级开始"] },
    storage: {
      databaseBytes: 1024,
      schemaVersion: 11,
      uploads: { files: 0, bytes: 0 },
    },
  },
});
const limits = { ai: 20, ocr: 10, notes: 10, chat: 30, photos: 10, brainstorm: 10, import: 10 };
const todo = () => ({
  data: {
    feedback: { map: 1, artifact: 0 },
    jobs: { failed24h: 1, unknown24h: 0, retryable: 1, queued: 0 },
    ai: { endpoints: 1, enabled: 1, vision: 0, cooling: 0 },
    users: { total: 3, banned: 0, newToday: 1, overrides: 0 },
  },
});
const feedback = () => ({
  data: {
    items: [
      {
        type: "map",
        id: "mrp_1",
        pointId: "c1-limit",
        pointName: "数列极限",
        chapter: "第一章",
        reason: "judge",
        problemIndex: 0,
        problemKind: "number",
        problem: { kind: "number", text: "求 $\\lim x$", answer: "2" },
        answer: "<img src=x onerror=private()>",
        understood: "2.0",
        verdict: "incorrect",
        createdAt: "2026-10-04T00:00:00Z",
        handledAt: null,
        handledNote: null,
      },
      {
        type: "artifact",
        id: "rep_1",
        artifactKind: "explain",
        model: "m1",
        reason: "wrong",
        note: "讲错了",
        createdAt: "2026-10-04T00:00:00Z",
        handledAt: "2026-10-04T01:00:00Z",
        handledNote: "已核对",
      },
    ],
  },
});
const account = {
  id: "usr_1",
  nickname: "同学甲",
  authMode: "dev",
  createdAt: "2026-10-01T00:00:00Z",
  lastActiveAt: "2026-10-04T00:00:00Z",
  bannedAt: null,
  banReason: null,
};
const users = () => ({
  data: {
    items: [
      {
        ...account,
        quota: {},
        today: { ai: 1, ocr: 0, notes: 0, chat: 2, photos: 0 },
      },
    ],
    total: 1,
    page: 1,
    pages: 1,
    global: limits,
  },
});
const userDetail = () => ({
  data: {
    ...account,
    quota: { chat: 5 },
    counts: {
      materials: 1,
      notes: 2,
      threads: 3,
      mapPoints: 4,
      mistakes: 0,
      reports: 1,
      jobs7d: 2,
    },
    usage: Object.fromEntries(
      Object.entries(limits).map(([bucket, limit]) => [
        bucket,
        { used: 0, limit: bucket === "chat" ? 5 : limit },
      ]),
    ),
    global: limits,
    history: [],
  },
});
const ai = () => ({
  data: {
    endpoints: [
      {
        id: "ep_1",
        alias: "主力",
        baseUrl: "https://api.example.com/v1",
        model: "m1",
        vision: false,
        thinkingFormat: "none",
        extraBody: {},
        timeoutMs: 30000,
        enabled: true,
        keyHint: "…abcd",
        health: { coolingUntil: null, lastError: null, lastOkAt: null },
        last24h: {
          calls: 0,
          succeeded: 0,
          failed: 0,
          unknown: 0,
          promptTokens: 0,
          completionTokens: 0,
          avgMs: null,
        },
      },
    ],
    thinking: {
      ask: "off",
      recheck: "high",
      notes: "off",
      study: "low",
      photo: "off",
    },
  },
});
const settings = () => ({ data: { limits: { current: limits, defaults: limits } } });
const bank = () => ({
  data: {
    points: [
      {
        pointId: "c1-limit",
        name: "数列极限",
        chapterId: "c1",
        chapter: "第一章",
        section: "1.2",
        tier: "基础",
        order: 1,
        reports: { total: 1, open: 1 },
        problems: [{ index: 0, kind: "number", text: "求极限", answer: "2" }],
      },
    ],
    chapters: [{ id: "c1", short: "第一章", label: "第一章 函数与极限" }],
    problems: 1,
  },
});
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const settle = () => new Promise((done) => setImmediate(done));
const find = (root, test) => {
  if (test(root)) return root;
  for (const child of root.children) {
    const found = find(child, test);
    if (found) return found;
  }
  return null;
};
const buttonNamed = (root, label) =>
  find(root, (item) => item.tagName === "button" && item.textContent === label);
const click = (item) => item.listeners.click({ currentTarget: item });
const sent = (app, method, path) =>
  app.requests.filter(
    (request) => request.options.method === method && request.path === path,
  );
function harness() {
  const elements = new Map();
  const get = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  get("#workspace").hidden = true;
  get("#login-error").hidden = true;
  const nav = [
    "overview",
    "feedback",
    "users",
    "jobs",
    "ai",
    "settings",
    "bank",
    "quality",
    "usage",
    "audit",
    "operations",
  ].map((page) => {
    const item = new Element("button");
    item.dataset.page = page;
    return item;
  });
  const requests = [];
  const timers = [];
  const pending = [];
  const windowEvents = {};
  const documentEvents = {};
  let custom;
  const defaults = (path, options) => {
    if (path === "/v1/admin/session") {
      if (options.method === "POST") return response(readySession());
      if (options.method === "DELETE")
        return response({ data: { revoked: true } });
      return response({ message: "管理会话已失效" }, 401);
    }
    if (path === "/v1/admin/overview")
      return response({ data: { users: 3, uptimeSec: 50 } });
    if (path === "/v1/admin/jobs") return response(jobs());
    if (path === "/v1/admin/usage") return response(usage());
    if (path === "/v1/admin/todo") return response(todo());
    if (path.startsWith("/v1/admin/feedback?")) return response(feedback());
    if (path.startsWith("/v1/admin/users/")) return response(userDetail());
    if (path === "/v1/admin/users" || path.startsWith("/v1/admin/users?"))
      return response(users());
    if (path === "/v1/admin/ai") return response(ai());
    if (path === "/v1/admin/settings") return response(settings());
    if (path === "/v1/admin/bank") return response(bank());
    if (path === "/v1/admin/audit" || path.startsWith("/v1/admin/audit?"))
      return response({ data: [] });
    if (path === "/v1/admin/quality")
      return response({
        data: { materials: [], generated: [], mapReports: [] },
      });
    if (path === "/v1/admin/operations")
      return response({
        data: {
          database: "ok",
          mode: "development",
          metrics: { requestCount: 12, errorCount: 0, avgDurationMs: 2 },
          security: {
            adminSessions: true,
            adminIdleTimeoutSec: 900,
            adminAbsoluteTimeoutSec: 28800,
          },
          integrations: { wechat: false, ai: false, judge: false, ocr: false },
        },
      });
    if (path === "/health/live")
      return response({ status: "ok", uptimeSec: 50 });
    if (path === "/health/ready") return response({ status: "ready" });
    throw new Error(`Unexpected request ${path}`);
  };
  const context = vm.createContext({
    ...model,
    Node: Element,
    Headers,
    AbortController,
    Error,
    TypeError,
    Intl,
    Date,
    document: {
      querySelector: get,
      querySelectorAll: () => nav,
      createElement: (tag) => new Element(tag),
      createElementNS: (_, tag) => new Element(tag),
      createTextNode: (text) => {
        const element = new Element("#text");
        element.textContent = text;
        return element;
      },
      addEventListener: (name, handler) => {
        documentEvents[name] = handler;
      },
      hidden: false,
    },
    window: {
      addEventListener: (name, handler) => {
        windowEvents[name] = handler;
      },
    },
    setTimeout: (fn, ms) => {
      timers.push(ms);
      pending.push({ fn, ms });
      return 1;
    },
    clearTimeout: () => {},
    fetch: async (path, options) => {
      requests.push({ path, options });
      return custom?.(path, options) ?? defaults(path, options);
    },
  });
  vm.runInContext(source, context);
  return {
    get,
    requests,
    timers,
    pending,
    windowEvents,
    context,
    override: (handler) => {
      custom = handler;
    },
    navigate: (page) =>
      vm.runInContext(`navigate(${JSON.stringify(page)})`, context),
    login: async () => {
      get("#admin-token").value = "synthetic-admin-key-0123456789abcdef";
      await get("#login-form").listeners.submit({ preventDefault() {} });
    },
    logout: () => vm.runInContext("logout()", context),
  };
}

test("管理台以短期会话登录，密钥只出现在交换请求，退出完成前禁止再次登录", async () => {
  const app = harness();
  await settle();
  assert.equal(app.get("#login-error").hidden, true);
  await app.login();
  assert.equal(app.get("#workspace").hidden, false);
  assert.equal(app.get("#admin-token").value, "");
  const login = app.requests.find(
    (request) => request.options.method === "POST",
  );
  assert.equal(
    JSON.parse(login.options.body).key,
    "synthetic-admin-key-0123456789abcdef",
  );
  for (const request of app.requests) {
    assert.equal(request.options.credentials, "same-origin");
    assert.equal(request.options.headers.has("x-admin-key"), false);
    assert.equal(request.options.redirect, "error");
  }
  const held = deferred();
  app.override((path, options) =>
    path === "/v1/admin/session" && options.method === "DELETE"
      ? held.promise
      : undefined,
  );
  const out = app.logout();
  assert.equal(app.get("#workspace").hidden, true);
  assert.equal(app.get("#login-submit").disabled, true);
  held.resolve(response({ data: { revoked: true } }));
  await out;
  assert.equal(app.get("#login-submit").disabled, false);
});

test("概览显示当前账号数，待完成包含七日统计之外的旧队列任务", async () => {
  const app = harness();
  await settle();
  const payload = jobs();
  payload.data.kinds[0].queued = 1;
  payload.data.queue = {
    queued: 5,
    running: 2,
    oldestQueuedSec: 800000,
    oldestRunningSec: 3,
  };
  app.override((path) =>
    path === "/v1/admin/jobs" ? response(payload) : undefined,
  );
  await app.login();
  const stats = app.get("#page-content").querySelectorAll(".stat-card");
  assert.match(stats[0].textContent, /^当前用户3/);
  assert.match(
    stats[3].textContent,
    /^待完成任务7全部排队与进行中的任务，含较早任务$/,
  );
  assert.doesNotMatch(stats[3].textContent, /近 7 日/);
});

test("退出重登后旧请求的401不能清除新管理会话", async () => {
  const app = harness();
  await settle();
  await app.login();
  const held = deferred();
  app.override((path) =>
    path === "/v1/admin/jobs" ? held.promise : undefined,
  );
  const stale = app.navigate("jobs");
  app.override(undefined);
  await app.logout();
  await app.login();
  held.resolve(response({ message: "旧会话失效" }, 401));
  await stale;
  assert.equal(app.get("#workspace").hidden, false);
  assert.equal(app.get("#page-title").textContent, "工作台");
  assert.match(app.get("#page-content").textContent, /近 7 日任务成功率/);
});

test("旧页面的晚成功响应不覆盖新页，当前会话401退出后仍可重新登录", async () => {
  const app = harness();
  await settle();
  await app.login();
  const held = deferred();
  app.override((path) =>
    path === "/v1/admin/jobs" ? held.promise : undefined,
  );
  const stale = app.navigate("jobs");
  app.override(undefined);
  await app.navigate("usage");
  held.resolve(response(jobs()));
  await stale;
  assert.equal(app.get("#page-title").textContent, "用量与维护");
  assert.match(app.get("#page-content").textContent, /尚未接入账单/);
  app.override((path) =>
    path === "/v1/admin/audit" ? response({ message: "过期" }, 401) : undefined,
  );
  await app.navigate("audit");
  assert.equal(app.get("#workspace").hidden, true);
  assert.equal(app.get("#login-submit").disabled, false);
  app.override(undefined);
  await app.login();
  assert.equal(app.get("#workspace").hidden, false);
});

test("依赖未就绪的503保留运行页，供应商文本仅作为文本节点渲染", async () => {
  const app = harness();
  await settle();
  await app.login();
  app.override((path) =>
    path === "/health/ready"
      ? response({ status: "not_ready", note: "依赖待检查" }, 503)
      : undefined,
  );
  await app.navigate("operations");
  assert.match(app.get("#page-content").textContent, /尚未就绪/);
  assert.match(app.get("#page-content").textContent, /运行环境/);
  assert.doesNotMatch(app.get("#page-content").textContent, /数据加载失败/);
  const payload = usage();
  payload.data.ledger.providers = [
    {
      source: "llm.json",
      provider: "<script>private()</script>",
      model: "test",
      calls: 1,
      promptTokens: 1,
      completionTokens: 0,
      unknown: 0,
      pending: 0,
      unreported: 0,
    },
  ];
  app.override((path) =>
    path === "/v1/admin/usage" ? response(payload) : undefined,
  );
  await app.navigate("usage");
  assert.match(
    app.get("#page-content").textContent,
    /<script>private\(\)<\/script>/,
  );
});

test("会话恢复失败不会卡死登录，离开页面后晚响应不重开管理台", async () => {
  const app = harness();
  await settle();
  const held = deferred();
  app.override((path, options) =>
    path === "/v1/admin/session" && options.method === "POST"
      ? held.promise
      : undefined,
  );
  const pending = app.login();
  app.windowEvents.pagehide();
  held.resolve(response(readySession()));
  await pending;
  assert.equal(app.get("#workspace").hidden, true);
  assert.equal(app.get("#admin-token").value, "");
  app.override((path) =>
    path === "/v1/admin/session"
      ? response({ message: "维护中" }, 503)
      : undefined,
  );
  await vm.runInContext("restoreSession()", app.context);
  assert.match(app.get("#login-error").textContent, /维护中/);
  assert.equal(app.get("#login-submit").disabled, false);
});

test("工作台待办和反馈处理：作答只作为文本显示，标记处理带上说明", async () => {
  const app = harness();
  await settle();
  await app.login();
  const content = app.get("#page-content");
  assert.match(content.textContent, /待处理反馈地图题 1 条/);
  assert.match(content.textContent, /可重试 1 个/);
  app.override((path, options) =>
    options.method === "PUT" && path === "/v1/admin/feedback/map/mrp_1"
      ? response({ data: { handled: true } })
      : undefined,
  );
  await app.navigate("feedback");
  assert.ok(app.requests.some((r) => r.path === "/v1/admin/feedback?status=open&type=all"));
  assert.match(content.textContent, /<img src=x onerror=private\(\)>/);
  assert.match(content.textContent, /判对判错有问题/);
  assert.match(content.textContent, /AI 起草 · 未经教师审定/);
  assert.match(content.textContent, /已处理/);
  const note = find(content, (item) => item.tagName === "input");
  note.value = "判定已修正";
  await click(buttonNamed(content, "标记已处理"));
  const [put] = sent(app, "PUT", "/v1/admin/feedback/map/mrp_1");
  assert.deepEqual(JSON.parse(put.options.body), { handled: true, note: "判定已修正" });
});

test("停用账号要点两次，额度留空表示跟随全局", async () => {
  const app = harness();
  await settle();
  await app.login();
  await app.navigate("users");
  const content = app.get("#page-content");
  assert.match(content.textContent, /同学甲/);
  assert.doesNotMatch(content.textContent, /openid/);
  app.override((path, options) =>
    options.method === "PUT" ? response(userDetail()) : undefined,
  );
  await click(buttonNamed(content, "查看"));
  assert.ok(app.requests.some((r) => r.path === "/v1/admin/users/usr_1"));
  assert.match(content.textContent, /资料 1 · 随心记 2/);
  const ban = buttonNamed(content, "停用账号");
  click(ban);
  assert.equal(sent(app, "PUT", "/v1/admin/users/usr_1/ban").length, 0);
  assert.equal(ban.textContent, "再点一次确认停用账号");
  await click(ban);
  assert.equal(sent(app, "PUT", "/v1/admin/users/usr_1/ban").length, 1);
  await click(buttonNamed(content, "保存额度"));
  const [quota] = sent(app, "PUT", "/v1/admin/users/usr_1/quota");
  assert.deepEqual(JSON.parse(quota.options.body), {
    ai: null,
    ocr: null,
    notes: null,
    chat: 5,
    photos: null,
    brainstorm: null,
    import: null,
  });
});

test("AI 接口测试按接口超时放宽等待，删除要二次确认，密钥不回显", async () => {
  const app = harness();
  await settle();
  await app.login();
  await app.navigate("ai");
  const content = app.get("#page-content");
  assert.match(content.textContent, /…abcd/);
  app.override((path, options) =>
    path === "/v1/admin/ai/endpoints/ep_1/test"
      ? response({
          data: {
            result: { ok: false, ms: 5, code: "AI_QUOTA", message: "额度不足" },
            ...ai().data,
          },
        })
      : options.method === "DELETE"
        ? response(ai())
        : undefined,
  );
  app.timers.length = 0;
  await click(buttonNamed(content, "测试"));
  assert.ok(app.timers.includes(40000));
  assert.match(app.get("#notice").textContent, /测试失败：AI_QUOTA 额度不足/);
  const remove = buttonNamed(content, "删除");
  click(remove);
  assert.equal(sent(app, "DELETE", "/v1/admin/ai/endpoints/ep_1").length, 0);
  await click(remove);
  assert.equal(sent(app, "DELETE", "/v1/admin/ai/endpoints/ep_1").length, 1);
});

test("场景接口下拉只显示多端点列表首项，旧列表项不被覆盖", async () => {
  const app = harness();
  await settle();
  await app.login();
  app.override((path, options) => {
    if (path === "/v1/admin/ai") {
      const data = ai().data;
      data.endpoints.push({ ...data.endpoints[0], id: "ep_2", alias: "备用" });
      data.routes = { "chat.study": ["ep_2", "ep_1"], brainstorm: ["ep_1", "ep_2"] };
      return response({ data });
    }
    return undefined;
  });
  await app.navigate("ai");
  const content = app.get("#page-content");
  const route = find(content, (item) => item.tagName === "select" && item.value === "ep_2");
  assert.ok(route);
  assert.equal(sent(app, "PUT", "/v1/admin/ai/routes").length, 0);
  route.value = "";
  await route.listeners.change({ currentTarget: route });
  assert.equal(sent(app, "PUT", "/v1/admin/ai/routes").length, 0);
  const save = buttonNamed(content, "保存接口选择");
  click(save);
  assert.equal(sent(app, "PUT", "/v1/admin/ai/routes").length, 0);
  await click(save);
  const [saved] = sent(app, "PUT", "/v1/admin/ai/routes");
  assert.deepEqual(JSON.parse(saved.options.body), { "chat.study": [] });
});

test("二次确认几秒内没点第二下或焦点移开就复位，之后误点一下不会执行", async () => {
  const app = harness();
  await settle();
  await app.login();
  await app.navigate("settings");
  const content = app.get("#page-content");
  const save = buttonNamed(content, "保存");
  click(save);
  assert.equal(save.textContent, "再点一次确认保存");
  const reset = app.pending.filter((item) => item.ms === 4000).at(-1);
  assert.ok(reset);
  reset.fn();
  assert.equal(save.textContent, "保存");
  assert.doesNotMatch(save.className, /armed/);
  click(save);
  assert.equal(sent(app, "PUT", "/v1/admin/settings/limits").length, 0);
  save.listeners.blur();
  assert.equal(save.textContent, "保存");
  click(save);
  assert.equal(sent(app, "PUT", "/v1/admin/settings/limits").length, 0);
  await click(save);
  assert.equal(sent(app, "PUT", "/v1/admin/settings/limits").length, 1);
});

test("额度设置拒绝非整数，题库能跳到该知识点的反馈", async () => {
  const app = harness();
  await settle();
  await app.login();
  await app.navigate("settings");
  const content = app.get("#page-content");
  const input = find(content, (item) => item.tagName === "input");
  input.value = "1.5";
  const save = buttonNamed(content, "保存");
  click(save);
  await click(save);
  assert.equal(sent(app, "PUT", "/v1/admin/settings/limits").length, 0);
  assert.match(app.get("#notice").textContent, /0 或正整数/);
  await app.navigate("bank");
  assert.match(content.textContent, /待处理反馈 1/);
  await click(buttonNamed(content, "查看这个知识点的反馈"));
  assert.equal(app.get("#page-title").textContent, "反馈处理");
  assert.ok(
    app.requests.some(
      (r) => r.path === "/v1/admin/feedback?status=all&type=map&point=c1-limit",
    ),
  );
});

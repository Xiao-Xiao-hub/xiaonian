const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");
const root = path.join(__dirname, "..", "miniprogram", "pages", "commercial");
const { orderPresentation } = require(path.join(root, "presentation.js"));

function loadPage(file, mocks) {
  const target = path.join(root, file);
  const original = Module._load;
  let page;
  Module._load = function (request, parent, main) {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    return original.call(this, request, parent, main);
  };
  global.Page = (value) => {
    page = value;
  };
  delete require.cache[require.resolve(target)];
  const exports = require(target);
  Module._load = original;
  return { page, exports };
}
function instance(page) {
  const value = {
    ...page,
    data: JSON.parse(JSON.stringify(page.data)),
    setData(next) {
      Object.assign(this.data, next);
    },
  };
  return value;
}
const baseMocks = ({
  api = { get: async () => [], post: async () => ({}) },
  auth,
  payment,
} = {}) => ({
  "../../../utils/share": { withShare: (value) => value },
  "../../../utils/api": api,
  "../../../utils/auth": auth,
  "../../../utils/gate": { check: () => true },
  "../../../utils/assets": { asset: (name) => `asset:${name}` },
  "../../../utils/format": { errorText: (error) => error.message },
  ...(payment ? { "../payment": payment } : {}),
});

test("commercial mappings show remaining balances, Beijing dates and real point credits", () => {
  const auth = {
    getUser: () => ({ id: "a" }),
    consentGeneration: () => 1,
    hasConsent: () => true,
    login: async () => {},
  };
  global.wx = { getSystemInfoSync: () => ({ platform: "android" }) };
  const { exports } = loadPage("center/index.js", baseMocks({ auth }));
  const account = exports.mapAccount({
    free: { day: { percent: 30 }, week: { percent: 100 } },
    plans: [
      {
        weekPercent: 25,
        totalPercent: 60,
        expiresAt: "2026-10-24T16:00:00.000Z",
        nextResetAt: "2026-10-25T16:00:00.000Z",
      },
    ],
  });
  assert.equal(account.free.day.remaining, 70);
  assert.equal(account.free.week.remaining, 0);
  assert.deepEqual(
    [
      account.plans[0].weekRemaining,
      account.plans[0].totalRemaining,
      account.plans[0].expiresLabel,
    ],
    [75, 40, "2026年10月25日"],
  );
  const catalog = exports.mapCatalog(
    [
      {
        id: "points_10",
        kind: "points",
        priceCents: 1000,
        platforms: { android: { credits: 123 } },
      },
    ],
    "android",
  );
  assert.deepEqual(
    { price: catalog[0].price, credits: catalog[0].credits },
    { price: "¥10", credits: 123 },
  );
  const plans = exports.mapCatalog([
    { id: "plan_entry", kind: "plan", priceCents: 1000, platforms: { android: { weeklyMultiplier: 9 } } },
    { id: "plan_standard", kind: "plan", priceCents: 3000, platforms: { android: { weeklyMultiplier: 30 } } },
    { id: "plan_advanced", kind: "plan", priceCents: 6800, platforms: { android: { weeklyMultiplier: 69 } } },
  ], "android");
  // "约" multiples must not round up: 30/9 is about 3, 69/30 about 2.
  assert.deepEqual(plans.map((item) => item.previousMultiplier), [null, 3, 2]);
});

test("orders use the real API timestamps and published names, with snapshot names preferred", () => {
  const listed = orderPresentation({
    id: "order-list",
    goodId: "points_30",
    amountCents: 3000,
    status: "closed",
    createdAtMs: Date.parse("2026-10-24T16:30:00.000Z"),
    paidAtMs: null,
  });
  assert.deepEqual(
    { name: listed.name, dateLabel: listed.dateLabel, paid: listed.paid },
    { name: "晓念积分包30元", dateLabel: "2026年10月25日", paid: false },
  );
  const detail = orderPresentation({
    id: "order-detail",
    goodId: "plan_entry_30d",
    amountCents: 1000,
    status: "delivered",
    createdAtMs: Date.parse("2026-10-23T16:00:00.000Z"),
    paidAtMs: Date.parse("2026-10-24T00:00:00.000Z"),
    snapshot: { good: { name: "历史名称" } },
  });
  assert.deepEqual(
    {
      name: detail.name,
      dateLabel: detail.dateLabel,
      paidLabel: detail.paidLabel,
      paid: detail.paid,
    },
    {
      name: "历史名称",
      dateLabel: "2026年10月24日",
      paidLabel: "2026年10月24日",
      paid: true,
    },
  );
});

test("adult declaration is 18+, and unsupported payment never creates an order", async () => {
  let purchase;
  const auth = {
    getUser: () => ({ id: "a" }),
    consentGeneration: () => 1,
    hasConsent: () => true,
    login: async () => {},
  };
  global.wx = {
    getSystemInfoSync: () => ({ platform: "android" }),
    canIUse: () => true,
    requestVirtualPayment() {},
    showActionSheet: ({ itemList, success }) => {
      assert.equal(itemList[0], "我已满18周岁");
      success({ tapIndex: 0 });
    },
    navigateTo() {},
  };
  const { page } = loadPage(
    "center/index.js",
    baseMocks({
      auth,
      payment: {
        purchase: async (_id, body) => {
          purchase = body;
          return { order: { id: "o" } };
        },
      },
    }),
  );
  const vm = instance(page);
  vm.alive = true;
  vm.epoch = 1;
  vm.data.catalog = [{ id: "p", purchasable: true }];
  vm.data.selectedItem = vm.data.catalog[0];
  vm.buy();
  await Promise.resolve();
  assert.deepEqual(purchase, { ageBand: "adult" });
  global.wx.canIUse = () => false;
  vm.data.buying = false;
  vm.buy();
  assert.equal(vm.data.error.includes("不支持购买"), true);
  global.wx.canIUse = undefined;
  global.wx.requestVirtualPayment = undefined;
  vm.data.error = "";
  vm.buy();
  assert.equal(vm.data.error.includes("不支持购买"), true);
});

test("native payment survives hide/show, while cancellation releases the purchase lock", async () => {
  let resolvePurchase;
  let navigated = "";
  let mode = "success";
  const auth = {
    getUser: () => ({ id: "a" }),
    consentGeneration: () => 1,
    hasConsent: () => true,
    login: async () => {},
  };
  global.wx = {
    getSystemInfoSync: () => ({ platform: "android" }),
    canIUse: () => true,
    requestVirtualPayment() {},
    navigateTo: ({ url }) => {
      navigated = url;
    },
    showActionSheet: ({ success, fail }) =>
      mode === "success"
        ? success({ tapIndex: 0 })
        : fail({ errMsg: "cancel" }),
  };
  const payment = {
    purchase: () =>
      new Promise((resolve) => {
        resolvePurchase = resolve;
      }),
  };
  const { page } = loadPage("center/index.js", baseMocks({ auth, payment }));
  const vm = instance(page);
  vm.alive = true;
  vm.epoch = 1;
  vm.data.catalog = [{ id: "p", purchasable: true }];
  vm.data.selectedItem = vm.data.catalog[0];
  vm.buy();
  vm.onHide();
  vm.onShow();
  assert.equal(vm.data.buying, true);
  resolvePurchase({ order: { id: "paid-order" } });
  await Promise.resolve();
  await Promise.resolve();
  assert.match(navigated, /paid-order/);
  assert.equal(vm.data.buying, false);
  mode = "cancel";
  vm.data.buying = false;
  vm.buy();
  assert.equal(vm.data.buying, false);
});

test("center discards a catalog/account result after the owner changes", async () => {
  let user = { id: "a" };
  let resolveCatalog;
  const delayed = new Promise((resolve) => {
    resolveCatalog = resolve;
  });
  const auth = {
    getUser: () => user,
    consentGeneration: () => 1,
    hasConsent: () => true,
    login: async () => {},
  };
  global.wx = { getSystemInfoSync: () => ({ platform: "android" }) };
  const { page } = loadPage(
    "center/index.js",
    baseMocks({
      auth,
      api: {
        get: (url) => (url.endsWith("catalog") ? delayed : delayed),
        needsConsent: () => false,
      },
    }),
  );
  const vm = instance(page);
  vm.alive = true;
  vm.epoch = 1;
  const pending = vm.load();
  user = { id: "b" };
  resolveCatalog([]);
  await pending;
  assert.equal(vm.data.account, null);
  assert.deepEqual(vm.data.catalog, []);
});

test("native payment passes server signatures unchanged and never sends a client price", async () => {
  const target = path.join(root, "payment.js"),
    original = Module._load;
  let payload;
  let posts = [];
  const auth = {
    getUser: () => ({ id: "a" }),
    consentGeneration: () => 1,
    login: async () => {},
  };
  Module._load = function (request, parent, main) {
    if (request === "../../utils/api")
      return {
        post: async (_url, body) => {
          posts.push(body);
          return {
            order: { id: "o" },
            payment: {
              mode: "short_series_goods",
              signData: "server-bytes",
              paySig: "server-pay",
              signature: "server-sign",
            },
          };
        },
      };
    if (request === "../../utils/auth") return auth;
    if (request === "../../utils/session") return { clearSession() {} };
    return original.call(this, request, parent, main);
  };
  global.wx = {
    canIUse: () => true,
    getSystemInfoSync: () => ({ platform: "Android" }),
    checkSession: ({ success }) => success(),
    requestVirtualPayment: (value) => {
      payload = value;
      value.success();
    },
  };
  delete require.cache[require.resolve(target)];
  const payment = require(target);
  Module._load = original;
  await payment.purchase("points_10", { ageBand: "adult" }, "same-key");
  assert.deepEqual(payload, {
    mode: "short_series_goods",
    signData: "server-bytes",
    paySig: "server-pay",
    signature: "server-sign",
    success: payload.success,
    fail: payload.fail,
  });
  assert.deepEqual(posts, [
    {
      productId: "points_10",
      idempotencyKey: "same-key",
      purchase: { ageBand: "adult" },
      platform: "android",
    },
  ]);
  assert.equal(Object.hasOwn(posts[0], "amountCents"), false);
});

for (const mode of ["older-server", "disabled-billing", "network-error"]) {
  test(`center preserves the active quota safely: ${mode}`, async () => {
    const requests = [];
    const auth = {
      getUser: () => ({ id: "a" }),
      consentGeneration: () => 1,
      hasConsent: () => true,
      login: async () => {},
    };
    global.wx = { getSystemInfoSync: () => ({ platform: "android" }) };
    const { page } = loadPage("center/index.js", baseMocks({ auth, api: {
      needsConsent: () => false,
      get: async (url) => {
        requests.push(url);
        if (url === "/v1/me/usage") return { budget: {
          day: { pct: 35, resetAt: "2026-10-24T16:00:00Z" },
          week: { pct: 70, resetAt: "2026-10-25T16:00:00Z" },
        } };
        if (mode === "older-server") throw Object.assign(new Error("不存在"), { statusCode: 404 });
        if (mode === "network-error") throw new Error("网络连接失败");
        return url.endsWith("catalog") ? [{ id: "p", purchasable: true }] : { enabled: false };
      },
    } }));
    const vm = instance(page);
    vm.alive = true;
    vm.epoch = 1;
    await vm.load();
    if (mode === "network-error") {
      assert.equal(vm.data.account, null);
      assert.equal(requests.includes("/v1/me/usage"), false);
      assert.equal(vm.data.error, "网络连接失败");
    } else {
      assert.equal(vm.data.account.legacy, true);
      assert.equal(vm.data.account.enabled, false);
      assert.equal(vm.data.account.free.day.remaining, 65);
      assert.equal(vm.data.account.free.week.remaining, 30);
      assert.deepEqual(vm.data.catalog, []);
      assert.equal(vm.data.selectedItem, null);
      assert.equal(vm.data.error, "");
    }
  });
}

test("switching accounts while confirming age cannot create an order for the next account", async () => {
  let user = { id: "a" }, confirm, purchases = 0;
  const auth = {
    getUser: () => user,
    consentGeneration: () => 1,
    hasConsent: () => true,
    login: async () => {},
  };
  global.wx = {
    getSystemInfoSync: () => ({ platform: "android" }),
    canIUse: () => true,
    requestVirtualPayment() {},
    showActionSheet: ({ success }) => { confirm = success; },
  };
  const { page } = loadPage("center/index.js", baseMocks({ auth,
    payment: { purchase: async () => { purchases++; return { order: { id: "wrong-owner" } }; } },
  }));
  const vm = instance(page);
  vm.data.selectedItem = { id: "p", purchasable: true };
  vm.buy();
  user = { id: "b" };
  await confirm({ tapIndex: 0 });
  assert.equal(purchases, 0);
  vm.load = async () => {};
  vm.onShow();
  assert.equal(vm.data.buying, false);
  assert.equal(vm.data.selectedItem, null);
});

test("plan quotes render one choice per plan: renew, upgrade, or greyed with a reason", () => {
  const auth = { getUser: () => ({ id: "a" }), consentGeneration: () => 1, hasConsent: () => true, login: async () => {} };
  global.wx = { getSystemInfoSync: () => ({ platform: "ios" }) };
  const { exports } = loadPage("center/index.js", baseMocks({ auth }));
  const catalog = [
    { id: "plan_entry_30d", kind: "plan", priceCents: 1000, purchasable: true },
    { id: "plan_standard_30d", kind: "plan", priceCents: 3000, purchasable: true },
    { id: "plan_advanced_30d", kind: "plan", priceCents: 6000, purchasable: true },
    { id: "points_10", kind: "points", priceCents: 1000, purchasable: true },
  ];
  const quotes = [
    { goodId: "plan_entry_30d", action: "blocked", priceCents: 1000, reason: "PLAN_DOWNGRADE_BLOCKED", expiresAt: "2026-12-23T08:00:00.000Z" },
    { goodId: "plan_standard_30d", action: "renew", priceCents: 3000, reason: null, expiresAt: "2027-01-22T08:00:00.000Z" },
    { goodId: "plan_advanced_30d", action: "upgrade", priceCents: 2667, reason: null, expiresAt: "2026-12-23T08:00:00.000Z" },
  ];
  const items = exports.mapCatalog(catalog, "android", quotes);
  assert.deepEqual(items.map((item) => [item.action, item.actionLabel, item.price, item.purchasable, item.buyLabel]), [
    ["blocked", "当前套餐到期后可买", "¥10", false, "购买"],
    ["renew", "续费 · 到期延至1月22日", "¥30", true, "续费"],
    ["upgrade", "升级 · 到期日不变", "¥26.67", true, "升级"],
    ["buy", "", "¥10", true, "购买"],
  ]);
  const ios = exports.mapCatalog(catalog, "ios", [{ goodId: "plan_advanced_30d", action: "blocked", reason: "PLAN_UPGRADE_ANDROID_ONLY" }]);
  assert.deepEqual([ios[2].blocked, ios[2].actionLabel], [true, "苹果手机暂不支持升级，到期后可买"]);
  const reasons = ["PLAN_UPGRADE_APP_OUTDATED", "PLAN_UPGRADE_DEVICE_UNSUPPORTED", "PLAN_UPGRADE_EXPIRING"].map((reason) =>
    exports.mapCatalog(catalog, "android", [{ goodId: "plan_advanced_30d", action: "blocked", reason }])[2].actionLabel);
  assert.deepEqual(reasons, ["请更新小程序后再升级", "请在安卓手机上升级", "即将到期，到期后可买"]);
  // Without a plan, every plan shows its list price and "购买".
  assert.deepEqual(exports.mapCatalog(catalog, "android", []).map((item) => item.actionLabel), ["", "", "", ""]);
  // The hint under the buy button follows the selected choice.
  assert.deepEqual(items.map((item) => item.buyHint).slice(1), [
    "顺延30天 · 一次购买，不自动续费",
    "到期日不变 · 一次购买，不自动续费",
    "一次购买，不自动续费",
  ]);
  assert.equal(exports.mapCatalog(catalog, "android", [])[0].buyHint, "有效期30天 · 一次购买，不自动续费");
  const wxml = require("node:fs").readFileSync(require("node:path").join(__dirname, "../miniprogram/pages/commercial/center/index.wxml"), "utf8");
  assert.match(wxml, /class="bottom-hint">\{\{selectedItem \? selectedItem\.buyHint :/);
  // A greyed card keeps its price and multiplier but has no selection circle.
  assert.match(wxml, /<view wx:if="\{\{!item\.blocked\}\}" class="selection">/);
});

test("the current plan shows as one card with the chain's expiry and queued renewals", () => {
  const auth = { getUser: () => ({ id: "a" }), consentGeneration: () => 1, hasConsent: () => true, login: async () => {} };
  global.wx = { getSystemInfoSync: () => ({ platform: "android" }) };
  const { exports } = loadPage("center/index.js", baseMocks({ auth }));
  const account = exports.mapAccount({
    free: { day: { percent: 0 }, week: { percent: 0 } },
    plans: [{ weekPercent: 25, totalPercent: 60, expiresAt: "2026-11-23T08:00:00.000Z", nextResetAt: "2026-10-31T08:00:00.000Z" }],
    planChain: { goodId: "plan_advanced_30d", name: "晓念Max", expiresAt: "2027-01-22T18:30:00.000Z", queued: 2 },
  });
  assert.deepEqual(account.card, {
    name: "晓念Max", hasQuota: true, weekRemaining: 75,
    detail: "总额度剩余 40% · 1月23日到期 · 已续费 2 期",
    resetLabel: "2026年10月31日",
  });
  assert.equal(exports.mapAccount({ free: { day: {}, week: {} }, plans: [] }).card, null);
});

test("the center asks for quotes with the device platform and never selects a greyed plan", async () => {
  const requests = [];
  const auth = { getUser: () => ({ id: "a" }), consentGeneration: () => 1, hasConsent: () => true, login: async () => {} };
  global.wx = { getSystemInfoSync: () => ({ platform: "iOS" }) };
  const { page } = loadPage("center/index.js", baseMocks({ auth, api: {
    needsConsent: () => false,
    get: async (url) => {
      requests.push(url);
      if (url.endsWith("catalog")) return [
        { id: "plan_entry_30d", kind: "plan", priceCents: 1000, purchasable: true },
        { id: "plan_advanced_30d", kind: "plan", priceCents: 6000, purchasable: true },
      ];
      return {
        enabled: true, free: { day: { percent: 0 }, week: { percent: 0 } }, plans: [], wallet: { balance: 0 },
        planChain: { name: "晓念Max", expiresAt: "2026-11-23T08:00:00.000Z", queued: 0 },
        planQuotes: [
          { goodId: "plan_entry_30d", action: "blocked", reason: "PLAN_DOWNGRADE_BLOCKED" },
          { goodId: "plan_advanced_30d", action: "renew", priceCents: 6000, expiresAt: "2026-12-23T08:00:00.000Z" },
        ],
      };
    },
  } }));
  const vm = instance(page);
  vm.alive = true;
  vm.epoch = 1;
  await vm.load();
  assert.ok(requests.includes("/v1/commercial/account?platform=ios"));
  assert.equal(vm.data.selected, "plan_advanced_30d");
  vm.select({ currentTarget: { dataset: { id: "plan_entry_30d" } } });
  assert.equal(vm.data.selected, "plan_advanced_30d");
  assert.equal(vm.data.selectedItem.buyLabel, "续费");
});

test("an upgrade order shows its prorated price with cents", () => {
  const order = orderPresentation({ id: "u", goodId: "plan_standard_30d", amountCents: 2667, status: "delivered", createdAtMs: 0, paidAtMs: 0 });
  assert.equal(order.price, "¥26.67");
  assert.equal(orderPresentation({ id: "p", goodId: "points_10", amountCents: 1000, status: "closed", createdAtMs: 0 }).price, "¥10");
});

const { withShare } = require("../../../utils/share");
const api = require("../../../utils/api");
const auth = require("../../../utils/auth");
const gate = require("../../../utils/gate");
const { asset } = require("../../../utils/assets");
const { errorText } = require("../../../utils/format");
const budgets = require("../../../utils/budget");
const payment = require("../payment");
const owner = () => (auth.getUser() || {}).id || "";
const platform = () => {
  try {
    return String(wx.getSystemInfoSync().platform).toLowerCase() === "ios"
      ? "ios"
      : "android";
  } catch (_) {
    return "android";
  }
};
// The raw device platform goes to the server, which allows upgrades only on android and devtools.
const devicePlatform = () => {
  try {
    return String(wx.getSystemInfoSync().platform || "").toLowerCase();
  } catch (_) {
    return "";
  }
};
const clamp = (value) => Math.max(0, Math.min(100, 100 - Number(value || 0)));
const dateLabel = (value) => {
  const ms = Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms + 8 * 3600_000).toISOString().slice(0, 10).split("-");
  return `${d[0]}年${Number(d[1])}月${Number(d[2])}日`;
};
const shortDate = (value) => {
  const ms = Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms + 8 * 3600_000).toISOString().slice(5, 10).split("-");
  return `${Number(d[0])}月${Number(d[1])}日`;
};
const yuan = (cents) => {
  const value = Number(cents || 0);
  return `¥${(value / 100).toFixed(value % 100 ? 2 : 0)}`;
};
const BLOCKED_TEXT = {
  PLAN_DOWNGRADE_BLOCKED: "当前套餐到期后可买",
  PLAN_UPGRADE_ANDROID_ONLY: "苹果手机暂不支持升级，到期后可买",
  PLAN_REFUND_PENDING: "退款处理完后可买",
  PLAN_UPGRADE_TOO_LONG: "已续费多期，到期后可买",
  PLAN_UPGRADE_DEVICE_UNSUPPORTED: "请在安卓手机上升级",
  PLAN_UPGRADE_APP_OUTDATED: "请更新小程序后再升级",
  PLAN_UPGRADE_EXPIRING: "即将到期，到期后可买",
};
// One card for the plan chain: the running plan's quota plus the chain's
// last expiry date and how many renewals wait behind it.
const planCard = (view, plans) => {
  const chain = view.planChain || null;
  const running = plans[0] || null;
  if (!chain && !running) return null;
  const queued = chain ? Number(chain.queued || 0) : 0;
  return {
    name: (chain && chain.name) || "当前套餐",
    hasQuota: Boolean(running),
    weekRemaining: running ? running.weekRemaining : 0,
    detail: [
      running ? `总额度剩余 ${running.totalRemaining}%` : "",
      `${shortDate(chain ? chain.expiresAt : running.expiresAt)}到期`,
      queued ? `已续费 ${queued} 期` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    resetLabel: running ? running.resetLabel : "",
  };
};
const mapAccount = (view) => {
  const account = mapAccountFields(view);
  return { ...account, card: planCard(view, account.plans) };
};
const mapAccountFields = (view) => ({
  ...view,
  free: {
    ...view.free,
    day: { ...view.free.day, remaining: clamp(view.free.day.percent) },
    week: { ...view.free.week, remaining: clamp(view.free.week.percent) },
  },
  plans: (view.plans || [])
    .filter((plan) => !plan.startsAt || Date.parse(plan.startsAt) <= Date.now())
    .map((plan) => ({
      ...plan,
      weekRemaining: clamp(plan.weekPercent),
      totalRemaining: clamp(plan.totalPercent),
      expiresLabel: dateLabel(plan.expiresAt),
      resetLabel: dateLabel(plan.nextResetAt),
    })),
});
async function legacyAccount() {
  const usage = await api.get("/v1/me/usage");
  if (!budgets.valid(usage.budget))
    throw new Error("暂时无法读取额度，请稍后重试");
  return {
    enabled: false,
    legacy: true,
    free: {
      day: { percent: usage.budget.day.pct, resetAt: usage.budget.day.resetAt },
      week: { percent: usage.budget.week.pct, resetAt: usage.budget.week.resetAt },
    },
    plans: [],
    wallet: { balance: 0, consentRequired: true },
  };
}
async function loadAccountData() {
  let catalog, view;
  try {
    [catalog, view] = await Promise.all([
      api.get("/v1/commercial/catalog"),
      api.get(
        devicePlatform()
          ? `/v1/commercial/account?platform=${encodeURIComponent(devicePlatform())}`
          : "/v1/commercial/account",
      ),
    ]);
  } catch (error) {
    if (!error || error.statusCode !== 404) throw error;
    return { catalog: [], view: await legacyAccount() };
  }
  // Until billing is enabled, show the same quota as the active service.
  if (!view.enabled) return { catalog: [], view: await legacyAccount() };
  return { catalog, view };
}
const quoteFields = (item, quote) => {
  if (item.kind !== "plan" || !quote || quote.action === "buy")
    return { price: yuan(item.priceCents), action: "buy", actionLabel: "", buyLabel: "购买", blocked: false };
  if (quote.action === "renew")
    return {
      price: yuan(quote.priceCents),
      action: "renew",
      actionLabel: `续费 · 到期延至${shortDate(quote.expiresAt)}`,
      buyLabel: "续费",
      blocked: false,
    };
  if (quote.action === "upgrade")
    return {
      price: yuan(quote.priceCents),
      action: "upgrade",
      actionLabel: "升级 · 到期日不变",
      buyLabel: "升级",
      blocked: false,
    };
  return {
    price: yuan(item.priceCents),
    action: "blocked",
    actionLabel: BLOCKED_TEXT[quote.reason] || "当前套餐到期后可买",
    buyLabel: "购买",
    blocked: true,
  };
};
const mapCatalog = (catalog, device, quotes) =>
  (catalog || []).map((item, index, all) => {
    const platformInfo = (item.platforms || {})[device] || {};
    const quote = quoteFields(
      item,
      (quotes || []).find((value) => value.goodId === item.id),
    );
    const prior = all
      .filter((x) => x.kind === "plan" && x.id !== item.id)
      .filter((x) => Number(x.priceCents) < Number(item.priceCents))
      .at(-1);
    return {
      ...item,
      ...quote,
      buyHint: `${item.kind !== "plan" ? "" : quote.action === "upgrade" ? "到期日不变 · " : quote.action === "renew" ? "顺延30天 · " : "有效期30天 · "}一次购买，不自动续费`,
      purchasable: Boolean(item.purchasable) && !quote.blocked,
      benefit:
        item.kind === "plan"
          ? Number(platformInfo.weeklyMultiplier || 0)
          : null,
      credits:
        item.kind === "points" ? Number(platformInfo.credits || 0) : null,
      description: item.id.includes("entry")
        ? "轻量日常"
        : item.id.includes("standard")
          ? "高频学习"
          : item.id.includes("advanced")
            ? "深度使用"
            : "购买后到账",
      previousMultiplier:
        item.kind === "plan" && prior
          ? Math.max(
              1,
              Math.round(
                Number(platformInfo.weeklyMultiplier || 0) /
                  Number(
                    ((prior.platforms || {})[device] || {}).weeklyMultiplier ||
                      1,
                  ),
              ),
            )
          : null,
    };
  });
Page(
  withShare({
    data: {
      ready: false,
      loading: true,
      error: "",
      tab: "plan",
      catalog: [],
      selected: "",
      selectedItem: null,
      platform: platform(),
      account: null,
      hi: { src: "", webp: true },
      hiBroken: false,
      buying: false,
      rulesOpen: false,
    },
    onLoad() {
      this.setData({ hi: { src: asset("xiaoli-hi.webp"), webp: true } });
    },
    onShow() {
      if (!gate.check()) return;
      this.alive = true;
      if (
        this.data.buying &&
        this.purchaseState &&
        this.purchaseState.owner === owner() &&
        this.purchaseState.generation === auth.consentGeneration()
      ) return;
      this.purchaseState = null;
      this.epoch = (this.epoch || 0) + 1;
      this.setData({
        account: null,
        catalog: [],
        selected: "",
        selectedItem: null,
        error: "",
        buying: false,
      });
      this.load();
    },
    onHide() {
      this.alive = false;
    },
    onUnload() {
      this.alive = false;
      this.unloaded = true;
    },
    guard() {
      return {
        epoch: this.epoch,
        owner: owner(),
        generation: auth.consentGeneration(),
      };
    },
    active(state) {
      return (
        this.alive &&
        this.epoch === state.epoch &&
        state.generation === auth.consentGeneration() &&
        state.owner === owner() &&
        auth.hasConsent()
      );
    },
    async load() {
      const state = this.guard();
      this.setData({ loading: true, error: "", ready: true });
      try {
        await auth.login();
        if (!state.owner) state.owner = owner();
        if (!this.active(state)) return;
        const { catalog, view } = await loadAccountData();
        if (!this.active(state)) return;
        const all = mapCatalog(catalog, platform(), view.planQuotes);
        const selected = all.some(
          (x) => x.id === this.data.selected && !x.blocked,
        )
          ? this.data.selected
          : (all.find((x) => x.kind === this.data.tab && !x.blocked) || {})
              .id || "";
        this.setData({
          catalog: all,
          account: mapAccount(view),
          selected,
          selectedItem: all.find((x) => x.id === selected) || null,
          platform: platform(),
        });
      } catch (error) {
        if (this.active(state) && !api.needsConsent(error))
          this.setData({ error: errorText(error) });
      } finally {
        if (this.active(state)) this.setData({ loading: false });
      }
    },
    setTab(e) {
      const tab = e.currentTarget.dataset.tab,
        selected =
          (this.data.catalog.find((x) => x.kind === tab && !x.blocked) || {})
            .id || "";
      this.setData({
        tab,
        selected,
        selectedItem: this.data.catalog.find((x) => x.id === selected) || null,
      });
    },
    select(e) {
      const item = this.data.catalog.find(
        (x) => x.id === e.currentTarget.dataset.id,
      );
      if (item && !item.blocked)
        this.setData({ selected: item.id, selectedItem: item });
    },
    hiError() {
      this.setData({ hiBroken: true });
    },
    toggleRules() {
      this.setData({ rulesOpen: !this.data.rulesOpen });
    },
    openSupport() { wx.navigateTo({ url: "/pages/support/chat/index" }); },
    openOrders() {
      wx.navigateTo({ url: "/pages/commercial/orders/index" });
    },
    consentWallet() {
      const state = this.guard();
      api
        .post("/v1/commercial/wallet-consent", { consent: true })
        .then((view) => {
          // The consent reply has no plan chain; keep the one already shown.
          if (this.active(state))
            this.setData({
              account: mapAccount({
                ...view,
                planChain: (this.data.account || {}).planChain,
              }),
            });
        })
        .catch((error) => {
          if (this.active(state)) this.setData({ error: errorText(error) });
        });
    },
    buy() {
      const item = this.data.selectedItem;
      if (!item || !item.purchasable || this.data.buying) return;
      if (
        typeof wx.requestVirtualPayment !== "function" ||
        (typeof wx.canIUse === "function" &&
          !wx.canIUse("requestVirtualPayment"))
      )
        return this.setData({
          error: "当前微信版本暂不支持购买，请升级微信后重试",
        });
      const state = { owner: owner(), generation: auth.consentGeneration() };
      this.purchaseState = state;
      const paymentActive = () =>
        !this.unloaded &&
        this.purchaseState === state &&
        state.owner === owner() &&
        state.generation === auth.consentGeneration();
      this.setData({ buying: true, error: "" });
      wx.showActionSheet({
        itemList: ["我已满18周岁", "14至17岁，已获监护人同意"],
        success: async ({ tapIndex }) => {
          if (!paymentActive()) return;
          const purchase =
            tapIndex === 0
              ? { ageBand: "adult" }
              : { ageBand: "14_17", guardianConsent: true };
          try {
            const result = await payment.purchase(item.id, purchase);
            if (paymentActive())
              wx.navigateTo({
                url: `/pages/commercial/order/index?id=${encodeURIComponent(result.order.id)}`,
              });
          } catch (error) {
            if (
              paymentActive() &&
              !/cancel/i.test((error && error.errMsg) || "")
            )
              this.setData({ error: errorText(error) });
          } finally {
            if (paymentActive()) this.setData({ buying: false });
          }
        },
        fail: () => {
          if (paymentActive()) this.setData({ buying: false });
        },
      });
    },
  }),
);
module.exports = { mapAccount, mapCatalog, dateLabel, shortDate };

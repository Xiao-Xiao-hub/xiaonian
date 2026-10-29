const { withShare } = require("../../../utils/share");
const auth = require("../../../utils/auth");
const gate = require("../../../utils/gate");
const support = require("../support-api");
const { errorText, when } = require("../../../utils/format");
const owner = () => (auth.getUser() || {}).id || "";

const present = (item) => ({
  ...item,
  statusText: ({ open: "待处理", replied: "已回复", closed: "已关闭" })[item.status] || "处理中",
  dateLabel: when(item.updated_at || item.updatedAt || item.created_at || item.createdAt),
});

Page(withShare({
  data: { loading: true, error: "", tickets: [] },
  onShow() {
    if (!gate.check()) return;
    this.alive = true;
    this.epoch = (this.epoch || 0) + 1;
    this.account = owner();
    this.setData({ loading: true, error: "", tickets: [] });
    this.load();
  },
  onHide() { this.alive = false; this.epoch = (this.epoch || 0) + 1; },
  onUnload() { this.onHide(); },
  guard() { const account = this.account || owner(); if (!this.account) this.account = account; return { epoch: this.epoch, owner: account, generation: auth.consentGeneration() }; },
  active(state) { return this.alive && state.epoch === this.epoch && state.owner === owner() && state.generation === auth.consentGeneration() && auth.hasConsent(); },
  async load() {
    const state = this.guard();
    try {
      await auth.login();
      if (!state.owner) state.owner = owner();
      const list = await support.tickets();
      if (this.active(state)) this.setData({ tickets: (list || []).map(present) });
    } catch (error) {
      if (this.active(state) && !(error && ["CONSENT_REQUIRED", "GUEST_MODE"].includes(error.code))) this.setData({ error: errorText(error) });
    } finally { if (this.active(state)) this.setData({ loading: false }); }
  },
  open(event) { wx.navigateTo({ url: `/pages/support/ticket/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
}));
module.exports = { present };

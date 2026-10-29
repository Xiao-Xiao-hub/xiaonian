const { withShare } = require("../../../utils/share");
const auth = require("../../../utils/auth");
const gate = require("../../../utils/gate");
const support = require("../support-api");
const { errorText, when } = require("../../../utils/format");
const owner = () => (auth.getUser() || {}).id || "";
const present = (ticket) => ({
  ...ticket,
  statusText: ({ open: "待处理", replied: "已回复", closed: "已关闭" })[ticket.status] || "处理中",
  replies: (ticket.replies || []).map((reply) => ({ ...reply, dateLabel: when(reply.created_at || reply.createdAt) })),
});

Page(withShare({
  data: { id: "", turnId: "", loading: true, confirming: false, submitting: false, error: "", ticket: null, content: "" },
  onLoad(query) { this.setData({ id: query.id || "", turnId: query.turnId || "" }); },
  onShow() {
    if (!gate.check()) return;
    this.alive = true;
    this.epoch = (this.epoch || 0) + 1;
    const scope = `${owner()}:${auth.consentGeneration()}`;
    const changed = Boolean(this.scope && this.scope !== scope);
    this.scope = scope;
    this.account = owner();
    if (changed) {
      this.pending = null;
      this.setData({ id: "", turnId: "", ticket: null, content: "", confirming: false, submitting: false });
    }
    this.setData({ loading: Boolean(this.data.id), error: "", ticket: null });
    this.notification = null;
    this.loadNotificationOptions(this.guard());
    if (this.data.id) this.load();
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
      const ticket = await support.ticket(this.data.id);
      if (this.active(state)) this.setData({ ticket: present(ticket) });
    } catch (error) { if (this.active(state) && !(error && ["CONSENT_REQUIRED", "GUEST_MODE"].includes(error.code))) this.setData({ error: errorText(error) }); }
    finally { if (this.active(state)) this.setData({ loading: false }); }
  },
  input(event) { this.setData({ content: String(event.detail.value || "").slice(0, 2000), error: "" }); },
  async loadNotificationOptions(state) {
    try {
      const options = await support.notificationOptions();
      if (this.active(state) && options && options.enabled && typeof options.templateId === "string")
        this.notification = { templateId: options.templateId, scope: this.scope };
    } catch (_) {
      // Notification configuration is optional; ticket submission remains available.
    }
  },
  subscribe(state) {
    const options = this.notification;
    if (!this.active(state) || !options || options.scope !== this.scope ||
      typeof wx.requestSubscribeMessage !== "function") return Promise.resolve(null);
    return new Promise((resolve) => {
      wx.requestSubscribeMessage({
        tmplIds: [options.templateId],
        success: (result) => {
          if (!this.active(state)) return resolve(null);
          const status = result && result[options.templateId];
          resolve(["accept", "reject", "ban"].includes(status) ? { templateId: options.templateId, status } : null);
        },
        fail: () => resolve(null),
      });
    });
  },
  submit() {
    const content = String(this.data.content || "").trim();
    if (!this.data.turnId || this.data.submitting || this.data.confirming) return;
    if (!content) return this.setData({ error: "请补充需要人工处理的内容" });
    const state = this.guard();
    const pending = this.pending && this.pending.turnId === this.data.turnId && this.pending.content === content
      ? this.pending
      : { turnId: this.data.turnId, content, key: support.key("support-ticket") };
    this.pending = pending;
    this.setData({ confirming: true, error: "" });
    wx.showModal({ title: "确认提交工单", content: "提交后会在三天内处理，你可以在工单页面查看进度与回复。", success: async ({ confirm }) => {
      if (!this.active(state)) return;
      if (!confirm) return this.setData({ confirming: false });
      this.setData({ confirming: false });
      this.setData({ submitting: true, error: "" });
      try {
        const subscription = await this.subscribe(state);
        if (!this.active(state)) return;
        const ticket = await support.createTicket(
          this.data.turnId,
          content,
          pending.key,
          ...(subscription ? [subscription] : []),
        );
        if (!this.active(state)) return;
        this.pending = null;
        this.setData({ id: ticket.id, turnId: "", content: "", ticket: present(ticket) });
      } catch (error) { if (this.active(state) && !(error && ["CONSENT_REQUIRED", "GUEST_MODE"].includes(error.code))) this.setData({ error: errorText(error) }); }
      finally { if (this.active(state)) this.setData({ submitting: false }); }
    }});
  },
}));
module.exports = { present };

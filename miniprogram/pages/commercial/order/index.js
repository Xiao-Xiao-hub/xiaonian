const { withShare } = require("../../../utils/share");
const api = require("../../../utils/api");
const auth = require("../../../utils/auth");
const gate = require("../../../utils/gate");
const { errorText } = require("../../../utils/format");
const { orderPresentation } = require("../presentation");

const owner = () => (auth.getUser() || {}).id || "";

Page(
  withShare({
    data: { id: "", loading: true, syncing: false, error: "", order: null, polls: 0 },
    onLoad(query) {
      this.setData({ id: query.id || "" });
    },
    onShow() {
      if (!gate.check() || !this.data.id) return;
      this.alive = true;
      this.epoch = (this.epoch || 0) + 1;
      this.setData({ order: null, polls: 0, error: "" });
      this.load(true);
    },
    onHide() {
      this.alive = false;
      clearTimeout(this.timer);
    },
    onUnload() {
      this.onHide();
    },
    guard() {
      return { epoch: this.epoch, owner: owner(), generation: auth.consentGeneration() };
    },
    active(state) {
      return this.alive && this.epoch === state.epoch && state.owner === owner() && state.generation === auth.consentGeneration() && auth.hasConsent();
    },
    async load(auto) {
      const state = this.guard();
      this.setData({ loading: !this.data.order, error: "" });
      try {
        await auth.login();
        if (!state.owner) state.owner = owner();
        const order = await api.get(`/v1/commercial/orders/${encodeURIComponent(this.data.id)}`);
        if (!this.active(state)) return;
        const presented = orderPresentation(order);
        this.setData({ order: presented });
        if (auto && presented.status === "created" && this.data.polls < 5) {
          this.setData({ polls: this.data.polls + 1 });
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.sync(true), 3000);
        }
      } catch (error) {
        if (this.active(state) && !api.needsConsent(error)) this.setData({ error: errorText(error) });
      } finally {
        if (this.active(state)) this.setData({ loading: false });
      }
    },
    async sync(auto) {
      if (this.data.syncing) return;
      const state = this.guard();
      this.setData({ syncing: true, error: "" });
      try {
        await api.post(`/v1/commercial/orders/${encodeURIComponent(this.data.id)}/sync`);
        if (this.active(state)) await this.load(auto);
      } catch (error) {
        if (this.active(state) && !api.needsConsent(error)) this.setData({ error: errorText(error) });
      } finally {
        if (this.active(state)) this.setData({ syncing: false });
      }
    },
    refresh() {
      this.sync(false);
    },
    openSupport() { wx.navigateTo({ url: "/pages/support/chat/index" }); },
  }),
);

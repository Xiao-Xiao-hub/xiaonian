const { withShare } = require("../../../utils/share");
const api = require("../../../utils/api");
const auth = require("../../../utils/auth");
const gate = require("../../../utils/gate");
const { errorText } = require("../../../utils/format");
const { orderPresentation } = require("../presentation");

const owner = () => (auth.getUser() || {}).id || "";

Page(
  withShare({
    data: { loading: true, error: "", orders: [] },
    onShow() {
      if (!gate.check()) return;
      this.alive = true;
      this.epoch = (this.epoch || 0) + 1;
      this.setData({ orders: [], error: "" });
      this.load();
    },
    onHide() {
      this.alive = false;
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
    async load() {
      const state = this.guard();
      this.setData({ loading: true, error: "" });
      try {
        await auth.login();
        if (!state.owner) state.owner = owner();
        const orders = await api.get("/v1/commercial/orders");
        if (this.active(state)) this.setData({ orders: (orders || []).map(orderPresentation) });
      } catch (error) {
        if (this.active(state) && !api.needsConsent(error)) this.setData({ error: errorText(error) });
      } finally {
        if (this.active(state)) this.setData({ loading: false });
      }
    },
    open(event) {
      wx.navigateTo({ url: `/pages/commercial/order/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}` });
    },
  }),
);

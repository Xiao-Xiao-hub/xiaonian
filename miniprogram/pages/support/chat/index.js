const { withShare } = require("../../../utils/share");
const auth = require("../../../utils/auth");
const gate = require("../../../utils/gate");
const support = require("../support-api");
const { asset } = require("../../../utils/assets");
const { errorText } = require("../../../utils/format");

const MAX_TEXT = 200;
const MAX_TURNS = 10;
const owner = () => (auth.getUser() || {}).id || "";
const size = (text) => Array.from(String(text || "").trim()).length;
const crisisPath = (value) =>
  value === "/pages/crisis/index" ? value : "";

Page(
  withShare({
    data: {
      loading: true,
      sending: false,
      unavailable: false,
      error: "",
      sessionId: "",
      turns: [],
      faqs: [],
      openFaq: "",
      draft: "",
      remaining: MAX_TEXT,
      maxTurns: MAX_TURNS,
      hi: { src: "", webp: true },
      hiBroken: false,
    },
    onLoad() {
      this.setData({ hi: { src: asset("xiaoli-hi.webp"), webp: true } });
    },
    onShow() {
      if (!gate.check()) return;
      this.alive = true;
      this.epoch = (this.epoch || 0) + 1;
      const currentOwner = owner();
      const scope = currentOwner ? `${currentOwner}:${auth.consentGeneration()}` : "";
      const keep = Boolean(this.data.sessionId) && (!scope || this.scope === scope);
      if (scope) this.scope = scope;
      this.account = currentOwner;
      if (!keep) {
        this.pending = null;
        this.setData({ sessionId: "", turns: [], draft: "", remaining: MAX_TEXT, openFaq: "" });
      }
      this.setData({ loading: true, sending: false, unavailable: false, error: "" });
      this.open(keep);
    },
    onHide() {
      this.alive = false;
      this.epoch = (this.epoch || 0) + 1;
    },
    onUnload() {
      this.onHide();
    },
    guard() {
      const account = this.account || owner();
      if (!this.account) this.account = account;
      return {
        epoch: this.epoch,
        owner: account,
        generation: auth.consentGeneration(),
      };
    },
    active(state) {
      return (
        this.alive &&
        state.epoch === this.epoch &&
        state.owner === owner() &&
        state.generation === auth.consentGeneration() &&
        auth.hasConsent()
      );
    },
    async open(reuse = false) {
      const state = this.guard();
      this.loadKnowledge(state);
      try {
        await auth.login();
        if (!state.owner) state.owner = owner();
        this.account = state.owner;
        this.scope = `${state.owner}:${auth.consentGeneration()}`;
        if (!this.active(state)) return;
        const id = reuse ? this.data.sessionId : (await support.chatSession()).id;
        if (!this.active(state)) return;
        const detail = await support.chatDetail(id);
        if (!this.active(state)) return;
        this.setData({ sessionId: detail.id || id, turns: detail.turns || [] });
      } catch (error) {
        if (!this.active(state) || apiNeedsConsent(error)) return;
        this.setData({
          unavailable: error && [404, 503].includes(error.statusCode),
          error: errorText(error),
        });
      } finally {
        if (this.active(state)) this.setData({ loading: false });
      }
    },
    async loadKnowledge(state) {
      try {
        const faqs = await support.knowledge();
        if (this.active(state)) this.setData({ faqs });
      } catch (_) {
        // A help lookup never replaces the explicit chat-service state.
      }
    },
    retry() {
      if (!this.data.loading) {
        this.setData({ loading: true, unavailable: false, error: "" });
        this.open(Boolean(this.data.sessionId));
      }
    },
    newSession() {
      if (this.data.loading || this.data.sending) return;
      this.pending = null;
      this.setData({ sessionId: "", turns: [], draft: "", remaining: MAX_TEXT, error: "", loading: true });
      this.open(false);
    },
    input(event) {
      const draft = String(event.detail.value || "").slice(0, MAX_TEXT);
      this.setData({ draft, remaining: MAX_TEXT - size(draft), error: "" });
    },
    async send() {
      const text = String(this.data.draft || "").trim();
      if (this.data.sending || !this.data.sessionId) return;
      if (!text) return this.setData({ error: "写下想问的内容再发送吧" });
      if (size(text) > MAX_TEXT)
        return this.setData({ error: `每次最多 ${MAX_TEXT} 字` });
      if (this.data.turns.length >= MAX_TURNS)
        return this.setData({ error: "这一轮已经聊满 10 次，可以稍后重新开始" });
      const state = this.guard();
      const pending =
        this.pending && this.pending.text === text
          ? this.pending
          : { text, key: support.key("support-turn") };
      this.pending = pending;
      this.setData({ sending: true, error: "" });
      try {
        const result = await support.chatTurn(
          this.data.sessionId,
          text,
          pending.key,
        );
        if (!this.active(state)) return;
        this.pending = null;
        const item = {
            id: result.turnId,
            text,
            answer: result.answer,
            layer: result.layer,
            ticketEligible: result.ticketEligible === true,
            resourcePath: crisisPath(result.resourcePath),
          };
        this.setData({
          turns: this.data.turns.some((turn) => turn.id === item.id)
            ? this.data.turns
            : this.data.turns.concat(item),
          // The chat response carries compact FAQ metadata. Keep the answers
          // loaded from the knowledge endpoint so opened FAQ entries stay useful.
          ...(Array.isArray(result.faqs) && this.data.faqs.length === 0 ? { faqs: result.faqs } : {}),
          draft: "",
          remaining: MAX_TEXT,
        });
      } catch (error) {
        if (this.active(state) && !apiNeedsConsent(error))
          this.setData({ error: errorText(error) });
      } finally {
        if (this.active(state)) this.setData({ sending: false });
      }
    },
    faq(event) {
      const id = event.currentTarget.dataset.id;
      if (this.data.faqs.some((item) => item.id === id))
        this.setData({ openFaq: this.data.openFaq === id ? "" : id });
    },
    ticket(event) {
      const turn = this.data.turns.find(
        (item) => item.id === event.currentTarget.dataset.id,
      );
      if (!turn || !turn.ticketEligible) return;
      wx.navigateTo({
        url: `/pages/support/ticket/index?turnId=${encodeURIComponent(turn.id)}`,
      });
    },
    resource(event) {
      const path = crisisPath(event.currentTarget.dataset.path);
      if (path) wx.navigateTo({ url: path });
    },
    tickets() {
      wx.navigateTo({ url: "/pages/support/tickets/index" });
    },
    hiError() {
      this.setData({ hiBroken: true });
    },
  }),
);

function apiNeedsConsent(error) {
  // Keep the support adapter independent from api's internal request shape.
  return error && ["CONSENT_REQUIRED", "GUEST_MODE"].includes(error.code);
}

module.exports = { MAX_TEXT, MAX_TURNS, size, crisisPath };

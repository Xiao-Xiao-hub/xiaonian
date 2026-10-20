/*
 * 头脑风暴结果页：展示已保存的整理与回顾，提供关联卡片和继续讨论入口。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../../utils/api");
const gate = require("../../../utils/gate");
const auth = require("../../../utils/auth");
const { itemView, reportView, reportStale, example } = require("../view");
const { watch, pending } = require("../../../utils/job");
const { view: cardView } = require("../../../utils/cards");
const { openChat } = require("../../../utils/chat-entry");
const owner = () => (auth.getUser() || {}).id || "";
const reportClientId = () =>
  `report-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
// V4.2 : the report job's stages, as on the process page.
const REPORT_STEPS = [
  { key: "write", label: "写分析" },
  { key: "check", label: "检查一遍" },
];
const dateLabel = (value) => {
  const date = value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime())
    ? `${date.getMonth() + 1}/${date.getDate()}`
    : "";
};

Page({
    data: {
      loading: true,
      error: "",
      item: null,
      cards: [],
      conclusionCard: null,
      newCards: [],
      report: null,
      // V4.2 : a report on its way or failed, a stale one, a failed request.
      reportSteps: REPORT_STEPS,
      reportTask: null,
      reportStale: false,
      reportError: "",
      reportLoading: false,
      isExample: false,
    },
    onLoad(query = {}) {
      this.id = query.id || "";
      this.isExample = query.example === "1" || this.id === "example";
      this.setData({ isExample: this.isExample });
    },
    onShow() {
      if (!gate.check()) return;
      // A guest only sees the example; anything else offers the welcome page.
      if (gate.state() !== "ok" && !this.isExample) return gate.ask({ leave: true });
      this.alive = true;
      this.epoch = (this.epoch || 0) + 1;
      const current = owner();
      if (this.account && current && current !== this.account) {
        this.setData({
          loading: false,
          item: null,
          cards: [],
          conclusionCard: null,
          newCards: [],
          error: "换了账号，退出这页再进来",
        });
        return;
      }
      if (current) this.account = current;
      if (this.isExample) {
        const raw = example();
        this.applyExample(raw);
        return;
      }
      if (!this.id)
        return this.setData({ loading: false, error: "没打开，再试一次" });
      this.load();
    },
    onHide() {
      this.alive = false;
      this.epoch = (this.epoch || 0) + 1;
      if (this.reportWatcher) this.reportWatcher.stop();
      this.reportWatcher = null;
    },
    onUnload() {
      this.onHide();
    },
    active(epoch, account) {
      const current = owner();
      return (
        this.alive &&
        epoch === this.epoch &&
        (!account || current === account) &&
        (!this.account || !current || current === this.account)
      );
    },
    load() {
      const epoch = this.epoch,
        account = this.account || owner();
      this.setData({ loading: true, error: "" });
      return api
        .get(`/v1/brainstorms/${this.id}`)
        .then((result) => {
          if (!this.active(epoch, account)) return;
          if (!this.account && owner()) this.account = owner();
          const raw = result.brainstorm || result,
            item = itemView(raw);
          // A report still being written shows up once it is done; a failed
          // one offers 重试.
          if (pending(raw.reportJob)) this.watchReport(raw.reportJob, epoch, account);
          else if (
            (!raw.report || reportStale(raw.report)) &&
            raw.reportJob &&
            raw.reportJob.status !== "succeeded"
          )
            this.setData({ reportTask: { job: raw.reportJob } });
          else this.setData({ reportTask: null });
          const cached = getApp().globalData.brainstormCards;
          if (cached && cached.id === this.id) {
            getApp().globalData.brainstormCards = null;
            return this.apply(raw, cached.cards || []);
          }
          return Promise.allSettled(
            (raw.outCardIds || []).map((id) => api.get(`/v1/cards/${id}`)),
          ).then((results) => {
            if (this.active(epoch, account))
              this.apply(
                raw,
                results
                  .filter((entry) => entry.status === "fulfilled")
                  .map((entry) => entry.value),
              );
          });
        })
        .catch((error) => {
          if (this.active(epoch, account) && !api.needsConsent(error))
            this.setData({
              loading: false,
              error: error.message || "没打开，再试一次",
            });
        });
    },
    watchReport(job, epoch, account) {
      if (!this.active(epoch, account)) return;
      if (this.reportWatcher) this.reportWatcher.stop();
      this.setData({ reportTask: { job }, reportError: "" });
      this.reportWatcher = watch(job, {
        onUpdate: (next) => {
          if (this.active(epoch, account))
            this.setData({ reportTask: { job: next } });
        },
        onDone: (done) => {
          if (!this.active(epoch, account)) return;
          this.reportId = "";
          if (done.status !== "succeeded")
            return this.setData({ reportTask: { job: done } });
          return api
            .get(`/v1/brainstorms/${this.id}`)
            .then((result) => {
              const raw = result.brainstorm || result;
              if (this.active(epoch, account))
                this.setData({
                  report: reportView(raw.report),
                  reportStale: reportStale(raw.report),
                  reportTask: null,
                });
            })
            .catch((error) => this.reportFailed(error, epoch, account));
        },
        onError: (error, { retrying }) => {
          if (!retrying) this.reportFailed(error, epoch, account);
        },
      });
    },
    // 重试 after a failed report, 重新看看 for a stale one.
    retryReport() {
      return this.requestReport(this.refreshing);
    },
    refreshReport() {
      if (this.data.reportTask) return Promise.resolve();
      this.reportId = "";
      return this.requestReport(true);
    },
    requestReport(refresh = false) {
      if (this.isExample || this.data.reportLoading) return Promise.resolve();
      const epoch = this.epoch,
        account = this.account || owner();
      if (!this.reportId) this.reportId = reportClientId();
      this.refreshing = refresh;
      this.setData({ reportLoading: true, reportError: "" });
      return api
        .post(`/v1/brainstorms/${encodeURIComponent(this.id)}/report`, {
          clientId: this.reportId,
          ...(refresh ? { refresh: true } : {}),
        })
        .then(({ job, report }) => {
          if (!this.active(epoch, account)) return;
          this.setData({ reportLoading: false });
          if (job) return this.watchReport(job, epoch, account);
          this.setData({
            report: reportView(report),
            reportStale: reportStale(report),
            reportTask: null,
          });
        })
        .catch((error) => this.reportFailed(error, epoch, account));
    },
    reportFailed(error, epoch, account) {
      if (!this.active(epoch, account) || api.needsConsent(error)) return;
      this.reportId = "";
      this.setData({
        reportLoading: false,
        reportError: error.message || "没出来，再试一次",
      });
    },
    apply(raw, cards) {
      const item = itemView(raw),
        saved = (cards || []).map(cardView),
        conclusionId =
          item.conclusion && (raw.outCardIds || [])[0]
            ? String(raw.outCardIds[0])
            : "",
        conclusionSource = item.conclusion
          ? conclusionId
            ? saved.find((card) => String(card.id) === conclusionId)
            : saved[0]
          : null,
        conclusionCard = item.conclusion
          ? this.conclusionView(conclusionSource || null)
          : null,
        newCards = conclusionId
          ? saved.filter((card) => String(card.id) !== conclusionId)
          : conclusionCard
            ? saved.slice(1)
            : saved;
      item.dateLabel = dateLabel(raw.createdAt);
      item.savedCount = (raw.outCardIds || []).length || saved.length;
      this.setData({
        loading: false,
        item,
        cards: saved,
        conclusionCard,
        newCards,
        report: reportView(raw.report),
        reportStale: reportStale(raw.report),
        error: "",
      });
    },
    // Card field names stay hidden here; the card page shows the full layout.
    conclusionView(card) {
      if (!card) return null;
      return {
        ...card,
        slotViews: (card.slots || []).slice(0, 2).map((slot) => ({
          ...slot,
          ai: slot.by === "ai",
        })),
        openViews: (card.open || []).slice(0, 1).map((entry) => ({
          ...entry,
          label: "还没想明白的",
          ai: entry.by === "ai",
        })),
      };
    },
    applyExample(item) {
      const conclusion = cardView({
        id: "example-conclusion",
        type: "method",
        scene: "study",
        title: item.conclusion,
        titleBy: "user",
        mine: item.conclusion,
        organizedAt: new Date().toISOString(),
        tags: [{ id: "e1", name: "极限", color: 0 }],
        slots: [
          { key: "when", text: "先看运算结构，再决定能不能替换", by: "ai" },
          { key: "steps", text: "把替换条件逐条写出来", by: "ai" },
        ],
        open: [
          {
            key: "example-tension",
            text: "加减结构里的等价怎么判断",
            by: "ai",
          },
        ],
      });
      const extras = item.more
        .filter((entry) => entry.selected)
        .map((entry, index) =>
          cardView({
            id: `example-new-${index}`,
            type: entry.type,
            scene: "study",
            title: entry.titleView.text,
            titleBy: "ai",
            tags: [{ id: "e1", name: "极限", color: 0 }],
          }),
        );
      item.dateLabel = "示例";
      item.savedCount = 1 + extras.length;
      this.setData({
        loading: false,
        item,
        cards: [conclusion, ...extras],
        conclusionCard: this.conclusionView(conclusion),
        newCards: extras,
      });
    },
    openCard(event) {
      if (this.isExample) return;
      wx.navigateTo({
        url: `/pages/card/index?id=${encodeURIComponent(event.detail.card.id)}`,
      });
    },
    // A card in the picture or a difference opens the card it came from.
    openSource(event) {
      const id = event.currentTarget.dataset.id;
      if (!id) return;
      this.openCard({ detail: { card: { id } } });
    },
    openConclusion() {
      if (!this.data.conclusionCard) return;
      this.openCard({ detail: { card: this.data.conclusionCard } });
    },
    goHome() {
      wx.switchTab({ url: "/pages/deck/index" });
    },
    chat() {
      if (this.isExample || !this.data.cards.length) return;
      openChat(
        { cards: this.data.cards.slice(0, 3), brainstormId: this.id },
        { fromHome: true },
      );
    },
  });

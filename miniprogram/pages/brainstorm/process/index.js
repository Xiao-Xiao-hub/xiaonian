/*
 * 头脑风暴过程页：等待整理任务并展示分组与差异，衔接后续结论选择。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../../utils/api");
const gate = require("../../../utils/gate");
const auth = require("../../../utils/auth");
const {
  itemView,
  reportView,
  reportStale,
  reportBasis,
  readDraft,
  writeDraft,
  clearDraft,
  withDraft,
  jobLine,
  cleanPicks,
  example,
} = require("../view");
const { openChat } = require("../../../utils/chat-entry");
const { watch, pending } = require("../../../utils/job");
const owner = () => (auth.getUser() || {}).id || "";
const clone = (value) => JSON.parse(JSON.stringify(value || []));
const reportClientId = () =>
  `report-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
// the brainstorm job's real stages (job.progress.stage).
const STEPS = [
  { key: "cards", label: "看这几张卡" },
  { key: "think", label: "找联系、分组" },
  { key: "tidy", label: "整理结果" },
];
// V4.2 : the report job's stages.
const REPORT_STEPS = [
  { key: "write", label: "写分析" },
  { key: "check", label: "检查一遍" },
];
const OFFLINE = "网不太好，连上后接着看";
// What this page edits; the conclude page keeps the rest of the draft.
const EDITED = ["groups", "tensions", "more", "ask"];

Page({
    data: {
      loading: true,
      saving: false,
      error: "",
      item: null,
      progress: "",
      // the job under way, or the one that did not finish (重试).
      steps: STEPS,
      task: null,
      ready: false,
      failed: false,
      canMove: false,
      editing: {},
      factsOpen: false,
      askOpen: false,
      isExample: false,
      // The AI report comes first once the brainstorm is ready (v3).
      report: null,
      reportLoading: false,
      reportError: "",
      // V4.2 : the report job under way or failed, and a stale report.
      reportSteps: REPORT_STEPS,
      reportTask: null,
      reportStale: false,
      detailsOpen: false,
    },
    onLoad(query = {}) {
      this.id = query.id || "";
      this.isExample = query.example === "1" || this.id === "example";
      this.setData({ isExample: this.isExample });
      const app = getApp();
      if (this.id && app.globalData.brainstormSaved === this.id)
        app.globalData.brainstormSaved = null;
    },
    resultUrl() {
      return `/pages/brainstorm/result/index?id=${encodeURIComponent(this.id)}`;
    },
    onShow() {
      if (!gate.check()) return;
      // A guest only sees the example; anything else offers the welcome page.
      if (gate.state() !== "ok" && !this.isExample) return gate.ask({ leave: true });
      // Back from a saved result: leave instead of offering edits that would delete it.
      const app = getApp();
      if (this.raw && this.id && app.globalData.brainstormSaved === this.id) {
        app.globalData.brainstormSaved = null;
        this.alive = false;
        return wx.navigateBack({
          fail: () => wx.redirectTo({ url: this.resultUrl() }),
        });
      }
      this.alive = true;
      this.epoch = (this.epoch || 0) + 1;
      const current = owner();
      if (this.account && current && current !== this.account) {
        this.setData({
          loading: false,
          item: null,
          error: "换了账号，退出这页再进来",
        });
        return;
      }
      if (current) this.account = current;
      if (this.isExample) return this.apply(example());
      if (!this.id)
        return this.setData({
          loading: false,
          error: "没打开，再试一次",
        });
      this.load();
    },
    onHide() {
      this.stop();
    },
    onUnload() {
      this.stop();
    },
    // Leaving only stops asking; the job goes on and onShow picks it up.
    stop() {
      this.alive = false;
      this.epoch = (this.epoch || 0) + 1;
      if (this.watcher) this.watcher.stop();
      this.watcher = null;
      if (this.reportWatcher) this.reportWatcher.stop();
      this.reportWatcher = null;
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
    apply(source) {
      const sent = (source && source.picks) || {},
        made = (source && source.result) || {};
      this.sentBasis = reportBasis(
        sent.groups || made.groups,
        sent.tensions || made.tensions,
      );
      // Edits not yet sent win over what the server has.
      const raw = this.isExample
        ? source
        : withDraft(source, readDraft(this.account || owner(), this.id));
      const generated = raw.result || {};
      const item = itemView(raw);
      this.raw = raw;
      this.groups = clone((raw.picks && raw.picks.groups) || generated.groups);
      this.tensions = clone(
        (raw.picks && raw.picks.tensions) || generated.tensions,
      );
      this.more = clone((raw.picks && raw.picks.more) || generated.more).map(
        (entry) => ({ ...entry, selected: Boolean(entry.selected) }),
      );
      const ask =
        raw.picks && raw.picks.ask !== undefined
          ? raw.picks.ask
          : generated.ask;
      this.ask = ask ? JSON.parse(JSON.stringify(ask)) : null;
      const ready =
        raw.status === "ready" ||
        raw.status === "paused" ||
        Boolean(raw.example);
      // failed and unknown both mean "didn't finish, try again".
      const failed = Boolean(
        !ready &&
          raw.job &&
          ["failed", "unknown", "cancelled"].includes(raw.job.status),
      );
      this.setData({
        loading: false,
        item,
        facts: item.facts,
        canMove: this.movable(),
        progress: jobLine(raw.job),
        task: !ready && (failed || pending(raw.job)) ? { job: raw.job } : null,
        report: reportView(raw.report),
        reportStale: this.staleNow(raw.report),
        reportLoading: false,
        ready,
        failed,
        error: "",
        // Without a report the groups and differences show at once.
        ...(raw.report ? {} : { detailsOpen: true }),
      });
    },
    // Out of date: written before saved changes (the server says so) or
    // before edits not sent yet. Keeps the report for later edits to check.
    staleNow(report) {
      this.reportRaw = report;
      return Boolean(
        report &&
          (reportStale(report) ||
            reportBasis(this.groups, this.tensions) !== this.sentBasis),
      );
    },
    // Any two groups can trade cards, however few.
    movable() {
      return this.groups.length >= 2;
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
          const raw = result.brainstorm || result;
          if (raw.status === "saved") {
            clearDraft(account, this.id);
            return wx.redirectTo({ url: this.resultUrl() });
          }
          this.apply(raw);
          if (pending(raw.job)) this.poll(raw.job, epoch, account);
          else this.startReport(raw, epoch, account);
        })
        .catch((error) => {
          if (this.active(epoch, account) && !api.needsConsent(error))
            this.setData({
              loading: false,
              error: error.message || "没打开，再试一次",
            });
        });
    },
    poll(job, epoch, account) {
      if (!this.active(epoch, account)) return;
      if (this.watcher) this.watcher.stop();
      this.watcher = watch(job, {
        onUpdate: (next) => {
          if (!this.active(epoch, account)) return;
          this.setData({ progress: jobLine(next), task: { job: next }, error: "" });
        },
        onDone: () => {
          if (this.active(epoch, account)) this.load();
        },
        onError: (error, { retrying }) => {
          if (this.active(epoch, account) && !api.needsConsent(error))
            this.setData({
              error: retrying ? "网不太好，连上后接着看" : "网有点慢，过会儿再看",
            });
        },
      });
    },
    // <task-progress bind:retry>: the same cards again. The server starts a
    // new job on this brainstorm (or a new one if the cards changed since).
    retryRun() {
      if (this.data.saving || !this.raw || this.isExample) return Promise.resolve();
      const cardIds = (this.raw.cards || []).map((card) => card.id).filter(Boolean);
      const epoch = this.epoch,
        account = this.account || owner();
      this.setData({ saving: true, error: "" });
      return api
        .post("/v1/brainstorms", {
          clientId: `retry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          cardIds,
        })
        .then((result) => {
          if (!this.active(epoch, account)) return;
          const raw = (result && (result.brainstorm || result)) || {};
          if (raw.id && raw.id !== this.id)
            return wx.redirectTo({
              url: `/pages/brainstorm/process/index?id=${encodeURIComponent(raw.id)}`,
            });
          this.apply(raw);
          if (pending(raw.job)) this.poll(raw.job, epoch, account);
        })
        .catch((error) => {
          if (this.active(epoch, account) && !api.needsConsent(error))
            this.setData({ error: error.message || "没开始，再试一次" });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ saving: false });
        });
    },
    // Once the first pass is ready, ask for the report unless one exists or is
    // on its way; a failed report job waits for 重试 (V4.2 G1b: shown with
    // its stages, watched through short network breaks).
    startReport(raw, epoch, account) {
      if (this.isExample || !this.data.ready) return;
      if (pending(raw.reportJob))
        return this.watchReport(raw.reportJob, epoch, account);
      if (raw.report) return this.setData({ reportTask: null });
      if (raw.reportJob && raw.reportJob.status !== "succeeded")
        return this.setData({ reportTask: { job: raw.reportJob } });
      if (!raw.reportJob) return this.requestReport(epoch, account);
    },
    retryReport() {
      if (this.data.reportLoading) return;
      this.reportId = "";
      return this.requestReport(
        this.epoch,
        this.account || owner(),
        this.refreshing,
      );
    },
    // 重新看看: the groups or differences changed since the report was
    // written. Edits not sent yet go first, so the report reads them.
    refreshReport() {
      if (this.data.reportLoading || this.data.reportTask) return;
      this.reportId = "";
      const epoch = this.epoch,
        account = this.account || owner();
      if (reportBasis(this.groups, this.tensions) === this.sentBasis)
        return this.requestReport(epoch, account, true);
      this.setData({ reportLoading: true, reportError: "" });
      return api
        .put(
          `/v1/brainstorms/${this.id}/picks`,
          cleanPicks(
            {
              groups: this.groups,
              tensions: this.tensions,
              more: this.more,
              ask: this.ask,
            },
            this.raw.result || {},
          ),
        )
        .then((result) => {
          if (!this.active(epoch, account)) return;
          const saved = result.brainstorm || result;
          this.raw = { ...this.raw, picks: saved.picks || this.raw.picks };
          this.sentBasis = reportBasis(this.groups, this.tensions);
          clearDraft(account, this.id, EDITED);
          this.setData({ reportLoading: false });
          return this.requestReport(epoch, account, true);
        })
        .catch((error) => this.reportFailed(error, epoch, account));
    },
    async requestReport(epoch, account, refresh = false) {
      // A retry after a lost response reuses the same clientId.
      if (!this.reportId) this.reportId = reportClientId();
      this.refreshing = refresh;
      this.setData({ reportLoading: true, reportError: "" });
      try {
        const { job, report } = await api.post(
          `/v1/brainstorms/${encodeURIComponent(this.id)}/report`,
          { clientId: this.reportId, ...(refresh ? { refresh: true } : {}) },
        );
        if (!this.active(epoch, account)) return;
        if (!job)
          return this.setData({
            report: reportView(report),
            reportStale: this.staleNow(report),
            reportTask: null,
            reportLoading: false,
          });
        this.setData({ reportLoading: false });
        return this.watchReport(job, epoch, account);
      } catch (error) {
        this.reportFailed(error, epoch, account);
      }
    },
    watchReport(job, epoch, account) {
      if (!this.active(epoch, account)) return;
      if (this.reportWatcher) this.reportWatcher.stop();
      this.setData({ reportTask: { job }, reportError: "" });
      this.reportWatcher = watch(job, {
        onUpdate: (next) => {
          if (this.active(epoch, account))
            this.setData({
              reportTask: { job: next },
              reportError: "",
              ...(this.data.error === OFFLINE ? { error: "" } : {}),
            });
        },
        onDone: (done) => {
          if (!this.active(epoch, account)) return;
          this.reportId = "";
          if (done.status !== "succeeded")
            return this.setData({ reportTask: { job: done } });
          // Read only the report back, so edits made meanwhile stay.
          return api
            .get(`/v1/brainstorms/${this.id}`)
            .then((result) => {
              if (!this.active(epoch, account)) return;
              const raw = result.brainstorm || result;
              this.refreshing = false;
              this.setData({
                report: reportView(raw.report),
                reportStale: this.staleNow(raw.report),
                reportTask: null,
              });
            })
            .catch((error) => this.reportFailed(error, epoch, account));
        },
        onError: (error, { retrying }) => {
          if (this.active(epoch, account) && !api.needsConsent(error))
            this.setData({
              reportError: retrying ? "" : error.message || "没出来，再试一次",
              error: retrying ? OFFLINE : this.data.error,
            });
        },
      });
    },
    reportFailed(error, epoch, account) {
      if (
        !this.active(epoch, account) ||
        error.code === "CANCELLED" ||
        api.needsConsent(error)
      )
        return;
      this.setData({
        reportLoading: false,
        reportError: error.message || "没出来，再试一次",
      });
    },
    toggleDetails() {
      this.setData({ detailsOpen: !this.data.detailsOpen });
    },
    chat() {
      if (this.isExample || !this.raw || !this.data.ready) return;
      openChat({
        cards: (this.raw.cards || []).slice(0, 3),
        brainstormId: this.id,
      });
    },
    edit(event) {
      const { kind, index, field } = event.currentTarget.dataset,
        value = event.detail.value;
      const list =
        kind === "group"
          ? this.groups
          : kind === "tension"
            ? this.tensions
            : this.more;
      list[Number(index)][field] = value;
      this.refreshDraft();
    },
    toggleEdit(event) {
      const key = event.currentTarget.dataset.key;
      this.setData({ [`editing.${key}`]: !this.data.editing[key] });
    },
    toggleFacts() {
      this.setData({ factsOpen: !this.data.factsOpen });
    },
    remove(event) {
      const { kind, index } = event.currentTarget.dataset;
      const list =
        kind === "group"
          ? this.groups
          : kind === "tension"
            ? this.tensions
            : this.more;
      wx.showModal({
        title: kind === "group" ? "删掉这组？" : "删掉这条？",
        content: kind === "group" ? "组里的卡还在，只是不再分到这组。" : "",
        confirmText: "删掉",
        cancelText: "留着",
        success: ({ confirm }) => {
          if (!confirm) return;
          list.splice(Number(index), 1);
          this.refreshDraft();
        },
      });
    },
    stance(event) {
      const { index, value } = event.currentTarget.dataset;
      this.tensions[Number(index)].choice = value;
      this.refreshDraft();
    },
    toggleMore(event) {
      const index = Number(event.currentTarget.dataset.index);
      this.more[index].selected = !this.more[index].selected;
      this.refreshDraft();
    },
    editAsk(event) {
      if (!this.ask) return;
      const { field, index } = event.currentTarget.dataset;
      if (field === "q") this.ask.q = event.detail.value;
      else this.ask.options[Number(index)] = event.detail.value;
      this.refreshDraft();
    },
    removeAsk() {
      wx.showModal({
        title: "删掉这句？",
        confirmText: "删掉",
        cancelText: "留着",
        success: ({ confirm }) => {
          if (!confirm) return;
          this.ask = null;
          this.setData({ askOpen: false });
          this.refreshDraft();
        },
      });
    },
    closeAsk() {
      this.setData({ askOpen: false });
    },
    openMenu() {
      const actions = [];
      if (this.ask && !this.data.askOpen) actions.push(["ask", "再问自己一句"]);
      actions.push(["cancel", "这次不想了"]);
      wx.showActionSheet({
        itemList: actions.map((entry) => entry[1]),
        success: ({ tapIndex }) => {
          const action = (actions[tapIndex] || [])[0];
          if (action === "ask")
            this.setData({ askOpen: true, detailsOpen: true });
          if (action === "cancel") this.cancel();
        },
      });
    },
    moveCard(event) {
      if (!this.movable())
        return wx.showToast({ title: "只有一组，不用挪", icon: "none" });
      const card = Number(event.currentTarget.dataset.card),
        from = Number(event.currentTarget.dataset.group);
      if ((this.groups[from].cards || []).length <= 1)
        return wx.showToast({ title: "这组只剩这一张了", icon: "none" });
      wx.showActionSheet({
        itemList: this.groups.map((group) => group.name || "还没起名的一组"),
        success: ({ tapIndex }) => {
          if (tapIndex === from) return;
          this.groups.forEach((group) => {
            group.cards = (group.cards || []).filter(
              (value) => Number(value) !== card,
            );
          });
          this.groups[tapIndex].cards = [
            ...(this.groups[tapIndex].cards || []),
            card,
          ];
          this.refreshDraft();
        },
      });
    },
    refreshDraft() {
      if (!this.raw) return;
      const raw = {
        ...this.raw,
        picks: {
          ...(this.raw.picks || {}),
          groups: this.groups,
          tensions: this.tensions,
          more: this.more,
          ask: this.ask,
        },
      };
      this.raw = raw;
      if (!this.isExample)
        writeDraft(this.account || owner(), this.id, {
          groups: this.groups,
          tensions: this.tensions,
          more: this.more,
          ask: this.ask,
        });
      this.setData({
        item: itemView(raw),
        canMove: this.movable(),
        ...(this.data.report
          ? { reportStale: this.staleNow(this.reportRaw) }
          : {}),
      });
    },
    next() {
      if (this.data.saving || !this.data.ready) return;
      if (this.isExample)
        return wx.navigateTo({
          url: "/pages/brainstorm/conclude/index?example=1",
        });
      const epoch = this.epoch,
        account = this.account || owner();
      this.setData({ saving: true, error: "" });
      return api
        .put(
          `/v1/brainstorms/${this.id}/picks`,
          cleanPicks(
            {
              groups: this.groups,
              tensions: this.tensions,
              more: this.more,
              ask: this.ask,
            },
            this.raw.result || {},
          ),
        )
        .then((result) => {
          if (!this.active(epoch, account)) return;
          const item = result.brainstorm || result;
          this.raw = item;
          clearDraft(account, this.id, EDITED);
          wx.navigateTo({
            url: `/pages/brainstorm/conclude/index?id=${encodeURIComponent(this.id)}`,
          });
        })
        .catch((error) => {
          if (this.active(epoch, account) && !api.needsConsent(error))
            this.setData({
              error: error.message || "没存上，你改的还在，再试一次",
            });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ saving: false });
        });
    },
    cancel() {
      if (this.isExample) return wx.navigateBack();
      wx.showModal({
        title: "这次不想了？",
        content: "AI 理出来的会清掉。",
        confirmText: "不想了",
        cancelText: "接着想",
        success: ({ confirm }) => {
          if (!confirm) return;
          const epoch = this.epoch,
            account = this.account || owner();
          api
            .del(`/v1/brainstorms/${this.id}`)
            .then(() => {
              clearDraft(account, this.id);
              if (this.active(epoch, account)) wx.navigateBack();
            })
            .catch((error) => {
              if (this.active(epoch, account) && !api.needsConsent(error))
                this.setData({ error: "没取消成，再点一次" });
            });
        },
      });
    },
  });

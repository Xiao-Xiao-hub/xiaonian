const { withShare } = require("../../../utils/share");
/*
 * 头脑风暴结论页：让用户选择、补充或修改结论，确认后保存。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../../utils/api");
const gate = require("../../../utils/gate");
const auth = require("../../../utils/auth");
const { openChat } = require("../../../utils/chat-entry");
const {
  itemView,
  example,
  cleanPicks,
  KINDS,
  kindType,
  readDraft,
  writeDraft,
  clearDraft,
  withDraft,
} = require("../view");
const owner = () => (auth.getUser() || {}).id || "";
const clone = (value) => JSON.parse(JSON.stringify(value || []));
const clientId = () =>
  `brainstorm-save-${Date.now()}-${Math.random().toString(16).slice(2)}`;
// V4.2 : any of the seven kinds.
const KIND_IDS = Object.keys(KINDS);
const count = (value) => [...String(value || "").replace(/\s/g, "")].length;

Page(withShare({
    data: {
      loading: true,
      saving: false,
      error: "",
      item: null,
      draftsOpen: false,
      moreOpen: false,
      listEditing: false,
      titleEditing: false,
      focusConclusion: false,
      saveCount: 0,
      conclusionType: "idea",
      conclusionTypeName: KINDS.idea,
    },
    onLoad(query = {}) {
      this.id = query.id || "";
      this.isExample = query.example === "1" || this.id === "example";
      this.clientId = clientId();
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
      this.alive = false;
      this.epoch = (this.epoch || 0) + 1;
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
          const raw = result.brainstorm || result;
          if (raw.status === "saved") {
            clearDraft(account, this.id);
            return wx.redirectTo({
              url: `/pages/brainstorm/result/index?id=${encodeURIComponent(this.id)}`,
            });
          }
          if (raw.status === "running" || raw.status === "picked")
            return wx.redirectTo({
              url: `/pages/brainstorm/process/index?id=${encodeURIComponent(this.id)}`,
            });
          this.apply(raw);
        })
        .catch((error) => {
          if (this.active(epoch, account) && !api.needsConsent(error))
            this.setData({
              loading: false,
              error: error.message || "没打开，再试一次",
            });
        });
    },
    apply(source) {
      // Edits not yet sent win over what the server has.
      const raw = this.isExample
        ? source
        : withDraft(source, readDraft(this.account || owner(), this.id));
      this.raw = raw;
      const result = raw.result || {},
        picks = raw.picks || {};
      this.title = picks.title ?? result.title ?? "";
      this.groups = clone(picks.groups || result.groups);
      this.tensions = clone(picks.tensions || result.tensions);
      this.more = clone(picks.more || result.more).map((entry) => ({
        ...entry,
        selected: Boolean(entry.selected),
      }));
      this.ifs = clone(picks.ifs || result.ifs).map((entry) => ({
        ...entry,
        selected: entry.selected !== false,
      }));
      this.directions = clone(picks.directions || result.directions);
      this.drafts = clone(picks.drafts || result.drafts);
      // An empty conclusion only carries the chosen type; keep it aside.
      const saved = picks.conclusion || null;
      this.conclusion = saved && count(saved.text) ? { ...saved } : null;
      this.pendingType =
        saved && !this.conclusion ? saved.kind || saved.type || "" : "";
      this.refresh(false);
    },
    payload(pause) {
      return {
        ...cleanPicks(
          {
            title: this.title,
            groups: this.groups,
            tensions: this.tensions,
            more: this.more,
            ifs: this.ifs,
            directions: this.directions,
            drafts: this.drafts,
          },
          (this.raw && this.raw.result) || {},
        ),
        conclusion: this.conclusion,
        ...(pause ? { pause: true } : {}),
      };
    },
    // edited: the user changed something, so it is kept as a draft.
    refresh(edited = true) {
      const raw = {
          ...this.raw,
          picks: {
            ...(this.raw.picks || {}),
            title: this.title,
            groups: this.groups,
            tensions: this.tensions,
            more: this.more,
            ifs: this.ifs,
            directions: this.directions,
            drafts: this.drafts,
            conclusion: this.conclusion,
          },
        },
        item = itemView(raw);
      this.raw = raw;
      if (edited && !this.isExample)
        writeDraft(this.account || owner(), this.id, {
          title: this.title,
          ifs: this.ifs,
          directions: this.directions,
          drafts: this.drafts,
          conclusion:
            this.conclusion ||
            (this.pendingType
              ? { text: "", type: kindType(this.pendingType), kind: this.pendingType }
              : null),
        });
      const saveCount =
        item.more.filter((entry) => entry.selected).length +
        (item.conclusion ? 1 : 0);
      const type =
        (this.conclusion && (this.conclusion.kind || this.conclusion.type)) ||
        this.pendingType ||
        item.conclusionType;
      this.setData({
        loading: false,
        item,
        saveCount,
        conclusionType: type,
        conclusionTypeName: KINDS[type] || KINDS.idea,
      });
    },
    editTitle() {
      this.setData({ titleEditing: true });
    },
    titleDone() {
      this.setData({ titleEditing: false });
    },
    titleInput(event) {
      this.title = event.detail.value;
      this.refresh();
    },
    conditionInput(event) {
      const entry = this.ifs[Number(event.currentTarget.dataset.index)];
      if (!entry) return;
      entry.if = event.detail.value;
      this.refresh();
    },
    thenInput(event) {
      const entry = this.ifs[Number(event.currentTarget.dataset.index)];
      if (!entry) return;
      entry.then = event.detail.value;
      entry.selected = Boolean(event.detail.value.trim());
      this.refresh();
    },
    removeIf(event) {
      const index = Number(event.currentTarget.dataset.index);
      wx.showModal({
        title: "删掉这个条件？",
        confirmText: "删掉",
        cancelText: "留着",
        success: ({ confirm }) => {
          if (!confirm) return;
          this.ifs.splice(index, 1);
          this.refresh();
        },
      });
    },
    conclusionInput(event) {
      const text = event.detail.value;
      if (!count(text) && this.conclusion)
        this.pendingType = this.conclusion.kind || this.conclusion.type;
      const kind = this.data.conclusionType;
      this.conclusion = count(text)
        ? {
            ...(this.conclusion || {}),
            text,
            type: kindType(kind),
            kind,
          }
        : null;
      if (this.data.error) this.setData({ error: "" });
      this.refresh();
    },
    conclusionBlur() {
      this.setData({ focusConclusion: false });
    },
    pickType() {
      wx.showActionSheet({
        itemList: KIND_IDS.map((id) => KINDS[id]),
        success: ({ tapIndex }) => this.setType(KIND_IDS[tapIndex]),
      });
    },
    // Choosing a type before writing only remembers it, it never creates an empty conclusion.
    setType(kind) {
      if (!KINDS[kind]) return;
      if (this.conclusion)
        this.conclusion = { ...this.conclusion, type: kindType(kind), kind };
      else this.pendingType = kind;
      this.refresh();
    },
    editList(event) {
      const { kind, index, field } = event.currentTarget.dataset;
      const list = kind === "direction" ? this.directions : this.drafts;
      list[Number(index)][field] = event.detail.value;
      this.refresh();
    },
    toggleDrafts() {
      this.setData({ draftsOpen: !this.data.draftsOpen });
    },
    toggleMore() {
      this.setData({ moreOpen: !this.data.moreOpen });
    },
    toggleListEdit() {
      this.setData({ listEditing: !this.data.listEditing });
    },
    removeList(event) {
      const { kind, index } = event.currentTarget.dataset;
      wx.showModal({
        title: "删掉这条？",
        confirmText: "删掉",
        cancelText: "留着",
        success: ({ confirm }) => {
          if (!confirm) return;
          const list = kind === "direction" ? this.directions : this.drafts;
          list.splice(Number(index), 1);
          this.refresh();
        },
      });
    },
    useDraft(event) {
      const entry = this.drafts[Number(event.currentTarget.dataset.index)];
      // The kind the AI gave this sentence, unless one was picked already.
      const kind =
        (this.conclusion && this.conclusion.kind) ||
        this.pendingType ||
        (KINDS[entry.kind] ? entry.kind : this.data.conclusionType);
      this.conclusion = {
        text: entry.text,
        draftId: entry.id,
        type: kindType(kind),
        kind,
      };
      this.setData({ error: "" });
      this.refresh();
    },
    savePicks(pause) {
      if (this.isExample) return Promise.resolve(this.raw);
      const account = this.account || owner();
      return api
        .put(`/v1/brainstorms/${this.id}/picks`, this.payload(pause))
        .then((result) => {
          // The server has every edit now.
          clearDraft(account, this.id);
          return result.brainstorm || result;
        });
    },
    save(event) {
      const mode = event.currentTarget.dataset.mode || "result";
      if (this.data.saving) return;
      if (!this.data.saveCount) {
        this.setData({
          error: "先写一句你现在的想法",
          focusConclusion: true,
        });
        return;
      }
      // A clear short sentence is enough.
      if (this.conclusion && count(this.conclusion.text) < 2) {
        this.setData({ error: "再多写几个字", focusConclusion: true });
        return;
      }
      if (this.isExample)
        return wx.redirectTo({
          url: "/pages/brainstorm/result/index?example=1",
        });
      const epoch = this.epoch,
        account = this.account || owner();
      this.setData({ saving: true, error: "" });
      return this.savePicks(false)
        .then(() =>
          api.post(`/v1/brainstorms/${this.id}/save`, {
            clientId: this.clientId,
          }),
        )
        .then((result) => {
          if (!this.active(epoch, account)) return;
          const cards = result.cards || [];
          getApp().globalData.brainstormCards = { id: this.id, cards };
          // Tells the process page underneath that this brainstorm is saved.
          getApp().globalData.brainstormSaved = this.id;
          if (mode === "chat")
            return openChat({ cards: cards.slice(0, 3) }, { fromHome: true });
          wx.redirectTo({
            url: `/pages/brainstorm/result/index?id=${encodeURIComponent(this.id)}`,
          });
        })
        .catch((error) => {
          if (!this.active(epoch, account)) return;
          if (error.code === "CRISIS_CONTENT")
            return wx.navigateTo({ url: "/pages/crisis/index" });
          if (!api.needsConsent(error))
            this.setData({
              error: error.message || "没存上，你写的还在，再试一次",
            });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ saving: false });
        });
    },
    pause() {
      if (this.data.saving) return;
      if (this.isExample) return wx.navigateBack();
      const epoch = this.epoch,
        account = this.account || owner();
      this.setData({ saving: true, error: "" });
      return this.savePicks(true)
        .then(() => {
          if (this.active(epoch, account))
            wx.switchTab({ url: "/pages/deck/index" });
        })
        .catch((error) => {
          if (this.active(epoch, account) && !api.needsConsent(error))
            this.setData({
              error: error.message || "没存上，你写的还在，再试一次",
            });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ saving: false });
        });
    },
  }));

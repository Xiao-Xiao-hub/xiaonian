const { withShare } = require("../../../utils/share");
/*
 * 拆卡确认页：查看导入生成的候选卡，编辑和选择后保存；保留未读完内容的继续处理入口。
 * 页面中的请求标识、账号快照和 alive 状态用于拦截过期回包；不能仅因离开页面就删除另一份新草稿。
 */
const api = require("../../../utils/api");
const gate = require("../../../utils/gate");
const auth = require("../../../utils/auth");
const { errorText } = require("../../../utils/format");
const {
  TYPES,
  KINDS,
  KIND_TYPE,
  kindOf,
  sentences,
  draftGet,
  draftSet,
  SCENES,
  clientId,
  candidateView,
  SPLIT_STEPS,
} = require("../view");
const { watch } = require("../../../utils/job");

const owner = () => (auth.getUser() || {}).id || "";
const imported = (result) => result && (result.import || result);
const uniq = (values) => Array.from(new Set(values));

Page(withShare({
    data: {
      loading: false,
      saving: false,
      error: "",
      item: null,
      candidates: [],
      selectedCount: 0,
      allSelected: true,
      own: false,
      progress: "",
      // the split job under way, for <task-progress>.
      task: null,
      waiting: false,
      edit: null,
      editTags: "",
      sourceSheet: null,
      sourceMode: "read",
      savedCards: [],
      pointAsk: [],
      pointSaving: false,
      pointsDone: false,
      crisis: false,
      moodConsented: false,
      // the seven kinds.
      typeChoices: KINDS.map((id) => ({ id, name: TYPES[id] })),
      sceneChoices: Object.entries(SCENES).map(([id, name]) => ({ id, name })),
    },
    onLoad(query) {
      this.importId = (query && query.id) || "";
      this.manual = [];
      this.edits = {};
      this.pointAccepted = new Set();
      this.selected = new Set();
    },
    onShow() {
      if (!gate.check()) return;
      // A guest has nothing here: offer the welcome page, send nothing.
      if (gate.state() !== "ok") return gate.ask({ leave: true });
      this.alive = true;
      this.setData({ saving: false });
      this.epoch = (this.epoch || 0) + 1;
      const current = owner();
      if (this.account && current && current !== this.account) {
        this.resetDraft();
        this.setData({ error: "换了账号，退出这页再进来" });
        return;
      }
      if (current) this.account = current;
      if (this.importId) this.load();
      else this.setData({ error: "没打开，再试一次" });
    },
    onHide() {
      this.stop();
    },
    onUnload() {
      this.stop();
    },
    // Leaving only stops asking; the split goes on and onShow picks it up.
    stop() {
      this.alive = false;
      this.epoch = (this.epoch || 0) + 1;
      if (this.watcher) this.watcher.stop();
      this.watcher = null;
    },
    active(epoch, account) {
      return (
        this.alive &&
        epoch === this.epoch &&
        (!account || owner() === account) &&
        (!this.account || !owner() || owner() === this.account)
      );
    },
    bindOwner(epoch, account) {
      if (!this.active(epoch, account)) return false;
      if (!this.account && owner()) this.account = owner();
      return true;
    },
    resetDraft() {
      this.manual = [];
      this.edits = {};
      this.pointAccepted = new Set();
      this.selected = new Set();
      this.initialized = false;
      this.setData({
        item: null,
        candidates: [],
        selectedCount: 0,
        savedCards: [],
        pointAsk: [],
      });
    },
    load() {
      const epoch = this.epoch;
      const account = owner();
      this.setData({ loading: true, error: "" });
      return api
        .get(`/v1/imports/${encodeURIComponent(this.importId)}`)
        .then((item) => {
          if (this.bindOwner(epoch, account)) this.adopt(item);
        })
        .catch((error) => {
          if (!this.active(epoch, account) || api.needsConsent(error)) return;
          // Deleted: its draft goes too.
          if (error.code === "NOT_FOUND" && (this.account || account))
            draftSet(this.draftName(), this.account || account, null);
          this.setData({ error: errorText(error) });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ loading: false });
        });
    },
    adopt(item) {
      if (!item) return;
      this.importId = item.id;
      // saved or given up (here, elsewhere or on another phone):
      // what was ticked for it is not needed any more.
      if (["saved", "abandoned"].includes(item.status) && this.account)
        draftSet(this.draftName(), this.account, null);
      // a split that failed went back to the read text; reading, a
      // failed read and 拆成卡 all live on the source page.
      if (!["picking", "saved", "splitting"].includes(item.status)) {
        if (!this.redirected) {
          this.redirected = true;
          wx.redirectTo({
            url: `/pages/import/source/index?id=${encodeURIComponent(item.id)}`,
          });
        }
        return;
      }
      this.rawCandidates = item.candidates || [];
      let own = Boolean(item.own);
      if (!this.initialized && ["picking", "saved"].includes(item.status)) {
        this.selected = new Set(
          this.rawCandidates
            .filter(
              (candidate) =>
                candidate.selected !== false &&
                !candidate.crisis &&
                !candidate.savedCardId,
            )
            .map((candidate) => candidate.id),
        );
        this.initialized = true;
        // edits, ticks and a sentence picked before leaving come back.
        const draft =
          item.status === "picking" ? draftGet(this.draftName(), this.account) : null;
        if (draft) {
          const known = new Set(this.rawCandidates.map((candidate) => candidate.id));
          const manual = (draft.manual || []).filter(
            (candidate) => candidate && candidate.manual && !known.has(candidate.id),
          );
          manual.forEach((candidate) => known.add(candidate.id));
          this.manual = manual;
          this.edits = draft.edits || {};
          this.selected = new Set((draft.selected || []).filter((id) => known.has(id)));
          this.pointAccepted = new Set(
            (draft.pointAccepted || []).filter((id) => known.has(id)),
          );
          if (typeof draft.own === "boolean") own = draft.own;
        }
      }
      if (this.manual && this.manual.length && item.status === "picking")
        this.rawCandidates = this.rawCandidates.concat(this.manual);
      this.setData({
        item,
        own,
        savedCards: item.savedCards || [],
        crisis: this.rawCandidates.some((candidate) => candidate.crisis),
        progress: "",
        task: api.pending(item.job) ? { steps: SPLIT_STEPS, job: item.job } : null,
        waiting: api.pending(item.job),
      });
      this.sync();
      if (api.pending(item.job)) this.watchJob(item.job);
    },
    sync() {
      const candidates = (this.rawCandidates || []).map((candidate) =>
        candidateView(
          candidate,
          this.edits[candidate.id],
          this.selected.has(candidate.id),
          this.pointAccepted.has(candidate.id),
        ),
      );
      const selectable = candidates.filter(
        (candidate) => !candidate.crisis && !candidate.savedCardId,
      );
      const current = this.editingId
        ? candidates.find((candidate) => candidate.id === this.editingId)
        : null;
      this.setData({
        candidates,
        selectedCount: this.selected.size,
        allSelected:
          Boolean(selectable.length) &&
          selectable.every((candidate) => this.selected.has(candidate.id)),
        // The open sheet keeps its unsaved title and type; only these follow along.
        ...(current && this.data.edit
          ? {
              "edit.mine": current.mine || "",
              "edit.pointAccepted": current.pointAccepted,
            }
          : {}),
      });
      this.keepDraft();
    },
    draftName() {
      return `pick:${this.importId}`;
    },
    // what was changed here is kept until the cards are saved.
    keepDraft() {
      if (!this.initialized || !this.account || !this.data.item) return;
      if (this.data.item.status !== "picking") return;
      draftSet(this.draftName(), this.account, {
        edits: this.edits,
        selected: Array.from(this.selected),
        pointAccepted: Array.from(this.pointAccepted),
        manual: this.manual || [],
        own: this.data.own,
      });
    },
    watchJob(job) {
      if (!job || !api.pending(job)) return;
      if (this.watcher) this.watcher.stop();
      const epoch = this.epoch;
      const account = owner();
      this.watcher = watch(job, {
        onUpdate: (next) => {
          if (!this.bindOwner(epoch, account) || !this.data.task) return;
          this.setData({ task: { ...this.data.task, job: next }, error: "" });
        },
        onDone: () => {
          if (this.bindOwner(epoch, account)) this.load();
        },
        onError: (error, { retrying }) => {
          if (!this.active(epoch, account) || api.needsConsent(error)) return;
          this.setData({
            error: retrying ? "网不太好，连上后接着看" : errorText(error),
          });
        },
      });
    },
    leave() {
      wx.navigateBack({
        fail: () => wx.switchTab({ url: "/pages/notes/index" }),
      });
    },
    toggleCandidate(event) {
      if (this.data.saving) return;
      const id = String(event.currentTarget.dataset.id || "");
      if (!id) return;
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
      this.sync();
    },
    toggleAll() {
      if (this.data.saving) return;
      const available = (this.rawCandidates || []).filter(
        (candidate) => !candidate.crisis && !candidate.savedCardId,
      );
      if (
        available.length &&
        available.every((candidate) => this.selected.has(candidate.id))
      )
        available.forEach((candidate) => this.selected.delete(candidate.id));
      else available.forEach((candidate) => this.selected.add(candidate.id));
      this.sync();
    },
    toggleOwn(event) {
      const detail = (event && event.detail) || {};
      const own = "value" in detail ? Boolean(detail.value) : !this.data.own;
      this.setData({ own, error: "" });
      this.keepDraft();
    },
    acceptMood(event) {
      const id = String(event.currentTarget.dataset.id || "");
      this.edits[id] = { ...(this.edits[id] || {}), scene: "mood" };
      if (this.editingId === id) this.setData({ "edit.scene": "mood" });
      this.sync();
    },
    openEdit(event) {
      const id = String(event.currentTarget.dataset.id || "");
      const candidate = this.data.candidates.find((item) => item.id === id);
      if (!candidate) return;
      this.editingId = id;
      this.setData({
        edit: { ...candidate, kind: candidate.kind || kindOf(candidate) },
        editTags: (candidate.tags || []).join("，"),
        error: "",
      });
    },
    editTitle(event) {
      this.setData({
        "edit.title": String(event.detail.value || "").slice(0, 16),
      });
    },
    editSummary(event) {
      this.setData({
        "edit.summary": String(event.detail.value || "").slice(0, 60),
      });
    },
    editTags(event) {
      this.setData({ editTags: String(event.detail.value || "").slice(0, 40) });
    },
    chooseType(event) {
      const kind = String(event.currentTarget.dataset.id || "");
      if (!TYPES[kind]) return;
      this.setData({ "edit.kind": kind, "edit.type": KIND_TYPE[kind] });
    },
    chooseScene(event) {
      this.setData({ "edit.scene": event.currentTarget.dataset.id });
    },
    closeEdit() {
      this.editingId = "";
      this.setData({ edit: null, editTags: "" });
    },
    noop() {},
    saveEdit() {
      if (!this.data.edit || !this.editingId) return;
      const title = String(this.data.edit.title || "").trim();
      const summary = String(this.data.edit.summary || "").trim();
      const tags = uniq(
        String(this.data.editTags || "")
          .split(/[，,]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      );
      if (!title) {
        wx.showToast({ title: "起个标题吧", icon: "none" });
        return;
      }
      if (!summary) {
        wx.showToast({ title: "摘要不能空着", icon: "none" });
        return;
      }
      if (tags.length > 3 || tags.some((tag) => tag.length > 6)) {
        wx.showToast({
          title: "标签多了点（最多 3 个，每个 6 个字以内）",
          icon: "none",
        });
        return;
      }
      const original =
        (this.rawCandidates || []).find((item) => item.id === this.editingId) ||
        {};
      const kind = this.data.edit.kind || kindOf(original);
      if (original.manual) {
        // A sentence picked from the text: its kind and title are the card's.
        Object.assign(original, { kind, type: KIND_TYPE[kind], title });
      }
      this.edits[this.editingId] = {
        ...(this.edits[this.editingId] || {}),
        kind,
        type: KIND_TYPE[kind],
        scene: this.data.edit.scene,
        title,
        summary,
        tags,
        kindEdited: kind !== kindOf(original),
        summaryEdited: !original.manual && summary !== original.summary,
        titleEdited: title !== original.title,
        tagsEdited:
          JSON.stringify(tags) !== JSON.stringify(original.tags || []),
      };
      this.closeEdit();
      this.sync();
    },
    acceptPoint(event) {
      const id = String(event.currentTarget.dataset.id || "");
      if (this.pointAccepted.has(id)) this.pointAccepted.delete(id);
      else this.pointAccepted.add(id);
      this.sync();
    },
    openSource(event) {
      this.showSource(String(event.currentTarget.dataset.id || ""), "read");
    },
    chooseMine(event) {
      if (!this.data.own) {
        this.setData({ error: "打开“原文是我自己写的”，就能挑一句" });
        return;
      }
      this.showSource(String(event.currentTarget.dataset.id || ""), "mine");
    },
    showSource(id, mode) {
      const candidate = this.data.candidates.find((item) => item.id === id);
      if (!candidate || !this.data.item) return;
      const hit = new Set(candidate.src || []);
      const segments = this.data.item.segments || [];
      // 我的话 is a sentence of this card's own text, 10–300 characters,
      // not someone else's line in a chat (what the server accepts).
      const lines =
        mode === "mine"
          ? segments
              .filter((segment) => hit.has(segment.n) && segment.who !== "other")
              .flatMap((segment) =>
                sentences(segment.text).map((text) => ({
                  n: segment.n,
                  who: segment.who,
                  text,
                })),
              )
              // at most 300 as the server counts (ends trimmed,
              // inner spaces too); at least 10 without spaces as before.
              .filter(
                (line) =>
                  line.text.replace(/\s/g, "").length >= 10 &&
                  line.text.trim().length <= 300,
              )
          : segments.map((segment) => ({ ...segment, hit: hit.has(segment.n) }));
      this.sourceCandidateId = id;
      this.setData({
        sourceMode: mode,
        sourceSheet: {
          title: mode === "mine" ? "挑一句我的话" : candidate.srcLabel,
          lines: lines.map((line, index) => ({ ...line, k: `${line.n}-${index}` })),
          empty: !lines.length,
          emptyText:
            this.data.item.source === "screenshot"
              ? "截图里没找到你说的话"
              : "这张卡的原文里没有合适的句子",
        },
      });
    },
    startManual() {
      if (!this.data.item) return;
      // one sentence, not a whole segment; someone else's chat line
      // is not offered (a screenshot read as a page has no speakers).
      const lines = (this.data.item.segments || [])
        .filter((segment) => segment.who !== "other")
        .flatMap((segment) =>
          sentences(segment.text).map((text) => ({
            n: segment.n,
            who: segment.who,
            text: text.slice(0, 1000),
          })),
        );
      this.setData({
        sourceMode: "manual",
        sourceSheet: {
          title: "从原文选一句",
          lines: lines.map((line, index) => ({ ...line, k: `${line.n}-${index}` })),
          empty: !lines.length,
          emptyText: "截图里没找到你说的话",
        },
      });
    },
    selectSourceLine(event) {
      if (!["mine", "manual"].includes(this.data.sourceMode)) return;
      const dataset = event.currentTarget.dataset || {};
      const lines = (this.data.sourceSheet && this.data.sourceSheet.lines) || [];
      const line =
        dataset.i !== undefined
          ? lines[Number(dataset.i)]
          : lines.find((item) => item.n === Number(dataset.n));
      if (!line) return;
      if (this.data.sourceMode === "manual") {
        const id = `manual-${line.k}`;
        const text = String(line.text || "").trim();
        // One sentence at a time (the server saves a picked sentence alone).
        const before = new Set((this.manual || []).map((candidate) => candidate.id));
        before.forEach((old) => {
          this.selected.delete(old);
          delete this.edits[old];
        });
        const candidate = {
          id,
          manual: true,
          quote: text,
          kind: "spark",
          type: "spark",
          scene: "study",
          // The server takes 16 characters at most.
          title: text.replace(/[。！？!?；;]+$/, "").slice(0, 16) || "从原文存下的卡",
          summary: text,
          src: [line.n],
          tags: [],
          selected: true,
        };
        this.manual = [candidate];
        this.rawCandidates = (this.rawCandidates || [])
          .filter((item) => !before.has(item.id))
          .concat(candidate);
        this.selected.add(id);
        this.closeSource();
        this.sync();
        // Confirm what kind of card it is before saving.
        this.openEdit({ currentTarget: { dataset: { id } } });
        return;
      }
      if (!this.sourceCandidateId) return;
      this.edits[this.sourceCandidateId] = {
        ...(this.edits[this.sourceCandidateId] || {}),
        mine: line.text,
        mineN: line.n,
      };
      this.closeSource();
      this.sync();
    },
    closeSource() {
      this.sourceCandidateId = "";
      this.setData({ sourceSheet: null, sourceMode: "read" });
    },
    openCrisis() {
      wx.navigateTo({ url: "/pages/crisis/index" });
    },
    saveCards() {
      if (this.data.saving || !this.selected.size) {
        if (!this.selected.size) this.setData({ error: "先勾一张吧" });
        return Promise.resolve();
      }
      const selections = (this.rawCandidates || [])
        .filter((candidate) => this.selected.has(candidate.id))
        .map((candidate) => {
          const edit = this.edits[candidate.id] || {};
          const kind = edit.kind || kindOf(candidate);
          const result = {
            type: KIND_TYPE[kind] || edit.type || candidate.type,
            scene: edit.scene || candidate.scene,
          };
          // the kind goes along when it was chosen here; otherwise the
          // server keeps the candidate's own.
          if (edit.kindEdited || candidate.manual) result.kind = kind;
          if (edit.summaryEdited && edit.summary) result.summary = edit.summary;
          if (edit.titleEdited || candidate.manual)
            result.title = edit.title || candidate.title;
          if (edit.tagsEdited) result.tags = edit.tags;
          if (candidate.manual) result.quote = candidate.quote;
          else result.candidateId = candidate.id;
          if (this.data.own && edit.mine) result.mine = edit.mine;
          if (this.pointAccepted.has(candidate.id) && candidate.pointId)
            result.pointId = candidate.pointId;
          return result;
        });
      const epoch = this.epoch;
      const account = owner();
      this.setData({ saving: true, error: "" });
      const updateOwn =
        this.data.own === this.data.item.own
          ? Promise.resolve()
          : api.patch(`/v1/imports/${encodeURIComponent(this.importId)}`, {
              own: this.data.own,
            });
      return updateOwn
        .then(() => {
          if (!this.bindOwner(epoch, account)) return null;
          return api.post(
            `/v1/imports/${encodeURIComponent(this.importId)}/save`,
            {
              clientId: clientId("save"),
              selections,
            },
          );
        })
        .then((result) => {
          if (!result || !this.bindOwner(epoch, account)) return;
          this.manual = [];
          draftSet(this.draftName(), this.account || account, null);
          const item = imported(result);
          if (item) this.adopt(item);
          const cards = (result && result.cards) || [];
          this.setData({
            savedCards: cards,
            crisis: Boolean(result && result.crisis),
            pointAsk: this.pointQuestions(item, cards),
            pointsDone: false,
          });
        })
        .catch((error) => {
          if (!this.active(epoch, account) || api.needsConsent(error)) return;
          if (error && error.code === "MOOD_CONSENT_REQUIRED") {
            this.setData({ error: "心情卡要先点一下同意，回来再存就好" });
            wx.navigateTo({ url: "/pages/mood-consent/index" });
            return;
          }
          this.setData({ error: errorText(error) });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ saving: false });
        });
    },
    // Asked once, right after saving: cards whose suggested point wasn't taken yet.
    pointQuestions(item, cards) {
      const byId = new Map(
        (cards.length ? cards : (item && item.savedCards) || []).map((card) => [
          String(card.id),
          card,
        ]),
      );
      return ((item && item.candidates) || [])
        .filter(
          (candidate) =>
            candidate.savedCardId &&
            candidate.pointId &&
            candidate.pointConfidence >= 0.7,
        )
        .map((candidate) => ({
          candidate,
          card: byId.get(String(candidate.savedCardId)),
        }))
        .filter(({ card }) => card && !card.pointId && card.version)
        .map(({ candidate, card }) => ({
          cardId: String(card.id),
          version: card.version,
          title: card.title || candidate.title || "这张卡",
          pointId: candidate.pointId,
          pointName: candidate.pointName || "这个知识点",
        }));
    },
    acceptPoints() {
      const pending = this.data.pointAsk.slice();
      if (!pending.length || this.data.pointSaving) return Promise.resolve();
      const epoch = this.epoch;
      const account = owner();
      this.setData({ pointSaving: true, error: "" });
      return pending
        .reduce(
          (chain, entry) =>
            chain.then(() =>
              api
                .patch(`/v1/cards/${encodeURIComponent(entry.cardId)}`, {
                  version: entry.version,
                  pointId: entry.pointId,
                })
                .then(() => {
                  if (!this.active(epoch, account)) return;
                  this.setData({
                    pointAsk: this.data.pointAsk.filter(
                      (item) => item.cardId !== entry.cardId,
                    ),
                  });
                }),
            ),
          Promise.resolve(),
        )
        .then(() => {
          if (this.active(epoch, account)) this.setData({ pointsDone: true });
        })
        .catch((error) => {
          if (!this.active(epoch, account) || api.needsConsent(error)) return;
          this.setData({ error: "没放进去，再点一次" });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ pointSaving: false });
        });
    },
    skipPoints() {
      this.setData({ pointAsk: [] });
    },
    // the text past the limit, as the next import (read already).
    importRest() {
      if (this.data.saving || !this.importId) return Promise.resolve();
      const epoch = this.epoch;
      const account = owner();
      this.setData({ saving: true, error: "" });
      return api
        .post(`/v1/imports/${encodeURIComponent(this.importId)}/rest`, {
          clientId: this.restClient || (this.restClient = clientId("rest")),
        })
        .then((result) => {
          const item = imported(result);
          if (!item || !this.bindOwner(epoch, account)) return;
          wx.redirectTo({
            url: `/pages/import/source/index?id=${encodeURIComponent(item.id)}`,
          });
        })
        .catch((error) => {
          if (!this.active(epoch, account) || api.needsConsent(error)) return;
          this.setData({ error: errorText(error) });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ saving: false });
        });
    },
    goCards() {
      wx.switchTab({ url: "/pages/deck/index" });
    },
    brainstorm() {
      const cards = this.data.savedCards || [];
      getApp().globalData.cardPick = {
        mode: "brainstorm",
        cards,
        selected: cards.map((card) => card.id),
      };
      wx.navigateTo({
        url: `/pages/brainstorm/pick/index?ids=${encodeURIComponent(cards.map((card) => card.id).join(","))}&source=import`,
      });
    },
    cancel() {
      const epoch = this.epoch;
      const account = owner();
      wx.showModal({
        title: "不导了？",
        content: "已经存好的卡还在。",
        confirmText: "不导了",
        cancelText: "接着导",
        success: (result) => {
          if (!result.confirm || !this.bindOwner(epoch, account)) return;
          this.setData({ saving: true, error: "" });
          api
            .del(`/v1/imports/${encodeURIComponent(this.importId)}`)
            .then(() => {
              draftSet(this.draftName(), this.account || account, null);
              if (this.bindOwner(epoch, account)) wx.navigateBack();
            })
            .catch((error) => {
              if (!this.active(epoch, account) || api.needsConsent(error))
                return;
              this.setData({ error: errorText(error) });
            })
            .finally(() => {
              if (this.active(epoch, account)) this.setData({ saving: false });
            });
        },
      });
    },
  }));

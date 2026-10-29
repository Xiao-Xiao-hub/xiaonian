const { withShare } = require("../../utils/share");
/*
 * 卡片详情：查看来源、编辑自己的内容、整理、标签、提醒、关联和合并后的原卡。
 * 页面中的请求标识、账号快照和 alive 状态用于拦截过期回包；不能仅因离开页面就删除另一份新草稿。
 */
const api = require("../../utils/api");
const auth = require("../../utils/auth");
const gate = require("../../utils/gate");
const { view, TYPES, KIND_TYPE, shortDate, tagView, REMIND_EVERY } = require("../../utils/cards");
const { markBlocks } = require("../../utils/blocks");
const { cards: exampleCards } = require("../../utils/examples");
const { openChat, chatAboutCard } = require("../../utils/chat-entry");
const { stamp, beijingDay, dueText } = require("../../utils/format");
const { clientId } = require("../../utils/stream");
const studyClock = require("../../utils/study-clock");

const owner = () => (auth.getUser() || {}).id || "";
const toast = (title) => wx.showToast({ title, icon: "none" });
// Short spoken labels for the editor; the detail view shows slot text only.
const EDIT_LABELS = {
  seed: "关键",
  expand: "还能往哪想",
  claim: "我认为",
  why: "因为",
  ask: "想问的",
  known: "已经知道的",
  stuck: "卡在",
  cause: "错在",
  when: "什么时候用",
  steps: "步骤",
  example: "例子",
  pitfall: "容易错",
};
const NO_POINT = "不放进知识点";
const SOME_POINT = "一个知识点";
const TYPE_KEYS = {
  spark: ["seed", "expand"],
  idea: ["claim", "why"],
  question: ["ask", "known", "stuck", "cause"],
  method: ["when", "steps", "example", "pitfall"],
};
// the seven kinds; a kind's slots are its four-way type's.
const familyKeys = (kind) => TYPE_KEYS[KIND_TYPE[kind] || kind] || TYPE_KEYS.idea;
const TYPE_CHOICES = Object.keys(TYPES).map((id) => ({
  id,
  name: TYPES[id].name,
  mark: TYPES[id].mark,
}));
const SCENE_CHOICES = [
  { id: "study", name: "学习" },
  { id: "life", name: "生活" },
];
// 之后 : what happens after saving. 不提醒 also stops my own date.
const FOLLOW_CHOICES = [
  { id: "review", name: "回顾" },
  { id: "done", name: "问我做了没" },
  { id: "chat", name: "接着聊" },
  { id: "none", name: "不提醒" },
];
const VERSION_NAMES = {
  create: "记下",
  edit: "改了标题或摘要",
  slots: "改了 AI 理的那部分",
  type: "换了种类",
  tags: "改了标签",
  mine: "改了我的话",
  close: "想明白了，收好",
  followup: "回答了它的问题",
  link: "连上了另一张卡",
  supplement: "补充了一句",
};

// The steps (15-card) in the kind's own words (V4.2, no percentage): the
// last word is the kind's (长成 / 落地 / 解决 / 用上 / 记住). Mood cards stop
// at 说清; a 待办 is 记下 then 做完; a 随手记 has no steps. The stage is the
// wall's (utils/cards stage, V4.2 FX5c): an AI tidy counts as 整理 on both.
function progressFor(card) {
  const mood = card.scene === "mood";
  if (card.kind === "note" && !mood) return { next: "", steps: [] };
  if (card.kind === "todo" && !mood)
    return {
      next: card.done ? "" : "下一步：做完了点“更多”里的“做完了”",
      steps: [
        { name: "记下", on: true },
        { name: "做完", on: card.done },
      ],
    };
  const order = ["written", "organized", "clear", "closed"];
  const at = order.indexOf(card.stage);
  const names = ["记下", "整理", "说清", card.closeName || "完成"].slice(
    0,
    mood ? 3 : 4,
  );
  const next = {
    written: "下一步：整理一下",
    organized: "下一步：用自己的话说一句",
    clear: mood ? "" : `下一步：确认已经${card.closeName || "完成"}`,
    closed: "",
  }[order[at]];
  return {
    next: next || "",
    steps: names.map((name, index) => ({ name, on: index <= at })),
  };
}
// 整理 rows drawn with their colour marks: slotsMarked from v4 servers,
// plain slots from older ones.
function tidyRows(card) {
  const marked = new Map(
    (card.slotsMarked || []).map((slot) => [slot.key, slot.text]),
  );
  return (card.slots || [])
    .filter((slot) => slot && String(slot.text || "").trim())
    .map((slot) => ({
      key: slot.key,
      label: EDIT_LABELS[slot.key] || "",
      ai: slot.by !== "user",
      blocks: markBlocks(marked.get(slot.key) || slot.text),
    }));
}
function editorFor(card) {
  const current = new Map((card.slots || []).map((slot) => [slot.key, slot]));
  return {
    title: card.title || "",
    summary: card.summary || "",
    type: card.type || "idea",
    kind: card.kind || card.type || "idea",
    scene: card.scene || "life",
    slots: familyKeys(card.kind || card.type).map((key) => ({
      key,
      label: EDIT_LABELS[key],
      text: (current.get(key) || {}).text || "",
    })),
    open: (card.open || []).map((item) => ({
      ...item,
      catName: item.cat === "verify" ? "要核实" : "要决定",
    })),
    nextIf: (card.next && card.next.if) || "",
    nextThen: (card.next && card.next.then) || "",
    nextOn: (card.next && card.next.on) || "",
    pointId: card.pointId || "",
  };
}
// What the editor would send for this card, to send only what changed.
function editValues(editor) {
  const open = editor.open
    .filter((item) => item.text.trim())
    .map((item) => ({
      key: item.key,
      cat: item.cat,
      text: item.text.trim(),
      ...(item.quote ? { quote: item.quote } : {}),
    }));
  const slots = editor.slots
    .filter((item) => item.text.trim())
    .map((item) => ({ key: item.key, text: item.text.trim() }));
  const hasNext =
    editor.nextIf.trim() || editor.nextThen.trim() || editor.nextOn;
  return {
    title: editor.title.trim(),
    summary: editor.summary.trim() || null,
    kind: editor.kind,
    scene: editor.scene,
    slots,
    open,
    next: hasNext
      ? {
          if: editor.nextIf.trim(),
          then: editor.nextThen.trim(),
          on: editor.nextOn || null,
        }
      : null,
    pointId: editor.pointId || null,
  };
}
function versionText(version) {
  const data = version.data || {};
  if (version.kind === "mine")
    return data.text ? `我的话：${data.text}` : "删掉了我的话";
  if (version.kind === "supplement") return data.text || "补充了一句";
  if (version.kind === "close")
    return data.text ? `想明白了：${data.text}` : "想明白了，收好";
  if (version.kind === "followup")
    return (
      data.text ||
      (data.action === "thinking"
        ? "再想想"
        : data.action === "done"
          ? "想到了"
          : "回答了它的问题")
    );
  return VERSION_NAMES[version.kind] || version.kind;
}
// The AI follow-up stays on the card after it is answered (the server keeps
// the last tidy result), so it counts as answered once a newer user answer
// exists. Versions arrive newest first.
function followupAnswered(versions) {
  for (const item of versions || []) {
    const data = item.data || {};
    if (item.by === "ai" && item.kind === "slots") return false;
    if (
      item.kind === "followup" &&
      data.kind === "followup" &&
      data.action === "answer"
    )
      return true;
  }
  return false;
}
// What the card asks back: open items first, then the AI follow-up.
function asksFor(card, base) {
  const asks = (card.open || []).map((item) => ({
    id: item.key,
    kind: "open",
    key: item.key,
    text: item.text,
    ai: item.by !== "user",
    options: [],
  }));
  if (base.followup && !followupAnswered(base.versions))
    asks.push({
      id: "followup",
      kind: "followup",
      key: "",
      text: base.followup.q,
      ai: true,
      options: base.followup.options || [],
    });
  return asks;
}

Page(withShare(studyClock.track({
    data: {
      guestBlocked: false,
      linksOpen: false,
      card: null,
      detail: null,
      loading: false,
      busy: false,
      error: "",
      notice: "",
      example: false,
      mineDraft: "",
      mineDirty: false,
      edit: false,
      editor: null,
      answerDrafts: {},
      answering: "",
      asksOpen: false,
      mineEditing: false,
      infoOpen: false,
      editMore: false,
      closeOpen: false,
      closeDraft: "",
      pickedCards: [],
      tags: [],
      tagOptions: [],
      tagPanel: false,
      points: [{ id: "", name: NO_POINT }],
      types: TYPE_CHOICES,
      scenes: SCENE_CHOICES,
      follows: FOLLOW_CHOICES,
      askAt: 0,
      original: false,
      mergedOpen: false,
      timelineOpen: false,
      supplementOpen: false,
      supplementDraft: "",
      today: "",
      lastDay: "",
    },
    onLoad(query) {
      this.id = query.id || "";
      // A merged original opens read-only from the merged card.
      this.original = query.merged === "1";
      this.exampleId =
        query.example || (this.id.startsWith("example-") ? this.id : "");
      if (this.exampleId) this.id = this.exampleId;
    },
    // 学习时长 : only a study card is study time; life and mood are not.
    studyOff() {
      return !(this.data.card && this.data.card.scene === "study");
    },
    onShow() {
      if (!gate.check()) return;
      // A guest only sees the example cards; anything else needs an account.
      if (gate.state() !== "ok" && !this.exampleId) {
        this.setData({ guestBlocked: true });
        return;
      }
      this.alive = true;
      this.epoch = (this.epoch || 0) + 1;
      this.remindRange();
      const current = owner();
      if (this.account && current !== this.account) this.clearOwner();
      if (current) this.account = current;
      // Work started before the page was hidden was cancelled with its epoch.
      if (this.data.busy) this.setData({ busy: false });
      if (this.exampleId) {
        this.showExample();
        return;
      }
      this.load(Boolean(this.data.card)).then(() => this.consumePicked());
      this.loadExtras();
    },
    onHide() {
      this.alive = false;
      this.epoch = (this.epoch || 0) + 1;
      this.loadSeq = (this.loadSeq || 0) + 1;
    },
    onUnload() {
      this.onHide();
    },
    active(epoch, account) {
      if (!this.alive || epoch !== this.epoch) return false;
      const current = owner();
      if (account && current !== account) return false;
      if (this.account && current && current !== this.account) return false;
      return true;
    },
    clearOwner() {
      this.setData({
        card: null,
        detail: null,
        pickedCards: [],
        mineDraft: "",
        mineDirty: false,
        answerDrafts: {},
        answering: "",
        mineEditing: false,
        edit: false,
        error: "换了账号，退出这页再进来",
      });
    },
    showExample() {
      const example = exampleCards.find((card) => card.id === this.exampleId);
      if (!example)
        return this.setData({
          example: true,
          error: "这张示例找不到了",
          loading: false,
        });
      this.applyDetail(example, false);
      this.setData({
        example: true,
        notice: "示例卡，随便点点，改了不会存",
      });
    },
    applyDetail(raw, preserveDrafts) {
      const base = raw.card ? { ...raw, ...raw.card } : raw,
        card = view(base),
        answerDrafts = preserveDrafts ? this.data.answerDrafts || {} : {};
      const versions = (base.versions || []).map((item) => ({
        ...item,
        date: shortDate(item.createdAt || item.created_at),
        label: VERSION_NAMES[item.kind] || item.kind,
        text: versionText(item),
      }));
      const mineVersions = versions.filter(
        (item) => item.kind === "mine" && item.data && item.data.text,
      );
      const previousMine = mineVersions.length > 1 ? mineVersions[1] : null;
      const points = this.data.points || [],
        point = points.find((item) => item.id === card.pointId);
      const tidied = Boolean(
        card.summary || (card.slots && card.slots.length) || card.next,
      );
      const asks = asksFor(card, base);
      const job = base.aiJob;
      const detail = {
        ...base,
        versions,
        links: (base.links || []).map(view),
        slotsView: (card.slots || []).map((slot) => ({
          ...slot,
          ai: slot.by !== "user",
        })),
        tidyRows: tidyRows(card),
        summaryBlocks: markBlocks(card.summary || ""),
        progress: progressFor(card),
        asks,
        // 整理 failed or was lost: said where it shows, with 再理一遍.
        tidyFailed: Boolean(job && ["failed", "unknown"].includes(job.status)),
        // 合并 : the cards this one was made from, read-only.
        mergedFrom: (base.mergedFrom || []).map(view),
        // 之后: the follow-up mode; 不提醒 also when reminders are off.
        follow: card.resume === "off" ? "none" : card.follow || "",
        sourceName: card.sourceName,
        quoteDate: shortDate(card.quoteOn || card.createdAt),
        mineDate: (mineVersions[0] && mineVersions[0].date) || "",
        mineChanges: Math.max(0, mineVersions.length - 1),
        previousMine,
        pointName: (point && point.name) || (card.pointId ? SOME_POINT : ""),
        relatedCount: (base.links || []).length,
        useCount: Number(base.useCount ?? (base.uses || []).length),
        hasTidy: tidied,
        retestText: this.retestText(base.retest),
        learning:
          card.scene === "study" &&
          (card.pointId || card.mistakeId) &&
          ["question", "method"].includes(card.type),
        learningProofId: base.learningProofId,
        // with the AI words a type change or a merge moved here
        // (a detail drawn again already holds them).
        supplements: (base.supplements || [])
          .filter((item) => !item.ai)
          .map((item) => ({ ...item, ai: false }))
          .concat((base.aiSupplements || []).map((item) => ({ ...item, ai: true })))
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
          .map((item) => ({ ...item, date: shortDate(item.createdAt) })),
        savedAt: stamp(card.createdAt),
        remindOn: card.remindOn || base.nextResumeOn || "",
        remindEvery: card.remindEvery || "",
        remindText: card.remindEvery
          ? `${REMIND_EVERY[card.remindEvery] || ""}${card.remindOn ? " · " + dueText(card.remindOn) : ""}`
          : dueText(card.remindOn || base.nextResumeOn) || "不提醒",
      };
      const tagIds = card.tags.map((tag) => tag.id);
      const editor = editorFor(card);
      editor.pointName =
        (point && point.name) || (card.pointId ? SOME_POINT : NO_POINT);
      this.setData({
        card,
        detail,
        answerDrafts,
        loading: false,
        error: "",
        mineDraft:
          preserveDrafts && this.data.mineDirty
            ? this.data.mineDraft
            : card.mine || "",
        tagOptions: this.tagOptions(this.data.tags, tagIds),
        editor: this.data.edit ? this.data.editor : editor,
        askAt: Math.min(this.data.askAt, Math.max(0, asks.length - 1)),
        ...(this.original
          ? { example: true, original: true, notice: "合并前的原卡，只能看" }
          : {}),
      });
      // A new card's tags and summary arrive from the automatic tidy job;
      // follow it so they appear without leaving the page.
      if (!this.exampleId && api.pending(base.aiJob) && !this.data.busy)
        this.watchTidy(base.aiJob);
    },
    retestText(retest) {
      if (!retest || retest.state === "dropped") return "";
      const date = shortDate(
        retest.done_at ||
          retest.due_on ||
          retest.created_at ||
          retest.createdAt,
      );
      const when = date ? `${date} ` : "";
      if (!retest.result) return `${when}换道题再试一次`;
      const predicted = {
          yes: "能做出来",
          unsure: "没把握",
          no: "做不出来",
        }[retest.predicted],
        actual =
          {
            right: "做对了",
            wrong: "没做出来",
            hinted: "看过提示才做出来",
            early: "提前练了一次",
          }[retest.result] || "还没做完";
      return `${when}换道题再试了一次：${predicted ? `你觉得${predicted}，` : ""}结果${actual}`;
    },
    load(preserveDrafts = true) {
      if (!this.id || this.exampleId) return Promise.resolve();
      const epoch = this.epoch,
        account = this.account || owner(),
        seq = (this.loadSeq || 0) + 1;
      this.loadSeq = seq;
      this.setData({ loading: true, error: "" });
      return api
        .get(
          `/v1/cards/${encodeURIComponent(this.id)}${this.original ? "?merged=1" : ""}`,
        )
        .then((detail) => {
          if (!this.active(epoch, account) || seq !== this.loadSeq) return;
          if (!this.account && owner()) this.account = owner();
          this.applyDetail(detail, preserveDrafts);
        })
        .catch((error) => {
          if (
            this.active(epoch, account) &&
            seq === this.loadSeq &&
            !api.needsConsent(error)
          )
            this.setData({ error: error.message || "没打开，再试一次" });
        })
        .finally(() => {
          if (this.active(epoch, account) && seq === this.loadSeq)
            this.setData({ loading: false });
        });
    },
    loadExtras() {
      const epoch = this.epoch,
        account = this.account || owner();
      api
        .get("/v1/tags")
        .then((tags) => {
          if (!this.active(epoch, account)) return;
          const list = (tags || []).map(tagView),
            ids = ((this.data.card && this.data.card.tags) || []).map(
              (tag) => tag.id,
            );
          this.setData({ tags: list, tagOptions: this.tagOptions(list, ids) });
        })
        .catch((error) => {
          if (this.active(epoch, account) && !api.needsConsent(error))
            this.setData({ notice: "标签没加载出来，等会儿再试" });
        });
      api
        .get("/v1/learn/map")
        .then((map) => {
          if (!this.active(epoch, account)) return;
          const points = [{ id: "", name: NO_POINT }];
          (map.chapters || []).forEach((chapter) =>
            (chapter.points || []).forEach((point) =>
              points.push({
                id: point.id,
                name: point.name || point.label || point.id,
              }),
            ),
          );
          this.setData({ points });
          if (this.data.card) this.applyDetail(this.data.detail, true);
        })
        .catch(() => {});
    },
    tagOptions(tags, selectedIds) {
      const selected = new Set(selectedIds || []);
      return (tags || []).map((tag) => ({
        ...tag,
        selected: selected.has(tag.id),
      }));
    },
    mutate(work, options = {}) {
      const card = this.data.card;
      if (!card || this.data.busy || this.data.example)
        return Promise.resolve();
      const epoch = this.epoch,
        account = this.account || owner();
      this.setData({ busy: true, error: "", notice: "" });
      return work(card)
        .then((result) => {
          if (!this.active(epoch, account)) return;
          if (result && result.crisis) {
            wx.navigateTo({ url: "/pages/crisis/index" });
            return;
          }
          return this.load(true).then(() => {
            if (this.active(epoch, account) && options.success)
              options.success(result);
          });
        })
        .catch((error) => {
          if (!this.active(epoch, account) || api.needsConsent(error)) return;
          const message =
            error.code === "CARD_CHANGED"
              ? "这张卡刚有变化，已经刷新了；你写的还在。"
              : error.message || options.failure || "没存上，再点一次";
          if (error.code === "CARD_CHANGED")
            return this.load(true).then(() => {
              if (this.active(epoch, account)) this.setData({ error: message });
            });
          this.setData({ error: message });
        })
        .finally(() => {
          // Clearing a neutral spinner is safe when the session expired while
          // this page stayed open; owner-bound card data still uses active.
          if (this.alive && this.epoch === epoch) this.setData({ busy: false });
        });
    },
    editMine() {
      if (this.data.example) return;
      this.setData({
        mineEditing: true,
        mineDraft: this.data.mineDirty
          ? this.data.mineDraft
          : (this.data.card && this.data.card.mine) || "",
        error: "",
      });
    },
    cancelMine() {
      this.setData({
        mineEditing: false,
        mineDirty: false,
        mineDraft: (this.data.card && this.data.card.mine) || "",
        error: "",
      });
    },
    mineInput(event) {
      this.setData({ mineDraft: event.detail.value, mineDirty: true });
    },
    saveMineText(text) {
      const value = String(text == null ? this.data.mineDraft : text).trim();
      // a short sentence is enough (“先约分再代入”).
      if (value && value.length < 2) {
        this.setData({ error: "再多写一个字就能存" });
        return Promise.resolve();
      }
      return this.mutate(
        (card) =>
          api.post(`/v1/cards/${encodeURIComponent(this.id)}/mine`, {
            version: card.version,
            text: value || undefined,
          }),
        {
          success: () => {
            this.setData({ mineDirty: false, mineEditing: false });
            toast(value ? "存好了" : "删掉了");
          },
        },
      );
    },
    saveMine() {
      return this.saveMineText();
    },
    clearMine() {
      const epoch = this.epoch,
        account = this.account || owner();
      wx.showModal({
        title: "删掉这句？",
        content: "以前写的，在“这张卡的变化”里还看得到。",
        success: (result) => {
          if (result.confirm && this.active(epoch, account)) {
            this.setData({ mineDraft: "", mineDirty: true });
            this.saveMineText("");
          }
        },
      });
    },
    toggleTagPanel() {
      if (!this.data.example) this.setData({ tagPanel: !this.data.tagPanel });
    },
    toggleTag(event) {
      const id = event.currentTarget.dataset.id,
        selected = this.data.tagOptions
          .filter((tag) => tag.selected)
          .map((tag) => tag.id),
        index = selected.indexOf(id);
      if (index >= 0) selected.splice(index, 1);
      else if (selected.length < 3) selected.push(id);
      else return toast("最多选 3 个");
      this.setData({ tagOptions: this.tagOptions(this.data.tags, selected) });
      return this.mutate(
        (card) =>
          api.put(`/v1/cards/${encodeURIComponent(this.id)}/tags`, {
            version: card.version,
            tagIds: selected,
          }),
        { success: () => this.setData({ tagPanel: false }) },
      );
    },
    manageTags() {
      wx.navigateTo({ url: "/pages/tags/index" });
    },
    openEditor() {
      if (!this.data.example) {
        const editor = editorFor(this.data.card),
          point = this.data.points.find((item) => item.id === editor.pointId);
        editor.pointName =
          (point && point.name) || (editor.pointId ? SOME_POINT : NO_POINT);
        this.setData({ edit: true, editMore: false, editor, error: "" });
      }
    },
    cancelEdit() {
      this.setData({ edit: false, editor: editorFor(this.data.card) });
    },
    toggleEditMore() {
      this.setData({ editMore: !this.data.editMore });
    },
    nextOnChange(event) {
      this.setData({
        editor: { ...this.data.editor, nextOn: event.detail.value },
      });
    },
    clearNextOn() {
      this.setData({ editor: { ...this.data.editor, nextOn: "" } });
    },
    noop() {},
    editInput(event) {
      const editor = {
        ...this.data.editor,
        [event.currentTarget.dataset.key]: event.detail.value,
      };
      this.setData({ editor });
    },
    // a kind; the slots shown are its family's, nothing is wiped.
    editType(event) {
      const kind = event.currentTarget.dataset.type,
        current = new Map(
          (this.data.editor.slots || []).map((slot) => [slot.key, slot.text]),
        );
      this.setData({
        editor: {
          ...this.data.editor,
          kind,
          type: KIND_TYPE[kind] || kind,
          slots: familyKeys(kind).map((key) => ({
            key,
            label: EDIT_LABELS[key],
            text: current.get(key) || "",
          })),
        },
      });
    },
    slotInput(event) {
      const index = Number(event.currentTarget.dataset.index),
        slots = this.data.editor.slots.map((slot, i) =>
          i === index ? { ...slot, text: event.detail.value } : slot,
        );
      this.setData({ editor: { ...this.data.editor, slots } });
    },
    openInput(event) {
      const index = Number(event.currentTarget.dataset.index),
        open = this.data.editor.open.map((item, i) =>
          i === index ? { ...item, text: event.detail.value } : item,
        );
      this.setData({ editor: { ...this.data.editor, open } });
    },
    openCat(event) {
      const index = Number(event.currentTarget.dataset.index),
        cat = event.currentTarget.dataset.cat,
        open = this.data.editor.open.map((item, i) =>
          i === index
            ? { ...item, cat, catName: cat === "verify" ? "要核实" : "要决定" }
            : item,
        );
      this.setData({ editor: { ...this.data.editor, open } });
    },
    addOpen() {
      if (this.data.editor.open.length >= 3) return;
      const open = this.data.editor.open.concat({
        key: `user-${Date.now()}`,
        cat: "decide",
        catName: "要决定",
        text: "",
      });
      this.setData({ editor: { ...this.data.editor, open } });
    },
    removeOpen(event) {
      const index = Number(event.currentTarget.dataset.index),
        open = this.data.editor.open.filter((_, i) => i !== index);
      this.setData({ editor: { ...this.data.editor, open } });
    },
    pointChange(event) {
      const point =
        this.data.points[Number(event.detail.value)] || this.data.points[0];
      this.setData({
        editor: {
          ...this.data.editor,
          pointId: point.id,
          pointName: point.name,
        },
      });
    },
    sceneChange(event) {
      this.setData({
        editor: { ...this.data.editor, scene: event.currentTarget.dataset.scene },
      });
    },
    // Only the fields that changed are sent, so an untouched AI tidy
    // stays the AI's and is refreshed by the next 再理一遍.
    saveEdit() {
      const editor = this.data.editor,
        hasNext =
          editor.nextIf.trim() || editor.nextThen.trim() || editor.nextOn;
      if (hasNext && (!editor.nextIf.trim() || !editor.nextThen.trim())) {
        this.setData({ error: "“如果”和“就”都写上，或者都空着" });
        return;
      }
      const card = this.data.card,
        now = editValues(editor),
        was = editValues(editorFor(card)),
        patch = {};
      for (const key of Object.keys(now))
        if (JSON.stringify(now[key]) !== JSON.stringify(was[key]))
          patch[key] = now[key];
      // Slots of an earlier kind that the editor does not show are kept.
      if (patch.slots) {
        const shown = new Set(editor.slots.map((slot) => slot.key));
        patch.slots = patch.slots.concat(
          (card.slots || [])
            .filter((slot) => !shown.has(slot.key) && String(slot.text || "").trim())
            .map((slot) => ({ key: slot.key, text: slot.text })),
        );
      }
      if (!Object.keys(patch).length) {
        this.setData({ edit: false, editMore: false });
        return;
      }
      return this.mutate(
        (current) =>
          api.patch(`/v1/cards/${encodeURIComponent(this.id)}`, {
            version: current.version,
            ...patch,
          }),
        {
          success: () => {
            this.setData({ edit: false, editMore: false });
            toast("改好了");
          },
        },
      );
    },
    // 之后 : 回顾 / 问我做了没 / 接着聊 turn reminders on in that mode;
    // 不提醒 stops them all, my own date too.
    setFollow(event) {
      const follow = event.currentTarget.dataset.follow;
      if (!follow || follow === this.data.detail.follow) return;
      return this.mutate(
        (card) =>
          api.patch(`/v1/cards/${encodeURIComponent(this.id)}`, {
            version: card.version,
            follow,
            ...(follow === "none"
              ? { resume: "off", remindOn: null, remindEvery: null }
              : card.resume === "off"
                ? { resume: "on" }
                : {}),
          }),
        { success: () => toast(follow === "none" ? "不提醒了" : "好") },
      );
    },
    startAnswer(event) {
      if (!this.data.example)
        this.setData({ answering: event.currentTarget.dataset.id, error: "" });
    },
    cancelAnswer() {
      this.setData({ answering: "", error: "" });
    },
    toggleAsks() {
      this.setData({ asksOpen: !this.data.asksOpen });
    },
    answerInput(event) {
      const id = event.currentTarget.dataset.id;
      this.setData({
        answerDrafts: { ...this.data.answerDrafts, [id]: event.detail.value },
      });
    },
    // "想到了" resolves an open item ("done", the sentence is optional) and
    // answers the AI follow-up ("answer", a sentence or one of its options).
    answer(event) {
      const data = event.currentTarget.dataset,
        draftKey = data.kind === "followup" ? "followup" : data.key;
      const text =
        data.text ||
        (data.action === "thinking"
          ? undefined
          : String(this.data.answerDrafts[draftKey] || "").trim() || undefined);
      if (data.action === "answer" && !text) {
        this.setData({
          error:
            data.kind === "followup"
              ? "写一句，或者点一个现成的"
              : "先写一句吧",
        });
        return Promise.resolve();
      }
      const card = this.data.card;
      if (!card || this.data.busy || this.data.example)
        return Promise.resolve();
      const epoch = this.epoch,
        account = this.account || owner();
      this.setData({ busy: true, error: "", notice: "" });
      return api
        .post(`/v1/cards/${encodeURIComponent(this.id)}/answer`, {
          version: card.version,
          kind: data.kind,
          key: data.key || undefined,
          action: data.action,
          text,
        })
        .then((result) => {
          if (!this.active(epoch, account)) return;
          if (result.crisis) {
            wx.navigateTo({ url: "/pages/crisis/index" });
            return;
          }
          const answerDrafts = { ...this.data.answerDrafts, [draftKey]: "" };
          this.setData({ answerDrafts, answering: "" });
          // 下一个 shows the next question, back to the first after the last.
          if (data.action === "thinking") {
            const count = (this.data.detail.asks || []).length;
            this.setData({ askAt: count ? (this.data.askAt + 1) % count : 0 });
          }
          // The server offers this only for "answer"; a resolved open item
          // with the user's own sentence gets the same offer.
          const offer =
            result.offerMine ||
            (data.action === "done" && text && text.length >= 2 && !card.mine);
          return this.load(true).then(() => {
            if (!offer || !text || !this.active(epoch, account)) return;
            wx.showModal({
              title: "存成我的话？",
              content: "这句是你自己的理解，点确定才会存进“我的话”。",
              success: (choice) => {
                if (choice.confirm && this.active(epoch, account)) {
                  this.setData({ mineDraft: text, mineDirty: true });
                  this.saveMineText(text);
                }
              },
            });
          });
        })
        .catch((error) => {
          if (!this.active(epoch, account) || api.needsConsent(error)) return;
          if (error.code === "CARD_CHANGED")
            return this.load(true).then(() => {
              if (this.active(epoch, account))
                this.setData({
                  error: "这张卡刚有变化，已经刷新了；你写的还在。",
                });
            });
          this.setData({ error: error.message || "没存上，再点一次" });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ busy: false });
        });
    },
    tidy() {
      const job = this.data.detail && this.data.detail.aiJob;
      if (api.pending(job)) return this.watchTidy(job);
      if (job && job.status === "unknown") {
        const epoch = this.epoch,
          account = this.account || owner();
        wx.showModal({
          title: "再理一遍？",
          content: api.jobMessage(job),
          confirmText: "再理一遍",
          success: (result) => {
            if (result.confirm && this.active(epoch, account))
              this.runTidy({ retryUnknown: true });
          },
        });
        return;
      }
      return this.runTidy({
        refresh: Boolean(job && job.status === "succeeded"),
      });
    },
    runTidy(options) {
      const card = this.data.card;
      if (!card || this.data.busy || this.data.example)
        return Promise.resolve();
      const epoch = this.epoch,
        account = this.account || owner();
      this.setData({ busy: true, error: "", notice: "在理一理…" });
      return api
        .post(`/v1/cards/${encodeURIComponent(this.id)}/tidy`, {
          version: card.version,
          ...options,
        })
        .then((result) => {
          if (!this.active(epoch, account)) return null;
          return result && result.job
            ? api.waitJob(result.job, () => this.active(epoch, account))
            : null;
        })
        .then((job) => {
          if (!this.active(epoch, account) || !job) return;
          if (job.status !== "succeeded") {
            const message = api.jobMessage(job);
            return this.load(true).then(() => {
              if (this.active(epoch, account))
                this.setData({ error: message, notice: "" });
            });
          }
          return this.load(true).then(() => {
            if (!this.active(epoch, account)) return;
            this.setData({ notice: "" });
            toast("理好了");
          });
        })
        .catch((error) => {
          if (
            !this.active(epoch, account) ||
            error.code === "CANCELLED" ||
            api.needsConsent(error)
          )
            return;
          this.setData({
            error:
              error.code === "JOB_UNKNOWN"
                ? "上次好像没理完，点“再理一遍”再试"
                : error.message || "这次没理好，过会儿再试",
            notice: "",
          });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ busy: false });
        });
    },
    watchTidy(job) {
      if (this.data.busy) return Promise.resolve();
      const epoch = this.epoch,
        account = this.account || owner();
      this.setData({ busy: true, notice: "在理一理…", error: "" });
      return api
        .waitJob(job, () => this.active(epoch, account))
        .then((finalJob) => {
          if (!this.active(epoch, account)) return;
          const message =
            finalJob.status !== "succeeded" ? api.jobMessage(finalJob) : "";
          return this.load(true).then(() => {
            if (!this.active(epoch, account)) return;
            this.setData({ error: message, notice: "" });
            if (!message) toast("理好了");
          });
        })
        .catch((error) => {
          if (
            this.active(epoch, account) &&
            error.code !== "CANCELLED" &&
            !api.needsConsent(error)
          )
            this.setData({
              error: error.message || "这次没理好，过会儿再试",
              notice: "",
            });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ busy: false });
        });
    },
    toggleClose() {
      if (this.data.detail.learning && !this.data.detail.learningProofId) {
        this.setData({
          error: "再自己做对一次相关的题，这张就能收好了",
        });
        return;
      }
      if (!this.data.example)
        this.setData({ closeOpen: !this.data.closeOpen, error: "" });
    },
    closeInput(event) {
      this.setData({ closeDraft: event.detail.value });
    },
    submitClose() {
      const text = this.data.closeDraft.trim();
      const learning = this.data.detail.learning;
      // a short sentence is enough; a 待办 needs none.
      if (
        text.length < 2 &&
        !(learning && this.data.card.mine) &&
        this.data.card.kind !== "todo"
      ) {
        this.setData({ error: "写一句再收好" });
        return;
      }
      return this.mutate(
        (card) =>
          api.post(
            `/v1/cards/${encodeURIComponent(this.id)}/${learning ? "learning-close" : "close"}`,
            {
              version: card.version,
              ...(text ? { text } : {}),
              ...(learning
                ? {
                    proofId: this.data.detail.learningProofId,
                    used: card.type === "method",
                  }
                : {}),
            },
          ),
        {
          success: () => {
            this.setData({ closeOpen: false, closeDraft: "" });
            toast("收好了");
          },
        },
      );
    },
    link() {
      if (this.data.example) return;
      getApp().globalData.cardPick = {
        mode: "link",
        returnTo: "card",
        sourceId: this.id,
      };
      wx.navigateTo({ url: "/pages/card-pick/index" });
    },
    consumePicked() {
      if (!this.data.card || this.data.example || this.data.busy) return;
      const app = getApp(),
        pick = app.globalData.cardPick || {},
        local = this.data.pickedCards || [],
        global = app.globalData.pickedCards || [];
      if (pick.sourceId && pick.sourceId !== this.id && !local.length) return;
      const picked = local.length ? local : global,
        other = picked[0];
      if (!other || other.id === this.id) return;
      return this.mutate(
        (card) =>
          api.post(`/v1/cards/${encodeURIComponent(this.id)}/links`, {
            version: card.version,
            cardId: other.id,
          }),
        {
          success: () => {
            this.setData({ pickedCards: [], infoOpen: true });
            app.globalData.pickedCards = [];
            toast("连上了");
          },
        },
      );
    },
    unlink(event) {
      const otherId = event.currentTarget.dataset.id;
      return this.mutate(
        (card) =>
          api.del(
            `/v1/cards/${encodeURIComponent(this.id)}/links/${encodeURIComponent(otherId)}`,
            { version: card.version },
          ),
        { success: () => toast("不连了") },
      );
    },
    openSupplement() {
      if (this.data.example) return;
      this.supplementId = this.supplementId || clientId();
      this.setData({ supplementOpen: true, error: "" });
    },
    cancelSupplement() {
      this.supplementId = "";
      this.setData({ supplementOpen: false, supplementDraft: "" });
    },
    supplementInput(event) {
      this.setData({ supplementDraft: event.detail.value });
    },
    // One clientId per draft, so a retry after a lost response is not saved twice.
    saveSupplement() {
      const text = this.data.supplementDraft.trim();
      if (!text) {
        this.setData({ error: "写一句再存" });
        return Promise.resolve();
      }
      this.supplementId = this.supplementId || clientId();
      return this.mutate(
        (card) =>
          api.post(`/v1/cards/${encodeURIComponent(this.id)}/supplements`, {
            version: card.version,
            text,
            clientId: this.supplementId,
          }),
        {
          success: () => {
            this.supplementId = "";
            this.setData({ supplementOpen: false, supplementDraft: "" });
            toast("补上了");
          },
        },
      );
    },
    remindRange() {
      this.setData({ today: beijingDay(), lastDay: beijingDay(365) });
    },
    remindChange(event) {
      return this.saveRemind(event.detail.value || null);
    },
    // 不提醒  stops every reminder of this card at once: my date, the
    // repeat and the automatic follow-ups.
    clearRemind() {
      return this.saveRemind(null);
    },
    saveRemind(remindOn) {
      return this.mutate(
        (card) =>
          api.patch(`/v1/cards/${encodeURIComponent(this.id)}`, {
            version: card.version,
            remindOn,
            ...(remindOn ? {} : { resume: "off", remindEvery: null }),
          }),
        { success: () => toast(remindOn ? "到时候提醒你" : "不提醒了") },
      );
    },
    // 每天 / 每周 repeat the reminder (v4); 关掉 stops the repeat and the date.
    // Servers before v4 refuse the field; the date picker still works there.
    saveEvery(event) {
      const every = event.currentTarget.dataset.every || null;
      if (every === (this.data.detail.remindEvery || null)) return;
      return this.mutate(
        (card) =>
          api.patch(`/v1/cards/${encodeURIComponent(this.id)}`, {
            version: card.version,
            remindEvery: every,
          }),
        {
          success: () =>
            toast(every ? `${REMIND_EVERY[every]}提醒你` : "不提醒了"),
        },
      );
    },
    toggleTimeline() {
      this.setData({ timelineOpen: !this.data.timelineOpen });
    },
    toggleInfo() {
      this.setData({ infoOpen: !this.data.infoOpen });
    },
    toggleLinks() {
      this.setData({ linksOpen: !this.data.linksOpen });
    },
    toggleMerged() {
      this.setData({ mergedOpen: !this.data.mergedOpen });
    },
    agree() {
      gate.ask();
    },
    openLinked(event) {
      wx.navigateTo({
        url: `/pages/card/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}`,
      });
    },
    actionItems() {
      const card = this.data.card,
        detail = this.data.detail || {},
        items = [];
      items.push([card.favorite ? "取消收藏" : "收藏", "toggleFavorite"]);
      if (!card.crisis) items.push(["再理一遍", "tidy"]);
      items.push(["改一改", "openEditor"], ["连上另一张卡", "link"]);
      if (card.kind === "todo" && !card.closed) items.push(["做完了", "doneTodo"]);
      else if (
        card.scene !== "mood" &&
        !card.closed &&
        (!detail.learning || detail.learningProofId)
      )
        items.push(["想明白了，收好", "toggleClose"]);
      items.push(["删掉这张", "remove"]);
      return items;
    },
    openActions() {
      if (!this.data.card || this.data.example) return;
      const items = this.actionItems(),
        epoch = this.epoch;
      wx.showActionSheet({
        itemList: items.map((item) => item[0]),
        success: ({ tapIndex }) => {
          const item = items[tapIndex];
          if (item && this.alive && this.epoch === epoch) this[item[1]]();
        },
      });
    },
    // 待办 : done needs no words.
    doneTodo() {
      return this.mutate(
        (card) =>
          api.post(`/v1/cards/${encodeURIComponent(this.id)}/close`, {
            version: card.version,
          }),
        { success: () => toast("做完了") },
      );
    },
    // 合并 : an original opens read-only.
    openOriginal(event) {
      wx.navigateTo({
        url: `/pages/card/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}&merged=1`,
      });
    },
    // 拆开: the originals come back while this card is as the merge made it.
    // Shown only at version 1 : the server refuses an edited one.
    unmerge() {
      if (this.data.example) return;
      const epoch = this.epoch,
        account = this.account || owner();
      wx.showModal({
        title: "拆开这张卡？",
        content: "原来的卡会回来，这张合并的卡会去掉。",
        confirmText: "拆开",
        success: (result) => {
          const card = this.data.card;
          if (!result.confirm || !card || this.data.busy) return;
          if (!this.active(epoch, account)) return;
          this.setData({ busy: true, error: "" });
          api
            .post(`/v1/cards/${encodeURIComponent(this.id)}/unmerge`, {
              version: card.version,
            })
            .then(() => {
              if (!this.active(epoch, account)) return;
              toast("拆开了");
              wx.navigateBack();
            })
            .catch((error) => {
              if (this.active(epoch, account) && !api.needsConsent(error))
                this.setData({ error: error.message || "没拆开，再试一次" });
            })
            .finally(() => {
              if (this.active(epoch, account)) this.setData({ busy: false });
            });
        },
      });
    },
    toggleFavorite() {
      const favorite = !this.data.card.favorite;
      return this.mutate(
        () =>
          api.put(`/v1/cards/${encodeURIComponent(this.id)}/favorite`, {
            favorite,
          }),
        { success: () => toast(favorite ? "收藏了" : "取消收藏了") },
      );
    },
    // 接着聊 goes on with the card's own chat.
    chat() {
      if (!this.data.card || this.data.example) return;
      return chatAboutCard(this.data.card);
    },
    teach() {
      if (
        !this.data.card ||
        this.data.example ||
        this.data.card.scene === "mood"
      )
        return;
      openChat({
        cards: [this.data.card],
        teach: true,
        scene: this.data.card.scene,
      });
    },
    openSource() {
      const card = this.data.card;
      if (!card || this.data.example) return;
      if (card.origin === "chat" && card.srcId)
        return openChat({
          threadId: card.srcId,
          messageId: card.messageId || "",
        });
      if (card.srcId && ["brainstorm", "import"].includes(card.origin))
        return wx.navigateTo({
          url:
            card.origin === "brainstorm"
              ? `/pages/brainstorm/result/index?id=${encodeURIComponent(card.srcId)}`
              : `/pages/import/split/index?id=${encodeURIComponent(card.srcId)}`,
        });
      if (card.pointId && (card.origin === "map" || card.scene === "study"))
        return wx.navigateTo({
          url: `/pages/point/index?id=${encodeURIComponent(card.pointId)}`,
        });
      if (card.origin === "mistake")
        return wx.navigateTo({ url: "/pages/mistakes/index" });
      if (card.origin === "note" && card.srcId)
        return wx.navigateTo({
          url: `/pages/note/index?id=${encodeURIComponent(card.srcId)}`,
        });
      toast("原话都在这张卡里了");
    },
    openPoint() {
      if (this.data.card && this.data.card.pointId)
        wx.navigateTo({
          url: `/pages/map/index?id=${encodeURIComponent(this.data.card.pointId)}`,
        });
    },
    remove() {
      if (this.data.example) return;
      const epoch = this.epoch,
        account = this.account || owner();
      wx.showModal({
        title: "删掉这张卡？",
        content:
          this.data.card && this.data.card.origin === "note"
            ? "这张卡和原来的随心记会一起删掉，删了就找不回来了。"
            : this.data.detail &&
                this.data.detail.mergedFrom &&
                this.data.detail.mergedFrom.length
              ? `合并前的 ${this.data.detail.mergedFrom.length} 张也会一起删掉，删了就找不回来了。`
              : "删了就找不回来了。",
        confirmText: "删掉",
        success: (result) => {
          const current = owner();
          const samePage =
            this.alive &&
            this.epoch === epoch &&
            (!current || !account || current === account) &&
            (!this.account || !current || current === this.account);
          if (!result.confirm || !samePage || this.data.busy) return;
          this.setData({ busy: true, error: "" });
          api
            .del(`/v1/cards/${encodeURIComponent(this.id)}`)
            .then(() => {
              if (this.active(epoch, account)) wx.navigateBack();
            })
            .catch((error) => {
              if (this.active(epoch, account) && !api.needsConsent(error))
                this.setData({ error: error.message || "没删掉，再试一次" });
            })
            .finally(() => {
              if (this.active(epoch, account)) this.setData({ busy: false });
            });
        },
      });
    },
    backHome() {
      wx.switchTab({ url: "/pages/notes/index" });
    },
})));

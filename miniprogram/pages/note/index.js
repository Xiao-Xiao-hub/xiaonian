const { withShare } = require("../../utils/share");
/*
 * 随心记详情：查看原话与补充，发起整理、编辑事项或关联知识点；保留旧笔记访问路径。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const gate = require("../../utils/gate");
const auth = require("../../utils/auth");
const { when, errorText } = require("../../utils/format");
const clock = require("../../utils/clock");
const budgets = require("../../utils/budget");
const owner = () => (auth.getUser() || {}).id || "";
const GROUPS = [
  { id: "clear", name: "想清楚了", hint: "你已经说清楚的" },
  { id: "decide", name: "还没定", hint: "还要你拿主意" },
  { id: "verify", name: "要再查查", hint: "先打个问号，再找依据" },
];
// what is shown follows the content. A record whose items are all
// already clear is plain material: nothing to decide or check, so no
// follow-up question and no next step are pushed on it.
const followUp = (result) => Boolean(result && !(result.items.length && result.items.every((item) => item.group === "clear")));
const clientId = () => `supplement-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
function noteError(error) {
  switch (error && error.code) {
    case "AI_NOT_CONFIGURED": return "现在理不了，想到的先写下来，过会儿再试。";
    // the server says which allowance ran out and when it comes back.
    case "DAILY_LIMIT": return `${/额度|恢复/.test((error && error.message) || "") ? error.message : "额度用完了"}；想到的先写下来。`;
    case "NETWORK": return "网络不太顺，过会儿再试。";
    case "TIMEOUT": return "这次等得有点久，先点“看看进展”，不用重新发起。";
    default: return errorText(error);
  }
}
// while it runs, the job's real state and the time it has taken.
function waited(job) {
  const seconds = Math.max(0, Math.floor((clock.now() - (Date.parse(job.createdAt) || clock.now())) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分钟`;
}
function jobText(job) {
  if (!job) return "";
  if (api.pending(job))
    return `${job.status === "queued" ? "排着队" : "正在理"}，等了 ${waited(job)}。原话存好了，可以先离开，回来再看。`;
  if (job.status === "unknown") return "上次好像没理完，你写的都还在。要再试一次吗？";
  if (job.status === "failed") return "这次没理完，你写的都还在。" + api.jobMessage(job);
  return "";
}
Page(withShare({
  data: {
    note: null, title: "", editing: false, loading: false, busy: false,
    error: "", editError: "", when: "", groups: [], supplement: "", supplementError: "",
    itemEditor: null, itemError: "", groupNames: GROUPS.map((group) => group.name),
    usage: null, usageLow: "", jobText: "", organizing: false, conflict: false, readOnly: false,
    context: null, linkedPoint: null, suggestedPoint: null, notice: "", followUp: false,
  },
  onLoad(query) {
    this.id = query.id;
    // Only with the mark an in-app tap leaves: a link from another mini program
    // cannot start a paid organize on someone's note.
    const app = typeof getApp === "function" ? getApp() : null;
    this.autoOrganize = query.organize === "1" && Boolean(app && app.globalData.noteOrganize === query.id);
    if (app) delete app.globalData.noteOrganize;
    if (query.pointId) this.setData({ context: { pointId: query.pointId, name: query.pointName || "这个知识点" } });
  },
  onShow() {
    if (!gate.check()) return;
    // A guest has nothing here: offer the welcome page, send nothing.
    if (gate.state() !== "ok") return gate.ask({ leave: true });
    this.alive = true;
    this.epoch = (this.epoch || 0) + 1;
    const account = owner();
    if (this.owner && account && this.owner !== account) this.clearIdentity();
    this.setData({ busy: false });
    return this.load().then(() => {
      if (this.autoOrganize && this.data.note && this.alive && !this.data.error) {
        this.autoOrganize = false;
        if (!this.data.note.aiJob && !this.data.note.result) return this.runOrganize(false);
      }
    });
  },
  onHide() { this.alive = false; this.epoch = (this.epoch || 0) + 1; this.stopWatch(); },
  onUnload() { this.closed = true; this.onHide(); },
  clearIdentity() {
    this.autoOrganize = false;
    this.pendingSupplement = null;
    this.points = null;
    this.stopWatch();
    this.setData({ note: null, title: "", editing: false, supplement: "", itemEditor: null, context: null, linkedPoint: null, suggestedPoint: null, groups: [], usage: null, usageLow: "", jobText: "", organizing: false, notice: "", error: "换了账号，重新打开这张卡看看。" });
  },
  active(epoch, account) {
    if (!this.alive || this.closed || epoch !== this.epoch || !auth.hasConsent()) return false;
    if (account && owner() && account !== owner()) { this.clearIdentity(); return false; }
    return true;
  },
  url(suffix = "") { return `/v1/notes/${encodeURIComponent(this.id || "")}${suffix}`; },
  applyNote(note) {
    const point = (id) => id && this.points && this.points.find((item) => item.id === id);
    const suggested = this.data.context ? this.data.context.pointId : note.result && note.result.nextStep.pointId;
    this.setData({
      note, when: when(note.createdAt),
      ...(this.data.editing ? {} : { title: note.title }),
      groups: GROUPS.map((group) => ({ ...group, items: note.result ? note.result.items.filter((item) => item.group === group.id) : [] })),
      followUp: followUp(note.result),
      readOnly: note.readOnly === true,
      jobText: jobText(note.aiJob), organizing: api.pending(note.aiJob),
      linkedPoint: point(note.pointId) || (note.pointId ? { id: note.pointId, name: "已关联知识点" } : null),
      suggestedPoint: suggested && suggested !== note.pointId ? point(suggested) || (this.data.context ? { id: suggested, name: this.data.context.name } : null) : null,
    });
  },
  load() {
    const seq = this.loadSeq = (this.loadSeq || 0) + 1;
    const epoch = this.epoch;
    const account = this.owner || owner();
    if (!auth.hasConsent()) { this.clearIdentity(); api.needsConsent({ code: "CONSENT_REQUIRED" }); return Promise.resolve(); }
    if (!this.active(epoch, account)) return Promise.resolve();
    this.setData({ loading: true, error: "" });
    return api.get(this.url()).then((note) => {
      if (!this.active(epoch, account) || seq !== this.loadSeq) return;
      this.owner = owner();
      this.setData({ conflict: false });
      this.applyNote(note);
      this.loadExtras();
      this.watch(note.aiJob);
    }).catch((error) => {
      if (this.active(epoch, account) && seq === this.loadSeq && !api.needsConsent(error)) this.setData({ error: noteError(error) });
    }).finally(() => {
      if (this.active(epoch, account) && seq === this.loadSeq) this.setData({ loading: false });
    });
  },
  loadExtras() {
    const epoch = this.epoch, account = this.owner;
    api.get("/v1/me/usage").then((usage) => {
      if (!this.active(epoch, account)) return;
      const notes = usage.notes || null;
      if (budgets.valid(usage.budget)) return this.setData({ usage: notes, usageLow: budgets.low(usage.budget) });
      // Only near the daily limit is the count worth a line.
      const left = notes ? Math.max(0, notes.limit - notes.used) : Infinity;
      this.setData({ usage: notes, usageLow: left === 0 ? "今天的次数用完了，明天再来" : left === 1 ? "今天还能理 1 次" : "" });
    }).catch(() => {});
    if (!this.points) api.get("/v1/learn/map").then((map) => {
      if (!this.active(epoch, account)) return;
      this.points = map.chapters.flatMap((chapter) => chapter.points.map((point) => ({ id: point.id, name: point.name })));
      if (this.data.note) this.applyNote(this.data.note);
    }).catch(() => {});
  },
  stopWatch() { this.pollSeq = (this.pollSeq || 0) + 1; if (this.pollTimer) clearTimeout(this.pollTimer); this.pollTimer = null; if (this.tickTimer) clearInterval(this.tickTimer); this.tickTimer = null; },
  watch(job) {
    this.stopWatch();
    if (!api.pending(job)) return;
    const seq = this.pollSeq, epoch = this.epoch, account = this.owner, started = Date.now();
    const alive = () => seq === this.pollSeq && this.active(epoch, account);
    let shown = job;
    // The wait line counts up between polls.
    this.tickTimer = setInterval(() => { if (alive()) this.setData({ jobText: jobText(shown) }); }, 1000);
    const poll = () => {
      if (!alive()) return;
      if (Date.now() - started > 150000) { this.stopWatch(); this.setData({ error: "还要一点时间，过会儿点“看看进展”就行，不用重新发起。" }); return; }
      api.get(`/v1/jobs/${encodeURIComponent(job.id)}`).then((current) => {
        if (!alive()) return;
        if (api.pending(current)) {
          shown = current;
          this.setData({ jobText: jobText(current) });
          this.pollTimer = setTimeout(poll, 1500);
        } else return this.load();
      }).catch((error) => {
        if (alive() && !api.needsConsent(error)) this.setData({ error: "暂时看不到进展，原话不会丢。" + noteError(error) });
      });
    };
    this.pollTimer = setTimeout(poll, 1500);
  },
  // A read-only note (old 随心记 after the release switch) can only be read and deleted.
  canMutate() {
    return !this.data.busy && !this.data.loading && this.data.note && this.active(this.epoch, this.owner);
  },
  canWrite() {
    return this.canMutate() && !this.data.readOnly;
  },
  mutate(work, field = "error", after) {
    if (!this.canMutate()) return Promise.resolve();
    const epoch = this.epoch, account = this.owner;
    this.stopWatch();
    this.setData({ busy: true, [field]: "", notice: "" });
    return work().then((note) => {
      if (!this.active(epoch, account)) return;
      this.applyNote(note);
      if (after) after(note);
      this.watch(note.aiJob);
    }).catch((error) => {
      if (!this.active(epoch, account) || api.needsConsent(error)) return;
      if (error.code === "NOTE_CHANGED") {
        if (field === "supplementError") this.pendingSupplement = null;
        this.setData({ conflict: true, [field]: "这张卡有了新内容，先打开最新的再改；你写的还在。" });
      } else this.setData({ [field]: noteError(error) });
      this.watch(this.data.note.aiJob);
    }).finally(() => { if (this.active(epoch, account)) this.setData({ busy: false }); });
  },
  edit() { if (this.canWrite()) this.setData({ editing: true, title: this.data.note.title, editError: "" }); },
  cancelEdit() { if (!this.data.busy) this.setData({ editing: false, editError: "" }); },
  onTitle(event) { this.setData({ title: event.detail.value, editError: "" }); },
  saveTitle() {
    const title = this.data.title.trim();
    if (!title || title.length > 80) { this.setData({ editError: title ? "标题有点长了（80 字以内）" : "先写个标题" }); return Promise.resolve(); }
    return this.mutate(() => api.put(this.url(), { title }), "editError", () => this.setData({ editing: false }));
  },
  onSupplement(event) { if (!this.data.busy) this.setData({ supplement: event.detail.value, supplementError: "" }); },
  chooseAnswer(event) {
    if (!this.canWrite() || !this.data.note.result) return;
    const question = this.data.note.result.question;
    const option = question.options.find((item) => item.id === event.currentTarget.dataset.id);
    if (!option) return;
    const text = `${question.prompt}\n我的选择：${option.text}`;
    const fill = () => this.setData({ supplement: text, supplementError: "", notice: "放进下面的草稿了，改好再存。" });
    if (this.data.supplement.trim()) this.confirm("换掉草稿？", "还没存的内容会换成这段回答。", fill);
    else fill();
  },
  saveSupplement() {
    const note = this.data.note, text = this.data.supplement;
    if (!note) return Promise.resolve();
    if (!text.trim() || text.length > 500) { this.setData({ supplementError: text.trim() ? "有点长了（500 字以内）" : "先写点内容" }); return Promise.resolve(); }
    const retry = this.pendingSupplement && this.pendingSupplement.text === text;
    if (!retry && (note.supplements.length >= 10 || note.text.length + note.supplements.reduce((n, item) => n + item.text.length, 0) + text.length > 6000)) { this.setData({ supplementError: "这张卡写满了，可以另记一张。" }); return Promise.resolve(); }
    if (!this.pendingSupplement || this.pendingSupplement.text !== text) this.pendingSupplement = { revision: note.revision, clientId: clientId(), text };
    const payload = this.pendingSupplement;
    return this.mutate(() => api.post(this.url("/supplements"), payload), "supplementError", () => {
      this.pendingSupplement = null;
      this.setData({ supplement: "", notice: "存好了。想的话，再让 AI 一起理一理。" });
    });
  },
  editItem(event) {
    if (!this.canMutate() || !this.data.note.result) return;
    const item = this.data.note.result.items.find((value) => value.id === event.currentTarget.dataset.id);
    if (item) this.setData({ itemEditor: { ...item, groupIndex: GROUPS.findIndex((group) => group.id === item.group) }, itemError: "" });
  },
  cancelItem() { if (!this.data.busy) this.setData({ itemEditor: null, itemError: "" }); },
  onItemText(event) { if (this.data.itemEditor) this.setData({ "itemEditor.text": event.detail.value, itemError: "" }); },
  onItemGroup(event) {
    const index = Number(event.detail.value);
    if (GROUPS[index] && this.data.itemEditor) this.setData({ "itemEditor.groupIndex": index, "itemEditor.group": GROUPS[index].id });
  },
  saveItem() {
    const note = this.data.note, item = this.data.itemEditor;
    if (!note || !item) return Promise.resolve();
    if (!item.text.trim() || item.text.length > 300) { this.setData({ itemError: item.text.trim() ? "有点长了（300 字以内）" : "先写点内容" }); return Promise.resolve(); }
    return this.mutate(() => api.put(this.url(`/items/${encodeURIComponent(item.id)}`), { revision: note.revision, resultVersion: note.resultVersion, group: item.group, text: item.text }), "itemError", () => this.setData({ itemEditor: null, notice: "改好了。" }));
  },
  removeItem(event) {
    if (!this.canMutate() || !this.data.note.result) return;
    const item = this.data.note.result.items.find((value) => value.id === event.currentTarget.dataset.id);
    if (!item) return;
    this.confirm("删掉这条？", "只删这一条，原话和补充都还在。", () => {
      const note = this.data.note;
      return this.mutate(() => api.del(this.url(`/items/${encodeURIComponent(item.id)}`), { revision: note.revision, resultVersion: note.resultVersion }), "error", () => this.setData({ itemEditor: null }));
    }, "删掉");
  },
  confirm(title, content, action, confirmText = "好") {
    if (this.confirming || !this.canMutate()) return;
    const epoch = this.epoch, account = this.owner;
    this.confirming = true;
    wx.showModal({ title, content, confirmText, success: ({ confirm }) => {
      this.confirming = false;
      if (confirm && this.active(epoch, account)) action();
    }, fail: () => { this.confirming = false; } });
  },
  organize() { return this.requestOrganize(false); },
  refresh() { return this.requestOrganize(true); },
  retryOrganize() { return this.requestOrganize(Boolean(this.data.note && this.data.note.result && !this.data.note.resultStale)); },
  requestOrganize(refresh) {
    if (!this.canWrite() || this.data.organizing) return Promise.resolve();
    const unknown = Boolean(this.data.note.aiJob && this.data.note.aiJob.status === "unknown");
    if (refresh || unknown) {
      const message = [refresh ? "新理的会换掉现在这份，包括你改过的条目；原话、补充、标题和放进的知识点都还在。" : "上次没理完，已有的都还在。", "这次会再用 1 次。"].join("");
      this.confirm(refresh ? "重新理一遍？" : "再试一次？", message, () => this.runOrganize(refresh, unknown));
      return Promise.resolve();
    }
    return this.runOrganize(refresh);
  },
  runOrganize(refresh, retryUnknown = false) {
    if (!this.canMutate() || this.data.organizing) return Promise.resolve();
    const note = this.data.note, epoch = this.epoch, account = this.owner;
    this.setData({ busy: true, error: "", notice: "" });
    return api.post(this.url("/organize"), { revision: note.revision, resultVersion: note.resultVersion, refresh, retryUnknown }).then(() => {
      if (this.active(epoch, account)) return this.load();
    }).catch((error) => {
      if (!this.active(epoch, account) || api.needsConsent(error)) return;
      this.setData({ error: error.code === "NOTE_CHANGED" ? "这张卡有了新内容，先打开最新的再理。" : `原话存好了，这次没理完。${noteError(error)}`, conflict: error.code === "NOTE_CHANGED" });
    }).finally(() => { if (this.active(epoch, account)) { this.setData({ busy: false }); this.loadExtras(); } });
  },
  linkPoint() {
    const point = this.data.suggestedPoint;
    if (!point || this.data.readOnly) return;
    this.confirm("放进这个知识点？", `把这张卡放进“${point.name}”，地图进度不会变。`, () => this.mutate(() => api.put(this.url("/point"), { pointId: point.id, confirm: true }), "error", () => this.setData({ context: null, suggestedPoint: null, notice: "放进去了。" })));
  },
  unlinkPoint() {
    if (this.data.readOnly) return;
    this.confirm("不放了？", "只是拿出来，原话和整理都还在。", () => this.mutate(() => api.put(this.url("/point"), { pointId: null, confirm: true })));
  },
  dismissContext() { if (!this.data.busy) { this.setData({ context: null }); this.applyNote(this.data.note); } },
  openPoint() { if (this.data.linkedPoint) wx.navigateTo({ url: `/pages/point/index?id=${encodeURIComponent(this.data.linkedPoint.id)}` }); },
  remove() {
    this.confirm("删掉这张卡？", "原话、补充和整理会一起删掉，删了就找不回来了；正在理的那一次可能停不下来。", () => this.deleteNote(), "删掉");
  },
  // Title, a fresh organize and delete sit behind ⋯.
  openMore() {
    const note = this.data.note;
    if (!note || this.data.busy || this.data.loading) return;
    const actions = this.data.readOnly ? [] : [["改标题", "edit"]];
    if (!this.data.readOnly && note.result && !note.resultStale && !this.data.organizing && !this.data.conflict) actions.push(["让 AI 再理一遍", "refresh"]);
    actions.push(["删掉这张卡", "remove"]);
    wx.showActionSheet({
      itemList: actions.map((a) => a[0]),
      success: ({ tapIndex }) => actions[tapIndex] && this[actions[tapIndex][1]](),
    });
  },
  // Tapping an organized item offers to change or drop it.
  itemMenu(event) {
    if (!this.canWrite() || (this.data.itemEditor && this.data.itemEditor.id === event.currentTarget.dataset.id)) return;
    wx.showActionSheet({
      itemList: ["改一改", "删掉这条"],
      success: ({ tapIndex }) => (tapIndex === 0 ? this.editItem(event) : this.removeItem(event)),
    });
  },
  loadLatest() {
    if (!this.data.busy && !this.data.loading) this.load();
  },
  noop() {},
  deleteNote() {
    if (!this.canMutate()) return Promise.resolve();
    const epoch = this.epoch, account = this.owner;
    this.stopWatch();
    this.loadSeq = (this.loadSeq || 0) + 1;
    this.setData({ busy: true, error: "" });
    return api.del(this.url()).then(() => {
      if (this.active(epoch, account)) wx.switchTab({ url: "/pages/notes/index" });
    }).catch((error) => {
      if (this.active(epoch, account) && !api.needsConsent(error)) { this.setData({ error: noteError(error) }); this.watch(this.data.note.aiJob); }
    }).finally(() => { if (this.active(epoch, account)) this.setData({ busy: false }); });
  },
}));

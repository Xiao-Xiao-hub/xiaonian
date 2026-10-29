const { withShare } = require("../../utils/share");
/*
 * 统一批改页：接收草稿或整页照片，确认输入后批改，允许逐题重试并重新打开历史。
 * 页面中的请求标识、账号快照和 alive 状态用于拦截过期回包；不能仅因离开页面就删除另一份新草稿。
 */
// 批改 : 批改草稿 and 整页作业 in one. A photo (or typing) of what
// the learner wrote is read once (scan purpose "grade"):
//   - one problem and its steps → editable lines, graded step by step
//     (POST /v1/chat/drafts with a clientId: a retry or a return gets the same
//     grading, never a second one);
//   - a page of two or more problems → POST /v1/chat/homework, each problem
//     graded on its own, the list polled while grading.
// ?id= opens a past 批改 (a draft or a page). The start lists past ones,
// unfinished first, and what was typed but not graded yet (kept on this phone).
// pages/draft and pages/homework only redirect here now.
const api = require("../../utils/api");
const auth = require("../../utils/auth");
const studyClock = require("../../utils/study-clock");
const gate = require("../../utils/gate");
const { errorText } = require("../../utils/format");
const { openAsk } = require("../../utils/chat-entry");
const tools = require("../../utils/tools");
const stream = require("../../utils/stream");
const { once } = require("../../utils/tap");
const budgets = require("../../utils/budget");
const { lineTex, lineBlocks } = require("../../utils/tex");
const TONE = "light";
// A page is read up to this many problems (the scan's own limit).
const PAGE_MAX = 6;
// 批改记录 come this many at a time; 更多 asks for the next ones.
const HISTORY_PAGE = 20;
const MARK = {
  ok: { mark: "✓", tone: "green" },
  wrong: { mark: "✗", tone: "red" },
  // After the first error, worked on from its wrong result: not checked again.
  carried: { mark: "–", tone: "grey" },
  unclear: { mark: "?", tone: "amber" },
};
const BADGE = {
  correct: { tone: "green", text: "做对了" },
  wrong: { tone: "red", text: "有错" },
  unsure: { tone: "amber", text: "拿不准" },
  grading: { tone: "violet", text: "正在看…" },
  unclear: { tone: "amber", text: "要你看一眼" },
  failed: { tone: "amber", text: "没看完" },
  hold: { tone: "amber", text: "明天再批" },
};
// the scan and the one-problem check send no stages: their bars
// follow time and show no percentage (vague); a page's grading counts problems.
const SCAN_STEPS = [{ key: "send", label: "传照片" }, { key: "read", label: "认题和过程" }];
const DRAFT_STEPS = [{ key: "read", label: "读过程" }, { key: "check", label: "逐步核对" }];
const PAGE_STEPS = [{ key: "read", label: "认出题目" }, { key: "grade", label: "一道道批改" }];
// A "？" is something the photo did not show: it has to be filled in first.
const UNFILLED = /[？?]/;

function resultOf(message, thread) {
  const d = message.draft;
  const first = d.first;
  const verdict = first ? "wrong" : d.verdict === "correct" ? "correct" : "unsure";
  return {
    messageId: message.id,
    verdict,
    tone: { wrong: "red", correct: "green", unsure: "amber" }[verdict],
    head: first ? `第 ${first.step} 步开始有错` : verdict === "correct" ? "每一步都对" : "有几步拿不准",
    summary: d.summary || "",
    problem: (thread && thread.problem) || [],
    problemText: d.problemText || "",
    imageId: (thread && thread.imageId) || "",
    steps: d.steps.map((s) => {
      // V4.2 FX5b : an old record's ✓ after the first error is carried
      // over (the server says so too; this covers a v4.1 one).
      const status = first && s.no > first.step && s.status === "ok" ? "carried" : s.status;
      return { ...s, status, ...(MARK[status] || MARK.unclear), first: Boolean(first && first.step === s.no) };
    }),
    lines: d.steps.map((s) => s.text || "").filter(Boolean),
    first,
    inBook: Boolean(thread && thread.mistake && thread.mistake.status === "open"),
  };
}
// held by the week's allowance waits until Monday (`holdUntil`).
function holdWhen(item) {
  const until = Date.parse(item.holdUntil || "");
  return until && until - Date.now() > 86400000 ? "下周一再批" : "明天再批";
}
function card(item) {
  const held = item.status === "unclear" && item.hold === "quota";
  const until = Date.parse(item.holdUntil || "");
  // Before its allowance comes back a held problem offers no 现在批这道:
  // it would only be held again (closing shots). After it, it says so.
  const waiting = held && until > Date.now();
  const back = Boolean(held && until && !waiting);
  const when = back ? "可以批了" : held ? holdWhen(item) : "";
  return {
    ...item,
    held,
    waiting,
    ...(back ? { unclear: "额度恢复了，可以接着批这道" } : {}),
    heldText: when,
    badge: held ? { ...BADGE.hold, text: when } : BADGE[item.status === "done" ? item.verdict || "unsure" : item.status],
    canConfirm: item.steps.length > 0 && !item.steps.some((s) => UNFILLED.test(s)),
  };
}
// The score counts only problems with a verdict; the rest are said apart.
function scoreOf(counts, items) {
  if (!counts || counts.grading) return "";
  const checked = counts.correct + counts.wrong;
  if (checked === items.length) return `对了 ${counts.correct} / ${items.length} 题`;
  return checked ? `已核对 ${checked} 题，${counts.correct} 题正确` : "";
}
function summaryOf(counts, items) {
  const held = items.filter((i) => i.held).length;
  const heldText = held ? items.find((i) => i.held).heldText : "";
  if (counts.grading) {
    const todo = items.length - counts.unclear;
    return `正在一道道看，看完 ${todo - counts.grading} / ${todo} 道`;
  }
  const parts = [];
  if (counts.wrong) parts.push(`${counts.wrong} 道有错`);
  if (counts.unsure) parts.push(`${counts.unsure} 道拿不准`);
  if (counts.unclear - held) parts.push(`${counts.unclear - held} 道要你看一眼`);
  if (held) parts.push(`${held} 道${heldText}`);
  if (counts.failed) parts.push(`${counts.failed} 道没看完`);
  return parts.join("，");
}
// The page's grading as a job, for the progress bar.
function pageJob(id, counts, items) {
  if (!counts || !counts.grading) return null;
  const todo = Math.max(1, items.length - counts.unclear);
  return { id, status: "running", progress: { stage: "grade", steps: todo, step: todo - counts.grading + 1 } };
}
function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// V4.2 FX5b : time on this page counts as study (utils/study-clock).
Page(withShare(studyClock.track({
  data: {
    usageText: "",
    guest: false,
    pageMax: PAGE_MAX,
    scanSteps: SCAN_STEPS,
    draftSteps: DRAFT_STEPS,
    pageSteps: PAGE_STEPS,
    // start → edit → draft (one problem graded) | page (a page of problems)
    stage: "start",
    // start: past 批改 and what was typed but not graded
    history: [],
    historyMore: false,
    historyBusy: false,
    historyFailed: false,
    resume: null,
    // edit
    photo: "",
    imageId: "",
    problem: "",
    lines: [],
    unclear: "",
    suggest: null,
    // V4.2 FX5b (V5): a problem with formulas shows typeset (tap to edit);
    // while it is edited, its text with the typeset preview under it and 好了.
    // A plain problem is a box. The steps do the same in step-edit.
    problemTex: false,
    problemView: null,
    problemEditing: false,
    scanning: false,
    scanAt: 0,
    scanError: "",
    grading: false,
    gradeAt: 0,
    gradeError: "",
    // draft
    threadId: "",
    result: null,
    // page
    id: "",
    title: "",
    pageImageId: "",
    items: [],
    counts: null,
    score: "",
    summary: "",
    job: null,
    full: false,
    editing: -1,
    editText: "",
    editSteps: "",
    sending: false,
    retryPage: false,
    loading: false,
    error: "",
    loadFailed: false,
  },
  onLoad(query) {
    this.alive = true;
    this.taskEpoch = 0;
    const id = (query && query.id) || "";
    this.opened = Boolean(id);
    if (id) this.setData({ threadId: id, stage: "draft", loading: true });
  },
  onUnload() {
    this.alive = false;
    this.taskEpoch = (this.taskEpoch || 0) + 1;
    clearTimeout(this.timer);
    clearTimeout(this.problemTimer);
  },
  onHide() {
    clearTimeout(this.timer);
  },
  // A new exercise can replace an old one without unloading this page.
  nextTask() {
    this.taskEpoch = (this.taskEpoch || 0) + 1;
    this.setData({ sending: false, scanning: false, grading: false, loading: false });
  },
  taskContext(account = tools.account()) {
    const epoch = this.taskEpoch || 0;
    const generation = auth.consentGeneration();
    const consentCurrent = () => auth.hasConsent() && auth.consentGeneration() === generation;
    const authorized = () => consentCurrent() && tools.sameAccount(account);
    const bind = (user) => {
      if (!user || !user.id || !authorized() || tools.account() !== user.id)
        throw Object.assign(new Error("登录状态变了，再试一次"), { code: "SESSION_CHANGED" });
      account = user.id;
    };
    // A first login can fail before there is any account: the page must still
    // show that error and stop waiting, without treating it as an upload result.
    const current = () => this.alive && (this.taskEpoch || 0) === epoch && consentCurrent() &&
      (tools.sameAccount(account) || (!account && !tools.account()));
    return { authorized, bind, current };
  },
  onShow() {
    if (!gate.check()) return;
    // A guest sees the start; anything else opens after agreeing.
    if (gate.state() === "guest") return this.setData({ guest: true, loading: false, ...(this.data.result || this.data.items.length ? {} : { stage: "start" }) });
    if (this.data.guest) this.setData({ guest: false });
    const handed = tools.take("grade");
    if (handed) return this.useScan(handed);
    if (this.data.id) {
      // 离开页面期间额度可能已恢复。先按已有记录显示“可以批了”，即使本次刷新失败也保留该提示。
      if (this.shown && this.shown.id === this.data.id) this.show(this.shown);
      return this.load();
    }
    if (this.data.threadId && !this.data.result) return this.load();
    if (this.data.stage === "start") this.startView();
  },
  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh();
    if (this.data.id) return this.load().then(done, done);
    if (this.data.stage === "start") return this.history().then(done, done);
    done();
  },
  // ---- start: past 批改, and a grading to come back to ------------------------
  startView() {
    const kept = tools.kept("grade");
    // A photo read after the page was left : shown now, not read
    // (and counted) again. Used once; one problem's lines are kept as typed.
    if (kept && kept.scan) {
      tools.drop("grade");
      return this.useScan(kept.scan);
    }
    // Left while grading: ask again with the same clientId — the same grading.
    if (kept && kept.grading && kept.clientId && !this.data.grading) {
      this.restore(kept);
      return this.grade();
    }
    this.setData({ resume: kept && (kept.problem || tools.cleanLines(kept.lines).length) ? { text: (kept.problem || kept.lines[0] || "").slice(0, 40) } : null });
    this.history();
  },
  // more: the page after the last one shown (`next` from the server, passed
  // back as it came). The first page puts unfinished ones first.
  history(more) {
    const after = more === true ? this.next : "";
    if (more === true && !after) return Promise.resolve();
    return api
      .get(`/v1/chat/threads?kind=solve&tool=grade&limit=${HISTORY_PAGE}${after ? `&before=${encodeURIComponent(after)}` : ""}&tone=${TONE}`)
      .then(({ threads, usage, next }) => {
        if (!this.alive) return;
        // one line once the budget runs low (80%).
        this.setData({ usageText: usage && budgets.valid(usage.budget) ? budgets.low(usage.budget) : "" });
        const rows = (threads || []).map((t) => ({
          id: t.id,
          title: t.title || "批改",
          kind: t.homework ? "一页" : "一道",
          open: Boolean(t.open),
          when: when(t.updatedAt),
        }));
        this.next = next || "";
        const known = new Set(after ? this.data.history.map((r) => r.id) : []);
        const history = after
          ? this.data.history.concat(rows.filter((r) => !known.has(r.id)))
          : // Unfinished first, then the newest.
            rows.filter((r) => r.open).concat(rows.filter((r) => !r.open)).slice(0, HISTORY_PAGE);
        this.setData({ history, historyMore: Boolean(next), historyFailed: false });
      })
      // Not "no records": one line to try again.
      .catch((error) => {
        if (this.alive && !api.needsConsent(error)) this.setData({ historyFailed: true });
      });
  },
  moreHistory() {
    if (this.data.historyBusy) return Promise.resolve();
    this.setData({ historyBusy: true });
    return this.history(true).then(() => {
      if (this.alive) this.setData({ historyBusy: false });
    });
  },
  retryHistory() {
    return this.history();
  },
  openPast(event) {
    const id = event.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/pages/grade/index?id=${encodeURIComponent(id)}` });
  },
  // Long press: delete one (as in 解题's history before).
  removePast(event) {
    const { id, kind } = event.currentTarget.dataset;
    if (!id) return;
    wx.showModal({
      title: kind === "一页" ? "删掉这页作业？" : "删掉这次批改？",
      content: "照片和批改记录会删掉；错题本里的题还在。",
      confirmText: "删掉",
      confirmColor: "#e0474c",
      success: ({ confirm }) => {
        if (!confirm) return;
        api
          .del(`/v1/chat/threads/${encodeURIComponent(id)}`)
          .then(() => this.alive && this.history())
          .catch((error) => this.alive && !api.needsConsent(error) && this.setData({ error: errorText(error) }));
      },
    });
  },
  resumeEdit() {
    const kept = tools.kept("grade");
    if (kept) this.restore(kept);
  },
  restore(kept) {
    this.nextTask();
    this.lastScan = null;
    this.clientId = kept.clientId || "";
    this.setData({
      stage: "edit",
      photo: kept.photo || "",
      imageId: kept.imageId || "",
      problem: kept.problem || "",
      lines: kept.lines && kept.lines.length ? kept.lines : [""],
      unclear: kept.unclear || "",
      suggest: null,
      resume: null,
      error: "",
    });
    this.showProblem(kept.problem || "");
  },
  // What is typed is kept on this phone until it is graded.
  keep(patch) {
    const { photo, imageId, problem, lines, unclear } = this.data;
    tools.keep("grade", { photo, imageId, problem, lines, unclear, clientId: this.clientId || "", grading: false, ...patch });
  },
  // ---- opening one -------------------------------------------------------
  load() {
    clearTimeout(this.timer);
    const id = this.data.id || this.data.threadId;
    if (!id) return Promise.resolve();
    // 若用户已经点了“再批一份”，旧作业的晚到结果不再更新当前页面。
    const context = this.taskContext();
    const current = () => context.current() && (this.data.id || this.data.threadId) === id;
    this.setData({ error: "", loadFailed: false });
    return api
      .get(`/v1/chat/threads/${encodeURIComponent(id)}?tone=${TONE}`)
      .then(({ thread, messages }) => {
        if (!current()) return;
        if (thread.homework) return this.show(thread);
        const graded = (messages || []).filter((m) => m.kind === "draft" && m.draft).pop();
        if (!graded) return this.setData({ error: "这份批改找不到了", stage: "start" });
        this.setData({ stage: "draft", threadId: thread.id, result: resultOf(graded, thread) });
      })
      .catch((error) => {
        if (current() && !api.needsConsent(error)) this.setData({ error: errorText(error), loadFailed: true });
      })
      .finally(() => current() && this.setData({ loading: false }));
  },
  // ---- input ---------------------------------------------------------------
  pick(event) {
    if (this.data.guest) return gate.ask();
    if (this.data.scanning) return;
    tools.pick(event.detail.source).then((file) => file && this.read(file));
  },
  read(file) {
    this.nextTask();
    const signed = auth.getUser();
    const context = this.taskContext(signed ? signed.id : "");
    let sameDraft = signed ? tools.draftGuard("grade") : () => false;
    this.lastFile = file;
    this.setData({ scanning: true, scanAt: Date.now(), scanError: "", error: "", suggest: null, retryPage: false });
    // Consent does not imply a session. Bind a first login before uploading,
    // so a result arriving after leaving is kept for its actual account.
    const request = signed ? tools.scan(file, "grade") : auth.login().then((user) => {
      context.bind(user);
      // Another page may already have written something while login waited.
      sameDraft = tools.kept("grade") ? () => false : tools.draftGuard("grade");
      return tools.scan(file, "grade");
    });
    return request
      .then((scan) => {
        if (!context.authorized()) return;
        if (context.current()) return this.useScan(scan);
        // Left while it was read : kept for this account, shown when
        // the page opens again, so the same photo is not read and counted twice.
        if (!this.alive && sameDraft()) tools.keep("grade", { scan });
      })
      .catch((error) => {
        if (context.current() && !api.needsConsent(error)) this.setData({ scanError: errorText(error) });
      })
      .finally(() => context.current() && this.setData({ scanning: false }));
  },
  rescan() {
    if (this.lastFile && !this.data.scanning) this.read(this.lastFile);
  },
  // A page goes to grading at once; one problem's steps are checked first.
  useScan(scan) {
    this.nextTask();
    this.lastScan = scan;
    if (scan.homework > 1) return this.startPage(scan);
    const problem = (scan.problems && scan.problems[0] && scan.problems[0].text) || "";
    const steps = (scan.solution && scan.solution.steps) || [];
    this.clientId = "";
    this.setData({
      stage: "edit",
      photo: scan.photo || "",
      imageId: scan.imageId || "",
      problem,
      lines: steps.length ? steps.slice(0, 40) : [""],
      unclear: (scan.solution && scan.solution.unclear) || "",
      suggest: tools.suggestOf(scan, "grade"),
      error: problem || steps.length ? "" : "没认出题目和过程，可以照着写进来",
      resume: null,
    });
    this.showProblem(problem, scan.problems && scan.problems[0] && scan.problems[0].blocks);
    this.keep();
  },
  // V4.2 FX5b : the page read (and paid for) is kept on this phone
  // until the server has it; asked again with the same photo, the server
  // answers with the same page, and problems past the allowance wait there.
  startPage(scan) {
    this.nextTask();
    const signed = auth.getUser();
    const context = this.taskContext(signed ? signed.id : "");
    let sameDraft = () => false;
    this.setData({ scanning: true, scanAt: Date.now(), scanError: "", error: "", suggest: null, retryPage: false });
    const send = () => {
      if (context.current() || !tools.kept("grade")) {
        tools.keep("grade", { scan });
        sameDraft = tools.draftGuard("grade");
      }
      return api.post("/v1/chat/homework", { imageId: scan.imageId, tone: TONE });
    };
    const request = signed ? send() : auth.login().then((user) => { context.bind(user); return send(); });
    return request
      .then((thread) => {
        if (context.authorized() && sameDraft()) tools.drop("grade");
        if (!context.current()) return;
        this.setData({ id: thread.id, stage: "page", loading: false });
        this.show(thread);
      })
      // The photo is kept: 再试一次 uses it again, no new upload or count.
      .catch((error) => {
        // Kept unless the photo cannot make a page (gone, not homework).
        if (context.authorized() && sameDraft() && error && (error.code === "NOT_FOUND" || error.code === "NOT_HOMEWORK")) tools.drop("grade");
        if (!context.current() || api.needsConsent(error)) return;
        const one = scan.problems && scan.problems.length ? { to: "problem", ...tools.SUGGEST.problem, text: "也可以挑一道单独问" } : null;
        this.setData({ stage: "start", error: errorText(error), retryPage: true, suggest: one });
      })
      .finally(() => context.current() && this.setData({ scanning: false }));
  },
  retryStart() {
    if (this.lastScan && !this.data.scanning) this.startPage(this.lastScan);
  },
  typeIn() {
    if (this.data.guest) return gate.ask();
    this.nextTask();
    this.lastScan = null;
    this.clientId = "";
    this.setData({ stage: "edit", photo: "", imageId: "", problem: "", lines: [""], unclear: "", suggest: null, error: "", resume: null });
    this.showProblem("");
  },
  switchTool() {
    const suggest = this.data.suggest;
    if (suggest && this.lastScan) tools.handOver(suggest.to, this.lastScan);
  },
  // An edit is a new submission: it gets a clientId of its own when sent.
  onProblem(event) {
    this.clientId = "";
    const problem = event.detail.value;
    // Typing is editing: the box stays a box, its preview follows a moment later.
    this.setData({ problem, problemTex: lineTex(problem), problemEditing: true });
    clearTimeout(this.problemTimer);
    this.problemTimer = setTimeout(() => this.typesetProblem(problem), 400);
    this.keep();
    if (this.studyTouch) this.studyTouch();
  },
  onLines(event) {
    this.clientId = "";
    this.setData({ lines: event.detail.lines });
    this.keep();
    if (this.studyTouch) this.studyTouch();
  },
  // The problem as it shows when not edited: typeset when it has formulas
  // (the scan's own blocks first, if it came with them).
  showProblem(problem, blocks) {
    clearTimeout(this.problemTimer);
    const tex = lineTex(problem);
    this.setData({ problemTex: tex, problemView: tex && blocks && blocks.length ? blocks : null, problemEditing: false });
    if (tex && !(blocks && blocks.length)) return this.typesetProblem(problem);
    return Promise.resolve();
  },
  typesetProblem(problem) {
    if (!lineTex(problem)) return Promise.resolve();
    return lineBlocks(problem).then((blocks) => {
      // Still the same text: an older answer never replaces a newer one.
      if (this.alive && blocks && this.data.problem === problem) this.setData({ problemView: blocks });
    });
  },
  editProblem() {
    this.setData({ problemEditing: true });
  },
  problemDone() {
    clearTimeout(this.problemTimer);
    this.setData({ problemEditing: false });
    return this.typesetProblem(this.data.problem);
  },
  viewPhoto() {
    if (this.data.photo) wx.previewImage({ urls: [this.data.photo] });
  },
  photoBroken() {
    this.setData({ photo: "" });
  },
  // ---- one problem graded --------------------------------------------------
  grade() {
    if (this.data.grading) return;
    const problem = this.data.problem.trim();
    const steps = tools.cleanLines(this.data.lines, 40);
    if (!problem) return this.setData({ error: "先写上题目" });
    if (!steps.length) return this.setData({ error: "至少写一步过程" });
    if (!this.clientId) this.clientId = stream.clientId();
    const clientId = this.clientId;
    const context = this.taskContext();
    this.keep({ clientId, grading: true });
    const sameDraft = tools.draftGuard("grade");
    this.setData({ grading: true, gradeAt: Date.now(), gradeError: "", error: "" });
    return api
      .post(
        "/v1/chat/drafts",
        { problem: problem.slice(0, 1500), steps, ...(this.data.imageId ? { imageId: this.data.imageId } : {}), clientId, tone: TONE },
        { timeout: 150000 },
      )
      .then((out) => {
        if (!context.current()) return;
        if (sameDraft()) tools.drop("grade");
        if (out.crisis) return wx.navigateTo({ url: "/pages/crisis/index" });
        this.setData({ stage: "draft", threadId: out.thread.id, result: resultOf(out.message, out.thread) });
        wx.pageScrollTo({ scrollTop: 0, duration: 0 });
      })
      .catch((error) => {
        if (!context.current() || api.needsConsent(error)) return;
        // Not graded: what was typed stays, and 再批一次 sends the same one.
        if (sameDraft()) this.keep({ clientId, grading: false });
        this.setData({ gradeError: errorText(error) });
      })
      .finally(() => context.current() && this.setData({ grading: false }));
  },
  // The full solution, in the same conversation (拍一道题); asked for once.
  solution() {
    if (this.data.threadId && once(this)) openAsk({ threadId: this.data.threadId, solution: true });
  },
  addMistake() {
    const result = this.data.result;
    if (!result || result.inBook || this.saving) return;
    this.saving = true;
    api
      .post(`/v1/chat/messages/${encodeURIComponent(result.messageId)}/mistake`, { tone: TONE })
      .then(() => {
        if (!this.alive) return;
        this.setData({ "result.inBook": true });
        wx.showToast({ title: "放进错题本了", icon: "success" });
      })
      .catch((error) => {
        if (this.alive && !api.needsConsent(error)) this.setData({ error: errorText(error) });
      })
      .finally(() => {
        this.saving = false;
      });
  },
  // Read wrong? The same problem and steps, to correct and grade again.
  fix() {
    const result = this.data.result;
    if (!result || this.data.grading) return;
    this.nextTask();
    this.lastScan = null;
    this.clientId = "";
    this.setData({
      stage: "edit",
      photo: "",
      imageId: result.imageId || "",
      problem: result.problemText,
      lines: result.lines.length ? result.lines : [""],
      unclear: "",
      suggest: null,
      result: null,
      threadId: "",
      error: "",
    });
    this.showProblem(result.problemText || "", result.problem);
    this.keep();
  },
  viewOriginal() {
    const imageId = (this.data.result && this.data.result.imageId) || this.data.pageImageId;
    if (!imageId) return;
    api
      .download(`/v1/chat/images/${imageId}`, "原图")
      .then((path) => wx.previewImage({ urls: [path] }))
      .catch((error) => this.alive && !api.needsConsent(error) && this.setData({ error: errorText(error) }));
  },
  again() {
    if (this.data.grading) return;
    this.nextTask();
    clearTimeout(this.timer);
    this.lastScan = null;
    this.clientId = "";
    tools.drop("grade");
    // A past one opened from the list: a fresh start in its place.
    if (this.opened) return wx.redirectTo({ url: "/pages/grade/index" });
    this.setData({ stage: "start", photo: "", imageId: "", problem: "", lines: [], unclear: "", suggest: null, threadId: "", result: null, error: "", gradeError: "", scanError: "", id: "", items: [], counts: null });
    this.startView();
  },
  // ---- a page of problems --------------------------------------------------
  show(thread) {
    if (!this.alive || !thread.homework) return;
    this.shown = thread;
    const { items, counts, imageId } = thread.homework;
    const cards = items.map(card);
    this.setData({
      stage: "page",
      id: thread.id,
      title: thread.title,
      pageImageId: imageId,
      items: cards,
      counts,
      summary: summaryOf(counts, cards),
      score: scoreOf(counts, cards),
      job: pageJob(thread.id, counts, cards),
      full: cards.length >= PAGE_MAX,
    });
    clearTimeout(this.timer);
    const shown = () => this.alive && this.data.id === thread.id;
    if (counts.grading) this.timer = setTimeout(() => shown() && this.load(), 3000);
    else {
      // 根据第一道待额度恢复的题，先算出下次可批改时间。
      // 离线导致刷新失败时，页面仍能及时显示“可以批了”。
      const next = Math.min(...cards.filter((c) => c.waiting).map((c) => Date.parse(c.holdUntil)));
      if (Number.isFinite(next)) {
        this.timer = setTimeout(() => {
          if (!shown()) return;
          this.load();
          this.show(thread);
        }, Math.min(next - Date.now() + 1000, 2000000000));
        if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
      }
    }
  },
  leave() {
    wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: "/pages/learn/index" }) });
  },
  item(event) {
    return this.data.items[Number(event.currentTarget.dataset.index)];
  },
  openItem(event) {
    const item = this.item(event);
    if (item && item.threadId) openAsk({ threadId: item.threadId });
  },
  addItemMistake(event) {
    const item = this.item(event);
    if (!item || item.inBook || this.saving) return;
    const id = this.data.id;
    const context = this.taskContext();
    const current = () => context.current() && this.data.id === id;
    this.saving = true;
    api
      .post(`/v1/chat/threads/${id}/homework/${item.index}/mistake`, { tone: TONE })
      .then(({ thread }) => {
        if (!current()) return;
        this.show(thread);
        wx.showToast({ title: "放进错题本了", icon: "success" });
      })
      .catch((error) => current() && !api.needsConsent(error) && this.setData({ error: errorText(error) }))
      .finally(() => {
        this.saving = false;
      });
  },
  gradeItem(index, body) {
    if (this.data.sending) return;
    const id = this.data.id;
    const context = this.taskContext();
    const current = () => context.current() && this.data.id === id;
    const sameDraft = tools.draftGuard(`grade:${id}`);
    this.setData({ sending: true, error: "" });
    return api
      .post(`/v1/chat/threads/${id}/homework/${index}`, { ...body, tone: TONE })
      .then((thread) => {
        if (context.authorized() && sameDraft()) tools.drop(`grade:${id}`);
        if (!current()) return;
        this.setData({ editing: -1 });
        this.show(thread);
      })
      .catch((error) => current() && !api.needsConsent(error) && this.setData({ error: errorText(error) }))
      .finally(() => current() && this.setData({ sending: false }));
  },
  confirm(event) {
    const item = this.item(event);
    if (item) this.gradeItem(item.index, { steps: item.steps });
  },
  edit(event) {
    const item = this.item(event);
    if (!item) return;
    const kept = tools.kept(`grade:${this.data.id}`);
    if (kept && kept.index === item.index) return this.setData({ editing: item.index, editText: kept.text, editSteps: kept.steps, error: "" });
    // "\text{？}" is shown as a bare "？", the one thing to replace.
    const steps = item.steps.join("\n").replace(/\\text\{\s*([？?])\s*\}/g, "$1");
    this.setData({ editing: item.index, editText: item.text, editSteps: steps, error: "" });
  },
  cancelEdit() {
    tools.drop(`grade:${this.data.id}`);
    this.setData({ editing: -1 });
  },
  keepEdit() {
    tools.keep(`grade:${this.data.id}`, { index: this.data.editing, text: this.data.editText, steps: this.data.editSteps });
  },
  onEditText(event) {
    this.setData({ editText: event.detail.value });
    this.keepEdit();
  },
  onEditSteps(event) {
    this.setData({ editSteps: event.detail.value });
    this.keepEdit();
  },
  submitEdit() {
    const { editing, editText, editSteps } = this.data;
    const steps = editSteps.split("\n").map((s) => s.trim()).filter(Boolean);
    const text = editText.trim();
    if (!text || !steps.length) return this.setData({ error: "题目和步骤都要写上" });
    if (steps.some((s) => UNFILLED.test(s))) return this.setData({ error: "步骤里还有 ？，改成纸上写的再批" });
    const item = this.data.items[editing];
    // A graded problem whose reading was corrected is graded once more.
    this.gradeItem(editing, { text, steps: steps.slice(0, 40), ...(item && item.status === "done" ? { again: true } : {}) });
  },
  openMistakes() {
    wx.navigateTo({ url: "/pages/mistakes/index" });
  },
})));

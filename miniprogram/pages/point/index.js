/*
 * 知识点练习页：加载题目、提交选项或答案、显示核对结果与复习状态，支持继续练习。
 * 页面中的请求标识、账号快照和 alive 状态用于拦截过期回包；不能仅因离开页面就删除另一份新草稿。
 */
const api = require("../../utils/api");
const auth = require("../../utils/auth");
const gate = require("../../utils/gate");
const learningSpace = require("../../utils/learning-space");
const { errorText } = require("../../utils/format");
const studyClock = require("../../utils/study-clock");
const stream = require("../../utils/stream");
const pad = require("../../components/numpad/input");
const { openAsk } = require("../../utils/chat-entry");
const { lookOf } = require("../../utils/point-look");
const tools = require("../../utils/tools");
const { transient } = require("../../utils/job");
const {
  TIER_CLS,
  STATE_TEXT,
  RANK_LINES,
  stampOf,
  retryText,
  moment,
  tierCells,
  tierCount,
  sheetCount,
  verdictText,
  backTo,
  ROUTES,
} = require("../../utils/learn");
// Formula images in ink: the problem and the key points sit on white, and the
// first formula on the dark kp card sits in a light chip (.mk.fx).
const TONE = "light";
// A response belongs to the account and visible page that requested it.
function activeFor(page) {
  const owner = (auth.getUser() || {}).id;
  const epoch = page.epoch || 0;
  return () =>
    page.alive !== false &&
    (page.epoch || 0) === epoch &&
    auth.hasConsent() &&
    owner === (auth.getUser() || {}).id;
}
// A judged answer is already recorded on the server and cannot be read back, so
// its result survives a trip to the background; only another account, revoked
// consent or a closed page discards it.
function ownedFor(page) {
  const owner = (auth.getUser() || {}).id;
  return () =>
    !page.unloaded && auth.hasConsent() && owner === (auth.getUser() || {}).id;
}
const PREDICTIONS = { yes: "能", unsure: "没把握", no: "不能" };
// AI 加练's wait : the server sends no stages, so the bar follows
// time and shows no percentage.
const AI_STEPS = [
  { key: "make", label: "出一道题" },
  { key: "check", label: "核对答案" },
];
function dayBefore(value, days) {
  const parts = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return "";
  const date = new Date(
    Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]) - days),
  );
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}
function retestCopy(retest) {
  if (!retest) return null;
  const date = dayBefore(retest.dueOn, retest.round === 2 ? 3 : 2);
  if (retest.round === 2)
    return {
      ...retest,
      line: `${date ? `${date} ` : ""}差一点，换道题再来。`,
      subline: retest.repeated
        ? "这题你见过，试试不看提示。"
        : "换了一道题，试试不看提示。",
    };
  const cause = {
    explanation: "你看过这个点的解析。",
    hint: "你看过这个点的提示。",
    ask: "你问过 AI 这个知识点。",
    stuck: "你在这个点卡住过。",
    wrong: "这道题上次没做出来。",
  }[retest.cause];
  return {
    ...retest,
    line: `${date ? `${date} ` : ""}${cause || "再做一题确认一下。"}`,
    subline: retest.repeated
      ? "再做一道，试试不看提示。"
      : "换了一道题，试试不看提示。",
  };
}
// A bank problem (GET …/practice): choice (1–3 questions of 4 options) or
// number blanks, filled on the number pad. `total` and `index` drive 下一题.
function problemView(pr) {
  const p = pr && pr.problem;
  if (!p) return null;
  const choice = p.format === "choice";
  const blanks = choice
    ? []
    : (p.blanks || []).map((b) => ({ label: b.label || "", note: b.note || "", var: "x" }));
  return {
    index: p.index,
    total: Number(p.total || 0),
    format: choice ? "choice" : "blanks",
    kind: choice ? "choice" : blanks.length > 1 ? "multi" : "number",
    kindText: choice ? "选择题" : blanks.length > 1 ? "多空题" : "填空题",
    blocks: p.blocks || [],
    var: "x",
    hasHint: Boolean(p.hasHint),
    // Every bank problem has its solution; a missing one says so on tap.
    hasExplanation: true,
    blanks,
    parts: blanks,
    questions: (p.questions || []).map((question, i) => ({ ...question, key: `q${i}` })),
    aiPractice: Boolean(pr.aiPractice),
  };
}
function slotsOf(problem) {
  return problem ? (problem.format === "choice" ? problem.questions : problem.blanks).length : 0;
}
function filledAll(problem, answers) {
  if (!problem || !answers.length) return false;
  return problem.format === "choice"
    ? answers.every((a) => String(a || "").trim())
    : answers.every((a) => pad.valid(a));
}
// What the AI problem shows (POST /v1/chat/practice, GET /v1/chat/messages/:id).
function aiView(message, threadId) {
  const s = (message && message.similar) || {};
  return {
    id: message.id,
    threadId: threadId || message.threadId || "",
    question: s.question || [],
    options: s.options || [],
    choice: Boolean(s.options && s.options.length),
    revealed: Boolean(s.revealed),
    correct: s.correct || "",
    steps: s.steps || null,
    answer: s.answer || null,
    solution: s.solution || null,
  };
}
// The page head, 先弄懂 and the problem. No 讲解 or why text yet : some of
// the map's why text gives the solution away.
function view(p, pr) {
  const retest = retestCopy(p.retest);
  return {
    id: p.id,
    name: p.name,
    tier: p.tier,
    tierCls: TIER_CLS[p.tier] || "base",
    meta: `${p.section} · ${p.chapter.book} ${p.chapter.short}`,
    chapterId: p.chapter.id,
    short: p.chapter.short,
    xp: p.xp,
    review: Boolean(p.review),
    red: Boolean(p.red),
    cell: lookOf(p).cell,
    stateText: lookOf(p).key === "none" ? "" : lookOf(p).text,
    prereqs: p.prereqs.map((q) => ({
      id: q.id,
      name: q.name,
      cell: lookOf(q).cell,
      state: lookOf(q).text,
    })),
    prereqNames: p.prereqs.map((q) => q.name).join("、"),
    // v4 kp card: the first formula, then the key points (MAP_CARDS).
    // The same look as the map (utils/learn.js lookOf); untouched is blue.
    star: ["none", "seen"].includes(lookOf(p).key) ? "next" : lookOf(p).cls,
    // The dark card draws its first formula in the dark tone (kpFormulaBlocks);
    // an older server without it shows nothing rather than ink on navy.
    kpFormula: p.kpFormulaBlocks || null,
    formulaText:
      (!p.kpFormulaBlocks && !p.formulaBlocks && p.formulas && p.formulas[0]) ||
      "",
    keys: p.keyBlocks || [],
    practice: Boolean(p.practice),
    retest,
    retestMode: Boolean(retest && retest.mode),
    // 0.6.0 : the problem is the bank's, from GET …/practice.
    problem: problemView(pr),
  };
}
// The tier's line and cells under a lit answer: "中值与应用 · 重点 做对 5/6，要 5".
function progress(point, after, map) {
  const chapter = after.chapters.find((c) => c.id === point.chapterId);
  const count = chapter && chapter.tiers.find((t) => t.tier === point.tier);
  if (!count) return null;
  const onMap = map && map.chapters.find((c) => c.id === point.chapterId);
  return {
    label: `${point.short} · ${point.tier}`,
    count: tierCount(count),
    cells: onMap ? tierCells(onMap.points, point.tier, point.id) : [],
  };
}
// The chapter rank-up sheet (RankUp board). 下一段 is the server's up for the
// chapter; the map only gives that tier's cells and the 看过 count.
function rankSheet(point, rankUp, after, map) {
  const sheet = {
    rank: rankUp.to,
    stamp: stampOf(rankUp.to),
    title: `${point.short} 升到 ${rankUp.to}`,
    line: RANK_LINES[rankUp.to] || "",
    jump: rankUp.jump,
    next: null,
  };
  const next = rankUp.next;
  const chapter = after.chapters.find((c) => c.id === point.chapterId);
  const t = next && chapter && chapter.tiers.find((x) => x.tier === next.tier);
  if (t) {
    const onMap = map && map.chapters.find((c) => c.id === point.chapterId);
    const cells = onMap ? tierCells(onMap.points, t.tier, "") : [];
    const seen = cells.filter((c) => c.cls === "seen").length;
    sheet.next = {
      rank: next.rank,
      stamp: next.stamp,
      gap: next.gap,
      note: next.note,
      cells,
      count: sheetCount(t, seen),
    };
  }
  return sheet;
}
// The book rank-up card: the chapter names come from the map read after the
// answer; without it the card leaves out the chapter list.
function bookCard(book, map) {
  const names = {};
  if (map) map.chapters.forEach((c) => (names[c.id] = c.short));
  return {
    rank: book.to,
    stamp: book.stamp,
    title: book.title,
    line: book.line,
    chapters: map
      ? book.chapters
          .filter((c) => names[c.id])
          .map((c) => ({ ...c, short: names[c.id] }))
      : [],
  };
}
function resultView(res, point, map) {
  const tone =
    res.verdict === "correct"
      ? "good"
      : res.verdict === "incorrect"
        ? "bad"
        : "unsure";
  const lit = res.counted === "lit";
  const m = moment(res.before, res.after, point.chapterId);
  const said =
    res.items && res.verdict === "unsure"
      ? "有几空的写法没认出来，按下面改一下。"
      : verdictText(
          res.items ? { ...res, reason: null } : res,
          (point.problem && point.problem.var) || "x",
        );
  return {
    tone,
    // The solution is under the verdict now, so a wrong answer points
    // there instead of 可以再试.
    text: res.solution ? said.replace("可以再试", "看看下面的解法") : said,
    solution: res.solution
      ? {
          options: (res.solution.correct && res.solution.correct.options) || [],
          answer: (res.solution.correct && res.solution.correct.blocks) || [],
          explanation: res.solution.explanation || null,
        }
      : null,
    // Only a correct answer brings the standard answer.
    standard:
      res.verdict === "correct" && (lit || res.counted === "review")
        ? res.standard || null
        : null,
    // "读出来是 …" helps rewrite a wrong or unclear answer.
    read:
      res.verdict !== "correct" && res.read && res.read.length
        ? res.read
        : null,
    items: (res.items || []).map((item, i) => ({
      ...item,
      // Settled with the solution below: no 可以再试 on any part either.
      text:
        item.verdict === "correct"
          ? "对了"
          : res.solution
            ? verdictText(item, (point.problem.parts[i] || {}).var || "x").replace(/，?可以再试/, "")
            : verdictText(item, (point.problem.parts[i] || {}).var || "x"),
      tone:
        item.verdict === "correct"
          ? "good"
          : item.verdict === "incorrect"
            ? "bad"
            : "unsure",
      standard: res.verdict === "correct" ? item.standard || null : null,
    })),
    xp: lit ? res.xp : 0,
    levelUp: lit ? m.levelUp : null,
    progress: lit ? progress(point, res.after, map) : null,
    rank:
      lit && m.rankUp
        ? {
            rank: m.rankUp.to,
            stamp: stampOf(m.rankUp.to),
            text: `${point.short} 升到${m.rankUp.to}`,
          }
        : null,
    sheet: lit && m.rankUp ? rankSheet(point, m.rankUp, res.after, map) : null,
    book: lit && m.book ? bookCard(m.book, map) : null,
    next: res.next
      ? { id: res.next.id, text: `下一个：${res.next.name} · ${res.next.tier}` }
      : null,
  };
}
function withRetestResult(result, response, prediction, wasRetest, helped) {
  if (!wasRetest) return result;
  const finished = response.retest || null;
  const actual = helped
    ? "看了提示"
    : response.verdict === "unsure"
      ? "这次没判出来"
      : finished && finished.result === "hinted"
        ? "看了提示"
        : response.verdict === "correct"
          ? "做出来了"
          : "没做出来";
  return {
    ...result,
    // Retests show no XP (README §5.4).
    retest: true,
    predictionLine: `你觉得${PREDICTIONS[prediction] || "没猜"}，结果${actual}`,
    retestPassed: Boolean(
      (finished && finished.result === "right") ||
        (response.verdict === "correct" && response.counted !== "practice"),
    ),
    retestWrong: Boolean(
      (finished && finished.result === "wrong") ||
        (!finished && response.verdict === "incorrect"),
    ),
  };
}
// 这题有问题 (spec §13): the action sheet's items and the reasons they send.
const REPORTS = [
  ["我的答案是对的，判错了", "judge"],
  ["题目或标准答案有错", "problem"],
  ["题目看不懂", "unclear"],
  ["其他问题", "other"],
];
// 知识点页: the problem, the answer box, the result, the chapter rank-up sheet
// and the book rank-up card.
Page(studyClock.track({
  data: {
    loading: true,
    error: "",
    canRetry: true,
    point: null,
    correct: false,
    self: false,
    answer: "",
    answers: [],
    canSubmit: false,
    busy: false,
    marking: false,
    fail: "",
    result: null,
    done: false,
    sheet: null,
    sheetOpen: false,
    book: null,
    bookOpen: false,
    reporting: false,
    kpOpen: false,
    hint: null,
    explanation: null,
    helpBusy: false,
    helpError: "",
    prediction: "",
    predictionLocked: false,
    helpNotice: "",
    wrongNote: "",
    learningCards: [],
    numActive: 0,
    bankDone: false,
    aiPractice: false,
    ai: null,
    aiPick: -1,
    aiResult: null,
    aiBusy: false,
    aiSending: false,
    aiError: "",
    aiRetry: false,
    aiSteps: AI_STEPS,
    aiAt: 0,
  },
  onLoad(query) {
    this.alive = true;
    this.id = (query && query.id) || "";
    if (!gate.check()) return;
    // A guest has no problems to try: the map shows the cards, this page asks.
    if (gate.state() === "guest") return;
    // An answer left half filled in on this point opens on its problem again
    // (a due retest still wins on the server).
    // 题库 can open one problem by its number (?index=).
    const asked = Number(query && query.index);
    const draft = learningSpace.pointDraft((auth.getUser() || {}).id, this.id);
    if (query && query.index !== undefined && Number.isInteger(asked) && asked >= 0) {
      this.draftWanted = draft && draft.index === asked ? draft : null;
      return this.load({ index: asked });
    }
    this.draftWanted = draft;
    this.load(draft ? { index: draft.index } : undefined);
  },
  // What is filled in goes with the problem; empty, or judged, it goes.
  keepDraft(answers) {
    const problem = this.data.point && this.data.point.problem;
    if (!problem) return;
    const owner = (auth.getUser() || {}).id;
    const any = answers.some((a) => String(a || "").trim());
    learningSpace.keepPointDraft(owner, this.id, any ? { index: problem.index, answers } : null);
  },
  // Back here from the chapter page (backTo returns to this page in the stack),
  // where 把剩下的标为会了 or its undo may have changed 我会了. The first show
  // follows onLoad, which already loads. A changed problem clears old work.
  onShow() {
    this.alive = true;
    if (!gate.check()) return;
    if (gate.state() === "guest") {
      this.setData({ loading: false, error: "游客模式不能做题，同意后就能用", canRetry: false });
      return gate.ask();
    }
    this.confirmingHelp = false;
    // 练一题 on the detail page (knowledge practise) asks for a fresh problem:
    // a finished one goes on to the next, as 下一题 does.
    const app = getApp();
    const fresh = Boolean(app && app.globalData && app.globalData.practiseFresh === this.id);
    if (fresh) app.globalData.practiseFresh = "";
    // Back from a card or a chat: the same problem (a due retest still wins).
    const problem = this.data.point && this.data.point.problem;
    if (this.shown)
      this.load(problem ? (fresh && this.data.done ? { after: problem.index } : { index: problem.index }) : {});
    this.shown = true;
  },
  onHide() {
    this.alive = false;
    this.epoch = (this.epoch || 0) + 1;
  },
  onUnload() {
    this.unloaded = true;
    this.onHide();
  },
  // which: { index } one problem, { after } the one after it (下一题), {} the
  // server's pick (a due retest, else the first one not yet done right).
  load(which) {
    const pick = which && typeof which === "object" && !which.type ? which : {};
    // A refresh cannot replace the problem being judged. Repeated refreshes
    // share one request after the current submission has completed.
    if (this.answerRequest) return this.answerRequest.then(() => this.load(pick));
    if (this.markRequest) return this.markRequest.then(() => this.load(pick));
    if (this.helpRequest) return this.helpRequest.then(() => this.load(pick));
    const epoch = this.epoch || 0;
    if (this.loadRequest) {
      const scope = this.loadScope;
      if (
        scope &&
        scope.epoch === epoch &&
        (!scope.authenticated || scope.owner === (auth.getUser() || {}).id)
      )
        return this.loadRequest;
      // A returning page or changed account needs a fresh read after the old
      // response is discarded. Concurrent callers then share that fresh read.
      return this.loadRequest.then(() => this.alive !== false && this.load(pick));
    }
    const scope = (this.loadScope = {
      epoch,
      owner: undefined,
      authenticated: false,
    });
    let active = () => this.alive !== false && (this.epoch || 0) === epoch;
    this.setData({ loading: true, error: "" });
    const request = auth
      .login()
      .then(() => {
        if (!active()) return null;
        active = activeFor(this);
        const owner = (auth.getUser() || {}).id;
        scope.owner = owner;
        scope.authenticated = true;
        if (this.owner !== owner) {
          this.owner = owner;
          this.confirmingHelp = false;
          this.seenSent = false;
          this.lastAnswer = "";
          this.lastAnswerIndex = undefined;
          this.firstIndex = undefined;
          this.setData({
            point: null,
            numActive: 0,
            bankDone: false,
            ai: null,
            aiPick: -1,
            aiResult: null,
            aiError: "",
            aiBusy: false,
            aiSending: false,
            aiRetry: false,
            correct: false,
            self: false,
            answer: "",
            answers: [],
            canSubmit: false,
            result: null,
            done: false,
            fail: "",
            hint: null,
            explanation: null,
            helpError: "",
            helpNotice: "",
            prediction: "",
            predictionLocked: false,
            wrongNote: "",
            learningCards: [],
            busy: false,
            marking: false,
            helpBusy: false,
            sheet: null,
            sheetOpen: false,
            book: null,
            bookOpen: false,
          });
        }
        const base = `/v1/learn/points/${encodeURIComponent(this.id)}`;
        const query =
          pick.index !== undefined
            ? `&index=${pick.index}`
            : pick.after !== undefined
              ? `&after=${pick.after}`
              : "";
        // The page state (retest, 我会了, prereqs, the dark card) and the bank
        // problem  side by side; a point without problems yet has none.
        return Promise.all([
          api.get(`${base}?tone=${TONE}`),
          api.get(`${base}/practice?tone=${TONE}${query}`).catch((error) => {
            if (error && error.statusCode === 409 && error.code === "NO_PROBLEM") return null;
            throw error;
          }),
        ]);
      })
      .then((both) => {
        if (!both || !active()) return;
        const [p, pr] = both;
        if (!p) return;
        // v4: the bar says 练一题; the kp card names the point.
        wx.setNavigationBarTitle({ title: "练一题" });
        const oldPoint = this.data.point,
          oldProblem = oldPoint && oldPoint.problem,
          shown = view(p, pr);
        // 下一题 ({ after }) always starts clean, even when a one-problem bank
        // comes back to the same problem.
        const changed = Boolean(
          (oldProblem &&
            (pick.after !== undefined ||
              !shown.problem ||
              oldProblem.index !== shown.problem.index ||
              oldProblem.kind !== shown.problem.kind ||
              (oldPoint.practice && !p.practice))) ||
            (oldPoint &&
              (oldPoint.retestMode !== shown.retestMode ||
                (oldPoint.retest && oldPoint.retest.id) !==
                  (shown.retest && shown.retest.id))),
        );
        const slots = slotsOf(shown.problem);
        // 下一题 goes round the bank from here; back at this one it is done.
        if (shown.problem && (this.firstIndex === undefined || pick.fresh))
          this.firstIndex = shown.problem.index;
        if (changed) {
          this.lastAnswer = "";
          this.lastAnswerIndex = undefined;
        }
        this.setData({
          point: shown,
          correct: p.correct,
          self: p.self,
          prediction:
            !oldProblem || changed
              ? (shown.retest && shown.retest.predicted) || ""
              : this.data.prediction,
          predictionLocked:
            !oldProblem || changed
              ? Boolean(
                  shown.retestMode && shown.retest && shown.retest.predicted,
                )
              : this.data.predictionLocked,
          aiPractice: Boolean(shown.problem && shown.problem.aiPractice),
          ...(!oldProblem || changed
            ? { answers: Array(slots).fill(""), numActive: 0 }
            : {}),
          ...(changed
            ? {
                answer: "",
                bankDone: false,
                canSubmit: false,
                result: null,
                done: false,
                fail: "",
                sheet: null,
                sheetOpen: false,
                book: null,
                bookOpen: false,
                hint: null,
                explanation: null,
                helpError: "",
                helpNotice: "",
                wrongNote: "",
                learningCards: [],
              }
            : {}),
        });
        learningSpace.remember((auth.getUser() || {}).id, p.id);
        // An AI 加练 asked for before the page was left: its problem now.
        if (tools.kept(`practice:${p.id}`) && !this.data.aiBusy) this.aiStart();
        // The answer left on this problem last time comes back.
        const wanted = this.draftWanted;
        this.draftWanted = null;
        if (
          wanted &&
          shown.problem &&
          shown.problem.index === wanted.index &&
          wanted.answers.length === slots
        )
          this.setData({
            answers: wanted.answers.slice(),
            canSubmit: filledAll(shown.problem, wanted.answers),
          });
        // 看过 is recorded once, on the first load that works (also after 重试);
        // a failure here changes nothing on screen.
        if (!this.seenSent) {
          this.seenSent = true;
          api
            .post("/v1/learn/marks", { action: "seen", pointId: this.id })
            .then((res) => {
              if (!active()) return;
              // An answer or self-mark may have changed the head while this ran.
              if (this.data.point && this.data.point.cell === "")
                this.setData({
                  "point.cell": res.state === "none" ? "" : res.state,
                  "point.stateText": STATE_TEXT[res.state] || "",
                });
            })
            .catch(() => {});
        }
      })
      .catch((error) => {
        // An unknown point stays unknown: no 重试.
        if (active() && !api.needsConsent(error))
          this.setData({
            error: retryText(error),
            canRetry: error.statusCode !== 404,
          });
      })
      .finally(() => {
        this.loadRequest = null;
        this.loadScope = null;
        if (active()) this.setData({ loading: false });
      });
    this.loadRequest = request;
    return request;
  },
  locked() {
    return (
      this.data.loading ||
      this.data.busy ||
      this.data.marking ||
      this.data.helpBusy ||
      this.data.done
    );
  },
  // The number pad (components/numpad): every key and a tap on another blank.
  onPad(event) {
    if (this.locked()) return;
    const { values, active } = event.detail || {};
    const problem = this.data.point && this.data.point.problem;
    if (!problem || !Array.isArray(values) || values.length !== problem.blanks.length) return;
    const answers = values.map((v) => String(v || ""));
    this.setData({
      answers,
      numActive: Number(active) || 0,
      canSubmit: filledAll(problem, answers),
    });
    this.keepDraft(answers);
  },
  onPart(event) {
    if (this.locked()) return;
    const i = Number(event.currentTarget.dataset.index);
    const answers = this.data.answers.slice();
    if (!Number.isInteger(i) || i < 0 || i >= answers.length) return;
    answers[i] = event.detail.value;
    this.setData({
      answers,
      canSubmit: filledAll(this.data.point && this.data.point.problem, answers),
    });
    this.keepDraft(answers);
  },
  chooseOption(event) {
    const { question, id } = event.currentTarget.dataset;
    const problem = this.data.point && this.data.point.problem;
    const q = problem && problem.questions[Number(question)];
    if (!q || !q.options.some((o) => o.id === id)) return;
    this.onPart({
      currentTarget: { dataset: { index: question } },
      detail: { value: id },
    });
  },
  choosePrediction(event) {
    if (
      this.data.result ||
      this.data.predictionLocked ||
      this.data.busy ||
      this.data.loading ||
      this.data.helpBusy
    )
      return;
    const prediction = event.currentTarget.dataset.prediction;
    if (PREDICTIONS[prediction])
      this.setData({ prediction, fail: "", helpError: "" });
  },
  submit() {
    const point = this.data.point;
    if (!point || !point.problem) return;
    if (point.retestMode && !this.data.prediction) {
      this.setData({ fail: "先猜猜这次能不能做出来" });
      return;
    }
    // Choice: the option of each question; blanks: ASCII numbers ("-3/4"),
    // one string for one blank; "-0" goes as "0".
    const values = this.data.answers.map((s) =>
      point.problem.format === "choice" ? String(s || "").trim() : pad.normalize(String(s || "").trim()),
    );
    const structured = point.problem.format === "choice" || values.length > 1;
    const answer = structured ? values : values[0];
    const filled = filledAll(point.problem, values);
    if (
      !filled ||
      this.data.loading ||
      this.loadRequest ||
      this.data.busy ||
      this.data.marking ||
      this.data.helpBusy ||
      this.data.done
    )
      return;
    const active = ownedFor(this),
      prediction = this.data.prediction,
      wasRetest = point.retestMode;
    this.setData({ busy: true, fail: "" });
    const request = api
      .post(`/v1/learn/points/${encodeURIComponent(point.id)}/submit`, {
        answer,
        index: point.problem.index,
        tone: TONE,
        ...(wasRetest ? { predicted: prediction } : {}),
      })
      .then((res) => {
        if (!active()) return;
        // The tier's cells come from the map, read again after a lit answer.
        const map =
          res.counted === "lit"
            ? api.get("/v1/learn/map").catch(() => null)
            : null;
        return Promise.resolve(map).then((m) => {
          const current = this.data.point;
          if (
            !active() ||
            !current ||
            current.id !== point.id ||
            !current.problem ||
            current.problem.index !== point.problem.index
          )
            return;
          const result = withRetestResult(
            resultView(res, point, m),
            res,
            prediction,
            wasRetest,
            wasRetest && Boolean(this.data.hint || this.data.explanation),
          );
          // Judged: nothing is left to keep for this problem.
          if (res.verdict !== "unsure") learningSpace.keepPointDraft((auth.getUser() || {}).id, point.id, null);
          // 这题有问题 sends the last answer the server judged on this page.
          this.lastAnswer = structured ? answer.slice() : answer;
          this.lastAnswerIndex = point.problem.index;
          // Settled (right or wrong): the solution is shown and 下一题 is next;
          // round the bank back to the first one, the bank is done.
          const settled = res.verdict !== "unsure";
          const total = point.problem.total;
          const bankDone =
            settled && total > 0 && (point.problem.index + 1) % total === this.firstIndex;
          // Practice (看过解析 today) does not light the point or clear 我会了.
          const counts =
            res.counted === "lit" ||
            res.counted === "again" ||
            res.counted === "review";
          const state = counts
            ? "correct"
            : res.counted === "lapse"
              ? "due"
              : null;
          this.setData({
            result,
            "point.practice": Boolean(res.practice),
            done: settled,
            bankDone,
            correct: this.data.correct || counts,
            self: counts ? false : this.data.self,
            ...(state
              ? { "point.cell": state, "point.stateText": STATE_TEXT[state] }
              : {}),
            ...(counts
              ? { "point.review": false }
              : res.counted === "lapse"
                ? { "point.review": true }
                : {}),
            sheet: result.sheet,
            // The book card takes the place of the chapter sheet; the result's
            // chapter row still opens the sheet.
            sheetOpen: Boolean(result.sheet) && !result.book,
            book: result.book,
            bookOpen: Boolean(result.book),
            predictionLocked: wasRetest,
            wrongNote: result.retestWrong ? this.data.wrongNote : "",
          });
          // a long choice problem leaves the result below the options;
          // bring the verdict and the solution up before 下一题 can be tapped.
          if (point.problem.format === "choice" && typeof wx.pageScrollTo === "function")
            wx.pageScrollTo({ selector: ".result", offsetTop: -16, duration: 200 });
          if (res.learningCards && res.learningCards.cardIds.length) {
            api
              .get(`/v1/cards/learning/${res.learningCards.proofId}`)
              .then((saved) => {
                const current = this.data.point;
                if (
                  active() &&
                  current &&
                  current.id === point.id &&
                  current.problem &&
                  current.problem.index === point.problem.index
                )
                  this.setData({ learningCards: saved.cards });
              })
              .catch(() => {});
          }
        });
      })
      .catch((error) => {
        if (!active() || api.needsConsent(error)) return;
        // A retest fell due on another problem meanwhile: open that one.
        if (error && error.statusCode === 409 && error.code === "RETEST_CHANGED") {
          wx.showToast({ title: "题换了一道", icon: "none" });
          this.answerRequest = null;
          return this.load({ fresh: true });
        }
        this.setData({ fail: errorText(error) });
      })
      .finally(() => {
        this.answerRequest = null;
        if (active()) this.setData({ busy: false });
      });
    this.answerRequest = request;
    return request;
  },
  // 我会了，先跳过 / 撤销“我会了”.
  toggleSelf() {
    if (
      this.data.loading ||
      this.loadRequest ||
      this.data.busy ||
      this.data.marking ||
      this.data.helpBusy ||
      this.data.correct
    )
      return;
    const action = this.data.self ? "unself" : "self";
    const active = activeFor(this),
      cleanup = ownedFor(this);
    this.setData({ marking: true, fail: "" });
    const request = api
      .post("/v1/learn/marks", { action, pointId: this.id })
      .then((res) => {
        if (!active()) return;
        const self = res.state === "self";
        this.setData({
          self,
          "point.cell": res.state === "none" ? "" : res.state,
          "point.stateText": STATE_TEXT[res.state] || "",
        });
        wx.showToast({
          title: self ? "记下了，你会这个" : "改回来了",
          icon: "none",
        });
      })
      .catch((error) => {
        if (active() && !api.needsConsent(error))
          this.setData({ fail: errorText(error) });
      })
      .finally(() => {
        this.markRequest = null;
        if (cleanup()) this.setData({ marking: false });
      });
    this.markRequest = request;
    return request;
  },
  showHint() {
    return this.confirmHelp(false);
  },
  rememberStuck() {
    const point = this.data.point;
    if (
      !point ||
      this.data.loading ||
      this.data.busy ||
      this.data.marking ||
      this.data.helpBusy
    )
      return;
    getApp().globalData.noteContext = { pointId: point.id, name: point.name };
    wx.switchTab({ url: "/pages/notes/index" });
  },
  clearRed() {
    const point = this.data.point;
    if (
      !point ||
      !point.red ||
      this.data.loading ||
      this.data.busy ||
      this.data.marking ||
      this.data.helpBusy
    )
      return;
    const active = activeFor(this),
      cleanup = ownedFor(this);
    this.setData({ marking: true, fail: "" });
    const request = api
      .post("/v1/learn/marks", { action: "unred", pointId: point.id })
      .then(() => {
        if (!active()) return;
        if (this.data.point && this.data.point.id === point.id)
          this.setData({ "point.red": false });
      })
      .catch((error) => {
        if (active() && !api.needsConsent(error))
          this.setData({ fail: errorText(error) });
      })
      .finally(() => {
        this.markRequest = null;
        if (cleanup()) this.setData({ marking: false });
      });
    this.markRequest = request;
    return request;
  },
  showExplanation() {
    return this.confirmHelp(true);
  },
  confirmHelp(explanation) {
    if (
      this.data.helpBusy ||
      this.data.busy ||
      this.data.marking ||
      this.data.loading ||
      this.confirmingHelp
    )
      return;
    if (this.data[explanation ? "explanation" : "hint"]) return;
    const p = this.data.point;
    if (
      !p ||
      !p.problem ||
      !(explanation ? p.problem.hasExplanation : p.problem.hasHint)
    )
      return;
    if (p.retestMode && !this.data.prediction) {
      this.setData({ helpError: "先猜猜这次能不能做出来" });
      return;
    }
    const active = activeFor(this);
    this.confirmingHelp = true;
    wx.showModal({
      title: explanation ? "看完整解析？" : "看提示？",
      content: this.data.correct
        ? `会显示${explanation ? "完整解法" : "提示"}，做对过的不受影响。`
        : `看了${explanation ? "解析" : "提示"}，今天做对先算练习。`,
      confirmText: explanation ? "看解析" : "看提示",
      success: ({ confirm }) => {
        if (confirm && active()) this.loadHelp(explanation);
      },
      complete: () => {
        if (active()) this.confirmingHelp = false;
      },
    });
  },
  loadHelp(explanation) {
    const p = this.data.point;
    if (
      !p ||
      !p.problem ||
      this.data.helpBusy ||
      this.data.busy ||
      this.data.marking ||
      this.data.loading
    )
      return Promise.resolve();
    const problem = p.problem;
    if (explanation ? !problem.hasExplanation : !problem.hasHint)
      return Promise.resolve();
    if (this.data[explanation ? "explanation" : "hint"])
      return Promise.resolve();
    const active = activeFor(this),
      cleanup = ownedFor(this),
      wasRetest = p.retestMode,
      prediction = this.data.prediction;
    if (wasRetest && !prediction) {
      this.setData({ helpError: "先猜猜这次能不能做出来" });
      return Promise.resolve();
    }
    this.setData({ helpBusy: true, helpError: "" });
    const request = api
      .post("/v1/learn/marks", {
        action: explanation ? "explanation" : "hint",
        pointId: p.id,
        index: problem.index,
        tone: TONE,
        ...(wasRetest ? { predicted: prediction } : {}),
      })
      .then((res) => {
        const current = this.data.point;
        if (
          !active() ||
          !current ||
          current.id !== p.id ||
          !current.problem ||
          current.problem.index !== res.index
        )
          return;
        this.setData({
          [explanation ? "explanation" : "hint"]: res.blocks,
          "point.practice": true,
          predictionLocked: wasRetest || this.data.predictionLocked,
          helpNotice: wasRetest
            ? "看了提示，这一轮先不算过。"
            : `看过${explanation ? "解析" : "提示"}，今天做对先算练习。`,
        });
      })
      .catch((error) => {
        if (active() && !api.needsConsent(error))
          this.setData({ helpError: errorText(error) });
      })
      .finally(() => {
        this.helpRequest = null;
        if (cleanup()) this.setData({ helpBusy: false });
      });
    this.helpRequest = request;
    return request;
  },
  openLearningCard(event) {
    const id = event.currentTarget.dataset.id;
    if (this.data.learningCards.some((card) => card.id === id))
      wx.navigateTo({
        url: `/pages/card/index?id=${encodeURIComponent(id)}`,
      });
  },
  wrongNoteInput(event) {
    this.setData({ wrongNote: event.detail.value });
  },
  collectWrong() {
    const point = this.data.point,
      quote = this.data.wrongNote.trim();
    if (!point || !this.data.result || !this.data.result.retestWrong) return;
    if (!quote) {
      this.setData({ fail: "先写下卡在哪一步" });
      return;
    }
    getApp().globalData.collect = {
      mode: "message",
      origin: "map",
      scene: "study",
      type: "question",
      title: "",
      mine: "",
      quote,
      quotes: [quote],
      pointId: point.id,
      pointName: point.name,
    };
    wx.navigateTo({ url: "/pages/collect/index" });
  },
  later() {
    wx.navigateBack();
  },
  // The kp card opens its key points, 先弄懂, the chapter link and ⋯.
  toggleKp() {
    this.setData({ kpOpen: !this.data.kpOpen });
  },
  // 卡住了？: a hint, the full solution or a note about the stuck step.
  openStuck() {
    const p = this.data.point;
    if (!p || !p.problem) return;
    // A retest offers the solution only after the answer is in.
    const items = [
      p.problem.hasHint && !this.data.hint && ["给点提示", () => this.showHint()],
      p.problem.hasExplanation &&
        !this.data.explanation &&
        (!p.retestMode || this.data.result) && [
          "看完整解析",
          () => this.showExplanation(),
        ],
      ["记下卡住的一步", () => this.rememberStuck()],
    ].filter(Boolean);
    const active = activeFor(this);
    wx.showActionSheet({
      itemList: items.map((item) => item[0]),
      success: ({ tapIndex }) => {
        if (active() && items[tapIndex]) items[tapIndex][1]();
      },
    });
  },
  // ⋯: 我会了，先跳过 (not in a retest), 先不做 and 这题有问题; without a
  // problem there is no 卡住了？, so 记下卡住的一步 lives here.
  openMore() {
    const p = this.data.point;
    if (!p) return;
    const items = [
      !this.data.done &&
        !this.data.correct && [
          this.data.self ? "撤销“我会了”" : "我会了，先跳过",
          () => this.toggleSelf(),
        ],
      !this.data.result &&
        !this.data.correct && ["先不做", () => this.later()],
      p.problem && ["这题有问题", () => this.openReport()],
      !p.problem && ["记下卡住的一步", () => this.rememberStuck()],
    ].filter(Boolean);
    if (!items.length) return;
    const active = activeFor(this);
    wx.showActionSheet({
      itemList: items.map((item) => item[0]),
      success: ({ tapIndex }) => {
        if (active() && items[tapIndex]) items[tapIndex][1]();
      },
    });
  },
  openPrereq(event) {
    wx.redirectTo({
      url: `/pages/point/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}`,
    });
  },
  openNext() {
    const next = this.data.result && this.data.result.next;
    if (next) wx.redirectTo({ url: `/pages/point/index?id=${encodeURIComponent(next.id)}` });
  },
  openSheet() {
    if (this.data.sheet) this.setData({ sheetOpen: true });
  },
  closeSheet() {
    this.setData({ sheetOpen: false });
  },
  // The result's 全书 row opens the book card again after 好.
  openBook() {
    if (this.data.book) this.setData({ bookOpen: true });
  },
  // 好 on the book card: back to the result.
  closeBook() {
    this.setData({ bookOpen: false });
  },
  // Taps inside the sheet stay there.
  hold() {},
  // 这题有问题: pick a reason, then report(reason) does the work.
  openReport() {
    const active = activeFor(this);
    wx.showActionSheet({
      itemList: REPORTS.map((r) => r[0]),
      success: (res) => {
        if (!active()) return;
        const r = REPORTS[res.tapIndex];
        if (r) this.report(r[1]);
      },
    });
  },
  report(reason) {
    if (this.data.reporting || !this.data.point) return Promise.resolve();
    const active = activeFor(this),
      cleanup = ownedFor(this);
    // form "bank": the answer is to the problem as this page shows it.
    const body = { reason, form: "bank" };
    if (this.data.point.problem) body.index = this.data.point.problem.index;
    if (this.lastAnswer && body.index === this.lastAnswerIndex)
      body.answer = this.lastAnswer;
    this.setData({ reporting: true });
    return api
      .post(
        `/v1/learn/points/${encodeURIComponent(this.data.point.id)}/report`,
        body,
      )
      .then(() => {
        if (active())
          wx.showToast({ title: "收到了，谢谢", icon: "none" });
      })
      .catch((error) => {
        // A toast, not the answer box's line: the link is at the bottom of the page.
        if (active() && !api.needsConsent(error))
          wx.showToast({
            title: (error && error.message) || errorText(error),
            icon: "none",
          });
      })
      .finally(() => {
        if (cleanup()) this.setData({ reporting: false });
      });
  },
  // 下一题: the bank problem after this one.
  nextProblem() {
    const problem = this.data.point && this.data.point.problem;
    if (!problem || this.data.busy || this.data.loading) return;
    if (typeof wx.pageScrollTo === "function") wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    return this.load({ after: problem.index });
  },
  // 让 AI 再出一道 (aiPractice points, after the bank): a problem of the same
  // point in the same choice look, judged by POST /v1/chat/messages/:id/answer.
  // one request per problem wanted. Its clientId is kept on this
  // phone (per account and point) until the problem is on screen: a retry, a
  // timeout or leaving and coming back gets the same problem, not another
  // one to pay for.
  aiStart() {
    const point = this.data.point;
    if (!point || this.data.aiBusy || this.data.aiSending) return;
    const active = ownedFor(this);
    // A newer AI request (or another account's) owns the busy flags.
    const seq = (this.aiSeq = (this.aiSeq || 0) + 1);
    const mine = () => active() && seq === this.aiSeq;
    const slot = `practice:${point.id}`;
    const kept = tools.kept(slot);
    const pending = kept && kept.clientId ? kept : { clientId: stream.clientId(), at: Date.now() };
    tools.keep(slot, pending);
    // the wait card sits below the fixed bottom bar's buttons;
    // bring it (the steps and the time) into view once it is drawn.
    this.setData({ aiBusy: true, aiAt: pending.at, aiError: "", aiRetry: false }, () => {
      if (mine() && typeof wx.pageScrollTo === "function")
        wx.pageScrollTo({ selector: ".ai-wait", offsetTop: -16, duration: 200 });
    });
    return api
      .post("/v1/chat/practice", { pointId: point.id, clientId: pending.clientId, tone: TONE }, { timeout: 150000 })
      .then(({ thread, message }) => {
        // Not shown (the page is gone): kept, and fetched again unpaid.
        if (!mine()) return;
        tools.drop(slot);
        this.setData({
          ai: aiView(message, thread && thread.id),
          aiPick: -1,
          aiResult: null,
          sheetOpen: false,
          bookOpen: false,
        });
        if (typeof wx.pageScrollTo === "function") wx.pageScrollTo({ scrollTop: 0, duration: 0 });
      })
      .catch((error) => {
        // Refused, not lost: the next tap is a new request.
        if (!transient(error)) tools.drop(slot);
        if (mine() && !api.needsConsent(error)) this.setData({ aiError: errorText(error) });
      })
      .finally(() => {
        if (mine()) this.setData({ aiBusy: false });
      });
  },
  aiLeave() {
    wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: "/pages/learn/index" }) });
  },
  aiChoose(event) {
    if (!this.data.ai || this.data.aiResult || this.data.aiSending) return;
    const i = Number(event.currentTarget.dataset.index);
    if (i >= 0 && i < this.data.ai.options.length) this.setData({ aiPick: i });
  },
  aiSubmit() {
    const ai = this.data.ai;
    if (!ai || this.data.aiPick < 0 || this.data.aiResult || this.data.aiSending) return;
    const active = ownedFor(this);
    const seq = (this.aiSeq = (this.aiSeq || 0) + 1);
    const mine = () => active() && seq === this.aiSeq && this.data.ai && this.data.ai.id === ai.id;
    this.setData({ aiSending: true, aiError: "", aiRetry: false });
    return api
      .post(`/v1/chat/messages/${encodeURIComponent(ai.id)}/answer`, {
        choice: this.data.aiPick,
        clientId: stream.clientId(),
        tone: TONE,
      })
      .then(({ judge }) => {
        if (!mine()) return;
        const r = judge && judge.attempt && judge.attempt.result;
        const verdict = (r && r.verdict) || "unsure";
        this.setData({
          aiResult: {
            tone: verdict === "correct" ? "good" : verdict === "incorrect" ? "bad" : "unsure",
            text:
              verdict === "correct"
                ? "做对了"
                : verdict === "incorrect"
                  ? "不对，看看下面的步骤"
                  : "这次没判出来",
          },
        });
        // The right option, the steps and the answer show once picked.
        return this.aiReveal(ai, mine);
      })
      .catch((error) => {
        if (mine() && !api.needsConsent(error)) this.setData({ aiError: errorText(error) });
      })
      .finally(() => {
        if (mine()) this.setData({ aiSending: false });
      });
  },
  // Reads the answered AI problem again for its right option and steps; a
  // failure leaves a line to tap and read it again.
  aiReveal(ai, mine) {
    return api
      .get(`/v1/chat/messages/${encodeURIComponent(ai.id)}?tone=${TONE}`)
      .then((fresh) => {
        if (mine()) this.setData({ ai: aiView(fresh, ai.threadId), aiError: "", aiRetry: false });
      })
      .catch((error) => {
        if (mine() && !api.needsConsent(error))
          this.setData({ aiError: "步骤没加载出来，点这里再试", aiRetry: true });
      });
  },
  aiReload() {
    const ai = this.data.ai;
    if (!ai || !this.data.aiRetry || this.data.aiSending) return;
    const active = ownedFor(this);
    const seq = (this.aiSeq = (this.aiSeq || 0) + 1);
    const mine = () => active() && seq === this.aiSeq && this.data.ai && this.data.ai.id === ai.id;
    this.setData({ aiSending: true, aiRetry: false, aiError: "" });
    return this.aiReveal(ai, mine).finally(() => {
      if (mine()) this.setData({ aiSending: false });
    });
  },
  // An AI problem without options is answered in its chat.
  aiOpenChat() {
    const ai = this.data.ai;
    if (ai && ai.threadId) openAsk({ threadId: ai.threadId });
  },
  // 看讲解 and 回详情: the point's detail page.
  openDetail() {
    if (this.data.point) this.leave(ROUTES.knowledge, this.data.point.id);
  },
  // 换个知识点: the 题库.
  goBank() {
    this.leave(ROUTES.bank);
  },
  // Leaving closes the sheet and the book card: this page stays in the stack
  // and a later backTo returns to it. The result's row reopens the sheet.
  leave(route, id) {
    this.setData({ sheetOpen: false, bookOpen: false });
    backTo(route, id);
  },
  goLearn() {
    this.leave(ROUTES.learn);
  },
  goMap() {
    this.leave(ROUTES.map);
  },
  // The head's "3.3 · 第 3 章 中值与应用" and the sheet's 接着做这一章.
  openChapter() {
    if (this.data.point)
      this.leave(ROUTES.chapter, this.data.point.chapterId);
  },
}));

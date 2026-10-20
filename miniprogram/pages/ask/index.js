/*
 * 解题页面：先确认题面与卡点，再发送、接收流式回答、作答或保存卡片；批改和讲一遍有独立页面。
 * 页面中的请求标识、账号快照和 alive 状态用于拦截过期回包；不能仅因离开页面就删除另一份新草稿。
 */
// 拍照或输入题目后，先确认题面，再选择“没思路／做到一半卡住／直接看解法”。
// 批改和讲一遍分别进入自己的页面，各工具只展示自己的历史。
const api = require("../../utils/api");
const auth = require("../../utils/auth");
const stream = require("../../utils/stream");
const { plainAll } = require("../../utils/blocks");
const { errorText, when, dueText } = require("../../utils/format");
const gate = require("../../utils/gate");
const { copyAi } = require("../../utils/copy");
const studyClock = require("../../utils/study-clock");
const keyboard = require("../../utils/keyboard");
const { backTo, ROUTES } = require("../../utils/learn");
const learningSpace = require("../../utils/learning-space");
const chatV2 = require("../../utils/chat-v2");
const { pickFailed } = require("../../utils/pick");
const tools = require("../../utils/tools");
const budgets = require("../../utils/budget");
const { transient } = require("../../utils/job");
const { lineTex, lineBlocks } = require("../../utils/tex");
// 公式墨迹；两种皮肤都是浅色页面上的深色文字。
const TONE = "light";
// 继续上次的会话指针通过 learning-space 按账号保存，切换账号后不能读到另一个人的指针。
const owner = () => (auth.getUser() || {}).id;
const PHOTO_LIMIT = 5 * 1024 * 1024;
// 用户点过段落后记录此标记，此后不再显示该操作提示。
const TIP = "ask_tip_seen";
// 核对结果角标：一致时保持低强调，不一致时突出提示。
// ── 界面字典与展示转换 ──
const VERIFY = {
  pass: { tone: "green", mark: "✓", text: "算过一遍，对得上" },
  partial: { tone: "green", mark: "✓", text: "算过其中几步，对得上" },
  conflict: { tone: "red", mark: "对不上", text: "我又算了一遍，对不上，你也核一下" },
  unsure: { tone: "amber", mark: "拿不准", text: "又算了一遍，还是拿不准，你也核一下" },
};
const ITEM = { pass: "对得上", fail: "对不上", unknown: "拿不准" };
const VERDICT = {
  correct: { tone: "green", mark: "tick-green", title: "做对了" },
  incorrect: { tone: "red", mark: "cross-red", title: "还差一点" },
  unsure: { tone: "amber", mark: "query-pencil", title: "这题我拿不准对错" },
};
// 参考答案的来源。
const SOURCE = {
  user: { text: "你给的答案", tone: "ink" },
  rule: { text: "算过一遍，对得上", tone: "green" },
  ai: { text: "AI 给的，没核对过", tone: "amber" },
};
function sourceOf(answer) {
  if (!answer) return { text: "", tone: "" };
  if (answer.disputed) return { text: "我又算了一遍，对不上，你也核一下", tone: "red" };
  return SOURCE[answer.source] || { text: "", tone: "" };
}
// 一道要试做的题目。
const EXAMPLES = [
  {
    show: "求 lim(x→0) sin3x/x",
    text: String.raw`求极限 $\lim_{x\to 0}\frac{\sin 3x}{x}$`,
    problem: true,
  },
];
// 练一题可抽取的章节（学习页提供同样的章节）。
const PRACTICE = ["limit", "derivative", "application", "indefinite", "definite"];
// 空页面上最近显示多少条解题对话。
const RECENT = 3;
// 相机菜单中的“批改”进入统一批改页。
const PHOTOS = [
  { purpose: "problem", text: "拍一道题" },
  { purpose: "grade", text: "拍下我写的，批改" },
];
// 历史一次来一页（服务器最多发100条）。
const PAGE = 100;
const PENDING_JOB = ["queued", "running"];
// 这些长请求没有真实阶段事件，因此等待条只随时间变化，不显示百分比，也不承诺离开后继续取得结果。
const WAIT_STEPS = {
  scan: [{ key: "send", label: "传照片" }, { key: "read", label: "认照片里的字" }],
  // 出题和同类题：服务器先生成一道，再检查它的答案。
  make: [{ key: "make", label: "出一道题" }, { key: "check", label: "核对答案" }],
  wrap: [{ key: "wrap", label: "整理这段对话" }],
};
// 单选题的选项。
const LETTERS = ["A", "B", "C", "D"];

// 同一张照片中的其他题目缩短后显示为选项按钮；pendingText 是服务端给出的公式纯文本。
function short(text) {
  const s = String(text || "");
  return s.length > 16 ? `${s.slice(0, 16)}…` : s;
}
// 错题状态行显示“今天再做一次”或“明天再做一次”；这里只显示到期信息，不发送推送。
function mistakeText(mistake) {
  if (!mistake || mistake.status !== "open") return "";
  return `${mistake.due ? "今天" : dueText(mistake.dueOn)}再做一次`;
}
function threadOf(thread) {
  if (!thread) return null;
  const pending = thread.pending || [];
  return {
    ...thread,
    pending,
    currentCards: thread.currentCards || [],
    pendingShow: (thread.pendingText || pending).map(short),
    mistake: thread.mistake || null,
    mistakeText: mistakeText(thread.mistake),
  };
}

function verdictOf(m) {
  const r = m.attempt && m.attempt.result;
  if (!r) {
    const pending = Boolean(m.job) && PENDING_JOB.includes(m.job.status);
    return {
      pending,
      failed: !pending,
      text: pending ? "" : api.jobMessage(m.job) || "这次没看出对错，再交一次试试",
    };
  }
  const head = VERDICT[r.verdict] || VERDICT.unsure;
  const source = sourceOf(r.reference);
  return {
    ...head,
    answer: typeof m.choice === "number" ? LETTERS[m.choice] || "" : m.attempt.answer,
    reference: r.reference ? r.reference.text || r.reference.value : "",
    sourceText: source.text,
    sourceTone: source.tone,
    cause: r.cause ? r.cause.label : "",
    revealed: r.revealSolution,
  };
}
// 加上页面显示的内容：对勾和判定结果。
function decorate(m) {
  const v = m.verify && VERIFY[m.verify.state];
  return {
    ...m,
    blocks: m.blocks || [],
    tail: m.tail || "",
    thinking: Boolean(m.thinking),
    badge: v ? { ...v } : null,
    verdict: m.kind === "judge" ? verdictOf(m) : null,
    similarOf: m.similarOf || "",
    errorText: m.error ? m.error.message : "",
    guide: m.guide || null,
    cards: m.cards || [],
    // 服务器把用户的话作为 plain 发送。
    plain: m.plain || m.content || "",
    // 单选题上的一次选择：选了哪个选项，选错时给出步骤。
    choice: typeof m.choice === "number" ? m.choice : -1,
    steps: m.steps || null,
    picked: typeof m.picked === "number" ? m.picked : -1,
  };
}
// 每道单选题选了哪个选项，来自其后的判定。
function markPicks(list) {
  const picked = {};
  list.forEach((m) => {
    if (m.kind === "judge" && m.similarOf && m.choice >= 0) picked[m.similarOf] = m.choice;
  });
  return list.map((m) => (m.kind === "similar" && m.id in picked ? { ...m, picked: picked[m.id] } : m));
}
// 在最新回复之后提供什么。
function nextActions(thread, messages) {
  if (messages.length && messages[messages.length - 1].crisis) return [];
  const last = messages.filter((m) => m.role === "assistant").pop();
  if (!last || last.status === "streaming") return [];
  const problem = Boolean(thread && thread.problem);
  const out = [];
  if (last.kind === "judge") {
    const v = last.verdict || {};
    if (v.pending) return [];
    // 对相似题的回答：换一道，或再试一次。
    if (last.similarOf) {
      const sim = messages.find((m) => m.id === last.similarOf);
      const practice = Boolean(sim && sim.practice);
      // 错误选项已显示步骤：继续下一题。
      if (last.choice >= 0 && v.tone !== "green")
        return [practice ? { key: "nextPractice", text: "下一题", primary: true } : { key: "similar", text: "再来一道", primary: true }];
      if (v.tone === "green")
        return [
          practice ? { key: "nextPractice", text: "下一题", primary: true } : { key: "similar", text: "再来一道", primary: true },
          { key: "map", text: "去地图上看看" },
        ];
      out.push({ key: "answerSimilar", text: "再试一次", primary: true });
      if (practice) out.push({ key: "hint", text: "给我一点提示" });
      if (sim && sim.similar && !sim.similar.revealed) out.push({ key: "revealSimilar", text: "看答案和解析" });
      return out;
    }
    if (v.failed) return [{ key: "answer", text: "重新交答案", primary: true }];
    if (v.tone === "green" && problem) out.push({ key: "similar", text: "出一道同类题", primary: true });
    else {
      // 漏掉积分常数 C 或符号相反等错误，需要重新作答后确认修正。
      const again = v.tone === "red" && problem;
      if (again) out.push({ key: "answer", text: "再试一次", primary: true });
      out.push({ key: "more", text: "给我一点提示", primary: !again });
    }
    if (!v.revealed) out.push({ key: "solution", text: "看完整解析" });
    if (v.tone === "green") out.push({ key: "map", text: "去地图上看看" });
    return out;
  }
  if (last.kind === "similar") {
    const open = last.similar && !last.similar.revealed;
    // 选项在卡片本身上选择。
    const options = Boolean(last.similar && last.similar.options && last.similar.options.length);
    if (open && !options) out.push({ key: "answerSimilar", text: "我来作答", primary: true });
    if (last.practice) {
      if (open) out.push({ key: "hint", text: "给我一点提示" });
      out.push({ key: "nextPractice", text: "下一题", primary: !open });
      return out;
    }
    out.push({ key: "similar", text: "再来一道" });
    return out;
  }
  if (last.status === "failed") return [{ key: "retry", text: "重试", primary: true }];
  const hint = last.mode === "auto" && (last.kind === "reply" || last.kind === "recheck");
  // 练习题在它的卡片上有已核对的答案，以及下一题。
  const practice = Boolean(thread && thread.practice);
  if (problem) {
    if (hint) {
      out.push({ key: "answer", text: "我算出来了", primary: true });
      out.push({ key: "more", text: "再给一步提示" });
      out.push(practice ? { key: "revealSimilar", text: "看答案和解析" } : { key: "solution", text: "看完整解析" });
    } else if (practice) {
      out.push({ key: "nextPractice", text: "下一题", primary: true });
      out.push({ key: "answer", text: "我来作答" });
      out.push({ key: "draft", text: "拍我的过程批改" });
    } else {
      out.push({ key: "similar", text: "出一道同类题", primary: true });
      out.push({ key: "answer", text: "我来作答" });
      out.push({ key: "draft", text: "拍我的过程批改" });
    }
    if (last.mode === "grade") out.push({ key: "map", text: "去地图上看看" });
    return out;
  }
  // 学习问题；聊生活或心情没有练习可提供。
  if (!thread || !thread.scene || thread.scene === "study") {
    out.push({ key: "example", text: "举个例子" });
    out.push({ key: "simpler", text: "讲得再简单点" });
    out.push({ key: "practice", text: "出一道题给我练" });
  }
  if (last.mode === "grade") out.push({ key: "map", text: "去地图上看看" });
  return out;
}
// 服务器标记每条新回复：是否为引导式（一道题，逐步做完）或非引导式。旧版本回复没有标记，沿用上面的启发式规则。
function guidedActions(thread, messages) {
  const last = chatV2.latestAssistant(messages);
  if (!last || last.crisis || last.status !== "done") return null;
  if (typeof last.guided !== "boolean" || (thread && thread.mode === "teach"))
    return null;
  if (["judge", "similar"].includes(last.kind)) return null;
  if (!last.guided)
    return [
      { key: "example", text: "举个例子" },
      { key: "simpler", text: "讲简单点" },
    ];
  const practice = Boolean(thread && thread.practice);
  return [
    { key: thread && thread.problem ? "answer" : "answerFree", text: "我算出来了", primary: true },
    { key: "more", text: "再给一步提示" },
    practice ? { key: "revealSimilar", text: "看答案和解析" } : { key: "solution", text: "看完整解析" },
  ];
}
function pageActions(thread, messages) {
  if (messages.length && messages[messages.length - 1].crisis) return [];
  return (
    guidedActions(thread, messages) ||
    chatV2.actions(thread, messages, true, nextActions(thread, messages))
  );
}
// 生成最新回复下方的快捷操作，并只在对应回复提供“＋ 存成卡”。
function steps(thread, messages) {
  return { actions: pageActions(thread, messages), collectId: chatV2.collectTarget(messages) };
}
const QUICK = {
  hint: { text: "给我一点提示", mode: "auto" },
  more: { text: "继续，给我下一步提示", mode: "auto" },
  solution: { text: "给我看完整解析", mode: "solution" },
  example: { text: "能举一个具体的例子吗？", mode: "auto" },
  simpler: { text: "讲得再简单一点，用大白话说", mode: "auto" },
};
function scanView(scan, purpose, photo) {
  const problems = (scan.problems || []).map((p, index) => ({ ...p, index }));
  const kind =
    scan.type === "solution" && scan.solution
      ? "solution"
      : problems.length
        ? "problems"
        : scan.type === "notes" && scan.notes
          ? "notes"
          : "none";
  const homework = scan.homework > 1 ? scan.homework : 0;
  const titles = {
    problems: homework
      ? `这是一页作业，认出 ${homework} 道题`
      : problems.length > 1
        ? `认出 ${problems.length} 道题，选一道来问`
        : "认出了这道题",
    solution: "认出了你的解题过程",
    notes: "这张像是笔记或讲义",
    none: "这张没认出题目",
  };
  return {
    imageId: scan.imageId,
    photo,
    purpose,
    kind,
    title: titles[kind],
    problems,
    solution: scan.solution,
    notes: scan.notes || "",
    homework,
    mismatch:
      purpose === "draft" && kind === "problems" && !homework
        ? "这张像是题目，不像解题过程，可以直接问这道题。"
        : purpose === "problem" && kind === "solution"
          ? "这张像是你写的解题过程，可以去批改。"
          : purpose === "homework" && kind === "problems" && !homework
            ? "没认出一页作业，可以一道一道问。"
            : "",
    editing: -1,
    editText: "",
  };
}
// 每份待确认题面都有自己的 id；识别出的步骤只能写回这份题面，页面也只能清除自己展示的题面。
// at 记录题面创建时间，照片题面取发起识别的时间；晚到照片只能替换比它更旧的题面。
const checkKey = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
// 拍题识别后生成待确认题面，用户确认或编辑后再选择解题方式。
function confirmView(scan, photo, at) {
  const problems = (scan.problems || []).map((p, index) => ({ ...p, index }));
  const first = problems[0];
  return {
    key: checkKey(),
    at: at || Date.now(),
    imageId: scan.imageId || "",
    photo: photo || "",
    title: problems.length > 1 ? `认出 ${problems.length} 道题，选一道` : first ? "认出了这道题" : scan.type === "solution" ? "这张像是解题过程" : "这张没认出题目",
    problems,
    index: 0,
    text: first ? first.text : "",
    blocks: first ? first.blocks || [] : [],
    unclear: first ? first.unclear || "" : "",
    editing: false,
    typed: false,
    suggest: tools.suggestOf(scan, "problem"),
    notes: problems.length ? "" : scan.notes || "",
  };
}
// 手动输入的题目也进入同一个确认流程，并立即允许编辑。
function typedView(text) {
  return {
    key: checkKey(),
    at: Date.now(),
    imageId: "",
    photo: "",
    title: "确认题目",
    problems: [{ text, index: 0, blocks: [] }],
    index: 0,
    text,
    blocks: [],
    unclear: "",
    editing: true,
    typed: true,
    suggest: null,
    notes: "",
  };
}
// 识别步骤只写入这份确认稿的第 i 题：当前题写入 stuck，其他题写入 problems[i].stuck。
// 不能覆盖较晚识别的步骤；返回更新后的确认稿与卡点状态，无法匹配时返回 null。
function withSteps(confirm, stuck, i, steps, sentAt) {
  const fill = (s) => (s && !((s.at || 0) > sentAt) ? { ...s, lines: steps.slice(0, 40), at: sentAt } : null);
  if (confirm.index === i) {
    const next = fill(stuck);
    return next && { confirm, stuck: next };
  }
  const p = confirm.problems[i];
  const next = p && fill(p.stuck);
  if (!next) return null;
  const problems = confirm.problems.slice();
  problems[i] = { ...p, stuck: next };
  return { confirm: { ...confirm, problems }, stuck };
}
// 把第 i 题识别出的步骤写入本机保存的对应确认稿。
function keepSteps(key, i, steps, sentAt) {
  const kept = tools.kept("ask");
  const next = key && kept && kept.confirm && kept.confirm.key === key && withSteps(kept.confirm, kept.stuck, i, steps, sentAt);
  if (next) tools.keep("ask", { ...kept, ...next });
}
// 切换到照片的第 i 题时，先保存离开那题的卡点，再恢复目标题自己的卡点。
function showProblem(confirm, stuck, i) {
  const p = confirm.problems[i];
  if (!p || p.index === confirm.index) return { confirm, stuck };
  const problems = confirm.problems.map((q) =>
    q.index === confirm.index ? { ...q, stuck } : q.index === p.index ? { ...q, stuck: null } : q,
  );
  return {
    confirm: { ...confirm, problems, index: p.index, text: p.text, blocks: p.blocks || [], unclear: p.unclear || "", editing: confirm.typed, pv: null },
    stuck: p.stuck || null,
  };
}
// 服务端接收照片第 i 题后，将该题标为已问并清除其卡点，不再重复提供。
// 若照片的其他题仍有卡点或正在识别步骤，继续保存整份确认稿，供“上次拍的题”恢复。
function afterAsked(check, i) {
  const { confirm } = check;
  const open = (p) => p.index !== i && !p.asked && (p.index === confirm.index ? check.stuck : p.stuck);
  const next = (confirm.problems || []).find(open);
  if (!next) return null;
  const problems = confirm.problems.map((p) => (p.index === i ? { ...p, stuck: null, asked: true } : p));
  return { ...check, ...showProblem({ ...confirm, problems }, confirm.index === i ? null : check.stuck, next.index) };
}
// 发送被拒绝时恢复确认稿。照片发送前已保存，恢复时应包含等待期间新识别出的步骤。
// 手动题面或已被新照片替换的题面，按发出时的快照恢复。
function sentBack(restore) {
  const kept = restore.confirm && restore.confirm.imageId ? tools.kept("ask") : null;
  return kept && kept.confirm && kept.confirm.key === restore.confirm.key ? { confirm: kept.confirm, stuck: kept.stuck || null } : restore;
}
// 寻找当前打开的另一个解题页；最多只允许一个解题页作为恢复目标。
function openAskPage(self) {
  const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
  return pages.find((page) => page && page !== self && page.route === "pages/ask/index" && page.alive) || null;
}
// “做到一半卡住”的输入：已写的步骤 lines，以及停止的位置。
function stuckText(lines, text) {
  const done = lines.length ? `\n已经写了：\n${lines.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "";
  const at = text ? `\n卡在：${text}` : "";
  return `我做到一半卡住了。${done}${at}`;
}
// 正确答案，或学习者最后的话说题已完成。
const GOT_IT = /懂了|明白了|会了|搞定|算出来了|没问题了|谢谢/;
function settled(messages) {
  const list = messages || [];
  if (list.some((m) => m.verdict && m.verdict.tone === "green")) return true;
  const mine = list.filter((m) => m.role === "user").pop();
  return Boolean(mine && GOT_IT.test(mine.plain || ""));
}
function tipSeen() {
  try {
    return Boolean(wx.getStorageSync(TIP));
  } catch (_) {
    return false;
  }
}

Page(studyClock.track({
  data: {
    // 游客模式（utils/gate.js）：只有空页面，不发送任何内容。
    guest: false,
    recent: [],
    thread: null,
    messages: [],
    actions: [],
    collectId: "",
    draft: "",
    // 键盘弹起时的高度（px）（utils/keyboard.js）。
    kb: 0,
    quote: "",
    answering: false,
    sending: false,
    busy: "",
    // 当前等待开始的时间，供 task-progress 计算已等待多久。
    busyAt: 0,
    scanAt: 0,
    waitSteps: WAIT_STEPS,
    usage: null,
    usageText: "",
    threads: [],
    more: false,
    moreBusy: false,
    examples: EXAMPLES,
    history: false,
    scan: null,
    scanning: false,
    // 拍题后待确认的题目及后续解题方式。
    confirm: null,
    stuck: null,
    checks: null,
    answerTarget: "",
    focus: false,
    answerHint: false,
    notice: "",
    error: "",
    suggestions: [],
    sceneCandidate: false,
    wrapDue: false,
    breakReminder: "",
    tip: false,
  },
  // ── 生命周期与页面归属 ──
  onLoad() {
    this.alive = true;
    this.follow = true;
    this.lastTop = 0;
    // 已经提供过“存成一张卡”的聊天，以及为其获取的问题相关卡片。
    this.offered = {};
    this.suggested = "";
    this.setData({ tip: !tipSeen() });
  },
  onUnload() {
    this.alive = false;
    clearTimeout(this.pollTimer);
    clearTimeout(this.settleTimer);
    clearTimeout(this.pvTimer);
    if (this.request) this.request.abort();
    this.keepCheck();
  },
  onHide() {
    this.hidden = true;
    this.keepCheck();
  },
  onShow() {
    this.hidden = false;
    if (!gate.check()) return;
    if (gate.state() === "guest") {
      // 账号曾打开的内容都会清除；游客只看到空页面。
      if (this.scope !== undefined && this.scope !== "guest") this.reset();
      this.scope = "guest";
      this.account = "";
      this.started = false;
      return this.setData({ guest: true });
    }
    if (this.data.guest) this.setData({ guest: false });
    // 另一个账号，或撤销后再次同意：从头开始。会话过期后重新登录是同一账号。
    const account = tools.account();
    const scope = `${account}#${auth.consentGeneration()}`;
    if (this.scope !== undefined && this.scope !== scope) this.reset();
    this.scope = scope;
    this.account = account;
    const app = getApp();
    const intent = app && app.globalData && app.globalData.ask;
    if (intent) app.globalData.ask = null;
    // 从情绪同意页返回，或从选卡返回。
    if (this.pendingMood) this.moodBack();
    if (this.picking) return this.picked();
    if (intent && intent.entry === "jot" && intent.text) return this.jot(intent);
    if (intent && intent.cards && intent.cards.length) return this.startWith(intent.cards, intent.teach);
    if (intent && intent.teach) return this.startTeach();
    // 从批改页转交的照片沿用同一次识别结果，不重复上传。
    const handed = tools.take("problem");
    if (handed) {
      this.newChat();
      this.lastScan = handed;
      return this.setData({ confirm: confirmView(handed, handed.photo) });
    }
    // 从学习页进入拍题工具时先显示起始页；若仍有待确认题面，则恢复该题面。
    if (intent && intent.start) {
      this.newChat();
      return this.restoreCheck();
    }
    // 从首页和错题本：一段对话（及其中一道相似题）、一道练习题、一张要拍的照片，或一个要输入的问题。
    if (intent && intent.threadId)
      return this.open(intent.threadId).then(() => {
        const now = this.data.thread;
        if (!now || now.id !== intent.threadId) return;
        if (intent.pendingMood) return this.consented() && this.patchThread({ scene: "mood" });
        if (intent.similar) this.similar();
        // 批改草稿 → 看正确做法：只问一次；之后就直接展示。
        if (intent.solution && !this.data.messages.some((m) => m.role === "assistant" && m.mode === "solution" && m.status !== "failed"))
          this.send(QUICK.solution);
      });
    if (intent && intent.practice) return this.practice(intent.practice);
    if (intent && intent.photo) {
      this.newChat();
      return this.choosePhoto({ currentTarget: { dataset: { purpose: intent.photo } } });
    }
    if (intent && intent.compose) {
      this.newChat();
      return this.setData({ draft: intent.text || "", focus: true });
    }
    // 答题中途网络断开后返回：服务器仍在继续。
    if (this.stale && this.data.thread) return this.open(this.data.thread.id);
    this.restoreCheck();
    this.loadThreads();
    if (this.data.thread) this.syncMistake();
  },
  onPageScroll({ scrollTop }) {
    // 答案流式输出时向上滚动，页面不再跟随。
    if (scrollTop < this.lastTop - 40) this.follow = false;
    this.lastTop = scrollTop;
  },
  // ── 历史加载 ──
  // 只查询 tool=ask 的解题会话，其他工具使用各自历史；最后打开的会话用于“继续上次”。
  // 服务端返回的 next 原样作为 before 回传，避免跳过同一时间的记录；旧响应没有 next 时沿用末行时间。
  loadThreads() {
    const scope = this.scope;
    return api
      .get(`/v1/chat/threads?kind=solve&tool=ask&limit=${PAGE}`)
      .then(({ threads, usage, next }) => {
        if (scope !== this.scope) return;
        this.next = next || "";
        const list = threads.map((t) => ({ ...t, when: when(t.updatedAt) }));
        const last = learningSpace.lastThread(owner());
        const resume = last && list.find((t) => t.id === last);
        const recent = resume ? [{ ...resume, resume: true }].concat(list.filter((t) => t !== resume)) : list;
        this.setData({ threads: list, recent: recent.slice(0, RECENT), more: next === undefined ? threads.length >= PAGE : Boolean(next) });
        this.showUsage(usage);
      })
      .catch((error) => {
        if (!api.needsConsent(error)) this.setData({ error: errorText(error) });
      });
  },
  moreThreads() {
    const list = this.data.threads;
    if (!list.length || this.loadingMore) return;
    const scope = this.scope;
    this.loadingMore = true;
    this.setData({ moreBusy: true });
    return api
      .get(`/v1/chat/threads?kind=solve&tool=ask&limit=${PAGE}&before=${encodeURIComponent(this.next || list[list.length - 1].updatedAt)}`)
      .then(({ threads, next }) => {
        if (scope !== this.scope) return;
        this.next = next || "";
        const known = new Set(list.map((t) => t.id));
        const rows = threads.filter((t) => !known.has(t.id)).map((t) => ({ ...t, when: when(t.updatedAt) }));
        this.setData({ threads: list.concat(rows), more: next === undefined ? threads.length >= PAGE : Boolean(next) });
      })
      .catch((error) => {
        if (!api.needsConsent(error)) this.setData({ error: errorText(error) });
      })
      .finally(() => {
        this.loadingMore = false;
        this.setData({ moreBusy: false });
      });
  },
  // 当天的次数只在快用完时才显示。
  showUsage(usage) {
    if (!usage) return;
    // 预算那一行从 80% 开始；没有预算的服务器发送次数。
    if (budgets.valid(usage.budget))
      return this.setData({ usage, usageText: budgets.low(usage.budget) });
    const left = Math.max(0, usage.answers.limit - usage.answers.used);
    this.setData({ usage, usageText: left > 10 ? "" : left ? `今天还能用 ${left} 次` : "今天的次数用完了" });
  },
  // quiet：不显示错误横幅（重新打开上次的聊天）。poll：服务器仍在写答案时刷新，会保留学生正在做的事。
  open(id, quiet, poll) {
    this.stale = false;
    if (!poll) this.setData({ error: "", notice: "", history: false });
    const scope = this.scope;
    return api
      .get(`/v1/chat/threads/${id}?tone=${TONE}`)
      .then(({ thread, messages }) => {
        if (!this.alive || scope !== this.scope) return;
        learningSpace.rememberThread(owner(), thread.id);
        const list = markPicks(messages.map(decorate));
        const same = Boolean(this.data.thread && this.data.thread.id === thread.id);
        this.sceneTurn(thread);
        this.setData({
          thread: threadOf(thread),
          messages: list,
          ...steps(thread, list),
          ...(same ? {} : { suggestions: [], sceneCandidate: false, breakReminder: "", wrapDue: false }),
          ...(poll ? {} : { quote: "", answering: false, confirm: null, stuck: null }),
        });
        if (!poll) this.lastScan = null;
        if (!poll) {
          this.follow = true;
          this.offerWrap();
          this.toLatest();
        } else this.scrollDown(false);
        list
          .filter((m) => m.kind === "judge" && m.verdict.pending)
          .forEach((m) => this.waitJudge(m));
        clearTimeout(this.pollTimer);
        if (list.some((m) => m.status === "streaming"))
          this.pollTimer = setTimeout(() => {
            const now = this.data.thread;
            if (this.alive && !this.hidden && now && now.id === thread.id && !this.data.sending)
              this.open(thread.id, true, true);
          }, 4000);
        if (!poll) this.loadThreads();
        if (!poll && list.some((message) => message.role === "assistant")) this.suggestCards();
      })
      .catch((error) => {
        if (error.statusCode === 404) learningSpace.forgetThread(owner());
        if (poll) return;
        if (quiet) return this.loadThreads();
        if (!api.needsConsent(error)) this.setData({ error: errorText(error) });
      });
  },
  // 离开页面后仍在本机保存待确认题面，包括识别文字、人工修改和卡点；返回起始页时可以恢复。
  // ── 待确认题面与草稿恢复 ──
  // 题面 key 区分不同草稿，账号标识区分用户，sentAt 区分先后操作；三者不能互相替代。
  keepCheck() {
    const { confirm, stuck } = this.data;
    // 保存或清理草稿时，使用页面展示内容所属的账号。
    if (this.data.guest || !this.owns()) return;
    if (confirm) {
      tools.keep("ask", { confirm, stuck, scan: this.lastScan || null });
      this.ownKey = confirm.key;
    } else if (this.ownKey && !this.askedPhoto) {
      // 只能按 id 清除本页面展示过的确认稿。离页后识别完成或由输入栏保存的照片仍保留为“上次拍的题”。
      // 已发问但服务端尚未接受的照片也需要保留，以便重试。
      this.dropOwn(this.ownKey);
      this.ownKey = "";
    }
  },
  dropOwn(key) {
    const kept = tools.kept("ask");
    if (key && kept && kept.confirm && kept.confirm.key === key) tools.drop("ask");
  },
  // 页面内容归属于显示它时的账号；游客页面归属于随后第一个登录的账号。
  // 切换到其他账号后，不把已有内容保存到新账号下。
  owns() {
    const now = tools.account();
    if (now && !this.account) this.pageFor(now);
    return Boolean(now) && this.account === now;
  },
  // 结果归属于发起请求前完成登录的账号。若该账号仍有效，则先清理别的账号在本页留下的状态再展示。
  // 若当前账号已改变，则不展示该结果；游客页面进行中的操作归属于随后第一个登录的账号。
  pageFor(who) {
    if (!who || !tools.sameAccount(who)) return false;
    if (this.account !== who) {
      if (this.account) {
        this.reset();
        this.scope = `${who}#${auth.consentGeneration()}`;
      }
      this.account = who;
    }
    return true;
  },
  restoreCheck() {
    if (this.data.thread || this.data.messages.length || this.data.confirm) return;
    let kept = tools.kept("ask");
    if (!kept || !kept.confirm) return;
    // 给旧缓存中没有 id 的确认稿补上 id 并立即保存，后续步骤回填和“不要了”才能准确找到它。
    if (!kept.confirm.key) {
      kept = { ...kept, confirm: { ...kept.confirm, key: checkKey() } };
      tools.keep("ask", kept);
    }
    this.lastScan = kept.scan || null;
    // 已经识别的照片以“上次拍的题”提供恢复入口，包括离页后才识别完成的照片。
    this.setData({ confirm: { ...kept.confirm, again: !kept.confirm.typed }, stuck: kept.stuck || null });
    this.ownKey = kept.confirm.key;
  },
  // 离页期间识别完成的步骤，只能回填到当前页面正在展示的同一确认稿、同一题。
  // 照片只有在当前没有题面或题面比它更旧时才展示，不能抢走较新的输入。
  lateSteps(key, i, who, steps, sentAt) {
    const { confirm } = this.data;
    if (!this.alive || !key || this.account !== who || !confirm || confirm.key !== key) return false;
    this.putSteps(i, steps, sentAt);
    return true;
  },
  putSteps(i, steps, sentAt) {
    const { confirm, stuck } = this.data;
    const next = withSteps(confirm, stuck, i, steps, sentAt);
    if (!next) return;
    this.setData(next.confirm === confirm ? { stuck: next.stuck } : { confirm: next.confirm });
    this.keepCheck();
  },
  latePhoto(who, scan, photo, sentAt) {
    const { confirm, thread, messages } = this.data;
    if (!this.alive || this.account !== who || thread || messages.length) return false;
    // 照片发出后新拍、新输入或新保存的确认稿优先保留。
    if (confirm && !((confirm.at || 0) < sentAt)) return false;
    this.lastScan = { ...scan, photo };
    this.setData({ confirm: confirmView(scan, photo, sentAt), stuck: null });
    this.keepCheck();
    return true;
  },
  // 照片的临时文件可能已消失（重启后）：文本仍保留。
  confirmPhotoBroken() {
    if (this.data.confirm) this.setData({ "confirm.photo": "" });
  },
  // 一个账号打开的内容，在另一个账号使用页面前被清空。
  reset() {
    clearTimeout(this.pollTimer);
    if (this.request) this.request.abort();
    this.started = false;
    this.stale = false;
    this.offered = {};
    this.suggested = "";
    this.pendingMood = "";
    this.picking = null;
    this.askedPhoto = null;
    this.asking = {};
    // 本页展示的题面和照片属于旧账号；离开时不能清除当前账号保存的新内容。
    this.ownKey = "";
    this.lastScan = null;
    this.barScan = null;
    this.setData({
      thread: null, messages: [], actions: [], collectId: "", draft: "", quote: "", answering: false,
      sending: false, busy: "", usage: null, usageText: "", threads: [], recent: [],
      history: false, scan: null, scanning: false, confirm: null, stuck: null, checks: null, answerTarget: "",
      notice: "", error: "",
      suggestions: [], sceneCandidate: false, wrapDue: false, breakReminder: "",
    });
  },
  // 指向上次对话的指针保留：空白页把它显示为“继续上次”。
  newChat() {
    if (this.data.sending) return;
    this.setData({
      thread: null,
      messages: [],
      actions: [],
      collectId: "",
      quote: "",
      answering: false,
      history: false,
      error: "",
      notice: "",
      suggestions: [],
      sceneCandidate: false,
      wrapDue: false,
      breakReminder: "",
      confirm: null,
      stuck: null,
    });
    this.loadThreads();
  },
  // 来自旧版本条目“随心记”：以已写内容开始的新聊天。
  jot(intent) {
    const cardIds = (intent.cardIds || (intent.cards && intent.cards.map((card) => card.id)) || []).slice(0, 3);
    return api
      .post("/v1/chat/threads", { text: intent.text, entry: "jot", cardIds, pointId: intent.pointId || undefined, origin: "solve", tone: TONE })
      .then(({ thread }) => this.open(thread.id).then(() => this.send({ text: intent.text, entry: "jot", mode: "auto" })))
      .catch((error) => {
        if (!api.needsConsent(error)) this.setData({ draft: intent.text, error: errorText(error) });
      });
  },
  // 关于卡片的聊天：来自一张卡片，或在提问前在此处选过。
  startWith(cards, teach) {
    const card = cards[0];
    return api
      .post("/v1/chat/threads", {
        text: card.title || "讲讲这张卡",
        mode: teach ? "teach" : "guide",
        cardIds: cards.map((item) => item.id).slice(0, 3),
        origin: "solve",
        tone: TONE,
      })
      .then(({ thread }) => this.open(thread.id))
      .catch((error) => {
        if (!api.needsConsent(error)) this.setData({ error: errorText(error) });
      });
  },
  // 在提问前的“讲一遍”：现在有自己的页面。
  startTeach() {
    if (this.data.guest) return gate.ask();
    wx.redirectTo({ url: `/${tools.ROUTE.teach}` });
  },
  // ── 输入与发送 ──
  // 输入文字也计入有效学习活动，由 study-clock 跟踪。
  onDraft(event) {
    this.setData({ draft: event.detail.value });
    this.studyTouch();
  },
  onBlur() {
    keyboard.reset(this);
    if (this.data.focus) this.setData({ focus: false });
  },
  // 页面整体不随键盘上移，只将输入栏抬到键盘上方。
  keyboardHeight(event) {
    keyboard.change(this, event, () => this.toLatest());
  },
  submit() {
    const text = this.data.draft.trim();
    if (!text || this.data.sending) return;
    if (this.data.guest) return gate.ask();
    if (this.data.answering) return this.submitAnswer(text);
    // 起始页手动输入的题目先进入题面确认流程。
    if (!this.data.thread && !this.data.messages.length)
      return this.setData({ confirm: typedView(text.slice(0, 1500)), stuck: null, error: "" });
    this.send({ text, mode: "auto", quote: this.data.quote || undefined });
  },
  useExample(event) {
    const example = EXAMPLES[event.currentTarget.dataset.index];
    if (!example) return;
    if (this.data.guest) return gate.ask();
    this.send(
      example.problem
        ? { problem: { text: example.text }, mode: "auto" }
        : { text: example.text, mode: "auto" },
    );
  },
  // restore 是发送被拒绝时恢复的题面确认稿；asked 是照片中已知的题目序号，尚未发给服务端。
  // ── 消息发送与服务端事件 ──
  send(payload, fresh, restore, asked = -1) {
    if (this.data.sending) return;
    const id = stream.clientId();
    const thread = fresh ? null : this.data.thread;
    const body = {
      ...payload,
      clientId: id,
      tone: TONE,
      // 在此处开始的新对话是解题对话。
      ...(thread ? { threadId: thread.id } : { origin: "solve" }),
    };
    const shown = payload.problem
      ? payload.problem.text
      : payload.steps
        ? payload.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")
        : payload.text;
    const question = decorate({
      id: `local_${id}`,
      role: "user",
      kind: payload.problem ? "problem" : payload.steps ? "steps" : "text",
      status: "done",
      blocks: [{ t: "p", c: [{ t: "text", v: shown }] }],
      mode: payload.mode,
      quote: payload.quote || null,
      images: payload.imageId ? [payload.imageId] : [],
    });
    const reply = decorate({
      id: `wait_${id}`,
      role: "assistant",
      kind: "reply",
      mode: payload.mode,
      status: "streaming",
      thinking: true,
    });
    const messages = (thread ? this.data.messages : []).concat([question, reply]);
    this.follow = true;
    this.setData({
      answerHint: false,
      ...(thread ? {} : { thread: null, suggestions: [], sceneCandidate: false, breakReminder: "" }),
      messages,
      actions: [],
      collectId: "",
      wrapDue: false,
      draft: "",
      quote: "",
      sending: true,
      error: "",
      notice: "",
    });
    this.scrollDown(true);
    this.lastSend = payload;
    // 发问的照片在本机保留到服务端确认接收（start 或 crisis 事件）；拒绝发送时用 restore 恢复。
    if (payload.imageId) this.askedPhoto = { id, imageId: payload.imageId, index: asked };
    const scope = this.scope;
    this.request = stream.send("/v1/chat/send", body, (event) => scope === this.scope && this.onEvent(event, id));
    this.request.promise
      .then(({ finished }) => {
        if (!finished) this.stale = true;
      })
      .catch((error) => {
        if (error.code === "CANCELLED") return;
        if (error.code === "NETWORK") {
          this.stale = true;
          return this.setData({ notice: error.message });
        }
        if (api.needsConsent(error)) return;
        if (this.askedPhoto && this.askedPhoto.id === id) this.askedPhoto = null;
        // 没有返回内容：丢弃占位内容，保留已输入的内容。
        const list = this.data.messages.filter((m) => m.id !== `wait_${id}` && m.id !== `local_${id}`);
        this.setData({
          messages: list,
          draft: payload.text && !payload.quote ? payload.text : this.data.draft,
          error: errorText(error),
          ...(restore && !list.length ? sentBack(restore) : {}),
        });
      })
      .finally(() => {
        this.request = null;
        if (!this.alive) return;
        const thread = this.data.thread;
        this.setData({ sending: false, ...steps(thread, this.data.messages) });
        this.offerWrap();
        this.suggestCards();
        const unfinished = this.data.messages.some((m) => m.status === "streaming");
        if ((this.stale || unfinished) && thread) this.open(thread.id);
        else this.loadThreads();
      });
  },
  index(id) {
    return this.data.messages.findIndex((m) => m.id === id);
  },
  // 解题会话转入生活或心情场景后停止学习计时；本轮开始前结算上一段时间，回到学习场景再启动。
  studyOff() {
    const t = this.data.thread;
    return Boolean(t && t.scene && t.scene !== "study");
  },
  sceneTurn(next) {
    const off = Boolean(next && next.scene && next.scene !== "study");
    if (off !== this.studyOff() && typeof this.studyTouch === "function") this.studyTouch();
  },
  onEvent(event, cid) {
    if (!this.alive) return;
    const patch = {};
    if ((event.e === "start" || event.e === "crisis") && this.askedPhoto && this.askedPhoto.id === cid) {
      this.askedAbout(this.askedPhoto);
      this.askedPhoto = null;
    }
    switch (event.e) {
      case "crisis": {
        learningSpace.rememberThread(owner(), event.thread.id);
        patch.thread = threadOf(event.thread);
        patch.messages = this.data.messages
          .filter((m) => m.id !== `wait_${cid}`)
          .map((m) => m.id === `local_${cid}` ? decorate(event.question) : m);
        if (!patch.messages.some((m) => m.id === event.question.id))
          patch.messages.push(decorate(event.question));
        patch.actions = [];
        patch.collectId = "";
        patch.sending = false;
        patch.error = "";
        break;
      }
      case "scene_candidate": {
        if (event.thread) patch.thread = threadOf(event.thread);
        patch.sceneCandidate = true;
        if (event.question) {
          const i = this.index(`local_${cid}`);
          if (i >= 0) patch[`messages[${i}]`] = decorate(event.question);
        }
        break;
      }
      case "break_reminder":
        patch.breakReminder = event.text;
        break;
      case "start": {
        learningSpace.rememberThread(owner(), event.thread.id);
        patch.thread = threadOf(event.thread);
        const q = this.index(`local_${cid}`);
        if (q >= 0) patch[`messages[${q}]`] = decorate(event.question);
        const r = this.index(`wait_${cid}`);
        if (r >= 0) patch[`messages[${r}].id`] = event.replyId;
        break;
      }
      case "thread":
        patch.thread = threadOf(event.thread);
        break;
      case "thinking": {
        const i = this.index(event.id);
        if (i >= 0) patch[`messages[${i}].thinking`] = true;
        break;
      }
      case "blocks": {
        const i = this.index(event.id);
        if (i < 0) break;
        const start = this.data.messages[i].blocks.length;
        event.blocks.forEach((block, k) => {
          patch[`messages[${i}].blocks[${start + k}]`] = block;
        });
        patch[`messages[${i}].thinking`] = false;
        break;
      }
      case "tail": {
        const i = this.index(event.id);
        if (i < 0) break;
        patch[`messages[${i}].tail`] = event.text;
        patch[`messages[${i}].thinking`] = false;
        break;
      }
      case "done": {
        const i = this.index(event.message.id);
        if (i >= 0) patch[`messages[${i}]`] = decorate(event.message);
        break;
      }
      case "verify": {
        const i = this.index(event.id);
        if (i < 0) break;
        const m = this.data.messages[i];
        patch[`messages[${i}]`] = decorate({ ...m, verify: event.verify });
        break;
      }
      case "recheck":
        patch[`messages[${this.data.messages.length}]`] = decorate({
          id: event.id,
          role: "assistant",
          kind: "recheck",
          mode: "solution",
          status: "streaming",
          thinking: true,
        });
        break;
      case "error": {
        const i = event.id ? this.index(event.id) : -1;
        if (i >= 0) {
          const m = this.data.messages[i];
          patch[`messages[${i}]`] = decorate({
            ...m,
            status: "failed",
            thinking: false,
            tail: "",
            error: { code: event.code, message: event.message },
          });
        } else patch.error = event.message;
        break;
      }
      default:
        return;
    }
    if (patch.thread) this.sceneTurn(patch.thread);
    this.setData(patch);
    if (event.e === "crisis") {
      wx.navigateTo({ url: "/pages/crisis/index" });
      return;
    }
    if (event.e === "start" || event.e === "done") this.showQuota();
    this.scrollDown();
  },
  showQuota() {
    if (this.data.guest) return;
    api
      .get("/v1/chat/usage")
      .then((usage) => this.showUsage(usage))
      .catch(() => {});
  },
  // 打开聊天会定位到最新消息。公式和图片在首次渲染后撑开页面，所以它们加载后会再查看一次。
  toLatest() {
    this.follow = true;
    this.lastTop = 0;
    clearTimeout(this.settleTimer);
    const go = () => {
      if (this.alive && this.follow) wx.pageScrollTo({ scrollTop: 1e6, duration: 0 });
    };
    if (wx.nextTick) wx.nextTick(go);
    else go();
    this.settleTimer = setTimeout(() => {
      go();
      this.settleTimer = setTimeout(go, 600);
    }, 300);
  },
  scrollDown(now) {
    if (!this.follow) return;
    if (this.scrollTimer && !now) return;
    const run = () => {
      this.scrollTimer = null;
      wx.pageScrollTo({ scrollTop: 1e6, duration: now ? 0 : 200 });
    };
    if (now) return run();
    this.scrollTimer = setTimeout(run, 300);
  },
  // “讲完了”转到讲一遍页核对要点，并带上未发送文字；这里不发送一条同名普通消息。
  finishTeach() {
    const thread = this.data.thread;
    if (!thread || this.data.sending) return;
    const draft = this.data.draft.trim();
    if (draft) tools.keep("teach", { threadId: thread.id, pointId: thread.pointId || "", name: thread.title || "讲一遍", draft });
    if (draft) this.setData({ draft: "" });
    wx.navigateTo({ url: `/${tools.ROUTE.teach}?id=${encodeURIComponent(thread.id)}&finish=1` });
  },
  // ── 回复后的继续操作 ──
  act(event) {
    const data = event.detail || event.currentTarget.dataset;
    const key = data.key;
    if (key && key.startsWith("guide-")) return this.send({ text:data.value, mode:"auto" });
    if (key === "self") return this.setData({ focus:true });
    if (key === "park") return this.openWrap();
    if (key === "teachDone") return this.finishTeach();
    if (QUICK[key]) return this.send(QUICK[key]);
    // “出一道题给我练”：来自章节的已核对选择题，不是聊天里输入的题。
    if (key === "practice") return this.practiceMenu();
    if (key === "answer") return this.startAnswer();
    // 没有存档的问题：答案直接作为下一条消息输入。
    if (key === "answerFree") return this.setData({ focus: true, answerHint: true, quote: "" });
    if (key === "answerSimilar") return this.startAnswer(this.currentSimilar());
    if (key === "nextPractice" && this.data.thread && this.data.thread.practice)
      return this.practice(this.data.thread.practice.chapter);
    if (key === "revealSimilar" && this.currentSimilar())
      return this.revealSimilar({ currentTarget: { dataset: { id: this.currentSimilar().id } } });
    if (key === "similar") return this.similar();
    if (key === "map") return this.openMap();
    // 步骤批改统一在批改页执行并保存。
    if (key === "draft") return backTo(tools.ROUTE.grade);
    if (key === "retry" && this.lastSend) return this.send(this.lastSend);
  },
  // 对回复中的一个内容块继续提问，或复制该块。
  pickBlock(event) {
    const text = String(event.detail.text || "").slice(0, 480);
    const id = event.currentTarget.dataset.id;
    if (!text) return;
    if (this.data.tip) {
      this.setData({ tip: false });
      try {
        wx.setStorageSync(TIP, 1);
      } catch (_) {
        // 这里只隐藏提示，不改变业务状态。
      }
    }
    wx.showActionSheet({
      itemList: ["问问这段", "复制这段", "复制全部"],
      success: ({ tapIndex }) => {
        if (tapIndex === 0) return this.setData({ quote: text, answering: false });
        const message = this.data.messages[this.index(id)];
        // 回复属于AI生成内容，复制时由 utils/copy 保留来源标记。
        copyAi(tapIndex === 1 ? text : plainAll(message && message.blocks)).catch(() => {});
      },
    });
  },
  // 长按较早的消息，可以存卡、加入错题本或复制。
  holdMessage(event) {
    const message = this.data.messages[this.index(event.currentTarget.dataset.id)];
    if (!message || message.status !== "done" || /^(local|wait)_/.test(message.id)) return;
    const text =
      plainAll(message.blocks) || plainAll(message.similar && message.similar.question) || message.plain;
    if (!text) return;
    const items = chatV2.holdItems(message, this.data.thread);
    wx.showActionSheet({
      itemList: items,
      success: ({ tapIndex }) => {
        const item = items[tapIndex];
        if (item === "存成卡") return this.collectMessage({ currentTarget: { dataset: { id: message.id } } });
        if (item === "收进错题本") return this.addMistake(message.id);
        if (item !== "复制") return;
        // 学生原话原样复制；生成回复保留 AI 来源标记。
        if (message.role === "user") wx.setClipboardData({ data: text });
        else copyAi(text).catch(() => {});
      },
    });
  },
  addMistake(id) {
    const thread = this.data.thread;
    if (!thread) return Promise.resolve();
    return api
      .post(`/v1/chat/messages/${encodeURIComponent(id)}/mistake`, { tone: TONE })
      .then((result) => {
        const now = this.data.thread;
        if (result && result.thread && now && now.id === thread.id)
          this.setData({ thread: threadOf(result.thread) });
        wx.showToast({ title: "收进错题本了", icon: "none" });
      })
      .catch((error) => {
        if (!api.needsConsent(error)) this.setData({ error: errorText(error) });
      });
  },
  clearQuote() {
    this.setData({ quote: "" });
  },
  // ── 核对详情与作答交互 ──
  showChecks(event) {
    const m = this.data.messages[this.index(event.currentTarget.dataset.id)];
    if (!m || !m.verify) return;
    const items = (m.verify.items || []).map((item) => ({
      ...item,
      label: ITEM[item.status] || "",
      tone: item.status === "pass" ? "green" : item.status === "fail" ? "red" : "amber",
    }));
    this.setData({ checks: { text: m.badge ? m.badge.text : "", tone: m.badge ? m.badge.tone : "", items } });
    // 核对的表达式使用 TeX，每个表达式排成一条独立公式。
    const tex = items.map((item) => item.tex).filter(Boolean);
    if (!tex.length || tex.length !== items.length) return;
    api
      .post("/v1/render", { text: tex.map((t) => `$$${t}$$`).join("\n\n"), tone: TONE })
      .then(({ blocks }) => {
        if (!this.data.checks || blocks.length !== items.length) return;
        this.setData({ "checks.items": items.map((item, i) => ({ ...item, formula: [blocks[i]] })) });
      })
      .catch(() => {});
  },
  closeChecks() {
    this.setData({ checks: null });
  },
  // ── 作答 ──
  // similar 指定正在作答的同类题；未指定时回答当前会话的原题。
  startAnswer(similar) {
    this.setData({ answering: true, answerTarget: similar ? similar.id : "", quote: "" });
  },
  // 允许回答页面中的任意一道同类题，不限最后一题。
  answerThis(event) {
    const target = this.data.messages.find((m) => m.id === event.currentTarget.dataset.id);
    if (target) this.startAnswer(target);
  },
  cancelAnswer() {
    this.setData({ answering: false, answerTarget: "" });
  },
  lastSimilar() {
    return this.data.messages.filter((m) => m.kind === "similar").pop();
  },
  // 优先取最新判定对应的同类题；没有该判定时取最新同类题。
  currentSimilar() {
    const last = this.data.messages.filter((m) => m.role === "assistant").pop();
    const of = last && last.kind === "judge" && last.similarOf;
    return (of && this.data.messages.find((m) => m.id === of)) || this.lastSimilar();
  },
  submitAnswer(answer) {
    const thread = this.data.thread;
    if (!thread) return;
    const target = this.data.answerTarget;
    this.postAnswer(target, { answer });
  },
  // 单选题点击选项即提交作答。
  pickOption(event) {
    if (this.data.guest) return gate.ask();
    const { id, index } = event.currentTarget.dataset;
    const i = this.index(id);
    if (i < 0 || !this.data.thread || this.data.sending || this.data.busy) return;
    this.setData({ [`messages[${i}].picked`]: Number(index) });
    this.postAnswer(id, { choice: Number(index) });
  },
  postAnswer(target, value) {
    const thread = this.data.thread;
    this.setData({ sending: true, error: "" });
    return api
      .post(target ? `/v1/chat/messages/${target}/answer` : `/v1/chat/threads/${thread.id}/answer`, {
        ...value,
        clientId: stream.clientId(),
        tone: TONE,
      })
      .then(({ question, judge }) => {
        const added = [question, judge].filter(Boolean).map(decorate);
        const messages = this.data.messages.concat(added);
        this.follow = true;
        this.setData({ messages, draft: "", answering: false, answerTarget: "", actions: [], collectId: "" });
        this.scrollDown(true);
        const pending = added.find((m) => m.kind === "judge");
        // 同类题或练习题即时判定，答对后展示解析。
        const similarOf = target || (pending && pending.similarOf);
        if (similarOf) return this.refreshSimilar(similarOf);
        if (pending) this.waitJudge(pending);
      })
      .catch((error) => {
        if (!api.needsConsent(error)) this.setData({ error: errorText(error) });
      })
      .finally(() => this.setData({ sending: false }));
  },
  waitJudge(message) {
    this.waiting = this.waiting || {};
    if (this.waiting[message.id]) return;
    this.waiting[message.id] = true;
    const job = message.job;
    const wait = job && PENDING_JOB.includes(job.status) ? api.waitJob(job, () => this.alive) : Promise.resolve();
    wait
      .catch(() => null)
      .then(() => api.get(`/v1/chat/messages/${message.id}?tone=${TONE}`))
      .then((fresh) => {
        const i = this.index(message.id);
        if (i < 0) return;
        this.setData({ [`messages[${i}]`]: decorate(fresh) });
        this.setData(steps(this.data.thread, this.data.messages));
        this.scrollDown();
        this.syncMistake();
      })
      .catch((error) => {
        if (this.alive) this.setData({ error: errorText(error) });
      })
      .finally(() => {
        this.waiting[message.id] = false;
      });
  },
  // 按章节生成的练习题使用独立会话。
  practice(chapter) {
    if (this.data.guest) return gate.ask();
    if (this.data.busy || this.data.sending) return;
    this.newChat();
    this.setData({ busy: "practice", busyAt: Date.now(), error: "" });
    let clientId = "";
    // 先完成登录，再为实际发送账号创建并保存提交标识。
    auth
      .login()
      .then(() => {
        clientId = this.askId("practice", chapter);
        return api.post("/v1/chat/practice", { chapter, tone: TONE, clientId }, { timeout: 150000 });
      })
      .then(({ thread }) => {
        this.askDone("practice", clientId);
        return this.open(thread.id);
      })
      .catch((error) => {
        if (clientId && !transient(error)) this.askDone("practice", clientId);
        if (!api.needsConsent(error)) this.setData({ error: errorText(error) });
      })
      .finally(() => this.setData({ busy: "" }));
  },
  // 每次出题或生成同类题使用一个 clientId；超时后可能已经生成并扣额，重试必须沿用该标识。
  // 页面和本机都保存标识，使离开后返回的重试仍是同一次请求；服务端无法匹配旧标识返回 409 时结束本次操作。
  // 标识在登录后、发送前保存；只有用户点击才写入本机，晚到的超时回调不能覆盖更新的标识。
  // 另一页面已完成的操作保留完成标记；旧页重试取回原结果，新页开始新操作。
  // ── 收费操作的重试标识 ──
  // 同一出题操作在网络重试时复用 clientId；明确结束后才开启新标识，避免重复生成或扣额。
  askId(kind, key) {
    this.asking = this.asking || {};
    const kept = tools.kept("asking") || {};
    const slot = kept[kind];
    const open = slot && !slot.done ? slot : null;
    const was = [this.asking[kind], open].find((item) => item && item.key === key);
    this.asking[kind] = { key, clientId: was ? was.clientId : stream.clientId() };
    const answered = slot && slot.done && slot.clientId === this.asking[kind].clientId;
    if (!answered) tools.keep("asking", { ...kept, [kind]: this.asking[kind] });
    return this.asking[kind].clientId;
  },
  // 只结束当前调用使用的 clientId；旧页的晚到结果不能结束新页面或其他账号正在重试的操作。
  // 本机保留“已完成”标记而非直接删除，使仍持有旧标识的页面在下次点击时生成新标识。
  askDone(kind, clientId) {
    if (this.asking && this.asking[kind] && this.asking[kind].clientId === clientId) delete this.asking[kind];
    const kept = tools.kept("asking");
    if (!kept || !kept[kind] || kept[kind].clientId !== clientId) return;
    tools.keep("asking", { ...kept, [kind]: { ...kept[kind], done: true } });
  },
  refreshSimilar(id) {
    return api
      .get(`/v1/chat/messages/${id}?tone=${TONE}`)
      .then((fresh) => {
        const i = this.index(id);
        const old = this.data.messages[i];
        if (i >= 0) this.setData({ [`messages[${i}]`]: decorate({ ...fresh, picked: old && old.picked }) });
        this.setData(steps(this.data.thread, this.data.messages));
        this.scrollDown();
        this.syncMistake();
      })
      .catch(() => this.setData(steps(this.data.thread, this.data.messages)));
  },
  // 空白页的“练一题”先选章节，再在独立会话中生成题目。
  practiceMenu() {
    if (this.data.guest) return gate.ask();
    if (this.data.busy || this.data.sending) return;
    return api
      .get("/v1/learn/map")
      .then((map) => {
        const chapters = (map.chapters || []).filter((c) => PRACTICE.includes(c.id) && !c.hidden);
        if (!chapters.length) return;
        wx.showActionSheet({
          itemList: chapters.map((c) => c.short || c.name),
          success: ({ tapIndex }) => chapters[tapIndex] && this.practice(chapters[tapIndex].id),
        });
      })
      .catch((error) => {
        if (!api.needsConsent(error)) this.setData({ error: errorText(error) });
      });
  },
  // ── 错题本 ──
  // 判定结果可以把题目加入错题本，也可以将已有错题标为掌握。
  syncMistake() {
    const thread = this.data.thread;
    if (!thread || !thread.materialId) return;
    api
      .get(`/v1/chat/threads/${thread.id}?tone=${TONE}`)
      .then((fresh) => {
        const now = this.data.thread;
        if (!this.alive || !now || now.id !== fresh.thread.id) return;
        this.setData({ "thread.mistake": fresh.thread.mistake, "thread.mistakeText": mistakeText(fresh.thread.mistake) });
      })
      .catch(() => {});
  },
  openMistakes() {
    wx.navigateTo({ url: "/pages/mistakes/index" });
  },
  openPoint() {
    const mistake = this.data.thread && this.data.thread.mistake;
    if (mistake && mistake.mapPoint) return backTo(ROUTES.point, mistake.mapPoint.id);
  },
  // A tool answer only offers a next step; lighting still requires the map's own question.
  openMap() {
    const last = this.data.messages.filter((m) => m.role === "assistant").pop();
    if (!last || (!(last.verdict && last.verdict.tone === "green") && !(last.mode === "grade" && last.status === "done"))) return;
    const similar = last.similarOf && this.data.messages.find((m) => m.id === last.similarOf);
    const mistake = this.data.thread && this.data.thread.mistake;
    // An ordinary generated similar question has no point classification of its own.
    const point = (!last.similarOf || (similar && similar.practice)) && mistake && mistake.mapPoint;
    return point ? backTo(ROUTES.point, point.id) : backTo(ROUTES.map);
  },
  dropMistake() {
    const thread = this.data.thread;
    const mistake = thread && thread.mistake;
    if (!mistake) return;
    api
      .del(`/v1/mistakes/${mistake.id}`)
      .then(() => {
        this.setData({ "thread.mistake": null, "thread.mistakeText": "" });
        wx.showToast({ title: "移出错题本了", icon: "none" });
      })
      .catch((error) => this.setData({ error: errorText(error) }));
  },
  // ---- similar problems --------------------------------------------------
  similar() {
    const thread = this.data.thread;
    if (!thread || this.data.busy) return;
    this.setData({ busy: "similar", busyAt: Date.now(), error: "", actions: [], collectId: "" });
    this.follow = true;
    this.scrollDown(true);
    let clientId = "";
    auth
      .login()
      .then(() => {
        clientId = this.askId("similar", thread.id);
        return api.post(`/v1/chat/threads/${thread.id}/similar`, { tone: TONE, clientId }, { timeout: 150000 });
      })
      .then((message) => {
        this.askDone("similar", clientId);
        // A retry answered with the problem already made: shown once.
        const messages = this.data.messages.filter((m) => m.id !== message.id).concat([decorate(message)]);
        this.setData({ messages });
        this.scrollDown(true);
        this.showQuota();
      })
      .catch((error) => {
        if (clientId && !transient(error)) this.askDone("similar", clientId);
        if (!api.needsConsent(error)) this.setData({ error: errorText(error) });
      })
      .finally(() => this.setData({ busy: "", ...steps(this.data.thread, this.data.messages) }));
  },
  // ---- cards, scene, storing the chat --------------------------------------
  // Related cards: fetched at most once per question, folded into one line.
  suggestCards() {
    const thread = this.data.thread;
    if (!thread || this.data.guest) return;
    const last = this.data.messages.filter((message) => message.role === "user").pop();
    const key = `${thread.id}#${last ? last.id : ""}`;
    if (key === this.suggested) return;
    this.suggested = key;
    return api
      .post(`/v1/chat/threads/${thread.id}/suggest-cards`, { text: (last && last.plain) || "" })
      .then(({ cards }) => {
        const now = this.data.thread;
        if (now && now.id === thread.id) this.setData({ suggestions: cards || [] });
      })
      .catch(() => {});
  },
  // "聊得差不多了？存成一张卡": once per chat, after four messages from the student.
  // offered once the problem is settled (a right answer, or the
  // learner says they got it), not just after four messages; + 存成卡 stays.
  offerWrap() {
    const thread = this.data.thread;
    if (!thread || thread.mode === "teach" || this.offered[thread.id]) return;
    if (!chatV2.shouldOfferWrap(this.data.messages) || !settled(this.data.messages)) return;
    this.offered[thread.id] = true;
    this.setData({ wrapDue: true });
  },
  patchThread(value) {
    const thread = this.data.thread;
    if (!thread) return Promise.resolve();
    return api
      .patch(`/v1/chat/threads/${thread.id}`, { ...value, tone: TONE })
      .then(({ thread: fresh }) => {
        const now = this.data.thread;
        if (!now || now.id !== fresh.id) return;
        this.sceneTurn(fresh);
        this.setData({ thread: threadOf(fresh), sceneCandidate: false, ...steps(fresh, this.data.messages) });
      })
      .catch((error) => {
        if (error.code === "MOOD_CONSENT_REQUIRED") return this.moodConsent(thread.id);
        if (!api.needsConsent(error)) wx.showToast({ title: errorText(error), icon: "none" });
      });
  },
  // The page's "⋯": what the chat is about, 讲一遍, cards, storing it.
  moreChat() {
    if (this.data.guest) return gate.ask();
    const thread = this.data.thread;
    if (!thread)
      return wx.showActionSheet({
        itemList: ["讲一遍", "带上一张卡"],
        success: ({ tapIndex }) => (tapIndex === 0 ? this.startTeach() : this.pickCards()),
      });
    const items = [{ text: `这段在聊：${chatV2.SCENES[thread.scene] || "学习"}`, run: () => this.sceneMenu() }];
    if (thread.scene !== "mood")
      items.push(
        thread.mode === "teach"
          ? { text: "不讲了，接着聊", run: () => this.patchThread({ mode: "guide" }) }
          : { text: "讲一遍", run: () => this.patchThread({ mode: "teach" }) },
      );
    items.push({ text: "带上一张卡", run: () => this.pickCards() });
    if (thread.mode !== "teach" && this.data.messages.length)
      items.push({ text: "聊完了，存成卡", run: () => this.openWrap() });
    wx.showActionSheet({
      itemList: items.map((item) => item.text),
      success: ({ tapIndex }) => items[tapIndex] && items[tapIndex].run(),
    });
  },
  // 这段在聊：学习 / 生活 / 心情. A mood chat stays one.
  sceneMenu() {
    const thread = this.data.thread;
    if (!thread) return;
    if (thread.scene === "mood") return wx.showToast({ title: "心情对话不切换，新开一段就行", icon: "none" });
    const scenes = ["study", "life", "mood"];
    wx.showActionSheet({
      itemList: scenes.map((scene) => chatV2.SCENES[scene]),
      success: ({ tapIndex }) => {
        const scene = scenes[tapIndex];
        if (!scene || scene === thread.scene) return;
        if (scene === "mood") return this.askMood();
        this.patchThread({ scene });
      },
    });
  },
  // A mood chat needs its own consent, and stays one. sure: the student already
  // said yes to the offer above the chat.
  askMood(sure) {
    if (!this.data.thread) return;
    if (sure === true) return this.patchThread({ scene: "mood" });
    wx.showModal({
      // V4.2 : gentler words; the same step and the same consent.
      title: "换成聊心情？",
      content: "换了以后这段就一直算心情，存下的是心情卡。想聊别的，新开一段就好。",
      confirmText: "换成心情",
      cancelText: "先不用",
      success: ({ confirm }) => {
        if (confirm) this.patchThread({ scene: "mood" });
      },
    });
  },
  // The switch waits until the consent page reports a yes (moodBack).
  moodConsent(id) {
    this.pendingMood = id;
    getApp().globalData.moodConsentReturn = null;
    this.setData({ moodConsented: false, sceneCandidate: false });
    wx.navigateTo({ url: `/pages/mood-consent/index?next=${encodeURIComponent(`/pages/ask/index?threadId=${id}`)}` });
  },
  // Whether the consent page just said yes; read once.
  consented() {
    const app = getApp();
    const back = app.globalData.moodConsentReturn;
    app.globalData.moodConsentReturn = null;
    const yes = Boolean(back && back.moodConsented) || Boolean(this.data.moodConsented);
    if (this.data.moodConsented) this.setData({ moodConsented: false });
    return yes;
  },
  moodBack() {
    const id = this.pendingMood;
    this.pendingMood = "";
    const thread = this.data.thread;
    if (this.consented() && thread && thread.id === id) this.patchThread({ scene: "mood" });
  },
  moodaccept() {
    this.askMood(true);
  },
  mooddecline() {
    this.setData({ sceneCandidate: false });
  },
  pickCards() {
    const app = getApp();
    app.globalData.cardPick = { mode: "chat", selected: chatV2.selectedIds(this.data.thread), limit: 3 };
    // Stays null unless card-pick hands back a list, so going back changes nothing.
    app.globalData.pickedCards = null;
    this.picking = true;
    wx.navigateTo({ url: "/pages/card-pick/index?mode=chat&limit=3" });
  },
  // Back from card-pick: carry the cards along, or start a chat with them.
  picked() {
    this.picking = null;
    const app = getApp();
    const cards = app.globalData.pickedCards;
    app.globalData.pickedCards = [];
    if (!Array.isArray(cards)) return;
    if (this.data.thread) return this.updateCards(cards.map((card) => card.id).slice(0, 3));
    if (cards.length) return this.startWith(cards);
  },
  // Resolves whether the cards were saved.
  updateCards(ids, dismissIds) {
    const thread = this.data.thread;
    if (!thread) return Promise.resolve(false);
    return api
      .put(`/v1/chat/threads/${thread.id}/cards`, { cardIds: ids, dismissIds: dismissIds || [], tone: TONE })
      .then(({ thread: fresh }) => {
        this.setData({ thread: threadOf(fresh) });
        return true;
      })
      .catch((error) => {
        if (!api.needsConsent(error)) wx.showToast({ title: errorText(error), icon: "none" });
        return false;
      });
  },
  suggestadd(e) {
    const id = e.detail.id;
    const ids = chatV2.selectedIds(this.data.thread);
    if (ids.includes(id)) return;
    if (ids.length >= 3) return wx.showToast({ title: "一次最多带 3 张卡", icon: "none" });
    this.updateCards(ids.concat(id)).then((saved) => {
      if (saved) this.setData({ suggestions: this.data.suggestions.filter((card) => card.id !== id) });
    });
  },
  suggestdismiss(e){const id=e.detail.id;api.post(`/v1/chat/threads/${this.data.thread.id}/suggest-cards`,{omitIds:[id]}).catch(()=>{});this.setData({suggestions:this.data.suggestions.filter(card=>card.id!==id)});},
  removecard(e){this.updateCards(chatV2.selectedIds(this.data.thread).filter(id=>id!==e.detail.id));},
  collectMessage(e){const id=(e.currentTarget.dataset||{}).id || (e.detail||{}).id;const message=this.data.messages.find(item=>item.id===id);if(!message||!this.data.thread)return;getApp().globalData.collect={...chatV2.collectIntent(message,this.data.thread,message.guide),quotes:chatV2.quotes(this.data.messages)};wx.navigateTo({url:"/pages/collect/index"});},
  collectSpot(e){const id=(e.currentTarget.dataset||{}).id || (e.detail||{}).id;const message=this.data.messages.find(item=>item.id===id);if(!message||!this.data.thread||!message.guide)return;getApp().globalData.collect={...chatV2.collectIntent(message,this.data.thread,message.guide),mine:message.guide.spot,quotes:chatV2.quotes(this.data.messages)};wx.navigateTo({url:"/pages/collect/index"});},
  teachActive(scope,account,threadId){return this.alive&&scope===this.scope&&owner()===account&&this.data.thread&&this.data.thread.id===threadId;},
  teachchange(e){const id=(e.currentTarget.dataset||{}).id||(e.detail||{}).id,i=this.index(id),message=this.data.messages[i];if(i<0||!message||!message.quote)return;this.setData({[`messages[${i}].quoteChoices`]:chatV2.teachQuotes(this.data.messages,message.selectedQuote||message.quote)});},
  teachpick(e){const detail=e.detail||e.currentTarget.dataset,id=detail.id,i=this.index(id),message=this.data.messages[i],value=String(detail.quote||"").trim();if(i<0||!message||!chatV2.teachQuotes(this.data.messages,message.quote).includes(value))return;this.setData({[`messages[${i}].selectedQuote`]:value,[`messages[${i}].quoteChoices`]:[]});},
  teachsave(e){const detail=e.detail||e.currentTarget.dataset,i=this.index(detail.id),message=this.data.messages[i],thread=this.data.thread,quote=String(detail.quote||message&&message.selectedQuote||message&&message.quote||"").trim();if(i<0||!message||!thread||thread.mode!=="teach"||message.mineSaving||message.mineSaved)return;if(quote.length<10)return this.setData({error:"这句短了点，换一句长一点的"});const target=chatV2.teachTarget(thread);if(!target){getApp().globalData.collect=chatV2.teachCollectIntent(message,thread,quote,this.data.messages);return wx.navigateTo({url:"/pages/collect/index"});}const scope=this.scope,account=owner(),threadId=thread.id;this.setData({[`messages[${i}].mineSaving`]:true,error:""});return api.get(`/v1/cards/${encodeURIComponent(target.id)}`).then(card=>this.teachActive(scope,account,threadId)?api.post(`/v1/cards/${encodeURIComponent(target.id)}/mine`,{version:card.version,text:quote}):undefined).then(result=>{if(!result||!this.teachActive(scope,account,threadId))return;if(result.crisis)return wx.navigateTo({url:"/pages/crisis/index"});this.setData({[`messages[${i}].mineSaved`]:true,[`messages[${i}].selectedQuote`]:quote,[`messages[${i}].quoteChoices`]:[]});wx.showToast({title:"存下了",icon:"success"});}).catch(error=>{if(this.teachActive(scope,account,threadId)&&!api.needsConsent(error))this.setData({error:errorText(error)});}).finally(()=>{if(this.teachActive(scope,account,threadId))this.setData({[`messages[${i}].mineSaving`]:false});});},
  // 先放着 / 聊完了，存成卡: AI drafts the card, the collect page stores it.
  openWrap() {
    const thread = this.data.thread;
    if (!thread || this.data.busy) return;
    this.offered[thread.id] = true;
    const count = this.data.messages.length;
    const kept = chatV2.keptWrap(thread.id, count);
    if (kept) {
      getApp().globalData.collect = kept;
      return wx.navigateTo({ url: "/pages/collect/index" });
    }
    // 此刻截取当前题目的引用和账号；token 过期后重新登录仍属于同一账号。
    const who = tools.account(),
      quotes = chatV2.quotes(this.data.messages);
    this.setData({ busy: "wrap", busyAt: Date.now(), error: "", wrapDue: false });
    return api
      .post(`/v1/chat/threads/${thread.id}/wrap`, { action: "open" }, { timeout: 150000 })
      .then((draft) => {
        const now = this.data.thread;
        if (!this.alive || !now || now.id !== thread.id || !tools.sameAccount(who)) return;
        this.setData({ thread: { ...now, wrapReady: true } });
        // Finished while the learner was elsewhere: only 理好的卡还没存 waits.
        if (this.hidden) return;
        getApp().globalData.collect = { mode: "wrap", threadId: thread.id, count, draft, quotes };
        wx.navigateTo({ url: "/pages/collect/index" });
      })
      .catch((error) => {
        if (!api.needsConsent(error)) this.setData({ error: errorText(error) });
      })
      .finally(() => this.setData({ busy: "" }));
  },
  revealSimilar(event) {
    const id = event.currentTarget.dataset.id;
    api
      .post(`/v1/chat/messages/${id}/reveal`, { tone: TONE })
      .then((message) => {
        const i = this.index(id);
        const old = this.data.messages[i];
        if (i >= 0) this.setData({ [`messages[${i}]`]: decorate({ ...message, picked: old && old.picked }) });
      })
      .catch((error) => this.setData({ error: errorText(error) }));
  },
  // ---- 拍一道题  -------------------------------------------------------
  // 拍照 or 相册 on the start page.
  pickStart(event) {
    if (this.data.guest) return gate.ask();
    if (this.data.sending || this.data.scanning) return;
    tools.pick(event.detail.source).then((file) => file && this.scanPhoto(file, "problem"));
  },
  closeConfirm() {
    const confirm = this.data.confirm;
    this.lastScan = null;
    this.setData({ confirm: null, stuck: null, error: "" });
    // The check shown goes; a photo kept meanwhile for 上次拍的题 stays.
    if (confirm) this.dropOwn(confirm.key);
    this.ownKey = "";
  },
  pickConfirm(event) {
    const confirm = this.data.confirm;
    const p = confirm && confirm.problems[Number(event.currentTarget.dataset.index)];
    if (!p) return;
    // 照片的每道题各自保存卡点；为某题输入或识别的步骤始终属于该题，不能随切题发给另一题。
    const shown = showProblem(confirm, this.data.stuck, p.index);
    this.setData({
      confirm: { ...shown.confirm, text: p.text, blocks: p.blocks || [], unclear: p.unclear || "", editing: confirm.typed, pv: null },
      stuck: shown.stuck,
    });
  },
  // V4.2 FX5b (V5): while the problem is corrected, the typeset text shows
  // under the box (as a step does in step-edit); 好了 goes back to it typeset.
  editConfirm() {
    const confirm = this.data.confirm;
    if (!confirm) return;
    this.pvText = confirm.text;
    this.setData({ "confirm.editing": true, "confirm.pv": confirm.blocks && confirm.blocks.length && lineTex(confirm.text) ? confirm.blocks : null });
  },
  onConfirmText(event) {
    const text = event.detail.value;
    this.setData({ "confirm.text": text });
    this.studyTouch();
    const confirm = this.data.confirm;
    if (!confirm || confirm.typed) return;
    clearTimeout(this.pvTimer);
    this.pvTimer = setTimeout(() => this.typesetConfirm(text), 400);
  },
  typesetConfirm(text) {
    return lineBlocks(text).then((blocks) => {
      const confirm = this.data.confirm;
      if (!this.alive || !confirm || confirm.text !== text) return;
      this.pvText = text;
      this.setData({ "confirm.pv": blocks });
    });
  },
  confirmDone() {
    const confirm = this.data.confirm;
    if (!confirm) return;
    clearTimeout(this.pvTimer);
    const text = confirm.text;
    const fresh = this.pvText === text && confirm.pv;
    // Plain words show as written; a formula is typeset when its render is in.
    this.setData({
      "confirm.editing": false,
      "confirm.pv": null,
      "confirm.blocks": fresh || [{ t: "p", c: [{ t: "text", v: text }] }],
    });
    if (fresh || !lineTex(text)) return Promise.resolve();
    return lineBlocks(text).then((blocks) => {
      const now = this.data.confirm;
      if (this.alive && blocks && now && !now.editing && now.text === text) this.setData({ "confirm.blocks": blocks });
    });
  },
  previewConfirm() {
    const photo = this.data.confirm && this.data.confirm.photo;
    if (photo) wx.previewImage({ urls: [photo] });
  },
  // The photo fits another tool better: hand the same scan over.
  switchTool() {
    const confirm = this.data.confirm;
    if (!confirm || !confirm.suggest || !this.lastScan) return;
    tools.handOver(confirm.suggest.to, this.lastScan);
  },
  // What is sent for the checked problem; the other problems of the photo stay offered.
  confirmed() {
    const confirm = this.data.confirm;
    const text = confirm ? confirm.text.trim() : "";
    if (!text) {
      this.setData({ error: "先写上题目" });
      return null;
    }
    const pending = confirm.problems.filter((p) => p.index !== confirm.index && !p.asked).map((p) => p.text);
    return {
      problem: { text, ...(pending.length ? { pending } : {}) },
      ...(confirm.imageId ? { imageId: confirm.imageId } : {}),
    };
  },
  // 没思路 / 做到一半卡住 / 直接看解法.
  choose(event) {
    const way = event.currentTarget.dataset.way;
    const base = this.confirmed();
    if (!base) return;
    const confirm = this.data.confirm;
    if (way === "stuck") {
      // 重新打开已问过的题并编辑后，当前内容属于尚未提交的新输入；继续保留照片并提供确认入口。
      const again = confirm.problems.some((p) => p.index === confirm.index && p.asked);
      const problems = again ? { "confirm.problems": confirm.problems.map((p) => (p.index === confirm.index ? { ...p, asked: false } : p)) } : {};
      return this.setData({ stuck: { lines: [], text: "" }, error: "", ...problems });
    }
    const mode = way === "solution" ? "solution" : "auto";
    // 保存照片当前的确认稿；向服务端提交这一题时，其他题尚未结束的卡点不能丢失。
    if (confirm.imageId) this.keepCheck();
    this.setData({ confirm: null, stuck: null });
    // Typed text goes as before: the server tells a problem from a question.
    this.send(confirm.typed ? { text: base.problem.text, mode } : { ...base, mode }, true, { confirm, stuck: null }, confirm.index);
  },
  cancelStuck() {
    this.setData({ stuck: null });
  },
  onStuckLines(event) {
    this.setData({ "stuck.lines": event.detail.lines });
  },
  onStuckText(event) {
    this.setData({ "stuck.text": event.detail.value });
    this.studyTouch();
  },
  // What was written so far, from a photo: its steps become the editable lines.
  pickStuck(event) {
    if (this.data.scanning) return;
    const source = event.currentTarget.dataset.source;
    // 记录步骤识别发起时的确认稿与题目序号；结果只写回该题自己的卡点。
    const shown = this.data.confirm;
    const key = shown ? shown.key : "";
    const index = shown ? shown.index : 0;
    tools.pick(source).then((file) => {
      if (!file) return;
      const sentAt = Date.now();
      this.setData({ scanning: true, scanAt: sentAt, error: "" });
      // 步骤属于页面展示的题目及其账号；游客题目归属于第一个登录账号。
      // 先登录再识别，若 token 失效后重新登录的仍是同一账号，可以继续原识别流程。
      const shownFor = this.account;
      let who = "";
      return auth
        .login()
        .then(() => {
          who = tools.account();
          // The problem shown is another account's (the session of one ran
          // out, signing in gave another): its steps are not read, or paid.
          return !shownFor || who === shownFor ? tools.scan(file, "draft") : null;
        })
        .then((scan) => {
          if (!scan) return this.alive && this.pageFor(who);
          const steps = (scan.solution && scan.solution.steps) || [];
          // V4.2 FX5b : the page left while it was read: the steps go
          // into the problem kept on this phone, to find when 解题 opens again.
          if (!this.alive) {
            if (!tools.sameAccount(who) || !steps.length) return;
            // 结果只写回原题；重新打开的解题页若展示同一确认稿就更新页面，否则仅更新对应缓存。
            const open = openAskPage(this);
            if (open && open.lateSteps(key, index, who, steps, sentAt)) return;
            return keepSteps(key, index, steps, sentAt);
          }
          // Read as another account: the page moves to it, the problem goes.
          if (!this.pageFor(who)) return;
          const { confirm, stuck } = this.data;
          if (key && confirm && confirm.key === key) {
            if (!steps.length) return confirm.index === index && stuck && this.setData({ error: "没认出写的步骤，可以直接打字" });
            return this.putSteps(index, steps, sentAt);
          }
          // 若等待期间已问了同一照片的另一题，只回填缓存中的原题；确认稿已关闭则不再保存。
          if (steps.length) keepSteps(key, index, steps, sentAt);
        })
        .catch((error) => {
          if (this.alive && !api.needsConsent(error)) this.setData({ error: errorText(error) });
        })
        .finally(() => {
          if (!this.alive) return;
          this.setData({ scanning: false });
          this.showQuota();
        });
    });
  },
  sendStuck() {
    const stuck = this.data.stuck;
    const base = this.confirmed();
    if (!stuck || !base) return;
    const lines = tools.cleanLines(stuck.lines, 40);
    const text = stuck.text.trim();
    if (!lines.length && !text) return this.setData({ error: "写一下卡在哪，或者拍下已经写的" });
    const message = stuckText(lines, text);
    // Nothing is cut off silently: too long is said, and kept for editing.
    if (message.length > 2000) return this.setData({ error: "写得太长了，删掉几步再发" });
    const confirm = this.data.confirm;
    if (confirm.imageId) this.keepCheck();
    this.setData({ confirm: null, stuck: null });
    this.send({ ...base, text: message, stuck: true, mode: "auto" }, true, { confirm, stuck }, confirm.index);
  },
  // ---- photos ------------------------------------------------------------
  // The camera by the input: one problem, a draft to check, or a page of homework.
  photoMenu() {
    if (this.data.guest) return gate.ask();
    if (this.data.sending || this.data.scanning) return;
    wx.showActionSheet({
      itemList: PHOTOS.map((item) => item.text),
      success: ({ tapIndex }) => {
        const item = PHOTOS[tapIndex];
        if (!item) return;
        if (item.purpose !== "problem") return backTo(tools.ROUTE[item.purpose]);
        this.choosePhoto({ currentTarget: { dataset: { purpose: item.purpose } } });
      },
    });
  },
  choosePhoto(event) {
    const purpose = event.currentTarget.dataset.purpose || "problem";
    if (this.data.guest) return gate.ask();
    if (this.data.sending || this.data.scanning) return;
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["camera", "album"],
      sizeType: ["compressed"],
      success: ({ tempFiles }) => this.scanPhoto(tempFiles[0], purpose),
      fail: pickFailed,
    });
  },
  scanPhoto(file, purpose) {
    if (!file) return;
    if (file.size > PHOTO_LIMIT)
      return this.setData({ error: "照片太大了，裁小一点再试" });
    // 照片确认稿的时间取发起识别时刻，而非响应到达时刻，防止旧照片覆盖新题面。
    const sentAt = Date.now();
    this.setData({ scanning: true, scanAt: sentAt, error: "", scan: null });
    // 先登录，再以该账号识别并保存照片；token 过期后重新登录仍按同一账号处理。
    let who = "";
    auth
      .login()
      .then(() => {
        who = tools.account();
        return api.uploadTo(`/v1/chat/scan?tone=${TONE}&purpose=${purpose}`, file.tempFilePath);
      })
      .then((scan) => {
        const photo = file.tempFilePath;
        // V4.2 FX5b : the photo is read and counted. Left meanwhile, it
        // is kept on this phone for this account, and 解题 offers it when
        // opened again (restoreCheck), instead of reading it again.
        if (!this.alive) {
          if (!tools.sameAccount(who)) return;
          // 解题页已经重新打开时，仅在没有更新输入的前提下展示照片。
          const open = openAskPage(this);
          if (open && open.latePhoto(who, scan, photo, sentAt)) return;
          // 保存为“上次拍的题”，但不覆盖本机保存的更新照片。
          const kept = tools.kept("ask");
          if (!kept || !kept.confirm || (kept.confirm.at || 0) < sentAt)
            tools.keep("ask", { confirm: confirmView(scan, photo, sentAt), stuck: null, scan: { ...scan, photo } });
          return;
        }
        // Read as another account than the page's: the page moves to it.
        if (!this.pageFor(who)) return;
        // The 拍一道题 start : check the problem, then choose how to go on.
        if (purpose === "problem" && !this.data.thread && !this.data.messages.length) {
          this.lastScan = { ...scan, photo };
          this.setData({ confirm: confirmView(scan, photo, sentAt), stuck: null });
          // Kept at once: a closed app still finds it.
          return this.keepCheck();
        }
        // 输入栏中的照片也立即缓存；尚未使用就离开时，可从空白解题页的“上次拍的题”恢复。
        this.barScan = { ...scan, photo };
        if (!this.data.guest) {
          tools.keep("ask", { confirm: confirmView(scan, photo, sentAt), stuck: null, scan: this.barScan });
          this.ownKey = "";
        }
        this.setData({ scan: scanView(scan, purpose, photo) });
      })
      .catch((error) => {
        if (this.alive && !api.needsConsent(error)) this.setData({ error: errorText(error) });
      })
      .finally(() => {
        if (!this.alive) return;
        this.setData({ scanning: false });
        this.showQuota();
      });
  },
  // 服务端接收照片中的题目后，清除输入栏照片；其他题仍有未结束卡点时，afterAsked 继续保留确认稿。
  askedAbout({ imageId, index }) {
    const kept = tools.kept("ask");
    const rest = kept && kept.confirm && kept.confirm.imageId === imageId && afterAsked(kept, index);
    if (!rest) return this.dropBarScan(imageId);
    if (this.barScan && this.barScan.imageId === imageId) this.barScan = null;
    tools.keep("ask", rest);
    // Kept for 上次拍的题 now: not this page's to drop when it is left.
    this.ownKey = "";
  },
  // 输入栏照片被使用或主动关闭后同步清理缓存。识别已完成并计费的照片，必须等服务端接收其题目后再清理。
  // 普通提问以 start 事件为确认，整页作业以成功创建作业为确认；用户主动关闭也可清理。
  dropBarScan(imageId) {
    const scan = this.barScan;
    const id = imageId || (scan && scan.imageId);
    if (scan && scan.imageId === id) this.barScan = null;
    const kept = id && tools.kept("ask");
    const same = kept && ((kept.scan && kept.scan.imageId === id) || (kept.confirm && kept.confirm.imageId === id));
    if (same) tools.drop("ask");
  },
  closeScan() {
    this.dropBarScan();
    this.setData({ scan: null });
  },
  editProblem(event) {
    const index = event.currentTarget.dataset.index;
    const problem = this.data.scan.problems[index];
    this.setData({ "scan.editing": index, "scan.editText": problem ? problem.text : "" });
  },
  onEditText(event) {
    this.setData({ "scan.editText": event.detail.value });
    this.studyTouch();
  },
  // A photographed problem always starts a new conversation.
  askProblem(event) {
    const scan = this.data.scan;
    const index = Number(event.currentTarget.dataset.index);
    const picked = scan.problems[index];
    if (!picked) return;
    const text = (scan.editing === index ? scan.editText : picked.text).trim();
    if (!text) return;
    const pending = scan.problems.filter((p) => p.index !== index).map((p) => p.text);
    this.setData({ scan: null });
    // Refused (the allowance, the network): the problems show again, and the
    // photo stays kept until the server has the question.
    this.send(
      {
        problem: { text, ...(pending.length ? { pending } : {}) },
        imageId: scan.imageId,
        mode: "auto",
      },
      true,
      { scan },
    );
  },
  // A worked solution is graded in the current problem's conversation if there is one.
  // A whole page of homework, each problem graded on its own.
  gradeHomework() {
    const scan = this.data.scan;
    if (!scan) return;
    this.setData({ scan: null, error: "" });
    api
      .post("/v1/chat/homework", { imageId: scan.imageId, tone: TONE })
      .then((thread) => {
        this.dropBarScan(scan.imageId);
        wx.navigateTo({ url: `/${tools.ROUTE.grade}?id=${thread.id}` });
      })
      // 作业创建失败时恢复照片展示，保留缓存供重试。
      .catch((error) => this.setData({ error: errorText(error), ...(this.data.scan ? {} : { scan }) }));
  },
  openHomework() {
    const thread = this.data.thread;
    if (thread && thread.homeworkOf) wx.navigateTo({ url: `/${tools.ROUTE.grade}?id=${thread.homeworkOf}` });
  },
  // A photo of worked steps goes to 批改 as read (V4.2 FX2: one 批改, its
  // records in one place); the photo is not read or counted again there.
  gradeSteps() {
    const scan = this.data.scan;
    if (!scan || !scan.solution) return;
    this.dropBarScan();
    this.setData({ scan: null });
    getApp().globalData.toolScan = {
      to: "grade",
      scan: { imageId: scan.imageId, photo: scan.photo, problems: scan.problems, solution: scan.solution },
    };
    backTo(tools.ROUTE.grade);
  },
  // The whole text when it fits one message (2000); longer, the start of it,
  // and the page says so (V4.2 G7: it was cut at 1500 without a word).
  useNotes() {
    const scan = this.data.scan;
    const ask = "\n\n这段讲的是什么？";
    const room = 2000 - ask.length;
    const cut = scan.notes.length > room;
    this.dropBarScan();
    this.setData({
      scan: null,
      draft: `${scan.notes.slice(0, room)}${ask}`,
      notice: cut ? `这段太长，只带上了前 ${room} 字；可以删掉不用问的部分` : "",
    });
  },
  // Another problem from the same photo starts its own conversation; the rest stay offered.
  pickPending(event) {
    const thread = this.data.thread;
    const index = Number(event.currentTarget.dataset.index);
    const text = thread && thread.pending[index];
    if (!text) return;
    const rest = thread.pending.filter((_, i) => i !== index);
    // 发送“从这里给我提示”时，带上该题在照片确认稿中保存的卡点和步骤。
    const kept = thread.imageId ? tools.kept("ask") : null;
    const confirm = kept && kept.confirm && kept.confirm.imageId === thread.imageId ? kept.confirm : null;
    // 同一照片有两道文本相同的题时，无法确认对应哪道；只发送当前题面，保留各题原有卡点。
    const same = confirm ? (confirm.problems || []).filter((q) => !q.asked && String(q.text || "").trim() === text.trim()) : [];
    const p = same.length === 1 ? same[0] : null;
    const stuck = p ? (p.index === confirm.index ? kept.stuck : p.stuck) : null;
    const lines = stuck ? tools.cleanLines(stuck.lines || [], 40) : [];
    const said = stuck ? String(stuck.text || "").trim() : "";
    const message = lines.length || said ? stuckText(lines, said) : "";
    // Too long for one message: the problem goes alone, its 卡住 stays kept.
    const withLines = Boolean(message) && message.length <= 2000;
    this.send(
      {
        problem: { text, ...(rest.length ? { pending: rest } : {}) },
        ...(thread.imageId ? { imageId: thread.imageId } : {}),
        ...(withLines ? { text: message, stuck: true } : {}),
        mode: "auto",
      },
      true,
      null,
      p && (withLines || !message) ? p.index : -1,
    );
  },
  viewPhoto(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    api
      .download(`/v1/chat/images/${id}`, "照片")
      .then((path) => wx.previewImage({ urls: [path] }))
      .catch((error) => this.setData({ error: errorText(error) }));
  },
  // ---- history -----------------------------------------------------------
  openHistory() {
    if (this.data.guest) return gate.ask();
    this.setData({ history: true });
    this.loadThreads();
  },
  closeHistory() {
    this.setData({ history: false });
  },
  openThread(event) {
    if (this.data.guest) return gate.ask();
    const { id, homework, tool } = event.currentTarget.dataset;
    // 批改 (a draft or a page) and 讲一遍 reopen on their own pages.
    const to = homework || tool === "draft" ? "grade" : tool === "teach" ? "teach" : "";
    if (!to) return this.open(id);
    this.setData({ history: false });
    wx.navigateTo({ url: `/${tools.ROUTE[to]}?id=${encodeURIComponent(id)}` });
  },
  removeThread(event) {
    const { id, homework } = event.currentTarget.dataset;
    wx.showModal({
      title: homework ? "删掉这页作业？" : "删掉这段对话？",
      content: homework
        ? "照片和每道题的对话会删掉；错题本里的题还在。"
        : "对话和照片会删掉；做过的题还在，不会丢。",
      confirmText: "删掉",
      confirmColor: "#e0474c",
      success: ({ confirm }) => {
        if (!confirm) return;
        api
          .del(`/v1/chat/threads/${id}`)
          .then(() => {
            if (this.data.thread && this.data.thread.id === id) this.newChat();
            else this.loadThreads();
          })
          .catch((error) => this.setData({ error: errorText(error) }));
      },
    });
  },
  noop() {},
}));

/*
 * 学习导航与展示约定：共享章节、知识点相关的页面入口、提示和视图辅助。
 * 业务进度从接口读取；新增学习页时优先复用这里已有的跳转和返回路径。
 */
// Display helpers for the learning map (GET /v1/learn/map). The server computes
// every number; these only turn them into classes and sentences.
const { errorText } = require("./format");
const STAMP = { 起步: "start", 基础段: "base", 重点段: "key", 难点段: "hard" };
const TIERS = ["基础", "重点", "难点", "拓展"];
function stampOf(rank) {
  return STAMP[rank] || "start";
}
// "本周做对 4 个 · +60 经验 · 2 个点该复习，做一题就亮". The count is the reviews in
// today's list still undone (at most 3): the backlog stays on the map (spec §9).
function weekLine(summary) {
  const reviews = summary.todayList.filter((t) => t.kind === "review" && !t.done).length;
  const parts = [
    summary.week.correct
      ? `本周做对 ${summary.week.correct} 个 · +${summary.week.xp} 经验`
      : "本周还没有新做对的点",
  ];
  if (reviews) parts.push(`${reviews} 个点该复习，做一题就亮`);
  return parts.join(" · ");
}
// The error bar already ends in a 再试一次 link, so drop the message's own "再试":
// "网络不太好，检查一下再试" -> "网络不太好，检查一下".
function retryText(error) {
  return errorText(error).replace(/(后重试|，?请重试|，?再试一次|再试)$/, "");
}
// All points on the map, hidden chapters included.
function pointCount(chapters) {
  return chapters.reduce((n, c) => n + c.points.length, 0);
}
// Tiers that set a chapter's rank, bottom up: passing RANKED[i] reaches RANKS[i + 1].
const RANKS = ["起步", "基础段", "重点段", "难点段"];
const RANKED = ["基础", "重点", "难点"];
// Tier tags on the point page (README 视觉规则, 层级标签).
const TIER_CLS = { 基础: "base", 重点: "key", 难点: "hard", 拓展: "ext" };
const { LOOKS, lookKey, lookOf } = require("./point-look");
// The server's states by their look's text (the old table, kept for callers
// that only have `state`).
const STATE_TEXT = {
  none: LOOKS.none.text,
  seen: LOOKS.seen.text,
  practice: LOOKS.practice.text,
  self: LOOKS.self.text,
  inferred: LOOKS.inferred.text,
  stuck: LOOKS.stuck.text,
  correct: LOOKS.correct.text,
  due: LOOKS.due.text,
};
// The plain sentence of each rank (Ranks board).
const RANK_LINES = {
  起步: "刚开始，这一章的基础还没做够。不代表你不会。",
  基础段: "这一章的基本概念、公式和直接套用的题，大部分你自己做对过。",
  重点段: "这一章作业和考试里最常考的方法，大部分你做对过。",
  难点段: "要转个弯、几步串起来的题，大部分你也做对过。这只说明地图上的题做对过，不等于综合大题和完整证明都有把握。",
};
const COUNT = ["", "一", "两", "三"];
// The cell legend of the map and the ranks page.
const LEGEND = [
  { cls: "", text: LOOKS.none.text },
  { cls: "seen", text: LOOKS.seen.text },
  { cls: "practice", text: LOOKS.practice.text },
  { cls: "self", text: LOOKS.self.text },
  { cls: "correct", text: LOOKS.correct.text },
  { cls: "retest", text: LOOKS.retest.text },
  { cls: "due", text: LOOKS.due.text },
  { cls: "stuck", text: LOOKS.stuck.text },
  { cls: "", red: true, text: "错题本里有这类题" },
];
// "经验 10/84，再得 74 升到 Lv.12", or 满级 once every point not hidden is done.
function xpLine(s) {
  return s.maxed
    ? "满级"
    : `经验 ${s.levelXp}/${s.levelNeed}，再得 ${s.levelNeed - s.levelXp} 升到 Lv.${s.level + 1}`;
}
// The book rank's sentence on the book rank-up card (spec §11, 第 4 档).
const BOOK_LINES = {
  基础段: "每一章的基础都大部分做对过。",
  重点段: "每一章的重点也大部分做对过。",
  难点段: "每一章的难点也大部分做对过。",
};
// "本章没有难点，重点达标就连升两段" when the next tier skips a missing one
// (up.skip); "" when it brings one rank. Chapter page and rank-up sheet share it.
function upJump(up, rank) {
  const steps = RANKS.indexOf(up.rank) - RANKS.indexOf(rank);
  return steps > 1
    ? `${up.skip.map((t) => `本章没有${t}，`).join("")}${up.tier}达标就连升${COUNT[steps] || steps}段`
    : "";
}
// What an answer changed (spec §11): the XP gained, a level-up line, the
// chapter's rank-up and the book's, from the brief summaries before and after
// the answer. Only the answered point's chapter can rise.
function moment(before, after, chapterId) {
  const xp = Math.max(0, after.xp - before.xp);
  const levelUp =
    after.level > before.level
      ? { level: after.level, text: `升到 Lv.${after.level}`, sub: xpLine(after) }
      : null;
  const was = before.chapters.find((c) => c.id === chapterId);
  const now = after.chapters.find((c) => c.id === chapterId);
  let rankUp = null;
  if (was && now) {
    const from = RANKS.indexOf(was.rank);
    const to = RANKS.indexOf(now.rank);
    if (to > from) {
      // Tiers passed on the way; one with no points is why two ranks came at once.
      const skipped = RANKED.slice(from, to).filter((tier) => {
        const t = now.tiers.find((x) => x.tier === tier);
        return t && t.total === 0;
      });
      const up = now.up;
      rankUp = {
        from: was.rank,
        to: now.rank,
        steps: to - from,
        jump:
          to - from > 1
            ? [`连升${COUNT[to - from]}段`, ...skipped.map((t) => `本章没有${t}`)].join(" · ")
            : "",
        // 下一段 from the server's up; null at 难点段.
        next: up
          ? {
              rank: up.rank,
              stamp: stampOf(up.rank),
              tier: up.tier,
              gap: `还差 ${up.gap} 个${up.tier}`,
              note: upJump(up, now.rank),
            }
          : null,
      };
    }
  }
  // 全书升段: the same card full screen, with every chapter not hidden.
  const bookFrom = RANKS.indexOf(before.book.rank);
  const bookTo = RANKS.indexOf(after.book.rank);
  const book =
    bookTo > bookFrom
      ? {
          from: before.book.rank,
          to: after.book.rank,
          stamp: stampOf(after.book.rank),
          title: `高数上 全书 升到 ${after.book.rank}`,
          line: BOOK_LINES[after.book.rank] || "",
          chapters: after.chapters
            .filter((c) => !c.hidden)
            .map((c) => ({ id: c.id, rank: c.rank, stamp: stampOf(c.rank) })),
        }
      : null;
  return { xp, levelUp, rankUp, book };
}
// One tier's cells in map order, `fresh` marking the point just lit.
function tierCells(points, tier, freshId) {
  return points
    .filter((p) => p.tier === tier)
    .map((p) => ({ id: p.id, cls: lookOf(p).cell, fresh: p.id === freshId }));
}
// "做对 5/6，要 5"; 拓展 never sets a rank, so it has no 要.
function tierCount(t) {
  return t.need === null || t.need === undefined
    ? `做对 ${t.done}/${t.total}`
    : `做对 ${t.done}/${t.total}，要 ${t.need}`;
}
// The rank-up sheet's line: "做对 0/5，要 4 · 看过 1"; no 看过 when none is
// seen or the map did not come back (D7).
function sheetCount(t, seen) {
  return seen ? `${tierCount(t)} · 看过 ${seen}` : tierCount(t);
}
// The answer box: placeholder and the line under it.
function answerHints(problem) {
  const v = problem.var || "x";
  // A number problem's note says what to write ("写精确值", "只填数字"), so the
  // placeholder then gives no example of its own that could contradict it.
  if (problem.kind === "number" && problem.note) return { placeholder: "写你的答案", hint: problem.note };
  const placeholder = {
    number: "写精确值，如 3/4",
    expr: `写关于 ${v} 的式子`,
    antiderivative: "写一个原函数，记得 +C",
  }[problem.kind] || "写你的答案";
  return { placeholder, hint: problem.note || "分数、根号、π、e 都能认出" };
}
// How to rewrite an answer the judge could not read, by the judge's reason.
function unsureText(reason, v) {
  const text = {
    decimal: "小数换成分数、根号、π 或 e 再交",
    division: "除号后面加个乘号或括号再交，如 1/(2x) 或 (1/2)x",
    "missing-c": "不定积分要写 +C，补上再交",
    ambiguous: "这个写法有两种读法，加上括号再交",
    abs: "ln 里面要加绝对值，写成 ln|…| 再交",
    tex: "不用写 TeX 命令，按 ln(x)、sqrt(x)、1/2 这样写再交",
    variable: `答案里有 ${v} 以外的字母，记得换回 ${v} 再交`,
    integral: "积分还没算完，算出结果再交",
    implicit: "写成 y = … 的显式式子再交",
    log: "自然对数写 ln，常用对数写 lg，改一下再交",
  }[reason];
  return text || "这个写法认不出，换个写法再交";
}
// The verdict line. A wrong answer never shows the standard answer.
function verdictText(result, v) {
  if (result.verdict === "correct") {
    if (result.counted === "lapse") return "这次做对了，明天再回头看看";
    if (result.counted === "review")
      return result.review.interval === null
        ? "做对了。这个点以后不再提醒，想练随时能做。"
        : `做对了，${result.review.interval} 天后再回头看看`;
    if (result.counted === "again") return "做对了。这个点之前做对过，这次不加经验。";
    if (result.counted === "practice") return "做对了。今天只算练习，明天再做对就算数。";
    return "做对了";
  }
  if (result.verdict === "incorrect") {
    const text = result.reason === "extra-c"
      ? "不对。这题不用加 C"
      : result.reason === "constant"
        ? "不对。要代入初始条件，把常数定出来"
        : "不对，可以再试";
    return result.counted === "lapse"
      ? `${text}。明天再回头看看这个点`
      : text;
  }
  return unsureText(result.reason, v);
}
// One point row on the chapter page: cell, name, status and section. The 下一段
// block lists its points without a status (`bare`), except 题还在出.
// A point without a problem yet (ready false) cannot be done, so it never
// shows 做对就升段. In a chapter not started, untouched cells are lighter (muted).
const isDone = (p) => p.state === "correct" || p.state === "due";
const isReady = (p) => p.ready !== false;
function pointRow(p, push, bare, muted) {
  const look = lookOf(p);
  const waiting = !isReady(p) && !isDone(p) ? "题还在出" : "";
  return {
    id: p.id,
    name: p.name,
    section: p.section,
    cell: look.cell || (muted ? "muted" : ""),
    // 做对就升段 marks the points of the next tier when one more is enough.
    status: push ? "" : bare ? waiting : (look.key !== "none" && look.text) || waiting,
    push,
  };
}
// 章节页 (Chapter board): one chapter of GET /v1/learn/map with its points, tiers and up.
function chapterView(c) {
  const points = c.points;
  const byId = {};
  points.forEach((p) => (byId[p.id] = p));
  const up = c.up;
  const muted = !c.started;
  // With one more point needed, every point not done of that tier that has a
  // problem would do it.
  const pushes = new Set(up && up.gap === 1 ? up.ids.filter((id) => byId[id] && isReady(byId[id])) : []);
  let next = null;
  if (up) {
    const rows = up.gap === 1 ? up.ids.filter((id) => byId[id]).map((id) => pointRow(byId[id], false, true, muted)) : [];
    const ready = rows.filter((r) => pushes.has(r.id));
    // Fewer points with a problem than the gap: nothing can be promised,
    // self-assessed or not. The 下一步 line (summary.ts nextStep) counts the same.
    const readyCount = up.ids.filter((id) => byId[id] && isReady(byId[id])).length;
    let note = "";
    if (readyCount < up.gap) note = "这一层的题还在出。";
    else if (up.selfOnly) note = `还差的 ${up.gap} 个${up.tier}你标了会，做对就升${up.rank}。`;
    else if (ready.length > 1) note = `做对其中任一个，就升${up.rank}。`;
    else if (ready.length === 1)
      note = rows.length === 1 ? `做对这一个，就升${up.rank}。` : `做对“${ready[0].name}”，就升${up.rank}。`;
    next = {
      rank: up.rank,
      stamp: stampOf(up.rank),
      gap: `还差 ${up.gap} 个${up.tier}`,
      rows,
      note,
      // 导数 has no 难点: "本章没有难点，重点达标就连升两段".
      jump: upJump(up, c.rank),
    };
  }
  const tiers = TIERS.map((tier) => {
    const t = c.tiers.find((x) => x.tier === tier) || { tier, done: 0, total: 0, need: null, self: 0 };
    const ranked = t.need !== null && t.need !== undefined;
    return {
      tier,
      cls: TIER_CLS[tier],
      none: t.total === 0,
      count: ranked
        ? `${tierCount(t)}${t.self ? ` · 标了会 ${t.self}` : ""}`
        : `做对 ${t.done}/${t.total}${t.self ? ` · 标了会 ${t.self}` : ""} · 不设段`,
      // 达标 or 还差 k; 拓展 sets no rank.
      side: !ranked ? "" : t.done >= t.need ? "达标" : `还差 ${t.need - t.done}`,
      ok: ranked && t.done >= t.need,
      rows: points.filter((p) => p.tier === tier).map((p) => pointRow(p, pushes.has(p.id) && !isDone(p), false, muted)),
    };
  });
  // 把剩下的标为会了 marks what is neither done nor self-assessed (selfRest's `changed`).
  const rest = points.filter((p) => !isDone(p) && p.state !== "self").length;
  const selfCount = points.filter((p) => p.state === "self").length;
  const first = points.length ? points[0].section : "";
  const last = points.length ? points[points.length - 1].section : "";
  return {
    id: c.id,
    short: c.short,
    hidden: c.hidden,
    started: c.started,
    rank: c.rank,
    stamp: stampOf(c.rank),
    meta: `${c.book} ${c.label} · ${c.total} 个点 · ${first}—${last}`,
    countText: `做对 ${c.done}/${c.total} 个点`,
    next,
    tiers,
    rest,
    restNote: `其余 ${rest} 个还没做对的点记成你会了（空心格）：不算段位、不加经验，随时能撤销；以后做对照样算、照样给经验`,
    selfCount,
  };
}
// The mini program keeps at most 10 pages; from 8 on, a new page replaces this one.
const STACK_LIMIT = 8;
// Where a link goes: back to the same page (route and, when given, options.id)
// already in the stack, nowhere when it is this page, else a new page.
function navPlan(pages, route, id) {
  const url = id ? `/${route}?id=${id}` : `/${route}`;
  let i = -1;
  pages.forEach((p, k) => {
    if (p.route === route && (!id || (p.options && p.options.id) === id)) i = k;
  });
  const top = pages.length - 1;
  if (i >= 0 && i === top) return { kind: "stay" };
  if (require("./theme").TAB_ROUTES.includes(route)) return { kind: "switchTab", url };
  if (i >= 0) return { kind: "back", delta: top - i };
  return { kind: pages.length >= STACK_LIMIT ? "redirectTo" : "navigateTo", url };
}
// Every learning-map link goes through here, so the stack stays shallow.
function backTo(route, id) {
  const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
  const plan = navPlan(pages, route, id);
  if (plan.kind === "back") wx.navigateBack({ delta: plan.delta });
  else if (plan.kind !== "stay") wx[plan.kind]({ url: plan.url });
  return plan;
}
const ROUTES = {
  learn: "pages/learn/index",
  map: "pages/map/index",
  chapter: "pages/chapter/index",
  point: "pages/point/index",
  ranks: "pages/ranks/index",
  bank: "pages/bank/index",
  knowledge: "pages/knowledge/index",
  // The study tools on 学习.
  draft: "pages/draft/index",
  homework: "pages/homework/index",
  teach: "pages/teach/index",
};
module.exports = {
  ROUTES,
  LEGEND,
  chapterView,
  navPlan,
  backTo,
  STAMP,
  TIERS,
  RANKS,
  TIER_CLS,
  STATE_TEXT,
  LOOKS,
  lookKey,
  lookOf,
  RANK_LINES,
  BOOK_LINES,
  stampOf,
  weekLine,
  pointCount,
  retryText,
  xpLine,
  moment,
  tierCells,
  tierCount,
  sheetCount,
  answerHints,
  unsureText,
  verdictText,
};

import { addDays, chinaDate } from "../../shared/time.js";
import type { LearnMap, MapChapter, MapPoint, Tier } from "./calc-map.js";

// Rule numbers. Every rule the learner sees is set here.
// Points done per tier to pass it: 80 %, rounded, at least 1 → ⌊(8n+5)/10⌋.
export const need = (n: number) => Math.floor((8 * n + 5) / 10);
// XP for the first correct answer on a point.
export const TIER_XP: Record<Tier, number> = {
  基础: 10,
  重点: 20,
  难点: 30,
  拓展: 20,
};
// Lv = ⌊√(XP ÷ 4)⌋ + 1, so Lv.n → n+1 takes 8n − 4 XP.
export const LEVEL_DIVISOR = 4;
// Review intervals in days; a lapse restarts at the first interval.
export const REVIEW_INTERVALS = [7, 21, 63] as const;
// Today's list: at most this many due reviews, then this many new points.
export const TODAY_REVIEWS = 3;
export const TODAY_NEW = 1;
// Tiers that set a chapter's rank, bottom up, and the rank each one unlocks.
export const RANKS = ["起步", "基础段", "重点段", "难点段"] as const;
export type Rank = (typeof RANKS)[number];
const RANKED: Tier[] = ["基础", "重点", "难点"];
const TIERS: Tier[] = ["基础", "重点", "难点", "拓展"];
// Reviews of these tiers come first in today's list.
const REVIEW_FIRST: Tier[] = ["重点", "难点"];

export function levelOf(xp: number) {
  let level = 1;
  while (LEVEL_DIVISOR * level * level <= xp) level++;
  const base = LEVEL_DIVISOR * (level - 1) ** 2;
  return {
    level,
    levelXp: xp - base,
    levelNeed: LEVEL_DIVISOR * level * level - base,
  };
}

// One map_points row: ISO times for *_at, Beijing dates (YYYY-MM-DD) for *_on.
export type PointRow = {
  pointId: string;
  correctAt: string | null;
  selfAt: string | null;
  seenAt: string | null;
  practiceOn: string | null;
  reviewedOn: string | null;
  dueOn: string | null;
  interval: number | null;
  red: boolean;
  redDue?: boolean; // the due date came from a red dot
  stuckAt?: string | null;
};
export type CellState = "none" | "seen" | "self" | "correct" | "due";
export type TierCount = {
  tier: Tier;
  done: number;
  total: number;
  // Points needed to pass; null for 拓展, which never sets a rank.
  need: number | null;
  self: number;
};
// What the chapter needs for its next rank (the 章节页 line 下一段 … 还差 …);
// null at 难点段.
export type ChapterUp = {
  // The rank reached once `tier` passes; a missing tier above it passes too,
  // so it can be two ranks up (导数: passing 重点 gives 难点段).
  rank: Rank;
  // The first ranked tier, bottom up, the chapter has and has not passed.
  tier: Tier;
  // need − done for that tier.
  gap: number;
  // The tier's points not done yet, in map order.
  ids: string[];
  // Every one of `ids` is self-assessed (spec §7: then the line mentions it).
  selfOnly: boolean;
  // Tiers jumped over because the chapter has no points in them (导数: ["难点"]).
  skip: Tier[];
};
export type ChapterSummary = {
  id: string;
  hidden: boolean;
  // A chapter with no point done, self-assessed or seen shows 还没开始 and no rank.
  started: boolean;
  rank: Rank;
  done: number;
  total: number;
  self: number;
  extDone: number;
  tiers: TierCount[];
  up: ChapterUp | null;
};
export type TodayItem = {
  kind: "review" | "retest" | "new";
  id: string;
  name: string;
  tier: Tier;
  chapterId: string;
  chapter: string;
  // Cell state on the map (a new point may have been seen before).
  state: CellState;
  // XP for doing a new point right; 0 for reviews, which give none (spec §8).
  xp: number;
  done: boolean;
  retest?: {
    id: number;
    cause: string;
    round: number;
    dueOn: string;
    result: string | null;
    repeated: boolean | null;
  };
};
export type Summary = {
  today: string;
  xp: number;
  level: number;
  levelXp: number;
  levelNeed: number;
  // Over chapters that are not hidden.
  correct: number;
  total: number;
  // Every point not hidden done once (spec §8 满级).
  maxed: boolean;
  chapters: ChapterSummary[];
  // Lowest rank among chapters not hidden; reached = how many are at 基础段 or above.
  book: { rank: Rank; reached: number; of: number };
  next: { text: string; chapterId: string | null };
  // Points first done this week, in chapters not hidden.
  week: { correct: number; xp: number };
  // Every due review in chapters not hidden; today's list shows at most TODAY_REVIEWS.
  due: number;
  todayList: TodayItem[];
  todayDone: boolean;
  cells: Record<string, { state: CellState; red: boolean }>;
};

const dateOf = (iso: string) => chinaDate(Date.parse(iso));
// Monday of the Beijing week that contains `today`.
export function weekStart(today: string) {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, -((weekday + 6) % 7));
}

function rankOf(passed: (tier: Tier) => boolean): Rank {
  let rank = 0;
  for (const tier of RANKED) {
    if (!passed(tier)) break;
    rank++;
  }
  return RANKS[rank]!;
}

export function summarize(
  map: LearnMap,
  rows: PointRow[],
  hidden: Set<string>,
  today: string,
  // whether a point has a problem yet; today's new point prefers those
  ready: (pointId: string) => boolean = () => true,
): Summary {
  const byId = new Map(rows.map((r) => [r.pointId, r]));
  const row = (p: MapPoint) => byId.get(p.id);
  const isCorrect = (p: MapPoint) => !!row(p)?.correctAt;
  const isSelf = (p: MapPoint) => !isCorrect(p) && !!row(p)?.selfAt;
  const isDue = (p: MapPoint) => {
    const r = row(p);
    return !!r?.correctAt && !!r.dueOn && r.dueOn <= today;
  };
  const touched = (p: MapPoint) => {
    const r = row(p);
    return !!(r?.correctAt || r?.selfAt || r?.seenAt);
  };
  // 最近做题的那一章 (spec §12) goes by the last correct answer; only while
  // nothing is done yet does a self-assessment or a seen point count.
  const anyCorrect = rows.some((r) => r.correctAt);
  const lastTouch = (p: MapPoint) => {
    const r = row(p);
    return (anyCorrect ? [r?.correctAt] : [r?.correctAt, r?.selfAt, r?.seenAt])
      .filter((t): t is string => !!t)
      .sort()
      .at(-1);
  };

  const cells: Summary["cells"] = {};
  let xp = 0;
  const monday = weekStart(today);
  const week = { correct: 0, xp: 0 };
  for (const chapter of map.chapters)
    for (const p of chapter.points) {
      const shownChapter = !hidden.has(chapter.id);
      const r = row(p);
      const state: CellState = isCorrect(p)
        ? isDue(p)
          ? "due"
          : "correct"
        : isSelf(p)
          ? "self"
          : r?.seenAt
            ? "seen"
            : "none";
      cells[p.id] = { state, red: !!r?.red };
      // Hidden chapters keep their XP: hiding is about scope, not about undoing work.
      // The week line counts like 做对 X/Y: chapters not hidden only.
      if (r?.correctAt) {
        xp += TIER_XP[p.tier];
        const day = dateOf(r.correctAt);
        if (shownChapter && day >= monday && day <= today) {
          week.correct++;
          week.xp += TIER_XP[p.tier];
        }
      }
    }

  const tierCount = (chapter: MapChapter, tier: Tier): TierCount => {
    const points = chapter.points.filter((p) => p.tier === tier);
    return {
      tier,
      done: points.filter(isCorrect).length,
      total: points.length,
      need: tier === "拓展" ? null : need(points.length),
      self: points.filter(isSelf).length,
    };
  };
  // A tier the chapter lacks counts as passed (导数 has no 难点).
  const passes = (t: TierCount) => t.total === 0 || t.done >= t.need!;
  const chapters: ChapterSummary[] = map.chapters.map((chapter) => {
    const tiers = TIERS.map((tier) => tierCount(chapter, tier));
    const of = (tier: Tier) => tiers.find((t) => t.tier === tier)!;
    const rank = rankOf((tier) => passes(of(tier)));
    return {
      id: chapter.id,
      hidden: hidden.has(chapter.id),
      started: chapter.points.some(touched),
      rank,
      done: chapter.points.filter(isCorrect).length,
      total: chapter.points.length,
      self: chapter.points.filter(isSelf).length,
      extDone: of("拓展").done,
      tiers,
      up: upOf(chapter, rank, of, passes, isCorrect, isSelf),
    };
  });
  const visible = chapters.filter((c) => !c.hidden);
  const rankIndex = (c: ChapterSummary) => RANKS.indexOf(c.rank);
  const book = {
    rank: visible.length
      ? RANKS[Math.min(...visible.map(rankIndex))]!
      : RANKS[0],
    reached: visible.filter((c) => rankIndex(c) >= 1).length,
    of: visible.length,
  };
  const correct = visible.reduce((n, c) => n + c.done, 0);
  const total = visible.reduce((n, c) => n + c.total, 0);

  const chapterOf = (id: string) => map.chapters.find((c) => c.id === id)!;
  const shown = new Set(visible.map((c) => c.id));
  const { next, target } = nextStep(visible, chapterOf, lastTouch, ready);

  const shownPoints = map.chapters
    .filter((c) => shown.has(c.id))
    .flatMap((c) => c.points.map((p) => ({ p, c })));
  const duePoints = shownPoints.filter(({ p }) => isDue(p));
  // Finished reviews keep their slots for today, including lapses. If more
  // than three were done, retain the first three in stable map order.
  const reviewed = shownPoints.filter(
    ({ p }) => isCorrect(p) && row(p)?.reviewedOn === today,
  );
  const pending = duePoints
    .filter(({ p }) => row(p)?.reviewedOn !== today)
    .sort((a, b) => {
      const pa = REVIEW_FIRST.includes(a.p.tier) ? 0 : 1;
      const pb = REVIEW_FIRST.includes(b.p.tier) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return row(a.p)!.dueOn!.localeCompare(row(b.p)!.dueOn!);
    });
  const todayList: TodayItem[] = [...reviewed, ...pending]
    .slice(0, TODAY_REVIEWS)
    .map(({ p, c }) =>
      item("review", p, c, cells[p.id]!.state, row(p)?.reviewedOn === today),
    );
  const completedNew = shownPoints
    .filter(
      ({ p }) => !!row(p)?.correctAt && dateOf(row(p)!.correctAt!) === today,
    )
    .sort((a, b) => row(b.p)!.correctAt!.localeCompare(row(a.p)!.correctAt!))
    .slice(0, TODAY_NEW);
  const freshPoints = completedNew.length
    ? completedNew
    : newPoints(map, shown, target, isCorrect, isSelf, ready);
  for (const fresh of freshPoints)
    todayList.push(
      item(
        "new",
        fresh.p,
        fresh.c,
        cells[fresh.p.id]!.state,
        completedNew.length > 0,
      ),
    );

  return {
    today,
    xp,
    ...levelOf(xp),
    correct,
    total,
    maxed: total > 0 && correct === total,
    chapters,
    book,
    next,
    week,
    due: duePoints.length,
    todayList,
    todayDone: todayList.length > 0 && todayList.every((entry) => entry.done),
    cells,
  };
}

// rankOf stops at the first tier not passed, so a chapter at RANKS[i] is held
// back by RANKED[i].
function upOf(
  chapter: MapChapter,
  rank: Rank,
  of: (tier: Tier) => TierCount,
  passes: (t: TierCount) => boolean,
  isCorrect: (p: MapPoint) => boolean,
  isSelf: (p: MapPoint) => boolean,
): ChapterUp | null {
  const from = RANKS.indexOf(rank);
  const tier = RANKED[from];
  if (!tier) return null;
  const t = of(tier);
  const to = rankOf((x) => x === tier || passes(of(x)));
  const ids = chapter.points
    .filter((p) => p.tier === tier && !isCorrect(p))
    .map((p) => p.id);
  const byId = new Map(chapter.points.map((p) => [p.id, p]));
  return {
    rank: to,
    tier,
    gap: t.need! - t.done,
    ids,
    selfOnly: ids.length > 0 && ids.every((id) => isSelf(byId.get(id)!)),
    skip: RANKED.slice(from + 1, RANKS.indexOf(to)).filter(
      (x) => of(x).total === 0,
    ),
  };
}

function item(
  kind: TodayItem["kind"],
  p: MapPoint,
  c: MapChapter,
  state: CellState,
  done = false,
): TodayItem {
  return {
    kind,
    id: p.id,
    name: p.name,
    tier: p.tier,
    chapterId: c.id,
    chapter: c.short,
    state,
    done,
    xp: kind === "review" ? 0 : TIER_XP[p.tier],
  };
}

// The 下一步 line (spec §12); never empty.
function nextStep(
  visible: ChapterSummary[],
  chapterOf: (id: string) => MapChapter,
  lastTouch: (p: MapPoint) => string | undefined,
  ready: (pointId: string) => boolean,
): {
  next: Summary["next"];
  target: { chapterId: string; tier: Tier | null } | null;
} {
  const top = RANKS.length - 1;
  const started = visible.filter((c) => c.started);
  const latest = (c: ChapterSummary) =>
    chapterOf(c.id)
      .points.map(lastTouch)
      .filter((t): t is string => !!t)
      .sort()
      .at(-1) || "";
  // 1. The chapter worked on most recently, unless it is at the top rank;
  // 2. otherwise the started chapter with the lowest rank.
  const recent = [...started].sort((a, b) =>
    latest(b).localeCompare(latest(a)),
  )[0];
  const lowest = [...started].sort(
    (a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank),
  )[0];
  const pick =
    recent && RANKS.indexOf(recent.rank) < top
      ? recent
      : lowest && RANKS.indexOf(lowest.rank) < top
        ? lowest
        : null;
  if (pick) {
    const short = chapterOf(pick.id).short;
    // The chapter page's 下一段 reads the same `up` and the same count of
    // points with a problem (utils/learn.js chapterView), so both pages say the same.
    const up = pick.up!;
    // Fewer points with a problem than the gap: the rank cannot be reached yet.
    const waiting = up.ids.filter(ready).length < up.gap;
    // spec §7: self-assessed points are mentioned only when they hold the rank back.
    return {
      next: {
        text: waiting
          ? `${short}的${up.tier}题还在准备`
          : up.selfOnly
            ? `${short}还差的 ${up.gap} 个${up.tier}你标了会，做对就升${up.rank}`
            : `${short}再做对 ${up.gap} 个${up.tier}，就升${up.rank}`,
        chapterId: pick.id,
      },
      target: { chapterId: pick.id, tier: up.tier },
    };
  }
  // 3. Every started chapter is at the top: the next chapter not started yet.
  const fresh = visible.find((c) => !c.started);
  if (fresh) {
    const { book, short } = chapterOf(fresh.id);
    return {
      next: {
        text: `开始${book}：${short}`,
        chapterId: fresh.id,
      },
      target: { chapterId: fresh.id, tier: null },
    };
  }
  if (!visible.length)
    return {
      next: { text: "所有章都设成了不学，去地图恢复一章", chapterId: null },
      target: null,
    };
  const left = visible.filter((c) => c.done < c.total);
  if (left.length)
    return {
      next: {
        text: `全书都到难点段了，还有 ${left.reduce((n, c) => n + c.total - c.done, 0)} 个点可以做`,
        chapterId: left[0]!.id,
      },
      target: { chapterId: left[0]!.id, tier: null },
    };
  return {
    next: { text: "全书的点都做对过了，到期的点记得复习", chapterId: null },
    target: null,
  };
}

// The new points in today's list: from the chapter and tier the 下一步 line
// points at first, then any chapter, in map order. Only points neither done nor
// self-assessed (spec §7: 我会了 keeps a point out of the daily list). Points
// with a problem come first, so the list does not open on 题目准备中.
function newPoints(
  map: LearnMap,
  shown: Set<string>,
  target: { chapterId: string; tier: Tier | null } | null,
  isCorrect: (p: MapPoint) => boolean,
  isSelf: (p: MapPoint) => boolean,
  ready: (pointId: string) => boolean,
) {
  const order = (points: MapPoint[]) =>
    points.filter((p) => !isCorrect(p) && !isSelf(p));
  const chapters = map.chapters.filter((c) => shown.has(c.id));
  const first = chapters.find((c) => c.id === target?.chapterId);
  const candidates: { p: MapPoint; c: MapChapter }[] = [];
  if (first) {
    const tiers = target!.tier ? [target!.tier] : TIERS;
    for (const tier of tiers)
      for (const p of order(first.points.filter((x) => x.tier === tier)))
        candidates.push({ p, c: first });
  }
  for (const c of chapters)
    for (const p of order(c.points)) candidates.push({ p, c });
  const unique = [...new Map(candidates.map((x) => [x.p.id, x])).values()];
  return [
    ...unique.filter((x) => ready(x.p.id)),
    ...unique.filter((x) => !ready(x.p.id)),
  ].slice(0, TODAY_NEW);
}

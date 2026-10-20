import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CALC_MAP, type Tier } from "../server/src/modules/learn/calc-map.js";
import {
  levelOf,
  need,
  summarize,
  type PointRow,
} from "../server/src/modules/learn/summary.js";
import { addDays } from "../server/src/shared/time.js";
import { sampleRows } from "./learn-sample.js";

const TODAY = "2026-10-01"; // a Thursday
const rowsOf = (today: string): PointRow[] =>
  sampleRows(today).map((r) => ({ ...r, practiceOn: null }));
const sample = (today = TODAY, hidden: string[] = []) =>
  summarize(CALC_MAP, rowsOf(today), new Set(hidden), today);
const done = (pointId: string, day = "2026-09-01"): PointRow => ({
  pointId,
  correctAt: `${day}T02:00:00.000Z`,
  selfAt: null,
  seenAt: null,
  practiceOn: null,
  reviewedOn: null,
  dueOn: addDays(day, 7),
  interval: 7,
  red: false,
});
const pointsOf = (chapter: string, tier?: Tier) =>
  CALC_MAP.chapters
    .find((c) => c.id === chapter)!
    .points.filter((p) => !tier || p.tier === tier)
    .map((p) => p.id);
const chapter = (s: ReturnType<typeof sample>, id: string) =>
  s.chapters.find((c) => c.id === id)!;
const tier = (s: ReturnType<typeof sample>, id: string, t: Tier) =>
  chapter(s, id).tiers.find((x) => x.tier === t)!;
const byName = (name: string) =>
  CALC_MAP.chapters.flatMap((c) => c.points).find((p) => p.name === name)!.id;

describe("the map", () => {
  it("has 89 points in six chapters with the textbook chapter labels", () => {
    assert.equal(CALC_MAP.chapters.flatMap((c) => c.points).length, 89);
    assert.deepEqual(
      CALC_MAP.chapters.map((c) => `${c.book} ${c.short}`),
      [
        "第 1 章 极限",
        "第 2 章 导数",
        "第 3 章 中值与应用",
        "第 4 章 不定积分",
        "第 5、6 章 定积分",
        "第 7 章 微分方程",
      ],
    );
  });
  it("carries no problem or answer", () => {
    const text = JSON.stringify(CALC_MAP);
    assert.doesNotMatch(text, /"(question|check)"/);
    assert.doesNotMatch(text, /x\/\(1-x\)/);
  });
});

describe("rule numbers", () => {
  it("need(n) is 80 % rounded, at least 1", () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(need),
      [1, 2, 2, 3, 4, 5, 6, 6, 7, 8],
    );
  });
  it("chapter thresholds match spec §4", () => {
    const s = summarize(CALC_MAP, [], new Set(), TODAY);
    const table = Object.fromEntries(
      s.chapters.map((c) => [
        c.id,
        c.tiers.map((t) => `${t.total}/${t.need ?? "-"}`).join(" "),
      ]),
    );
    assert.deepEqual(table, {
      limit: "9/7 3/2 4/3 1/-",
      derivative: "6/5 5/4 0/0 1/-",
      application: "6/5 6/5 5/4 2/-",
      indefinite: "3/2 3/2 1/1 0/-",
      definite: "7/6 7/6 4/3 1/-",
      ode: "4/3 5/4 2/2 4/-",
    });
  });
  it("levels: Lv = ⌊√(XP/4)⌋ + 1 with the bar inside the level", () => {
    assert.deepEqual(levelOf(0), { level: 1, levelXp: 0, levelNeed: 4 });
    assert.deepEqual(levelOf(4), { level: 2, levelXp: 0, levelNeed: 12 });
    assert.deepEqual(levelOf(390), { level: 10, levelXp: 66, levelNeed: 76 });
    assert.deepEqual(levelOf(410), { level: 11, levelXp: 10, levelNeed: 84 });
    assert.equal(levelOf(1444).level, 20);
    assert.equal(levelOf(1443).level, 19);
  });
  it("every point done: 1590 XP and Lv.20, every chapter at 难点段", () => {
    const all = CALC_MAP.chapters
      .flatMap((c) => c.points)
      .map((p) => done(p.id));
    const s = summarize(CALC_MAP, all, new Set(), TODAY);
    assert.equal(s.xp, 1590);
    assert.equal(s.level, 20);
    assert.equal(s.correct, 89);
    assert.ok(s.chapters.every((c) => c.rank === "难点段"));
    assert.deepEqual(s.book, { rank: "难点段", reached: 6, of: 6 });
    assert.ok(s.next.text.length > 0);
  });
});

describe("the sketch's sample", () => {
  // Thursday 2026-10-01 plus every other weekday, Monday and Sunday included.
  for (let i = 0; i < 7; i++) {
    const today = addDays(TODAY, i);
    it(`gives the sketch's numbers on ${today}`, () => {
      const s = sample(today);
      assert.equal(s.correct, 27);
      assert.equal(s.total, 89);
      assert.equal(s.xp, 390);
      assert.equal(s.level, 10);
      assert.equal(s.levelXp, 66);
      assert.equal(s.levelNeed, 76);
      assert.deepEqual(s.week, { correct: 4, xp: 60 });
      assert.equal(s.due, 2);
      assert.equal(s.next.text, "中值与应用再做对 1 个重点，就升重点段");
      assert.equal(s.next.chapterId, "application");
      assert.deepEqual(s.book, { rank: "起步", reached: 3, of: 6 });
      assert.deepEqual(
        s.todayList.map((t) => [t.kind, t.name]),
        [
          ["review", "等价无穷小替换"],
          ["review", "复合函数求导"],
          ["new", "最大值最小值应用题"],
        ],
      );
      assert.equal(s.todayList[2]!.xp, 20);
      assert.equal(s.todayList[2]!.done, true);
      assert.equal(s.todayDone, false);
    });
  }
  it("chapter ranks, counts and cells", () => {
    const s = sample();
    assert.deepEqual(
      s.chapters.map((c) => [c.id, c.started, c.rank, c.extDone]),
      [
        ["limit", true, "重点段", 1],
        ["derivative", true, "基础段", 0],
        ["application", true, "基础段", 0],
        ["indefinite", false, "起步", 0],
        ["definite", false, "起步", 0],
        ["ode", false, "起步", 0],
      ],
    );
    assert.deepEqual(tier(s, "limit", "基础"), {
      tier: "基础",
      done: 7,
      total: 9,
      need: 7,
      self: 1,
    });
    assert.equal(tier(s, "limit", "难点").done, 2);
    assert.equal(tier(s, "application", "重点").done, 4);
    assert.equal(chapter(s, "application").self, 1);
    assert.deepEqual(s.cells[byName("等价无穷小替换")], {
      state: "due",
      red: false,
    });
    assert.deepEqual(s.cells[byName("间断点及其分类")], {
      state: "none",
      red: true,
    });
    assert.equal(s.cells[byName("无穷小阶的比较")]!.state, "self");
    assert.equal(s.cells[byName("隐函数求导")]!.state, "seen");
    assert.equal(s.cells[byName("洛必达法则")]!.state, "correct");
    const states = Object.values(s.cells).map((c) => c.state);
    assert.equal(
      states.filter((x) => x === "correct" || x === "due").length,
      27,
    );
  });
});

describe("rules", () => {
  it("today retains completed reviews, caps them at three and resets tomorrow", () => {
    const rows = [
      { ...done("limit-equivalent"), reviewedOn: TODAY, interval: 0 },
      {
        ...done("derivative-chain"),
        reviewedOn: TODAY,
        dueOn: null,
        interval: 63,
      },
      {
        ...done("application-taylor-limit"),
        reviewedOn: TODAY,
        dueOn: addDays(TODAY, 21),
      },
      { ...done("indefinite-basic"), reviewedOn: TODAY },
    ];
    const s = summarize(CALC_MAP, rows, new Set(), TODAY);
    const reviews = s.todayList.filter((entry) => entry.kind === "review");
    assert.equal(reviews.length, 3);
    assert.ok(reviews.every((entry) => entry.done && entry.xp === 0));
    assert.equal(reviews[0]!.state, "due");
    assert.equal(reviews[1]!.state, "correct");
    assert.equal(s.todayDone, false); // A new point remains.
    const next = summarize(CALC_MAP, rows, new Set(), addDays(TODAY, 1));
    const tomorrow = next.todayList.filter((entry) => entry.kind === "review");
    assert.ok(
      tomorrow.some((entry) => entry.id === "limit-equivalent" && !entry.done),
    );
    assert.ok(tomorrow.every((entry) => entry.id !== "derivative-chain"));
    const hidden = summarize(CALC_MAP, rows, new Set(["limit"]), TODAY);
    assert.ok(hidden.todayList.every((entry) => entry.chapterId !== "limit"));
    const empty = summarize(
      CALC_MAP,
      [],
      new Set(CALC_MAP.chapters.map((c) => c.id)),
      TODAY,
    );
    assert.deepEqual(empty.todayList, []);
    assert.equal(empty.todayDone, false);
  });

  it("today's new slot is the latest first-correct point by Beijing date", () => {
    const rows = [
      {
        ...done("limit-rules"),
        correctAt: "2026-09-30T16:05:00Z",
        dueOn: addDays(TODAY, 7),
      },
      {
        ...done("derivative-chain"),
        correctAt: "2026-09-30T16:10:00Z",
        dueOn: addDays(TODAY, 7),
      },
    ];
    const s = summarize(CALC_MAP, rows, new Set(), TODAY);
    assert.equal(s.todayList.length, 1);
    assert.equal(s.todayList[0]!.id, "derivative-chain");
    assert.equal(s.todayList[0]!.done, true);
    assert.equal(s.todayDone, true);
    const hidden = summarize(CALC_MAP, rows, new Set(["derivative"]), TODAY);
    assert.equal(hidden.todayList[0]!.id, "limit-rules");
    assert.equal(hidden.todayDone, true);
  });

  it("derivative passing 重点 jumps straight to 难点段 (no 难点 tier)", () => {
    const rows = [
      ...pointsOf("derivative", "基础").slice(0, 5),
      ...pointsOf("derivative", "重点").slice(0, 3),
    ].map((id) => done(id));
    const before = summarize(CALC_MAP, rows, new Set(), TODAY);
    assert.equal(chapter(before, "derivative").rank, "基础段");
    assert.equal(before.next.text, "导数再做对 1 个重点，就升难点段");
    const after = summarize(
      CALC_MAP,
      [...rows, done(pointsOf("derivative", "重点")[3]!)],
      new Set(),
      TODAY,
    );
    assert.equal(chapter(after, "derivative").rank, "难点段");
  });
  it("a hidden chapter leaves the book rank, N/M and the point count, not the XP", () => {
    // Everything but 微分方程 at 难点段.
    const rows = CALC_MAP.chapters
      .filter((c) => c.id !== "ode")
      .flatMap((c) => c.points)
      .map((p) => done(p.id));
    const shown = summarize(CALC_MAP, rows, new Set(), TODAY);
    assert.deepEqual(shown.book, { rank: "起步", reached: 5, of: 6 });
    assert.equal(shown.total, 89);
    const hidden = summarize(CALC_MAP, rows, new Set(["ode"]), TODAY);
    assert.deepEqual(hidden.book, { rank: "难点段", reached: 5, of: 5 });
    assert.equal(hidden.total, 74);
    assert.equal(hidden.correct, 74);
    assert.equal(hidden.xp, shown.xp);
    assert.ok(chapter(hidden, "ode").hidden);
    // The sample with 定积分 hidden: still 3 chapters at 基础段, now out of 5.
    assert.deepEqual(sample(TODAY, ["definite"]).book, {
      rank: "起步",
      reached: 3,
      of: 5,
    });
  });
  it("拓展 never changes a rank", () => {
    const ext = pointsOf("ode", "拓展").map((id) => done(id));
    const s = summarize(CALC_MAP, ext, new Set(), TODAY);
    assert.equal(chapter(s, "ode").rank, "起步");
    assert.equal(chapter(s, "ode").extDone, 4);
    assert.equal(chapter(s, "ode").started, true);
    assert.equal(s.xp, 80);
    // And the sample's 极限 stays 重点段 without its 拓展 point.
    const rows = rowsOf(TODAY).filter((r) => r.pointId !== "limit-uniform");
    const t = summarize(CALC_MAP, rows, new Set(), TODAY);
    assert.equal(chapter(t, "limit").rank, "重点段");
    assert.equal(chapter(t, "limit").extDone, 0);
  });
  it("self-assessed never counts as correct", () => {
    const rows: PointRow[] = pointsOf("indefinite").map((id) => ({
      ...done(id),
      correctAt: null,
      dueOn: null,
      interval: null,
      selfAt: "2026-09-30T02:00:00.000Z",
    }));
    const s = summarize(CALC_MAP, rows, new Set(), TODAY);
    const c = chapter(s, "indefinite");
    assert.equal(c.rank, "起步");
    assert.equal(c.done, 0);
    assert.equal(c.self, 7);
    assert.equal(c.started, true);
    assert.equal(s.xp, 0);
    assert.equal(s.correct, 0);
    assert.equal(s.week.correct, 0);
    assert.ok(Object.values(s.cells).every((x) => x.state !== "correct"));
  });
  it("a red dot alone does not start a chapter", () => {
    const s = summarize(
      CALC_MAP,
      [{ ...done("ode-separable"), correctAt: null, dueOn: null, red: true }],
      new Set(),
      TODAY,
    );
    assert.equal(chapter(s, "ode").started, false);
    assert.deepEqual(s.cells["ode-separable"], { state: "none", red: true });
  });
  it("the next-step line is never empty", () => {
    const empty = summarize(CALC_MAP, [], new Set(), TODAY);
    assert.equal(empty.next.text, "开始第 1 章：极限");
    assert.equal(empty.todayList.length, 1);
    assert.equal(empty.todayList[0]!.kind, "new");
    assert.equal(empty.todayList[0]!.chapterId, "limit");
    assert.deepEqual(empty.book, { rank: "起步", reached: 0, of: 6 });
    assert.equal(empty.level, 1);
    // All started chapters at the top: on to the next one.
    const top = pointsOf("indefinite").map((id) => done(id));
    assert.equal(
      summarize(CALC_MAP, top, new Set(), TODAY).next.text,
      "开始第 1 章：极限",
    );
    // Every chapter hidden.
    const all = new Set(CALC_MAP.chapters.map((c) => c.id));
    assert.ok(summarize(CALC_MAP, [], all, TODAY).next.text.length > 0);
  });
  it("week starts on Monday in Beijing time", () => {
    // 2026-10-05 is a Monday; a point done on Sunday 10-04 is last week.
    const rows = [
      done("limit-function", "2026-10-04"),
      done("limit-rules", "2026-10-05"),
    ];
    const s = summarize(CALC_MAP, rows, new Set(), "2026-10-05");
    assert.deepEqual(s.week, { correct: 1, xp: 10 });
    // Monday 00:30 in Beijing is still Sunday in UTC: it counts this week.
    const early = summarize(
      CALC_MAP,
      [{ ...done("limit-function"), correctAt: "2026-10-04T16:30:00.000Z" }],
      new Set(),
      "2026-10-05",
    );
    assert.deepEqual(early.week, { correct: 1, xp: 10 });
  });
  it("the week line leaves out hidden chapters, the XP does not", () => {
    const rows = pointsOf("limit").map((id) => done(id, TODAY));
    const shown = summarize(CALC_MAP, rows, new Set(), TODAY);
    assert.deepEqual(shown.week, { correct: 17, xp: 290 });
    const hidden = summarize(CALC_MAP, rows, new Set(["limit"]), TODAY);
    assert.deepEqual(hidden.week, { correct: 0, xp: 0 });
    assert.equal(hidden.xp, shown.xp);
  });
  it("a point both done and self-assessed is done, not self; seen alone starts a chapter", () => {
    const s = summarize(
      CALC_MAP,
      [
        { ...done("limit-function"), selfAt: "2026-09-02T02:00:00.000Z" },
        {
          ...done("ode-separable"),
          correctAt: null,
          dueOn: null,
          seenAt: "2026-09-02T02:00:00.000Z",
        },
      ],
      new Set(),
      TODAY,
    );
    assert.equal(chapter(s, "limit").self, 0);
    assert.equal(chapter(s, "limit").done, 1);
    assert.notEqual(s.cells["limit-function"]!.state, "self");
    assert.equal(chapter(s, "ode").started, true);
    assert.equal(s.cells["ode-separable"]!.state, "seen");
  });
  it("满级 once every point not hidden is done", () => {
    assert.equal(sample().maxed, false);
    const all = CALC_MAP.chapters
      .flatMap((c) => c.points)
      .map((p) => done(p.id));
    assert.equal(summarize(CALC_MAP, all, new Set(), TODAY).maxed, true);
    const rest = CALC_MAP.chapters
      .filter((c) => c.id !== "ode")
      .flatMap((c) => c.points)
      .map((p) => done(p.id));
    assert.equal(summarize(CALC_MAP, rest, new Set(), TODAY).maxed, false);
    assert.equal(
      summarize(CALC_MAP, rest, new Set(["ode"]), TODAY).maxed,
      true,
    );
    assert.equal(summarize(CALC_MAP, [], new Set(), TODAY).maxed, false);
  });
  it("today: at most 3 reviews, 重点 and 难点 first by due date, no XP on reviews", () => {
    const rows = [
      done(pointsOf("limit", "基础")[0]!, "2026-09-01"), // due 09-08
      done(pointsOf("application", "重点")[0]!, "2026-09-02"), // due 09-09
      done(pointsOf("limit", "重点")[0]!, "2026-09-03"), // due 09-10
      done(pointsOf("derivative", "重点")[0]!, "2026-09-04"), // due 09-11
      done(pointsOf("limit", "难点")[0]!, "2026-09-05"), // due 09-12
    ];
    const s = summarize(CALC_MAP, rows, new Set(), TODAY);
    assert.equal(s.due, 5);
    const reviews = s.todayList.filter((t) => t.kind === "review");
    assert.deepEqual(
      reviews.map((t) => t.id),
      [rows[1]!.pointId, rows[2]!.pointId, rows[3]!.pointId],
    );
    assert.ok(reviews.every((t) => t.xp === 0 && t.state === "due"));
    assert.equal(s.todayList.filter((t) => t.kind === "new").length, 1);
    // A hidden chapter's due points leave the count and the list.
    const h = summarize(CALC_MAP, rows, new Set(["limit"]), TODAY);
    assert.equal(h.due, 2);
    assert.ok(h.todayList.every((t) => t.chapterId !== "limit"));
  });
  it("today's new point is never self-assessed", () => {
    const basics = pointsOf("limit", "基础");
    const self = (id: string): PointRow => ({
      ...done(id),
      correctAt: null,
      dueOn: null,
      interval: null,
      selfAt: "2026-09-02T02:00:00.000Z",
    });
    // A self-assessed point before an untouched one in the target tier.
    const a = summarize(
      CALC_MAP,
      [...basics.slice(0, 5).map((id) => done(id)), self(basics[5]!)],
      new Set(),
      TODAY,
    );
    assert.equal(a.next.text, "极限再做对 2 个基础，就升基础段");
    const freshA = a.todayList.find((t) => t.kind === "new")!;
    assert.equal(freshA.id, basics[6]);
    assert.equal(freshA.state, "none");
    // The rest of the target tier all self-assessed: spec §7's sentence, and
    // the new point comes from further on.
    const b = summarize(
      CALC_MAP,
      [
        ...basics.slice(0, 6).map((id) => done(id)),
        ...basics.slice(6).map(self),
      ],
      new Set(),
      TODAY,
    );
    assert.equal(b.next.text, "极限还差的 1 个基础你标了会，做对就升基础段");
    const freshB = b.todayList.find((t) => t.kind === "new")!;
    assert.equal(freshB.chapterId, "limit");
    assert.notEqual(freshB.tier, "基础");
    assert.notEqual(freshB.state, "self");
  });
  it("next step: fewer points with a problem than the gap promise nothing", () => {
    const basics = pointsOf("limit", "基础");
    const self = (id: string): PointRow => ({
      ...done(id),
      correctAt: null,
      dueOn: null,
      interval: null,
      selfAt: "2026-09-02T02:00:00.000Z",
    });
    const rows = basics.slice(0, 5).map((id) => done(id));
    const rest = basics.slice(5);
    // Two still needed, only one of the rest has a problem.
    const one = (id: string) => id === rest[0];
    const a = summarize(CALC_MAP, rows, new Set(), TODAY, one);
    assert.equal(chapter(a, "limit").up!.gap, 2);
    assert.equal(a.next.text, "极限的基础题还在准备");
    assert.equal(a.next.chapterId, "limit");
    // Self-assessed or not: still no promise.
    const b = summarize(
      CALC_MAP,
      [...rows, ...rest.map(self)],
      new Set(),
      TODAY,
      one,
    );
    assert.equal(chapter(b, "limit").up!.selfOnly, true);
    assert.equal(b.next.text, "极限的基础题还在准备");
    // Enough points with a problem: the usual sentences.
    const two = (id: string) => id === rest[0] || id === rest[1];
    assert.equal(
      summarize(CALC_MAP, rows, new Set(), TODAY, two).next.text,
      "极限再做对 2 个基础，就升基础段",
    );
    assert.equal(
      summarize(CALC_MAP, [...rows, ...rest.map(self)], new Set(), TODAY, two)
        .next.text,
      "极限还差的 2 个基础你标了会，做对就升基础段",
    );
  });
  it("next step: a top-ranked recent chapter hands over to the lowest started one", () => {
    const rows = [
      ...pointsOf("limit", "基础")
        .slice(0, 7)
        .map((id) => done(id, "2026-09-01")),
      ...pointsOf("indefinite").map((id) => done(id, "2026-09-20")),
    ];
    const s = summarize(CALC_MAP, rows, new Set(), TODAY);
    assert.equal(chapter(s, "indefinite").rank, "难点段");
    assert.equal(s.next.text, "极限再做对 2 个重点，就升重点段");
    assert.equal(s.next.chapterId, "limit");
    const fresh = s.todayList.find((t) => t.kind === "new")!;
    assert.equal(fresh.id, pointsOf("limit", "重点")[0]);
  });
  it("next step follows the last correct answer, not a point only seen", () => {
    const rows: PointRow[] = [
      done("limit-function", "2026-09-01"),
      done("derivative-definition", "2026-09-02"),
      {
        ...done("ode-separable"),
        correctAt: null,
        dueOn: null,
        seenAt: "2026-09-30T02:00:00.000Z",
      },
    ];
    const s = summarize(CALC_MAP, rows, new Set(), TODAY);
    assert.equal(s.next.chapterId, "derivative");
  });
  it("starting a chapter names it by its textbook chapter", () => {
    const s = summarize(CALC_MAP, [], new Set(["limit"]), TODAY);
    assert.equal(s.next.text, "开始第 2 章：导数");
  });
});

describe("up: what a chapter needs for its next rank (S4)", () => {
  const self = (pointId: string): PointRow => ({
    ...done(pointId),
    correctAt: null,
    dueOn: null,
    interval: null,
    selfAt: "2026-09-01T02:00:00.000Z",
  });
  const up = (rows: PointRow[], id: string) =>
    chapter(summarize(CALC_MAP, rows, new Set(), TODAY), id).up;
  it("the sample: 中值与应用 needs 1 more 重点 for 重点段, either of the two left", () => {
    const s = sample();
    assert.deepEqual(chapter(s, "application").up, {
      rank: "重点段",
      tier: "重点",
      gap: 1,
      ids: ["application-taylor-limit", "application-sketch"],
      selfOnly: false,
      skip: [],
    });
    assert.deepEqual(
      chapter(s, "application").up!.ids.map(
        (id) =>
          CALC_MAP.chapters.flatMap((c) => c.points).find((p) => p.id === id)!
            .name,
      ),
      ["泰勒公式求极限", "函数图形的描绘"],
    );
    // 极限 at 重点段 waits on 难点; an unstarted chapter on 基础.
    const limit = chapter(s, "limit").up!;
    assert.deepEqual(
      [limit.rank, limit.tier, limit.gap],
      ["难点段", "难点", 1],
    );
    const fresh = chapter(s, "indefinite").up!;
    assert.deepEqual(
      [
        fresh.rank,
        fresh.tier,
        fresh.gap,
        fresh.ids,
        fresh.selfOnly,
        fresh.skip,
      ],
      ["基础段", "基础", 2, pointsOf("indefinite", "基础"), false, []],
    );
  });
  it("导数 has no 难点: passing 重点 gives 难点段 and skips 难点", () => {
    assert.deepEqual(chapter(sample(), "derivative").up, {
      rank: "难点段",
      tier: "重点",
      // 高阶导数 is done in the sample.
      gap: 3,
      ids: pointsOf("derivative", "重点").filter(
        (id) => id !== "derivative-higher",
      ),
      selfOnly: false,
      skip: ["难点"],
    });
    // 重点 passed first: passing 基础 jumps to 难点段 at once.
    const first = up(
      pointsOf("derivative", "重点").map((id) => done(id)),
      "derivative",
    )!;
    assert.deepEqual(
      [first.rank, first.tier, first.gap, first.skip],
      ["难点段", "基础", 5, ["难点"]],
    );
  });
  it("重点 passed before 基础: passing 基础 gives 重点段, nothing skipped", () => {
    const u = up(
      pointsOf("limit", "重点").map((id) => done(id)),
      "limit",
    )!;
    assert.deepEqual(
      [u.rank, u.tier, u.gap, u.ids, u.skip],
      ["重点段", "基础", 7, pointsOf("limit", "基础"), []],
    );
  });
  it("selfOnly when every point left in the tier is self-assessed", () => {
    const [a, b, c] = pointsOf("indefinite", "基础");
    const held = up([done(a!), self(b!), self(c!)], "indefinite")!;
    assert.deepEqual(
      [held.tier, held.gap, held.ids, held.selfOnly],
      ["基础", 1, [b, c], true],
    );
    const mixed = up([done(a!), self(b!)], "indefinite")!;
    assert.equal(mixed.selfOnly, false);
    assert.deepEqual(mixed.ids, [b, c]);
    // 下一步 reads the same rule: one point untouched, so no 你标了会.
    const both = (rows: PointRow[]) =>
      summarize(CALC_MAP, rows, new Set(), TODAY).next.text;
    assert.equal(
      both([done(a!), self(b!)]),
      "不定积分再做对 1 个基础，就升基础段",
    );
    assert.equal(
      both([done(a!), self(b!), self(c!)]),
      "不定积分还差的 1 个基础你标了会，做对就升基础段",
    );
  });
  it("null at 难点段; hidden chapters keep theirs", () => {
    const all = CALC_MAP.chapters
      .flatMap((c) => c.points)
      .map((p) => done(p.id));
    const s = summarize(CALC_MAP, all, new Set(), TODAY);
    assert.ok(s.chapters.every((c) => c.up === null));
    assert.deepEqual(
      chapter(sample(TODAY, ["application"]), "application").up,
      chapter(sample(), "application").up,
    );
  });
});

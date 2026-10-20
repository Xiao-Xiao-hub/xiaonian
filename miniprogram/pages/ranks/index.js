/*
 * 段位说明：展示地图进度对应的阶段与规则，不在本地授予经验或修改学习记录。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const gate = require("../../utils/gate");
const auth = require("../../utils/auth");
const { RANKS, RANK_LINES, STAMP, LEGEND, xpLine } = require("../../utils/learn");
// 我的进度 (Ranks board): the level card the learning tab used to show, three
// sentences, then the rules folded. The numbers below are the rule numbers at
// the top of server/src/modules/learn/summary.ts; tests/pages.test.ts checks them.
//
// Review success, lapses and the 7/21/63-day cycle were added in S5; hints,
// solutions, choice problems  and red dots  since. A review a red
// dot brought forward keeps its interval. 连做  is not built, so
// its sentence stays out. There are no ordering problems.
// The native bar goes back to wherever this page was opened from.
const EXAMPLE = [
  { tier: "基础", n: 6, need: 5 },
  { tier: "重点", n: 6, need: 5 },
  { tier: "难点", n: 5, need: 4 },
];
// "3 小时 20 分", "45 分钟".
function timeText(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return `${m} 分钟`;
  return m % 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m / 60} 小时`;
}
// What 我的进度 shows as the record; null when study time is off or unknown.
// days, not hours, as on 我的: days studied, the current streak in
// days, and today.
function recordOf(s) {
  if (!s || s.enabled === false) return null;
  // An older server sends no totalDays; the days it does send stand in.
  const days = s.totalDays !== undefined ? s.totalDays : (s.days || []).length;
  return { days: Number(days) || 0, streak: Number(s.currentStreak) || 0, today: timeText(s.today) };
}
Page({
  data: {
    ranks: RANKS.map((rank) => ({ rank, stamp: STAMP[rank], line: RANK_LINES[rank] })),
    // need(6) and need(3) in the sentence, then the 中值与应用 table.
    sample: [
      { n: 6, need: 5 },
      { n: 3, need: 2 },
    ],
    example: EXAMPLE,
    xp: [
      { tier: "基础", xp: 10 },
      { tier: "重点", xp: 20 },
      { tier: "难点", xp: 30 },
      { tier: "拓展", xp: 20 },
    ],
    // Total XP needed to reach each level: 4 × (Lv − 1)².
    levels: [
      { level: 2, xp: 4 },
      { level: 5, xp: 64 },
      { level: 10, xp: 324 },
      { level: 15, xp: 784 },
      { level: 20, xp: 1444 },
    ],
    total: 1590,
    maxLevel: 20,
    points: 89,
    dueDays: 7,
    reviewDays: 21,
    finalReviewDays: 63,
    todayReviews: 3,
    legend: LEGEND,
    open: {},
    me: null,
    record: null,
  },
  // The level card is optional: without consent or a network the rules still show.
  // Another account (or none) never sees the last one's level or days.
  onShow() {
    if (!gate.check()) return;
    const owner = auth.hasConsent() && auth.signedIn() ? (auth.getUser() || {}).id || "" : "";
    if (owner !== this.owner) {
      this.owner = owner;
      if (this.data.me || this.data.record) this.setData({ me: null, record: null });
    }
    if (!owner) return;
    const mine = () => this.owner === owner && owner === (auth.getUser() || {}).id;
    api
      .get("/v1/learn/map")
      .then((map) => {
        if (!mine()) return;
        const s = (map && map.summary) || {};
        this.setData({
          me: {
            level: Number(s.level || 1),
            correctText: `${Number(s.correct || 0)}/${Number(s.total || 0)}`,
            xpText: xpLine(s),
            xpPct: s.maxed
              ? 100
              : Math.round((Number(s.levelXp || 0) / Math.max(1, Number(s.levelNeed || 1))) * 100),
          },
        });
      })
      .catch(() => {});
    // The record comes first: days studied and time, when 学习时长 is on.
    api
      .get("/v1/me/study-time")
      .then((s) => mine() && this.setData({ record: recordOf(s) }))
      .catch(() => {});
  },
  toggle(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({ open: { ...this.data.open, [key]: !this.data.open[key] } });
  },
});
module.exports = { recordOf, timeText };

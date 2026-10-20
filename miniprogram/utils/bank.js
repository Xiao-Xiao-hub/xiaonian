/*
 * 题库展示辅助：组织题目类型、章节或筛选信息，供题库相关页面使用。
 * 题目内容与判定依据来自服务端，前端转换只影响浏览和展示。
 */
// 题库 : every knowledge point by chapter with its problem
// count and the learner's progress. The bank page lists it; any page that
// lets the student pick a point (讲一遍 in G5) can load and show it the same
// way:
//
//   const bank = require("../../utils/bank");
//   bank.load.then((data) => this.setData({ bank: bank.view(data) }));
//   <point-list chapters="{{bank.chapters}}" chapter-id="{{chapterId}}" bindpick="pick" />
//
// load reads GET /v1/learn/bank signed in, or the public copy for a guest
// (no progress). view turns it into rows for components/point-list.
const api = require("./api");
const gate = require("./gate");
const { request } = require("./request");

const TIER_CLS = { 基础: "base", 重点: "key", 难点: "hard", 拓展: "ext" };

function load() {
  if (gate.state() === "guest")
    return request({ url: "/v1/learn/bank/public" }).then((body) => body && body.data);
  return api.get("/v1/learn/bank");
}
// "做对 1/2", "做过 1/2" or "没做过"; nothing for a guest.
function progressOf(point, guest) {
  if (guest || !point.problems) return { text: "", cls: "" };
  if (point.correct) return { text: `做对 ${point.correct}/${point.problems}`, cls: "ok" };
  if (point.done) return { text: `做过 ${point.done}/${point.problems}`, cls: "tried" };
  return { text: "没做过", cls: "" };
}
function row(point, guest) {
  const progress = progressOf(point, guest);
  return {
    id: point.id,
    name: point.name,
    section: point.section,
    tier: point.tier,
    tierCls: TIER_CLS[point.tier] || "base",
    mark: point.line === "side" ? "" : point.hard ? "◆" : point.key ? "★" : "",
    count: point.problems ? `${point.problems} 题` : "题还在出",
    ready: point.problems > 0,
    progress: progress.text,
    progressCls: progress.cls,
    // one chip per problem (第 N 题 and how it went), signed in only.
    items: guest || !Array.isArray(point.items)
      ? []
      : point.items.map((state, index) => ({
          index,
          no: index + 1,
          cls: state === "correct" ? "ok" : state === "tried" ? "tried" : "",
          label: `第 ${index + 1} 题，${state === "correct" ? "做对过" : state === "tried" ? "做过" : "没做过"}`,
        })),
  };
}
function view(data) {
  const guest = Boolean(!data || data.guest);
  const chapters = ((data && data.chapters) || []).map((c) => ({
    id: c.id,
    short: c.short,
    book: c.book,
    count: guest ? `${c.points.length} 个点 · ${c.problems} 题` : `做对 ${c.correct}/${c.problems} 题`,
    points: c.points.map((p) => row(p, guest)),
  }));
  return {
    guest,
    chapters,
    tabs: chapters.map((c) => ({ id: c.id, short: c.short })),
  };
}
// One point's row by id, from a view.
function find(bankView, id) {
  for (const chapter of (bankView && bankView.chapters) || []) {
    const point = chapter.points.find((p) => p.id === id);
    if (point) return point;
  }
  return null;
}

module.exports = { TIER_CLS, load, view, row, find };

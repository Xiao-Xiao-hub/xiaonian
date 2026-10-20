/*
 * 知识点展示转换：把题目、公式和进度信息整理为页面需要的显示字段。
 * 由知识点相关页面调用；展示转换不负责判题或授予学习进度。
 */
// one meaning for a point's state on every learning page (map, chapter,
// detail, 练一题, 学习首页). The present wins over the record: 卡住了, 该复习
// and an open 再试试 come before 做对了; 下一步 is a separate mark, never a state.
// `cls` is the star / text class, `cell` the chapter grid's map-cell class.
const LOOKS = {
  stuck: { cls: "stuck", cell: "stuck", text: "卡住了" },
  due: { cls: "due", cell: "due", text: "该复习" },
  retest: { cls: "pend", cell: "retest", text: "再试试" },
  correct: { cls: "ok", cell: "correct", text: "做对了" },
  self: { cls: "pend", cell: "self", text: "标了会" },
  inferred: { cls: "pend", cell: "inferred", text: "应该会" },
  practice: { cls: "practice", cell: "practice", text: "练过" },
  seen: { cls: "seen", cell: "seen", text: "看过" },
  none: { cls: "none", cell: "", text: "没碰过" },
};
// The look's key for a point of GET /v1/learn/map, …/detail or the point page.
function lookKey(p) {
  if (!p) return "none";
  if (p.stuck || p.stuckAt || p.state === "stuck") return "stuck";
  if (p.state === "due") return "due";
  // A wrong answer or a hint on a point once done opens a retest: not 做对了.
  if (p.retest && (p.retest.mode || p.state === "correct")) return "retest";
  if (p.state === "correct") return "correct";
  if (p.state === "self") return "self";
  if (p.state === "inferred" || p.inferredBy) return "inferred";
  if (p.state === "practice") return "practice";
  if (p.state === "seen") return "seen";
  return "none";
}
function lookOf(p) {
  const key = lookKey(p);
  return { key, ...LOOKS[key] };
}

module.exports = { LOOKS, lookKey, lookOf };

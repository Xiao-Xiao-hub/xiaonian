/*
 * 界面示例文字：提供输入提示和起步样例，供空状态页面展示。
 * 示例不是用户数据或真实使用结果；只有用户主动提交后才进入对应保存流程。
 */
// Static examples never enter user storage, selections or statistics.
const cards = [
  {
    id: "example-question",
    type: "question",
    scene: "study",
    title: "可去间断点怎么判断",
    quote: "函数在这个点没定义，为什么还能补成连续？",
    mine: "先算这个点的极限，存在有限极限时可以补上这个值。",
    organizedAt: "2026-10-03T02:00:00Z",
    closedAt: "2026-10-05T02:00:00Z",
    tags: [{ id: "example-limit", name: "极限", color: 0, by: "user" }],
  },
  {
    id: "example-idea",
    type: "idea",
    scene: "life",
    title: "先吃透极限再刷题",
    quote: "想先把极限的条件理顺再开始刷题。",
    mine: "我先把每种方法能用的条件写清楚，再选几道题来练。",
    organizedAt: "2026-10-03T02:00:00Z",
    tags: [{ id: "example-plan", name: "学习安排", color: 1, by: "user" }],
  },
  {
    id: "example-method",
    type: "method",
    scene: "study",
    title: "夹逼先放缩再取极限",
    quote: "先找上下界，再看两边是否趋向同一个值。",
    organizedAt: "2026-10-03T02:00:00Z",
    tags: [{ id: "example-method-tag", name: "方法", color: 2, by: "user" }],
  },
  {
    id: "example-spark",
    type: "spark",
    scene: "study",
    title: "画一张替换条件表",
    quote: "把用等价无穷小替换的条件画成一张表。",
    tags: [{ id: "example-drawing", name: "画一画", color: 3, by: "user" }],
  },
].map((card) => ({
  titleBy: "user",
  summary: null,
  summaryBy: null,
  mine: null,
  closedAt: null,
  organizedAt: null,
  quoteOn: "2026-10-03",
  slots: [],
  open: [],
  next: null,
  links: [],
  versions: [],
  uses: [],
  retest: null,
  followup: null,
  origin: "jot",
  pointId: null,
  resume: "off",
  createdAt: "2026-10-03T02:00:00Z",
  version: 0,
  ...card,
}));
module.exports = { cards };

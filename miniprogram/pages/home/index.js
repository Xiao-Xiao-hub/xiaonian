/*
 * 历史首页实现：保留早期学习汇总页面代码；当前底部入口以 app.json 为准。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const auth = require("../../utils/auth");
const api = require("../../utils/api");
const { when, today, dueText, errorText, KIND } = require("../../utils/format");
const { themed } = require("../../utils/theme");
const { openAsk } = require("../../utils/chat-entry");
function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? "夜深了" : hour < 11 ? "早上好" : hour < 13 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
}
function card(item) {
  const draft = item.status !== "confirmed";
  return {
    ...item,
    kindText: KIND[item.kind],
    meta: `${KIND[item.kind]} · ${when(item.updatedAt)}`,
    icon: item.kind === "problem" ? "pen" : "book",
    tag: draft ? "待核对" : item.inReview ? "复习中" : "",
    tagTone: draft ? "amber" : "",
  };
}
// "下一次：明天，2 项" from the upcoming list, which comes earliest first.
function nextText(upcoming) {
  const first = upcoming && upcoming[0];
  if (!first) return "";
  const count = upcoming.filter((item) => item.dueOn === first.dueOn).length;
  return `下一次：${dueText(first.dueOn)}，${count} 项`;
}
// The streak line: what it is and what keeps it going.
function streakOf(home) {
  const n = home.streak;
  if (!n) return { n: 0, title: "今天开始记录", sub: "问一道题、做一次复习都算一天" };
  return home.todayDone
    ? { n, title: `连续学习 ${n} 天`, sub: "今天已经学过了，明天接着来" }
    : { n, title: `已连续 ${n} 天`, sub: "今天学一题，就能续上" };
}
// Today's list: what is due, then where the learner left off.
function tasksOf(home, resume) {
  const out = [];
  const m = home.mistakes;
  if (m.due)
    out.push({ key: "mistakes", icon: "target", tone: "red", title: `重做 ${m.due} 道错题`, sub: "前几天做错的题，再做一遍才算会了" });
  if (home.reviews.due)
    out.push({ key: "review", icon: "repeat", tone: "green", title: `复习 ${home.reviews.due} 项`, sub: "今天到期，几分钟就能过完" });
  const last = home.threads[0];
  if (last)
    out.push({ key: "thread", id: last.id, icon: "chat", tone: "", title: `接着问：${last.title || "上次的问题"}`, sub: when(last.updatedAt) });
  if (resume)
    out.push({ key: "resume", icon: "book", tone: "violet", title: `接着学：${resume.title || "未命名"}`, sub: resume.meta });
  return out;
}
const TASK_ICON = { target: "rose", repeat: "teal", chat: "blue", book: "violet" };
// Chapters whose practice answers the program can check (server: PRACTICE).
const PRACTICE = [
  { key: "limit", label: "求极限", sub: "洛必达、泰勒、等价无穷小" },
  { key: "derivative", label: "求导数", sub: "复合函数、乘除、高阶导" },
  { key: "application", label: "导数应用", sub: "单调区间、极值、根的个数" },
  { key: "indefinite", label: "不定积分", sub: "换元、分部积分" },
  { key: "definite", label: "定积分", sub: "换元、分部、对称性" },
];
const PRACTICABLE = PRACTICE.map((p) => p.key);
Page(themed({
  data: {
    consent: false,
    today: "",
    greeting: "",
    name: "",
    home: null,
    streak: null,
    week: [],
    tasks: [],
    weak: [],
    threads: [],
    resume: null,
    recent: [],
    review: { due: 0, total: 0, next: "" },
    taskIcon: TASK_ICON,
    practice: PRACTICE,
    loading: false,
    error: "",
  },
  onShow() {
    const consent = auth.hasConsent();
    this.setData({ consent, today: today(), greeting: greeting() });
    if (consent) this.load();
  },
  onPullDownRefresh() {
    (this.data.consent ? this.load() : Promise.resolve()).then(() =>
      wx.stopPullDownRefresh(),
    );
  },
  load() {
    this.setData({ loading: true, error: "" });
    return Promise.all([api.get("/v1/home"), api.get("/v1/materials?limit=5")])
      .then(([home, items]) => {
        this.loadReviews();
        const user = auth.getUser();
        const found = items.find((item) => item.status === "confirmed");
        const resume = found ? card(found) : null;
        const most = home.mistakes.chapters[0] ? home.mistakes.chapters[0].n : 1;
        this.setData({
          name: user ? user.nickname : "",
          home,
          streak: streakOf(home),
          week: home.week.map((d, i) => ({ ...d, today: i === home.week.length - 1 })),
          tasks: tasksOf(home, resume),
          // Where the open mistakes are, as bars against the largest chapter.
          weak: home.mistakes.chapters.slice(0, 3).map((c) => ({
            ...c,
            pct: Math.round((c.n / most) * 100),
            practicable: PRACTICABLE.includes(c.chapter),
          })),
          // The latest one is already in today's list.
          threads: home.threads.slice(1).map((t) => ({ ...t, when: when(t.updatedAt) })),
          resume,
          recent: items.slice(0, 3).map(card),
        });
      })
      .catch((error) =>
        this.setData({ error: errorText(error), consent: auth.hasConsent() }),
      )
      .finally(() => this.setData({ loading: false }));
  },
  // A failed count only hides the "next review" line.
  loadReviews() {
    return api
      .get("/v1/reviews")
      .then(({ counts, upcoming }) =>
        this.setData({
          review: {
            due: counts.due,
            total: counts.total,
            next: counts.due ? `一共 ${counts.total} 项在复习` : nextText(upcoming),
          },
        }),
      )
      .catch(() => {});
  },
  // The 解题 page reads what to start with when it shows.
  ask(intent) {
    openAsk(intent);
  },
  askPhoto() {
    this.ask({ photo: "problem" });
  },
  askDraft() {
    this.ask({ photo: "draft" });
  },
  askText() {
    this.ask({ compose: true });
  },
  openTask(event) {
    const task = this.data.tasks[event.currentTarget.dataset.index];
    if (!task) return;
    if (task.key === "mistakes") return this.openMistakes();
    if (task.key === "review") return this.openReview();
    if (task.key === "thread") return this.ask({ threadId: task.id });
    if (task.key === "resume" && this.data.resume) api.openMaterial(this.data.resume);
  },
  // One practice problem from a chapter, made and checked on the 解题 page.
  practice(event) {
    this.ask({ practice: event.currentTarget.dataset.chapter });
  },
  openThread(event) {
    this.ask({ threadId: event.currentTarget.dataset.id });
  },
  openLearn() {
    wx.switchTab({ url: "/pages/learn/index" });
  },
  openMistakes() {
    wx.navigateTo({ url: "/pages/mistakes/index" });
  },
  openReview() {
    wx.navigateTo({ url: "/pages/review/index" });
  },
  startNote() {
    wx.navigateTo({ url: "/pages/capture/index?kind=note" });
  },
  startProblem() {
    wx.navigateTo({ url: "/pages/capture/index?kind=problem" });
  },
  openItem(event) {
    const item = this.data.recent[event.currentTarget.dataset.index];
    if (item) api.openMaterial(item);
  },
  openLibrary() {
    require("../../utils/learn").backTo("pages/library/index");
  },
}));

/*
 * 我的页面：读取用量和个人设置，处理导出、退出及注销；账号变更后同步清理本地状态。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const auth = require("../../utils/auth");
const gate = require("../../utils/gate");
const session = require("../../utils/session");
const { errorText } = require("../../utils/format");
const { asset } = require("../../utils/assets");
const studyClock = require("../../utils/study-clock");
const learningSpace = require("../../utils/learning-space");
const { showMood, setShowMood, sceneParam } = require("../../utils/cards");
const budgets = require("../../utils/budget");
// This phone's own flags, cleared after 注销 (utils/session).
const { LOCAL_FLAGS } = session;
// 我的 : the stickers, the materials and the study record moved to the learn tab.
// One cell per daily allowance; the 聊天 cell is the same count the 解题 page shows.
function cell(k, { used, limit }) {
  const left = Math.max(0, limit - used);
  return {
    k,
    used,
    limit,
    left,
    share: limit ? Math.min(100, Math.round((left / limit) * 100)) : 0,
  };
}
// One line at the top only when an allowance is nearly used up (v3 §5.6).
function lowUsage(cells) {
  const low = cells
    .filter((c) => c.limit && c.left <= Math.min(10, Math.ceil(c.limit / 5)))
    .sort((a, b) => a.left - b.left)[0];
  if (!low) return "";
  const name = /^[A-Za-z]/.test(low.k) ? ` ${low.k}` : low.k;
  return low.left
    ? `今天的${name}还能用 ${low.left} 次`
    : `今天的${name}次数用完了，明天再来`;
}
// today and this week, as used percentages with when each comes back.
function budgetCells(budget) {
  return [
    ["今天", budget.day],
    ["本周", budget.week],
  ].map(([k, w]) => ({
    k,
    pct: w.pct,
    share: Math.min(100, w.pct),
    reset: budgets.reset(w.resetAt),
  }));
}
// 学习时间 heat map (60-me.html): 18 weeks, one column per week, Monday on top.
// The last column holds `today` (the server's Beijing day); later days stay blank.
const WEEKS = 18;
const DAY_MS = 86400000;
function level(minutes) {
  if (!minutes) return 0;
  if (minutes <= 15) return 1;
  if (minutes <= 30) return 2;
  if (minutes <= 60) return 3;
  return 4;
}
const dayMs = (day) => Date.parse(`${day}T00:00:00Z`);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
function heat(days, today) {
  const minutes = {};
  for (const d of days || []) minutes[d.day] = Number(d.minutes) || 0;
  const end = dayMs(today);
  const weekday = (new Date(end).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  const start = end - (weekday + (WEEKS - 1) * 7) * DAY_MS;
  const columns = [];
  for (let w = 0; w < WEEKS; w++) {
    const cells = [];
    for (let i = 0; i < 7; i++) {
      const ms = start + (w * 7 + i) * DAY_MS;
      const day = dayOf(ms);
      const m = minutes[day] || 0;
      cells.push({ day, min: m, lv: level(m), td: ms === end, fu: ms > end });
    }
    columns.push({ key: cells[0].day, cells });
  }
  // A month name over the week its 1st falls in; the first column gets its own
  // month when no name would sit right next to it.
  const months = columns.map((c) => {
    const first = c.cells.find((x) => x.day.endsWith("-01"));
    return first ? `${Number(first.day.slice(5, 7))}月` : "";
  });
  if (!months[0] && !months[1])
    months[0] = `${Number(columns[0].cells[0].day.slice(5, 7))}月`;
  return { columns, months };
}
function dayText(day) {
  return `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;
}
// 累计 N 天 (a day with a whole minute, Beijing date) replaces the hours
// and minutes. A v4.1 server has no totalDays; the 18 weeks it sends are then
// the best count there is.
function studyView(s) {
  const total = Number(s.totalDays);
  return {
    enabled: s.enabled !== false,
    today: s.day,
    todayMin: Number(s.today) || 0,
    total: Number.isFinite(total) ? total : (s.days || []).length,
    current: Number(s.currentStreak) || 0,
    best: Number(s.bestStreak) || 0,
    ...heat(s.days, s.day),
  };
}
const ICONS = {
  cards: asset("ic-card-index-dividers.webp"),
  star: asset("ic-glowing-star.webp"),
  medal: asset("ic-sports-medal.webp"),
  mood: asset("ic-sun-behind-cloud.webp"),
  tags: asset("ic-label.webp"),
  resume: asset("ic-alarm-clock.webp"),
  export: asset("ic-inbox-tray.webp"),
  help: asset("ic-open-book.webp"),
};
// WeChat logins all carry this placeholder nickname; greet without it.
const PLACEHOLDER_NAME = "微信用户";
const EMPTY = {
  name: "",
  initial: "",
  usage: [],
  left: null,
  budget: "",
  stats: null,
  learn: null,
  study: null,
  picked: null,
  lowUsage: "",
  usageOpen: false,
  suggestCards: true,
  personalized: true,
  studyTime: true,
  prefs: false,
};
Page({
  data: {
    guest: false,
    ...EMPTY,
    icons: ICONS,
    broken: {},
    day: "",
    loading: false,
    busy: false,
    exporting: false,
    error: "",
    prefBusy: false,
    showMood: true,
  },
  onShow() {
    this.alive = true;
    if (!gate.check()) {
      this.loadVersion = (this.loadVersion || 0) + 1;
      return;
    }
    // A guest sees the page without anything personal and sends nothing.
    if (gate.state() === "guest") {
      this.loadVersion = (this.loadVersion || 0) + 1;
      this.owner = undefined;
      this.setData({ guest: true, ...EMPTY, loading: false, error: "" });
      return;
    }
    const owner = (auth.getUser() || {}).id;
    if (owner !== this.owner || this.data.guest) this.setData({ ...EMPTY });
    this.owner = owner;
    this.setData({ guest: false, prefBusy: false, showMood: showMood(owner) });
    this.load();
  },
  onHide() {
    this.alive = false;
    this.loadVersion = (this.loadVersion || 0) + 1;
  },
  onUnload() {
    this.onHide();
  },
  load() {
    const version = (this.loadVersion = (this.loadVersion || 0) + 1);
    if (gate.state() !== "ok") return Promise.resolve();
    let owner;
    const active = () =>
      this.alive !== false &&
      version === this.loadVersion &&
      auth.hasConsent();
    this.setData({ loading: true, error: "" });
    return auth
      .login()
      .then(() => {
        if (!active()) return null;
        owner = (auth.getUser() || {}).id;
        const scene = sceneParam(owner);
        // Each part on its own: one failing request keeps what the others
        // brought and what was shown before.
        const part = (url) =>
          api.get(url).then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
        return Promise.all(
          [
            "/v1/chat/usage",
            "/v1/me/usage",
            "/v1/learn/map",
            // Hidden mood cards stay out of the count, as on the deck.
            `/v1/cards/stats${scene ? `?scene=${scene}` : ""}`,
            "/v1/me/suggest-cards",
            "/v1/me/prefs",
            "/v1/me/study-time",
          ].map(part),
        );
      })
      .then((result) => {
        if (!result) return;
        const [chat, usage, map, stats, suggest, prefs, study] = result;
        if (!active()) return;
        const user = auth.getUser();
        if (owner !== (user || {}).id) {
          this.setData({ ...EMPTY });
          return this.load();
        }
        this.owner = (user || {}).id;
        // v4 only: on a server rolled back to v3.3 their rows are left out.
        // Any other failure is not "missing": the rows stay as they were.
        const absent = (r) =>
          r.error && (r.error.statusCode === 404 || r.error.code === "NOT_FOUND");
        const failed = result.find(
          (r, i) => r.error && !(i >= 5 && absent(r)),
        );
        if (failed && api.needsConsent(failed.error)) return;
        const patch = { error: failed ? errorText(failed.error) : "" };
        // the budget comes with /v1/me/usage alone; it no longer
        // waits for the chat counts.
        const budget = !usage.error && usage.value.budget;
        if (budgets.valid(budget))
          Object.assign(patch, {
            usage: budgetCells(budget),
            left: null,
            budget: budgets.line(budget),
            lowUsage: budgets.low(budget),
            day: usage.value.date || "",
          });
        else if (!chat.error && !usage.error) {
          const cells = [
            cell("聊天", chat.value.answers),
            cell("拍题", chat.value.photos),
            cell("讲题和出题", usage.value.ai),
            cell("图片认字", usage.value.ocr),
            ...(usage.value.notes ? [cell("AI 理卡", usage.value.notes)] : []),
            ...(usage.value.brainstorm ? [cell("头脑风暴", usage.value.brainstorm)] : []),
            ...(usage.value.import ? [cell("导入", usage.value.import)] : []),
          ];
          Object.assign(
            patch,
            { usage: cells, left: cells[0].left, budget: "", lowUsage: lowUsage(cells) },
            { day: usage.value.date || "" },
          );
        }
        const nickname = user ? user.nickname : "";
        const named = nickname && nickname !== PLACEHOLDER_NAME ? nickname : "";
        // By code point, so an emoji or a rare character stays whole.
        Object.assign(patch, { name: named, initial: Array.from(named)[0] || "" });
        if (!map.error) {
          const summary = (map.value && map.value.summary) || {};
          patch.learn = {
            level: Number(summary.level || 1),
            rank: summary.book && summary.book.reached ? summary.book.rank : "",
            correct: Number(summary.correct || 0),
            xp: Number(summary.xp || 0),
          };
        }
        if (!stats.error) patch.stats = stats.value;
        if (!suggest.error)
          patch.suggestCards = (suggest.value || {}).enabled !== false;
        if (!prefs.error || absent(prefs)) {
          const p = prefs.error ? null : prefs.value;
          const studyTime = !p || p.studyTime !== false;
          if (p) studyClock.setEnabled(studyTime);
          Object.assign(patch, {
            personalized: !p || p.personalized !== false,
            studyTime,
            prefs: Boolean(p),
          });
        }
        if (!study.error || absent(study)) {
          patch.study = study.error ? null : studyView(study.value);
          patch.picked = null;
        }
        this.setData(patch);
      })
      .catch((error) => {
        if (active() && !api.needsConsent(error))
          this.setData({ error: errorText(error) });
      })
      .finally(() => {
        if (active()) this.setData({ loading: false });
      });
  },
  // Tapping a day shows its minutes under the map; tapping it again goes back to today.
  pickDay(event) {
    const { w, i } = event.currentTarget.dataset;
    const c = this.data.study && this.data.study.columns[w].cells[i];
    if (!c || c.fu) return;
    const same = this.data.picked && this.data.picked.day === c.day;
    this.setData({
      picked: same || c.td ? null : { day: c.day, label: dayText(c.day), min: c.min },
    });
  },
  iconError(event) {
    this.setData({ [`broken.${event.currentTarget.dataset.k}`]: true });
  },
  toggleUsage() {
    this.setData({ usageOpen: !this.data.usageOpen });
  },
  // The counts (V4.2: the budget) sit under that row; bring them into view.
  openUsage() {
    this.setData({ usageOpen: true }, () => {
      if (typeof wx.pageScrollTo === "function")
        wx.pageScrollTo({ selector: ".usage", duration: 300 });
    });
  },
  // An empty filter clears every filter on the 卡片 tab: all cards.
  openCards() {
    getApp().globalData.cardFilter = {};
    wx.switchTab({ url: "/pages/deck/index" });
  },
  openTags() {
    if (this.data.guest) return gate.ask();
    wx.navigateTo({ url: "/pages/tags/index" });
  },
  openResume() {
    if (this.data.guest) return gate.ask();
    wx.navigateTo({ url: "/pages/resume-settings/index" });
  },
  openHelp() {
    wx.navigateTo({ url: "/pages/help/index" });
  },
  openPrivacy() {
    wx.navigateTo({ url: "/pages/privacy/index" });
  },
  openMoodLog() {
    if (this.data.guest) return gate.ask();
    wx.navigateTo({ url: "/pages/mood-log/index" });
  },
  // A setting saved after the account changed must not land on the new one.
  guard() {
    const owner = (auth.getUser() || {}).id,
      version = this.loadVersion;
    return () =>
      this.alive &&
      owner === (auth.getUser() || {}).id &&
      version === this.loadVersion;
  },
  async toggleSuggest(event) {
    if (this.data.prefBusy) return;
    const active = this.guard(),
      previous = this.data.suggestCards;
    this.setData({ prefBusy: true, error: "" });
    try {
      const setting = await api.put("/v1/me/suggest-cards", {
        enabled: event.detail.value,
      });
      if (active()) this.setData({ suggestCards: setting.enabled });
    } catch (error) {
      if (active() && !api.needsConsent(error))
        this.setData({ suggestCards: previous, error: errorText(error) });
    } finally {
      if (active()) this.setData({ prefBusy: false });
    }
  },
  // V4.2 卡片里显示心情卡: this phone's setting for this account.
  toggleMood(event) {
    setShowMood(this.owner, event.detail.value);
    this.setData({ showMood: event.detail.value });
    // The card count follows the setting.
    this.load();
  },
  // 个性化学习推荐 and 学习时长统计 (PUT /v1/me/prefs).
  async togglePref(event) {
    if (this.data.prefBusy) return;
    const key = event.currentTarget.dataset.k;
    const active = this.guard(),
      previous = this.data[key];
    this.setData({ prefBusy: true, error: "" });
    try {
      const prefs = await api.put("/v1/me/prefs", { [key]: event.detail.value });
      if (!active()) return;
      this.setData({ personalized: prefs.personalized, studyTime: prefs.studyTime });
      studyClock.setEnabled(prefs.studyTime);
      if (this.data.study)
        this.setData({ "study.enabled": prefs.studyTime });
    } catch (error) {
      if (active() && !api.needsConsent(error))
        this.setData({ [key]: previous, error: errorText(error) });
    } finally {
      if (active()) this.setData({ prefBusy: false });
    }
  },
  deleteStudyTime() {
    if (this.data.busy || this.studyPrompt) return;
    const active = this.guard();
    this.studyPrompt = true;
    wx.showModal({
      title: "删除学习时长记录？",
      content: "累计天数、连续天数和每天的格子都会清空，找不回来。",
      confirmText: "删除",
      confirmColor: "#c0392b",
      success: ({ confirm }) => {
        this.studyPrompt = false;
        if (!confirm || !active()) return;
        this.setData({ busy: true, error: "" });
        api
          .del("/v1/me/study-time")
          .then(() => api.get("/v1/me/study-time"))
          .then((study) => {
            if (active()) this.setData({ study: studyView(study), picked: null });
          })
          .catch((error) => {
            if (active() && !api.needsConsent(error))
              this.setData({ error: errorText(error) });
          })
          .finally(() => this.setData({ busy: false }));
      },
      fail: () => {
        this.studyPrompt = false;
      },
    });
  },
  // The export is a JSON file sent to a chat (for example 文件传输助手);
// 准备中… on the icon while it is being made.
  exportData() {
    if (this.data.guest) return gate.ask();
    if (this.data.busy) return;
    if (typeof wx.shareFileMessage !== "function")
      return this.setData({
        error: "微信版本有点旧，升级后就能导出了",
      });
    this.setData({ busy: true, exporting: true, error: "" });
    const day = this.data.day;
    const owner = (auth.getUser() || {}).id;
    const generation = auth.consentGeneration();
    api
      .download("/v1/me/export", "导出文件", { account: true })
      .then((filePath) => {
        if (
          this.alive === false ||
          generation !== auth.consentGeneration() ||
          owner !== (auth.getUser() || {}).id
        )
          throw new Error("换了账号，退出这页再进来");
        return new Promise((resolve, reject) =>
          wx.shareFileMessage({
            filePath,
            fileName: `晓念数据导出${day ? "-" + day : ""}.json`,
            success: resolve,
            fail: (error) =>
              /cancel/.test((error && error.errMsg) || "")
                ? resolve()
                : reject(new Error("文件没发出去，再试一次")),
          }),
        );
      })
      .catch((error) => this.setData({ error: errorText(error) }))
      .finally(() => this.setData({ busy: false, exporting: false }));
  },
  deleteAccount() {
    if (this.data.busy || this.deletePrompt) return;
    const original = session.getSession();
    const generation = auth.consentGeneration();
    if (!original)
      return this.setData({
        error: "换了账号，退出这页再进来",
      });
    this.deletePrompt = true;
    wx.showModal({
      title: "注销账号？",
      content:
        "你放进来的资料和原图、随心记里的内容、生成的讲解提示和题目、做题和回头看看的记录、学习时长都会删掉，找不回来。想留着的话，先导出一份；导出的是 JSON 文件，不含原图。",
      confirmText: "注销",
      confirmColor: "#c0392b",
      success: ({ confirm }) => {
        this.deletePrompt = false;
        if (!confirm) return;
        const current = session.getSession();
        if (
          !current ||
          current.token !== original.token ||
          generation !== auth.consentGeneration()
        )
          return this.setData({
            error: "换了账号，退出这页再进来",
          });
        const owner = original.user.id;
        this.setData({ busy: true, error: "" });
        api
          .del("/v1/me", { confirm: true }, { account: true })
          .then(() => {
            learningSpace.clear(owner);
            // A completed deletion of A must not erase a newer B session.
            if (
              (auth.getUser() || {}).id !== owner ||
              generation !== auth.consentGeneration()
            )
              return;
            delete getApp().globalData.noteContext;
            session.clearSession();
            auth.clearConsent();
            // This phone's own flags go too: whoever starts again is new here
            // (the tour, 随心记's hello and 稍后, the 解题 tip).
            LOCAL_FLAGS.forEach((key) => {
              try {
                wx.removeStorageSync(key);
              } catch (_) {}
            });
            this.setData({ ...EMPTY });
            wx.showToast({ title: "账号注销了", icon: "none" });
            wx.switchTab({ url: "/pages/notes/index" });
          })
          .catch((error) => this.setData({ error: errorText(error) }))
          .finally(() => this.setData({ busy: false }));
      },
      fail: () => {
        this.deletePrompt = false;
      },
    });
  },
});

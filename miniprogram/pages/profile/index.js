const { withShare } = require("../../utils/share");
/*
 * 我的页面：读取用量和个人设置，处理导出、退出及注销；账号变更后同步清理本地状态。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const auth = require("../../utils/auth");
const gate = require("../../utils/gate");
const session = require("../../utils/session");
const profile = require("../../utils/profile");
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
    const sum = cells.reduce((total, c) => total + (c.fu ? 0 : c.min), 0);
    // A whole week is the tap target (a day cell is too small to hit), and
    // its name is what a screen reader announces.
    columns.push({ key: cells[0].day, cells, sum, al: `${dayText(cells[0].day)}起的一周，共 ${sum} 分钟` });
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
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
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
    minutes: Number(s.totalMinutes) || 0,
    current: Number(s.currentStreak) || 0,
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
  gem: asset("ic-gem-stone.webp"),
  headphone: asset("ic-headphone.webp"),
};
const EMPTY = {
  name: "",
  initial: "",
  avatarPath: "",
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
Page(withShare({
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
    editingProfile: false,
    profileReady: false,
    profileAuthorizing: false,
    profileUnsupported: false,
    profileSaving: false,
    profileWaiting: false,
    profileError: "",
    profileMode: "",
    profileFirst: false,
    profileEditId: 0,
    draftNickname: "",
    draftAvatar: "",
    nicknamePending: false,
    nicknameInputId: 0,
    profileCanReset: false,
  },
  onShow() {
    this.alive = true;
    if (!gate.check()) {
      this.loadVersion = (this.loadVersion || 0) + 1;
      return;
    }
    // A guest sees the page without anything personal and sends nothing.
    if (gate.state() === "guest") {
      this.avatarSelection = null;
      this.discardProfile();
      this.loadVersion = (this.loadVersion || 0) + 1;
      this.owner = undefined;
      this.setData({ guest: true, ...EMPTY, loading: false, error: "" });
      return;
    }
    const owner = (auth.getUser() || {}).id;
    if (owner !== this.owner || this.data.guest ||
      (this.data.editingProfile && this.editGeneration !== auth.consentGeneration())) {
      this.avatarSelection = null;
      this.discardProfile();
      this.setData({ ...EMPTY });
    }
    this.owner = owner;
    this.setData({ guest: false, prefBusy: false, showMood: showMood(owner) });
    const completed = this.completedProfile;
    this.completedProfile = null;
    if (completed) this.acceptProfile(completed.user, completed.id, completed.message);
    return this.load();
  },
  onHide() {
    this.alive = false;
    this.loadVersion = (this.loadVersion || 0) + 1;
  },
  onUnload() {
    this.discardProfile();
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
            "/v1/auth/me",
          ].map(part),
        );
      })
      .then((result) => {
        if (!result) return;
        const [chat, usage, map, stats, suggest, prefs, study, identity] = result;
        if (!active()) return;
        let user = auth.getUser();
        if (owner !== (user || {}).id) {
          this.setData({ ...EMPTY });
          return this.load();
        }
        this.owner = (user || {}).id;
        if (!identity.error && identity.value && identity.value.id === owner) {
          session.updateUser(identity.value);
          user = auth.getUser();
        }
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
        const named = profile.displayName(user);
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
        this.loadAvatar(user, active);
      })
      .catch((error) => {
        if (active() && !api.needsConsent(error))
          this.setData({ error: errorText(error) });
      })
      .finally(() => {
        if (active()) this.setData({ loading: false });
      });
  },
  // 图片下载与编辑草稿都绑定账号；网络晚返回时不能把 A 的头像显示给 B。
  loadAvatar(user, active) {
    const version = user && user.avatar && user.avatar.version;
    const key = version ? `${user.id}:${version}` : "";
    if (!key) {
      this.avatarKey = "";
      this.setData({ avatarPath: "" });
      return;
    }
    if (this.avatarKey === key && this.data.avatarPath) return;
    this.avatarKey = key;
    this.setData({ avatarPath: "" });
    api.download(`/v1/me/profile/avatar?v=${encodeURIComponent(version)}`, "头像")
      .then((filePath) => {
        if (active() && this.avatarKey === key && (auth.getUser() || {}).id === user.id)
          this.setData({ avatarPath: filePath });
      })
      .catch(() => {
        if (active() && this.avatarKey === key) this.setData({ avatarPath: "" });
      });
  },
  avatarError() {
    this.avatarKey = "";
    this.setData({ avatarPath: "" });
  },
  editCurrent(id = this.editId) {
    return this.data.editingProfile && id === this.editId &&
      this.editOwner === (auth.getUser() || {}).id &&
      this.editGeneration === auth.consentGeneration() && auth.hasConsent();
  },
  editActive(id = this.editId) {
    return this.alive !== false && this.editCurrent(id);
  },
  beginAvatar() {
    if (this.data.loading || this.data.profileSaving || this.data.profileAuthorizing || this.data.profileMode === "nickname") return;
    const user = auth.getUser();
    this.avatarSelection = user && auth.hasConsent()
      ? { owner: user.id, generation: auth.consentGeneration() }
      : null;
  },
  async changeAvatar(event) {
    const selection = this.avatarSelection;
    this.avatarSelection = null;
    const filePath = event.detail && event.detail.avatarUrl;
    if (!selection || selection.owner !== (auth.getUser() || {}).id ||
      selection.generation !== auth.consentGeneration() || !auth.hasConsent() ||
      typeof filePath !== "string" || !filePath) return;
    // 原生选择完成即保存，只更新头像；不在页面插入资料表单。
    const opening = this.editProfile("avatar");
    const id = this.editId;
    await opening;
    if (!this.editCurrent(id) || selection.owner !== this.editOwner || !this.data.profileReady) return;
    return this.commitProfile({ avatar: filePath, changed: false, nickname: this.originalNickname });
  },
  editNickname() {
    if (this.data.loading || this.data.profileSaving) return;
    return this.editProfile("nickname");
  },
  async editProfile(first = false) {
    if (this.data.guest) return gate.ask();
    if (this.data.profileSaving || this.data.profileAuthorizing) return;
    const user = auth.getUser();
    if (!user) return;
    this.discardProfile();
    this.editOwner = user.id;
    this.editGeneration = auth.consentGeneration();
    const id = this.editId;
    this.originalNickname = profile.displayName(user);
    this.reviewValue = this.originalNickname;
    this.reviewState = "unchanged";
    this.setData({
      editingProfile: true, profileFirst: first === true, profileEditId: id,
      profileMode: typeof first === "string" ? first : "",
      nicknameInputId: 0,
      draftNickname: this.originalNickname, draftAvatar: "",
      profileCanReset: Boolean(this.originalNickname || user.avatar),
      profileUnsupported: !profile.supported(),
    });
    if (!this.data.profileUnsupported) await this.authorizeProfile();
    else if (this.data.profileMode) {
      wx.showToast({ title: "请升级微信后修改资料", icon: "none" });
      this.discardProfile();
    }
  },
  async authorizeProfile() {
    if (this.data.profileAuthorizing) return;
    const id = this.editId;
    this.setData({ profileAuthorizing: true, profileError: "" });
    try {
      await profile.authorize();
      if (this.editCurrent(id)) this.setData({ profileReady: true });
    } catch (error) {
      if (this.editCurrent(id)) {
        this.setData({ profileError: errorText(error) });
        if (this.data.profileMode) {
          wx.showToast({ title: errorText(error), icon: "none" });
          this.discardProfile();
        }
      }
    } finally {
      if (this.editCurrent(id)) this.setData({ profileAuthorizing: false });
    }
  },
  discardProfile() {
    this.editId = (this.editId || 0) + 1;
    clearTimeout(this.reviewTimer);
    this.pendingProfileSave = null;
    this.completedProfile = null;
    this.setData({
      editingProfile: false, profileReady: false, profileAuthorizing: false,
      profileUnsupported: false, profileSaving: false, profileWaiting: false,
      profileError: "", profileFirst: false, draftNickname: "", draftAvatar: "",
      profileMode: "",
      nicknamePending: false,
      profileCanReset: false,
    });
  },
  cancelProfile() {
    if (this.data.profileSaving) return;
    const owner = this.editOwner;
    if (this.data.profileFirst && owner === (auth.getUser() || {}).id)
      profile.markPrompted(owner);
    const next = this.data.profileFirst ? this.profileSetupReturn : "";
    this.profileSetupReturn = "";
    this.discardProfile();
    if (next) wx.reLaunch({ url: next });
  },
  chooseAvatar(event) {
    if (!this.editActive() || !this.data.profileReady || this.data.profileSaving) return;
    if (String(event.currentTarget.dataset.edit) !== String(this.editId)) return;
    const filePath = event.detail && event.detail.avatarUrl;
    // 取消或微信审核未通过时没有可用的临时路径，不清掉原头像。
    if (typeof filePath !== "string" || !filePath) return;
    this.pendingProfileSave = null;
    this.setData({ draftAvatar: filePath, profileError: "", profileWaiting: false });
  },
  nicknameInput(event) {
    if (!this.editActive() || this.data.profileSaving || this.data.nicknamePending) return;
    if (String(event.currentTarget.dataset.edit) !== String(this.editId) ||
      Number(event.currentTarget.dataset.input) !== this.data.nicknameInputId) return;
    const value = String(event.detail.value || "");
    this.pendingProfileSave = null;
    this.reviewValue = "";
    this.reviewState = value === this.originalNickname ? "unchanged" : "typing";
    this.setData({ draftNickname: value, profileError: "", profileWaiting: false });
  },
  nicknameBlur(event) {
    if (!this.editActive() || String(event.currentTarget.dataset.edit) !== String(this.editId)) return;
    if (Number(event.currentTarget.dataset.input) !== this.data.nicknameInputId) return;
    const value = String(event.detail.value || "");
    // blur 的值仍可能等待微信审核；只能由 nicknamereview 认可这一轮输入。
    if (value !== this.data.draftNickname) {
      this.reviewValue = "";
      this.reviewState = "typing";
      this.pendingProfileSave = null;
      this.setData({ draftNickname: value, profileWaiting: false });
    }
    // 原位修改没有取消按钮：清空后离开输入框等同放弃，恢复原昵称。
    if (value === this.originalNickname || (this.data.profileMode === "nickname" && !value.trim())) {
      if (this.data.profileMode === "nickname") this.cancelProfile();
      return;
    }
    if (!(this.reviewState === "passed" && this.reviewValue === value)) this.waitNicknameReview();
    if (this.data.profileMode === "nickname")
      this.saveProfile({ detail: { value: { nickname: value } } });
  },
  waitNicknameReview() {
    this.reviewState = "pending";
    this.setData({ nicknamePending: true });
    clearTimeout(this.reviewTimer);
    const id = this.editId;
    this.reviewTimer = setTimeout(() => {
      if (!this.editCurrent(id) || this.reviewState !== "pending") return;
      this.reviewState = "timeout";
      this.pendingProfileSave = null;
      this.setData({
        nicknamePending: false, profileWaiting: false,
        nicknameInputId: this.data.nicknameInputId + 1,
        profileError: "昵称检查暂时没有完成，请重新填写后再保存",
      });
      if (this.data.profileMode === "nickname" && this.alive !== false)
        wx.showToast({ title: "昵称检查超时，请重新填写", icon: "none" });
    }, 10000);
  },
  nicknameReview(event) {
    if (!this.editCurrent() || String(event.currentTarget.dataset.edit) !== String(this.editId)) return;
    if (Number(event.currentTarget.dataset.input) !== this.data.nicknameInputId) return;
    clearTimeout(this.reviewTimer);
    const accepted = event.detail && event.detail.pass === true && event.detail.timeout !== true;
    this.reviewState = accepted ? "passed" : (event.detail && event.detail.timeout ? "timeout" : "failed");
    this.reviewValue = accepted ? this.data.draftNickname : "";
    const pending = this.pendingProfileSave;
    this.pendingProfileSave = null;
    this.setData({
      nicknamePending: false, profileWaiting: false,
      profileError: accepted ? "" : "昵称没有通过检查，请换一个昵称后再保存",
      ...(!accepted ? { draftNickname: "", nicknameInputId: this.data.nicknameInputId + 1 } : {}),
    });
    if (!accepted && this.data.profileMode === "nickname" && this.alive !== false)
      wx.showToast({ title: "昵称未通过检查，请重新填写", icon: "none" });
    if (accepted && pending && pending.nickname === this.reviewValue) this.commitProfile(pending);
  },
  saveProfile(event) {
    if (!this.editActive() || !this.data.profileReady || this.data.profileSaving) return;
    const value = String((event.detail.value || {}).nickname || "");
    // form 提供原生组件当前值；不能把较早的 blur 值或审核超时当作已通过。
    if (value !== this.data.draftNickname)
      return this.setData({ profileError: "昵称正在更新，请确认内容后再保存" });
    const nickname = value.trim();
    const changed = value !== this.originalNickname;
    if (changed && (!nickname || nickname.length > 24)) {
      this.setData({ profileError: "昵称需要 1–24 个字，请重新填写" });
      if (this.data.profileMode === "nickname") wx.showToast({ title: this.data.profileError, icon: "none" });
      return;
    }
    const pending = { nickname: value, changed, avatar: this.data.draftAvatar };
    if (changed && !(this.reviewState === "passed" && this.reviewValue === value)) {
      if (this.reviewState === "failed" || this.reviewState === "timeout")
        return this.setData({ profileError: "请重新填写昵称，完成检查后再保存" });
      this.pendingProfileSave = pending;
      this.setData({ profileWaiting: true, profileError: "" });
      if (this.reviewState !== "pending") this.waitNicknameReview();
      return;
    }
    this.commitProfile(pending);
  },
  async commitProfile(draft) {
    if (!this.editCurrent() || this.data.profileSaving) return;
    if (!draft.changed && !draft.avatar) return this.cancelProfile();
    const id = this.editId;
    this.setData({ profileSaving: true, profileError: "" });
    try {
      const user = draft.avatar
        ? await api.uploadTo("/v1/me/profile", draft.avatar, draft.changed ? { nickname: draft.nickname.trim() } : undefined)
        : await api.patch("/v1/me/profile", { nickname: draft.nickname.trim() });
      this.acceptProfile(user, id, "资料已保存");
    } catch (error) {
      if (this.editCurrent(id)) {
        this.setData({ profileError: errorText(error) });
        if (this.data.profileMode && this.alive !== false)
          wx.showToast({ title: errorText(error), icon: "none" });
        if (this.data.profileMode === "avatar") this.discardProfile();
      }
    } finally {
      if (this.editCurrent(id)) this.setData({ profileSaving: false });
    }
  },
  acceptProfile(user, id, message) {
    if (!this.editCurrent(id) || !user || user.id !== this.editOwner) return;
    if (this.alive === false) {
      // 切页后只记住同账号的完成结果；返回时再更新可见资料，busy 仍须正常释放。
      this.completedProfile = { user, id, message };
      return;
    }
    session.updateUser(user);
    profile.markPrompted(user.id);
    // 旧的 /auth/me 读取不能晚于这次保存，再把旧昵称盖回来。
    this.loadVersion = (this.loadVersion || 0) + 1;
    const name = profile.displayName(user);
    this.setData({ name, initial: Array.from(name)[0] || "", loading: false, profileSaving: false });
    const next = this.data.profileFirst ? this.profileSetupReturn : "";
    this.profileSetupReturn = "";
    this.discardProfile();
    this.loadAvatar(user, () => this.alive && (auth.getUser() || {}).id === user.id);
    wx.showToast({ title: message, icon: "success" });
    if (next) wx.reLaunch({ url: next });
  },
  resetProfile() {
    if (!this.editActive() || this.data.profileSaving || this.resetPrompt || !this.data.profileCanReset) return;
    const id = this.editId;
    this.resetPrompt = true;
    wx.showModal({
      title: "恢复默认资料？",
      content: "已保存的头像和昵称会移除，账号和学习资料不会改变。",
      confirmText: "恢复默认",
      success: async ({ confirm }) => {
        this.resetPrompt = false;
        if (!confirm || !this.editActive(id)) return;
        this.setData({ profileSaving: true, profileError: "" });
        try {
          const user = await api.del("/v1/me/profile", { avatar: true, nickname: true });
          this.acceptProfile(user, id, "已恢复默认资料");
        } catch (error) {
          if (this.editCurrent(id)) this.setData({ profileError: errorText(error) });
        } finally {
          if (this.editCurrent(id)) this.setData({ profileSaving: false });
        }
      },
      fail: () => { this.resetPrompt = false; },
    });
  },
  // Tapping a day shows its minutes under the map; tapping it again goes back to today.
  pickWeek(event) {
    const w = Number(event.currentTarget.dataset.w);
    const col = this.data.study && this.data.study.columns[w];
    if (!col) return;
    if (this.data.picked && this.data.picked.w === w) {
      this.setData({ picked: null });
      return;
    }
    const first = col.cells[0].day;
    const last = col.cells[6].day;
    const end = first.slice(0, 7) === last.slice(0, 7) ? `${Number(last.slice(8, 10))}日` : dayText(last);
    this.setData({
      picked: {
        w,
        label: `${dayText(first)}–${end}`,
        min: col.sum,
        days: col.cells.map((c, i) => ({ k: c.day, wd: WEEKDAYS[i], min: c.fu ? "" : c.min, td: c.td, fu: c.fu })),
      },
    });
  },
  iconError(event) {
    this.setData({ [`broken.${event.currentTarget.dataset.k}`]: true });
  },
  toggleUsage() {
    this.openUsage();
  },
  openUsage() {
    if (!gate.check()) return;
    wx.navigateTo({ url: "/pages/commercial/center/index" });
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
  openSupport() {
    wx.navigateTo({ url: "/pages/support/chat/index" });
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
        "你放进来的资料和原图、随心记里的内容、生成的讲解提示和题目、做题和回头看看的记录、学习时长都会删掉，找不回来；没用完的套餐和积分也会作废。订单和退款记录另存 3 年，只用于对账和退款。想留着的话，先导出一份；导出的是 JSON 文件，不含原图。",
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
            profile.clearPrompt(owner);
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
          .catch((error) => {
            // The server refuses while an order is unfinished (D130).
            if (error && error.code === "ACCOUNT_OPEN_ORDERS")
              return wx.showModal({
                title: "暂时不能注销",
                content: error.message,
                confirmText: "看订单",
                success: ({ confirm }) => {
                  if (confirm) wx.navigateTo({ url: "/pages/commercial/orders/index" });
                },
              });
            this.setData({ error: errorText(error) });
          })
          .finally(() => this.setData({ busy: false }));
      },
      fail: () => {
        this.deletePrompt = false;
      },
    });
  },
}));

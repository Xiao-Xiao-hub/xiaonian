const { withShare } = require("../../utils/share");
/*
 * 回顾设置：读取和修改卡片接续偏好，设置保存后由服务端安排后续回顾。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const gate = require("../../utils/gate");
const auth = require("../../utils/auth");
const { errorText } = require("../../utils/format");
const owner = () => (auth.getUser() || {}).id || "";
const DAYS = [
  { id: 1, name: "一" },
  { id: 2, name: "二" },
  { id: 3, name: "三" },
  { id: 4, name: "四" },
  { id: 5, name: "五" },
  { id: 6, name: "六" },
  { id: 0, name: "日" },
];
Page(withShare({
    data: {
      settings: null,
      days: [],
      busy: false,
      error: "",
      modes: [
        { id: "open", name: "打开时问" },
        { id: "time", name: "到点再问" },
        { id: "off", name: "先别问" },
      ],
      types: [
        { id: "study", name: "问学过的题" },
        { id: "cards", name: "问记下的事" },
        { id: "mood", name: "问心情相关的事" },
      ],
    },
    onShow() {
      if (!gate.check()) return;
      // A guest has nothing here: offer the welcome page, send nothing.
      if (gate.state() !== "ok") return gate.ask({ leave: true });
      this.alive = true;
      this.setData({ settings: null, error: "", busy: false });
      this.load();
    },
    onHide() {
      this.alive = false;
      this.seq = (this.seq || 0) + 1;
    },
    onUnload() {
      this.onHide();
    },
    active(account, seq) {
      return this.alive && owner() === account && this.seq === seq;
    },
    render(settings) {
      this.setData({
        settings,
        days: DAYS.map((d) => ({
          ...d,
          selected: settings.days.includes(d.id),
        })),
      });
    },
    async load() {
      const seq = (this.seq = (this.seq || 0) + 1);
      let account = "";
      try {
        await auth.login();
        account = owner();
        if (!this.alive || seq !== this.seq) return;
        const settings = await api.get("/v1/resume/settings");
        if (this.active(account, seq)) this.render(settings);
      } catch (error) {
        if (this.alive && seq === this.seq)
          this.setData({ error: errorText(error) });
      }
    },
    async save(settings) {
      if (this.data.busy || !this.alive || !this.data.settings) return;
      const account = owner(),
        seq = this.seq;
      this.setData({ busy: true, error: "" });
      try {
        const result = await api.put("/v1/resume/settings", settings);
        if (this.active(account, seq)) this.render(result);
      } catch (error) {
        if (this.active(account, seq))
          this.setData({ error: errorText(error) });
      } finally {
        if (this.active(account, seq)) this.setData({ busy: false });
      }
    },
    mode(event) {
      return this.save({
        ...this.data.settings,
        mode: event.currentTarget.dataset.id,
      });
    },
    time(event) {
      return this.save({ ...this.data.settings, at: event.detail.value });
    },
    day(event) {
      const id = Number(event.currentTarget.dataset.id),
        days = this.data.settings.days;
      const next = days.includes(id)
        ? days.filter((d) => d !== id)
        : days.concat(id);
      if (!next.length) return;
      return this.save({ ...this.data.settings, days: next });
    },
    type(event) {
      const id = event.currentTarget.dataset.id;
      return this.save({
        ...this.data.settings,
        types: { ...this.data.settings.types, [id]: event.detail.value },
      });
    },
    list(event) {
      wx.navigateTo({
        url: `/pages/resume-list/index?state=${event.currentTarget.dataset.state}`,
      });
    },
  }));

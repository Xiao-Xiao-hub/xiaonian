/*
 * 标签管理：列出、重命名或删除本人标签，并进入相应卡片筛选；加载前不显示空列表结论。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const gate = require("../../utils/gate");
const auth = require("../../utils/auth");
const { TAG_COLORS, tagView } = require("../../utils/cards");
const owner = () => (auth.getUser() || {}).id || "";
const colors = TAG_COLORS.map((color, index) => ({
  ...color,
  index,
  style: `background:${color.bg};color:${color.ink}`,
}));

Page({
    data: {
      tags: [],
      name: "",
      color: 0,
      colors,
      error: "",
      busy: false,
      busyId: "",
      editingId: "",
      editName: "",
      editColor: 0,
      creating: false,
      favorites: null,
      // The list came back at least once : only then is it "empty".
      loaded: false,
    },
    onShow() {
      if (!gate.check()) return;
      // A guest has nothing here: offer the welcome page, send nothing.
      if (gate.state() !== "ok") return gate.ask({ leave: true });
      this.alive = true;
      this.epoch = (this.epoch || 0) + 1;
      const current = owner();
      // A save left running when the page hid no longer holds the buttons:
      // its answer is dropped and the list below shows what was stored.
      this.setData({ busy: false, busyId: "" });
      if (this.account && current !== this.account)
        this.setData({
          tags: [],
          loaded: false,
          editingId: "",
          error: "换了账号，退出这页再进来",
        });
      if (current) this.account = current;
      this.load();
    },
    onHide() {
      this.alive = false;
      this.epoch = (this.epoch || 0) + 1;
      this.seq = (this.seq || 0) + 1;
    },
    onUnload() {
      this.onHide();
    },
    active(epoch, account) {
      if (!this.alive || epoch !== this.epoch) return false;
      const current = owner();
      if (account && current !== account) return false;
      if (this.account && current && this.account !== current) return false;
      return true;
    },
    load() {
      const epoch = this.epoch,
        account = this.account || owner(),
        seq = (this.seq || 0) + 1;
      this.seq = seq;
      return api
        .get("/v1/tags")
        .then((tags) => {
          if (!this.active(epoch, account) || seq !== this.seq) return;
          if (!this.account && owner()) this.account = owner();
          this.setData({ tags: (tags || []).map(tagView), error: "", loaded: true });
        })
        .catch((error) => {
          if (
            this.active(epoch, account) &&
            seq === this.seq &&
            !api.needsConsent(error)
          )
            this.setData({ error: error.message || "没打开，再试一次" });
        })
        .then(() => this.loadFavorites(epoch, account, seq));
    },
    // The 收藏 row shows only when the server counts favorites.
    loadFavorites(epoch, account, seq) {
      return api
        .get("/v1/cards/stats")
        .then((stats) => {
          if (!this.active(epoch, account) || seq !== this.seq) return;
          const count = stats && stats.favorites;
          this.setData({ favorites: typeof count === "number" ? count : null });
        })
        .catch(() => {});
    },
    // A row opens the 卡片 tab showing just those cards.
    showCards(filter) {
      getApp().globalData.cardFilter = filter;
      wx.switchTab({ url: "/pages/deck/index" });
    },
    openFavorites() {
      this.showCards({ favorite: true });
    },
    openTag(event) {
      const tag = event.currentTarget.dataset.tag;
      if (tag) this.showCards({ tag: tag.id, tagName: tag.name });
    },
    startCreate() {
      if (this.data.tags.length >= 50)
        return this.setData({ error: "标签最多 50 个" });
      this.setData({ creating: true, editingId: "", error: "" });
    },
    cancelCreate() {
      this.setData({ creating: false, name: "", error: "" });
    },
    input(event) {
      this.setData({ name: event.detail.value });
    },
    color(event) {
      this.setData({ color: Number(event.currentTarget.dataset.color) });
    },
    create() {
      const name = this.data.name.trim();
      if (!name) return this.setData({ error: "先写个名字" });
      if (this.data.tags.length >= 50)
        return this.setData({ error: "标签最多 50 个" });
      if (this.data.busy) return Promise.resolve();
      const epoch = this.epoch,
        account = this.account || owner();
      this.setData({ busy: true, error: "" });
      return api
        .post("/v1/tags", { name, color: this.data.color })
        .then(() => {
          if (!this.active(epoch, account)) return;
          this.setData({ name: "", creating: false });
          return this.load();
        })
        .catch((error) => {
          if (this.active(epoch, account) && !api.needsConsent(error))
            this.setData({ error: error.message || "没建好，再试一次" });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ busy: false });
        });
    },
    startEdit(event) {
      const tag = event.currentTarget.dataset.tag;
      this.setData({
        editingId: tag.id,
        editName: tag.name,
        editColor: Number(tag.color),
        creating: false,
        error: "",
      });
    },
    editInput(event) {
      this.setData({ editName: event.detail.value });
    },
    editColor(event) {
      this.setData({ editColor: Number(event.currentTarget.dataset.color) });
    },
    cancelEdit() {
      this.setData({ editingId: "", editName: "" });
    },
    saveEdit() {
      const id = this.data.editingId,
        name = this.data.editName.trim();
      if (!id || !name) return this.setData({ error: "名字空着，写几个字吧" });
      if (this.data.busyId) return Promise.resolve();
      const epoch = this.epoch,
        account = this.account || owner();
      this.setData({ busyId: id, error: "" });
      return api
        .patch(`/v1/tags/${encodeURIComponent(id)}`, {
          name,
          color: this.data.editColor,
        })
        .then(() => {
          if (!this.active(epoch, account)) return;
          this.setData({ editingId: "", editName: "" });
          return this.load();
        })
        .catch((error) => {
          if (this.active(epoch, account) && !api.needsConsent(error))
            this.setData({ error: error.message || "没改成，再试一次" });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ busyId: "" });
        });
    },
    remove(event) {
      const tag = event.currentTarget.dataset.tag,
        epoch = this.epoch,
        account = this.account || owner();
      wx.showModal({
        title: "删掉这个标签？",
        content: `删了之后，卡上的 #${tag.name} 也会一起去掉。`,
        confirmText: "删掉",
        success: (result) => {
          if (
            !result.confirm ||
            !this.active(epoch, account) ||
            this.data.busyId
          )
            return;
          this.setData({ busyId: tag.id, error: "" });
          api
            .del(`/v1/tags/${encodeURIComponent(tag.id)}`)
            .then(() => {
              if (!this.active(epoch, account)) return;
              this.setData({ editingId: "", editName: "" });
              return this.load();
            })
            .catch((error) => {
              if (this.active(epoch, account) && !api.needsConsent(error))
                this.setData({ error: error.message || "没删掉，再试一次" });
            })
            .finally(() => {
              if (this.active(epoch, account)) this.setData({ busyId: "" });
            });
        },
      });
    },
  });

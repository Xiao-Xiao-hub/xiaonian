const { withShare } = require("../../utils/share");
/*
 * 协议正文页：按文档标识读取服务端法律文件，展示当前正文及版本。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const { request } = require("../../utils/request");
const { errorText } = require("../../utils/format");
// 协议查看页: 用户协议、隐私政策、儿童隐私政策, from GET /v1/legal/:doc (public,
// so it opens before anyone agrees or logs in). ?doc= picks the first one.
const DOCS = [
  { key: "user-agreement", name: "用户协议" },
  { key: "privacy-policy", name: "隐私政策" },
  { key: "children-privacy", name: "儿童隐私政策" },
];
Page(withShare({
  data: { docs: DOCS, doc: "privacy-policy", view: null, loading: false, error: "" },
  onLoad(query) {
    this.cache = {};
    const doc = DOCS.some((d) => d.key === query.doc) ? query.doc : "privacy-policy";
    this.show(doc);
  },
  pick(e) {
    const doc = e.currentTarget.dataset.doc;
    if (doc !== this.data.doc) this.show(doc);
  },
  retry() {
    this.show(this.data.doc);
  },
  show(doc) {
    const cached = this.cache[doc];
    this.setData({ doc, view: cached || null, error: "", loading: !cached });
    if (typeof wx.pageScrollTo === "function") wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    if (cached) return;
    request({ url: `/v1/legal/${doc}` })
      .then((body) => {
        const view = body && body.data;
        if (!view || !Array.isArray(view.sections)) throw new Error("没打开，再试一次");
        this.cache[doc] = view;
        if (this.data.doc === doc) this.setData({ view, loading: false });
      })
      .catch((error) => {
        if (this.data.doc === doc) this.setData({ loading: false, error: errorText(error) });
      });
  },
  // 目录: jumps to the chapter.
  jump(e) {
    wx.pageScrollTo({ selector: `#s${e.currentTarget.dataset.index}`, offsetTop: -64, duration: 200 });
  },
}));

/* 原生右上角菜单：分享晓念入口，不携带个人笔记、会话或页面截图。 */
const HOME = "/pages/notes/index";
const TITLE = "晓念随心记";
// 转发卡片按 5:4 显示；专用图让小狸完整出现，不被裁切。
const IMAGE = "/assets/xiaoli/share.jpg";
const QUERY = "xnShare=1";
let copyOwner = null;

function clearCopy(page) {
  if (copyOwner !== page) return;
  wx.offCopyUrl();
  copyOwner = null;
}

function singlePage() {
  return (
    typeof wx.getLaunchOptionsSync === "function" &&
    wx.getLaunchOptionsSync().scene === 1154
  );
}

function withShare(options, timeline = false) {
  return {
    ...options,
    onLoad(query) {
      // 原生短链不能改 path；接收方回首页。朋友圈只开放已有的纯内容帮助页。
      if (
        query &&
        query.xnShare === "1" &&
        this.route !== HOME.slice(1) &&
        !(timeline && singlePage())
      ) {
        this._shareLandingRedirect = true;
        wx.reLaunch({ url: HOME });
        return;
      }
      if (options.onLoad) return options.onLoad.apply(this, arguments);
    },
    onShow() {
      if (this._shareLandingRedirect) return;
      // 朋友圈单页模式禁止菜单、剪贴板及页面跳转，帮助页无需这些API。
      if (timeline && singlePage()) return;
      if (typeof wx.showShareMenu === "function") {
        wx.showShareMenu({
          menus: timeline
            ? ["shareAppMessage", "shareTimeline"]
            : ["shareAppMessage"],
        });
      }
      if (
        typeof wx.onCopyUrl === "function" &&
        typeof wx.offCopyUrl === "function"
      ) {
        if (copyOwner) clearCopy(copyOwner);
        wx.onCopyUrl(() => ({ query: QUERY, title: TITLE }));
        copyOwner = this;
      }
      if (options.onShow) return options.onShow.apply(this, arguments);
    },
    onReady() {
      if (this._shareLandingRedirect) return;
      if (options.onReady) return options.onReady.apply(this, arguments);
    },
    onHide() {
      clearCopy(this);
      if (this._shareLandingRedirect) return;
      if (options.onHide) return options.onHide.apply(this, arguments);
    },
    onUnload() {
      clearCopy(this);
      if (this._shareLandingRedirect) return;
      if (options.onUnload) return options.onUnload.apply(this, arguments);
    },
    onShareAppMessage() {
      return { title: TITLE, path: HOME, imageUrl: IMAGE };
    },
    ...(timeline
      ? {
          onShareTimeline() {
            return { title: TITLE, query: QUERY, imageUrl: IMAGE };
          },
        }
      : {}),
  };
}

module.exports = { withShare };

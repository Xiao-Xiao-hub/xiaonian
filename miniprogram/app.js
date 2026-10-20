/*
 * 小程序全局生命周期：初始化皮肤、访问状态和平台隐私授权相关行为。
 * 页面业务分别位于 pages，登录与请求公共逻辑位于 utils；不要把单页状态放进全局长期复用。
 */
const config = require("./utils/config");
const visit = require("./utils/visit");
const auth = require("./utils/auth");
App({
  globalData: { config },
  onShow() {
    visit.show();
    auth.syncPending();
  },
  onHide() {
    visit.hide();
  },
  onLaunch() {
    if (typeof wx.getUpdateManager !== "function") return;
    const manager = wx.getUpdateManager();
    manager.onUpdateReady(() =>
      wx.showModal({
        title: "更新已准备好",
        content: "重启后使用新版本。请先完成当前操作。",
        success: (r) => {
          if (r.confirm) manager.applyUpdate();
        },
      }),
    );
    manager.onUpdateFailed(() =>
      wx.showToast({ title: "更新下载失败，可稍后重新进入", icon: "none" }),
    );
  },
});

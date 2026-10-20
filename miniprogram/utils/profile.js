/*
 * 自选头像昵称：这里只管理显示、原生能力检查和首次提示，不改变微信账号身份。
 * 头像临时路径只用于当前页面预览，不写入账号或登录会话。
 */
const DEFAULT_NAME = "微信用户";
const PROMPT_PREFIX = "zhiye_profile_prompt:";
function displayName(user) {
  const name = user && user.nickname;
  return name && name !== DEFAULT_NAME ? name : "";
}
function supported() {
  try {
    const info = typeof wx.getAppBaseInfo === "function"
      ? wx.getAppBaseInfo()
      : wx.getSystemInfoSync();
    const parts = String(info.SDKVersion || "").split(".").map(Number);
    const version = (parts[0] || 0) * 1000000 + (parts[1] || 0) * 1000 + (parts[2] || 0);
    return version >= 2032003 &&
      typeof wx.getPrivacySetting === "function" &&
      typeof wx.requirePrivacyAuthorize === "function" &&
      typeof wx.canIUse === "function" &&
      wx.canIUse("button.open-type.chooseAvatar") &&
      wx.canIUse("input.type.nickname");
  } catch (_) {
    return false;
  }
}
function authorize() {
  return new Promise((resolve, reject) => {
    wx.getPrivacySetting({
      success: ({ needAuthorization }) => {
        if (!needAuthorization) return resolve();
        // 未注册自定义隐私监听时，由微信展示官方隐私弹窗；成功前不渲染昵称输入框。
        wx.requirePrivacyAuthorize({
          success: resolve,
          fail: () => reject(new Error("还没有同意头像昵称的隐私授权，可以重试或先跳过")),
        });
      },
      fail: () => reject(new Error("暂时无法确认隐私授权，请稍后重试")),
    });
  });
}
function prompted(owner) {
  return wx.getStorageSync(PROMPT_PREFIX + owner) === "1";
}
function markPrompted(owner) {
  wx.setStorageSync(PROMPT_PREFIX + owner, "1");
}
function clearPrompt(owner) {
  wx.removeStorageSync(PROMPT_PREFIX + owner);
}
module.exports = { displayName, supported, authorize, prompted, markPrompted, clearPrompt };

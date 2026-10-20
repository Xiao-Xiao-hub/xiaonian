/*
 * 文件选择错误处理：区分取消选择与真实读取失败，向页面提供一致提示。
 * 用户取消不是业务错误；后续上传和格式校验由调用方继续处理。
 */
// Shared `fail` for wx.chooseMedia / wx.chooseMessageFile. A cancel stays
// silent; a missing privacy declaration and a denied permission each get one
// short line. Returns the message shown, or "" when nothing was shown.
const PRIVACY = /privacy|隐私|api scope is not declared/i;
function failText(error) {
  const message = String((error && error.errMsg) || "");
  if (/cancel/i.test(message)) return "";
  return PRIVACY.test(message)
    ? "小程序还没开通这项权限，先用粘贴文字"
    : "没能打开相册或文件，去右上角 ⋯ → 设置 里看看权限";
}
function pickFailed(error) {
  const text = failText(error);
  if (text)
    wx.showModal({ content: text, showCancel: false, confirmText: "好" });
  return text;
}
module.exports = { failText, pickFailed };

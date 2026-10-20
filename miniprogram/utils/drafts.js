/*
 * 收录与导入草稿：按账号生成本地缓存键，保存或清除未完成输入。
 * 模块位于主包，供主包收录页和导入分包共同使用；主包不能反向依赖分包文件。
 */
// Import and capture drafts, kept per account. In the main package so that
// main-package pages (capture) can use them: a main-package page cannot
// require a module from the import subpackage (V4.2: that left the capture
// page blank).
function draftKey(name, account) {
  return `zhiye_import_${name}:${account || ""}`;
}
function draftGet(name, account) {
  try {
    const value = wx.getStorageSync(draftKey(name, account));
    return value && typeof value === "object" ? value : null;
  } catch (error) {
    return null;
  }
}
function draftSet(name, account, value) {
  try {
    if (value) wx.setStorageSync(draftKey(name, account), value);
    else wx.removeStorageSync(draftKey(name, account));
  } catch (error) {
    /* A draft that was not kept is not an error. */
  }
}

module.exports = { draftKey, draftGet, draftSet };

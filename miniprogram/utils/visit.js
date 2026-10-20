/*
 * 访问标识：冷启动或离开达到设定时间后开启新访问，标签页切换仍属于同次访问。
 * 回顾流程使用该标识限制重复展示；它不替代用户身份或登录凭证。
 */
// A cold launch or 30 minutes away starts a visit; tab changes do not.
let id = "";
let hiddenAt = null;
let serial = 0;
function show(now = Date.now()) {
  if (!id || (hiddenAt !== null && now - hiddenAt >= 30 * 60 * 1000)) {
    id = `visit_${now}_${++serial}_${Math.random().toString(36).slice(2, 10)}`;
  }
  hiddenAt = null;
  return id;
}
function hide(now = Date.now()) {
  hiddenAt = now;
}
function current() {
  return id || show();
}
module.exports = { show, hide, current };

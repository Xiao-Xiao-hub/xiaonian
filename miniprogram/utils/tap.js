/*
 * 点击防重复：在短时间窗口内只接受一次点击，避免连续打开同一页面。
 * 调用者传入页面或组件，函数在该对象上保存上次点击时间并返回是否接受本次点击。
 */
// One tap, one action: a second tap within WINDOW ms is dropped, so a quick
// double tap opens one page, not two. The map's taps (pages/map/hit.js) use it
// too. owner: the page or component the tap lands on.
const WINDOW = 450;
function once(owner, now = Date.now()) {
  if (now - (owner.lastTapAt || 0) < WINDOW) return false;
  owner.lastTapAt = now;
  return true;
}
module.exports = { once, WINDOW };

/*
 * 键盘适配：根据系统键盘高度与安全区域计算输入栏位置。
 * 供需要固定输入栏的页面复用；页面布局仍由各自 WXML/WXSS 决定。
 */
// A bottom input over the soft keyboard. Android pushes the whole page
// up for a fixed textarea, which hides the messages; instead the textarea gets
// adjust-position="{{false}}" and the page lifts the input itself:
//
//   <view class="page" style="padding-bottom:calc(220rpx + {{kb}}px)">…
//   <view class="composer" style="bottom:{{kb}}px">
//     <textarea fixed adjust-position="{{false}}"
//       bindkeyboardheightchange="keyboardHeight" bindblur="…"/>
//
//   keyboardHeight(e) { keyboard.change(this, e,  => this.toLatest); }
//
// `kb` is the keyboard's height in px (0 when it is down). The page keeps the
// same room at the bottom, so the newest message can scroll above the input.
function height(event) {
  const value = Number(event && event.detail && event.detail.height);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
// Returns the new height. `onRise` runs when the keyboard comes up or grows,
// e.g. to scroll to the newest message. `gap` (px) is the part of the keyboard
// the page does not reach, e.g. the tab bar on a tab page.
function change(page, event, onRise, gap) {
  const kb = Math.max(0, height(event) - (Number(gap) || 0)),
    before = Number(page.data.kb) || 0;
  if (kb === before) return kb;
  page.setData({ kb });
  if (kb > before && typeof onRise === "function") onRise();
  return kb;
}
// Some phones send no last 0 when the input loses focus: call from bindblur.
function reset(page) {
  if (Number(page.data.kb)) page.setData({ kb: 0 });
}
module.exports = { height, change, reset };

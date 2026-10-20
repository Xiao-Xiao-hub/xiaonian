/*
 * 默认皮肤兼容入口：保留旧页面调用的方法，当前界面仅使用一个默认皮肤。
 * 页面颜色以 app.wxss 为准，原生导航栏和标签栏由 app.json 配置；选择、应用皮肤不会改变外观。
 */
// Skins. v4 has one look only: the 作业本 skin is gone
// and the window, navigation bar and tab bar come straight from app.json. The
// exports keep their shapes so pages and older callers still work; choosing a
// skin or applying one changes nothing.
const SKINS = [
  {
    id: "sky",
    name: "默认",
    note: "浅灰打底，白色卡片",
    cls: "",
    bg: "#f5f6f8",
    tab: { color: "#8f959e", selectedColor: "#2f6bf6", backgroundColor: "#ffffff", borderStyle: "white" },
    tabIcon: "blue",
    swatch: ["#f5f6f8", "#ffffff", "#2f6bf6", "#1f2329"],
  },
];
// Tab bar order in app.json; icons are assets/tab/<name>.png and <name>-blue.png.
const TABS = ["pen", "deck", "map", "chat", "user"];
const TAB_ROUTES = ["pages/notes/index", "pages/deck/index", "pages/learn/index", "pages/talk/index", "pages/profile/index"];

function current() {
  return SKINS[0];
}
function apply(page) {
  if (page && page.data && page.data.skin) page.setData({ skin: "" });
}
function choose() {}
// Page(themed({...})): kept so pages need no change; the skin is always "".
function themed(def) {
  const show = def.onShow;
  return {
    ...def,
    data: { ...def.data, skin: "" },
    onShow(...args) {
      apply(this);
      if (show) return show.apply(this, args);
    },
  };
}
module.exports = { SKINS, TABS, TAB_ROUTES, current, apply, choose, themed };

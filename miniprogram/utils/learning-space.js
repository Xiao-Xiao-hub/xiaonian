/*
 * 学习页面本地状态：按账号保存学习位置和相关草稿指针，支持继续上次。
 * 这些缓存服务于导航与恢复；学习进度和最终结果仍由服务端判定。
 */
// Only per-account pointers live on this device (the last point, the last 问 AI
// conversation), and since V4.2 the unfinished answers on 练一题 so leaving the
// page keeps them; never messages or note contents. All go with the account.
const prefix = "zhiye_last_point:";
const draftPrefix = "zhiye_point_draft:";
const DRAFTS = 20;
const threadPrefix = "ask_thread:";
function remember(owner, pointId, now = Date.now()) {
  if (!owner || typeof pointId !== "string" || !pointId || !Number.isFinite(now)) return;
  try { wx.setStorageSync(prefix + owner, { pointId, openedAt: now }); } catch (_) { /* Optional convenience; learning still works. */ }
}
function clear(owner) {
  if (!owner) return;
  try { wx.removeStorageSync(prefix + owner); } catch (_) { /* No server state changes. */ }
  forgetThread(owner);
  try { wx.removeStorageSync(draftPrefix + owner); } catch (_) { /* Optional convenience. */ }
  try {
    wx.removeStorageSync("v2_map_cache:" + owner); // pages/map: the last map
    wx.removeStorageSync("v2_map_view:" + owner); // and where it was scrolled
  } catch (_) { /* Optional convenience. */ }
  // The 学习时长 switch is kept per phone (utils/study-clock.js PREF_KEY); it
  // goes with the account, and the next one starts from its own setting.
  try { wx.removeStorageSync("zhiye_study_time"); } catch (_) { /* Only decides whether to time. */ }
}
function lastThread(owner) {
  try { return (owner && wx.getStorageSync(threadPrefix + owner)) || ""; } catch (_) { return ""; }
}
function rememberThread(owner, id) {
  if (!owner || !id) return;
  try { wx.setStorageSync(threadPrefix + owner, id); } catch (_) { /* Optional convenience. */ }
}
function forgetThread(owner) {
  try {
    if (owner) wx.removeStorageSync(threadPrefix + owner);
    wx.removeStorageSync("ask_thread"); // the old key shared by every account
  } catch (_) { /* Optional convenience. */ }
}
function visiblePoint(map, id) {
  for (const chapter of map.chapters || []) {
    if (chapter.hidden) continue;
    const point = chapter.points.find((p) => p.id === id && p.ready !== false);
    if (point) return { id: point.id, name: point.name, chapterId: chapter.id, chapter: chapter.short };
  }
  return null;
}
function continuation(map, owner) {
  let last;
  try { last = owner && wx.getStorageSync(prefix + owner); } catch (_) { last = null; }
  const prior = last && Number.isFinite(last.openedAt) && visiblePoint(map, last.pointId);
  if (prior) return { ...prior, label: "继续上次", detail: `${prior.chapter} · 从这里接着做` };
  for (const item of map.summary.todayList || []) {
    const point = !item.done && visiblePoint(map, item.id);
    if (point) return { ...point, label: item.kind === "review" ? "温故一小步" : "今天从这里开始", detail: item.kind === "review" ? "做一道复习题，找回思路" : "一次一题，按自己的节奏" };
  }
  return { id: null, label: "按自己的节奏", name: "看看学习地图", detail: "想复习哪一章，就从哪里开始" };
}
function stickers(map) {
  return (map.chapters || []).map((chapter) => ({
    id: chapter.id, name: chapter.short,
    rank: chapter.started ? chapter.rank : "还没开始",
    earned: Boolean(chapter.started && chapter.rank !== "起步"),
    hidden: Boolean(chapter.hidden),
  }));
}
// 练一题: the problem being answered on a point and what is filled in so far,
// { index, answers }, kept for the last few points; null clears it.
function drafts(owner) {
  try { return (owner && wx.getStorageSync(draftPrefix + owner)) || {}; } catch (_) { return {}; }
}
function pointDraft(owner, pointId) {
  const d = drafts(owner)[pointId];
  return d && Number.isInteger(d.index) && Array.isArray(d.answers) ? d : null;
}
function keepPointDraft(owner, pointId, draft, now = Date.now()) {
  if (!owner || !pointId) return;
  const all = drafts(owner);
  delete all[pointId];
  if (draft) all[pointId] = { index: draft.index, answers: draft.answers.slice(), at: now };
  const kept = Object.entries(all)
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .slice(0, DRAFTS);
  try {
    if (kept.length) wx.setStorageSync(draftPrefix + owner, Object.fromEntries(kept));
    else wx.removeStorageSync(draftPrefix + owner);
  } catch (_) { /* Optional convenience; the answer is still on the page. */ }
}
module.exports = { remember, clear, continuation, stickers, lastThread, rememberThread, forgetThread, pointDraft, keepPointDraft };

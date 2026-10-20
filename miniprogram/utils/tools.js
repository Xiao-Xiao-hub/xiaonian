/*
 * 学习工具衔接：保存并转交解题、批改和讲一遍需要的草稿、照片及提交标识。
 * 缓存按账号隔离；清理旧操作前核对草稿身份，防止旧请求完成时删除刚输入的新内容。
 */
// The study tools on 学习 : 拍一道题 (pages/ask), 批改
// (pages/grade; V4.2 G7 merged 批改草稿 and 整页作业 into it) and 讲一遍
// (pages/teach). Here: taking or picking a photo, reading it for one tool,
// handing a photo that fits another tool over to it (the same scan, no second
// upload or count), and what was typed into a tool, kept on this phone.
const api = require("./api");
const { pickFailed } = require("./pick");
const PHOTO_LIMIT = 5 * 1024 * 1024;
const ROUTE = {
  problem: "pages/ask/index",
  grade: "pages/grade/index",
  // Old names (0.6.0 links, openAsk({ photo })): the one 批改 now.
  draft: "pages/grade/index",
  homework: "pages/grade/index",
  teach: "pages/teach/index",
};
// The chip shown when a photo fits another tool better (scan.suggest).
const SUGGEST = {
  problem: { text: "这张像是一道题", go: "去拍一道题" },
  grade: { text: "这张像是你写的解答", go: "去批改" },
};
// The server still names the two kinds of 批改 apart.
const toolOf = (s) => (s === "draft" || s === "homework" ? "grade" : s);
// source: "camera" or "album". Resolves with the file, or null when cancelled.
function pick(source) {
  return new Promise((resolve) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: [source === "album" ? "album" : "camera"],
      sizeType: ["compressed"],
      success: ({ tempFiles }) => resolve(tempFiles[0] || null),
      fail: (error) => {
        pickFailed(error);
        resolve(null);
      },
    });
  });
}
// Reads a photo for one tool. The reply is the server's (POST /v1/chat/scan)
// with the local path as photo.
function scan(file, purpose) {
  if (file.size > PHOTO_LIMIT)
    return Promise.reject(Object.assign(new Error("照片太大了，裁小一点再试"), { code: "IMAGE_TOO_LARGE" }));
  return api
    .uploadTo(`/v1/chat/scan?tone=light&purpose=${purpose}`, file.tempFilePath)
    .then((result) => ({ ...result, photo: file.tempFilePath }));
}
// here: the tool showing it; a photo handed over never points back at it.
function suggestOf(result, here) {
  const s = toolOf(result && result.suggest);
  return s && s !== here && SUGGEST[s] ? { to: s, ...SUGGEST[s] } : null;
}
// The tool a photo is handed to reads it once (take). 解题 opens through
// openAsk, so it is never in the stack twice.
function handOver(to, result) {
  getApp().globalData.toolScan = { to, scan: result };
  if (to === "problem") return require("./chat-entry").openAsk({}, { replace: true });
  wx.redirectTo({ url: `/${ROUTE[to]}` });
}
function take(to) {
  const app = getApp();
  const held = app && app.globalData && app.globalData.toolScan;
  if (!held || toolOf(held.to) !== toolOf(to)) return null;
  app.globalData.toolScan = null;
  return held.scan;
}
// Problem lines as the learner edits them: no empty lines, at most `max`.
function cleanLines(lines, max) {
  return (lines || []).map((s) => String(s || "").trim()).filter(Boolean).slice(0, max || 40);
}
// 获取本机当前登录账号。token 过期后由下一次请求重新登录，这仍是同一账号，不能误判成账号切换。
function account() {
  const user = require("./auth").getUser() || require("./session").lastUser();
  return (user && user.id) || "";
}
// A result is kept for the account its request was made as: the one signed in
// when it started, or, with nobody signed in then, the one it signed in as.
function sameAccount(was) {
  const now = account();
  return Boolean(now) && (!was || now === was);
}
// What was typed into a tool and not sent yet, per account on this
// phone: it survives leaving the page; dropped once it is sent and answered.
const keyOf = (tool) => {
  const id = account();
  return id ? `tool_draft:${tool}:${id}` : "";
};
// Versions only live as long as the callbacks they protect. Keep the stored
// draft format unchanged; even a new draft with identical text is a new write.
const draftVersions = new Map();
const changed = (key) => draftVersions.set(key, (draftVersions.get(key) || 0) + 1);
function keep(tool, value) {
  const key = keyOf(tool);
  if (!key) return;
  try { wx.setStorageSync(key, value); changed(key); } catch (_) { /* Optional convenience. */ }
}
function kept(tool) {
  const key = keyOf(tool);
  try { return (key && wx.getStorageSync(key)) || null; } catch (_) { return null; }
}
function drop(tool) {
  const key = keyOf(tool);
  try { if (key) { wx.removeStorageSync(key); changed(key); } } catch (_) { /* Optional convenience. */ }
}
// Capture after keeping a request's draft. Late success/failure may clear it
// only if the account, write version and stored contents still match.
function draftGuard(tool) {
  const key = keyOf(tool);
  const version = draftVersions.get(key) || 0;
  let value;
  try { value = JSON.stringify(key && wx.getStorageSync(key)); } catch (_) { return () => false; }
  return () => {
    if (!key || keyOf(tool) !== key || (draftVersions.get(key) || 0) !== version) return false;
    try { return JSON.stringify(wx.getStorageSync(key)) === value; } catch (_) { return false; }
  };
}
module.exports = { ROUTE, SUGGEST, pick, scan, suggestOf, handOver, take, cleanLines, PHOTO_LIMIT, keep, kept, drop, account, sameAccount, draftGuard };

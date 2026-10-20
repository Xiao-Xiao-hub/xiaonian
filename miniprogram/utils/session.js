/*
 * 本地会话存取：保存 token 和公开用户信息，并通过会话代际区分新旧请求。
 * 供登录和请求模块共用；读取缓存不等于重新取得授权，隐私版本检查仍由 auth 负责。
 */
const KEY = "zhiye_session";
function getSession() {
  const session = wx.getStorageSync(KEY);
  if (
    !session ||
    !session.token ||
    !session.user ||
    !Number.isFinite(Date.parse(session.expiresAt)) ||
    Date.parse(session.expiresAt) <= Date.now()
  )
    return null;
  return session;
}
// 返回本机保存的会话账号，token 过期后仍保留身份，以便下次重新登录时识别为同一账号。
// 用户退出、注销或会话被服务端拒绝后，不再返回该身份。
function lastUser() {
  const stored = wx.getStorageSync(KEY);
  return stored && stored.token && stored.user ? stored.user : null;
}
function setSession(value) {
  wx.setStorageSync(KEY, value);
}
// 只合并当前账号的公开资料，保留可能已续期的 token 和到期时间。
function updateUser(user) {
  const current = getSession();
  if (!current || !user || current.user.id !== user.id) return false;
  setSession({ ...current, user: { ...current.user, ...user } });
  return true;
}
function clearSession() {
  wx.removeStorageSync(KEY);
}
// Kept on this phone, not on the account; 注销 (我的 and 隐私政策) clears them
// so whoever starts again is new here.
const LOCAL_FLAGS = [
  "zhiye_onboarded",
  "zhiye_notes_hello_closed",
  "zhiye_notes_tidy_later",
  "ask_tip_seen",
];
module.exports = { getSession, lastUser, setSession, updateUser, clearSession, LOCAL_FLAGS };

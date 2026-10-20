/*
 * 对话导航：统一进入聊一聊、解题或已有会话，避免各页面自行拼出不同路由。
 * 调用者提供话题、卡片或会话标识；这里负责入口与页面切换，不代替服务端创建业务事实。
 */
// Where a conversation opens. Conversations that start from 随心记 — a
// jot, a card, a mood thread, a brainstorm — open the standalone chat page and
// come back to where they started; problems open the 解题 page (openAsk), and a
// chat about anything starts on the 聊一聊 tab (pages/talk).
//
// The chat page reads getApp.globalData.chat once, in the same shapes the
// 解题 page reads globalData.ask:
//   { text, entry: "jot", cardIds?, cards?, pointId?, scene? }  a new chat from a jot
//   { cards: [card], teach?: true, scene? }                       a chat about cards
//   { cards: [card], brainstormId }                               a chat about a brainstorm and its report
//   { threadId, messageId?, pendingMood?: true }                  an existing chat
//   { threadId, wrap: true }                                      an existing chat, straight to 存成卡
//   { threadId, cards: [card] }                                   a card's chat; a new one about the card if it is gone
//
// V4.2 : tab opens it on the 聊一聊 tab instead (the history page, the
// unfinished chat on 随心记); the chat page stays for chats opened on top of
// a card or a brainstorm, so back leads there.
function openChat(intent, { fromHome = false, tab = false } = {}) {
  getApp().globalData.chat = intent || {};
  if (tab) return wx.switchTab({ url: "/pages/talk/index" });
  const go = () => wx.navigateTo({ url: "/pages/chat/index" });
  // From deep inside a flow (a finished brainstorm), back should lead home.
  if (fromHome) wx.switchTab({ url: "/pages/notes/index", success: go });
  else go();
}
// A card's 接着聊 : the chat it was saved from, else the latest chat
// that carried it, else a new chat about it.
function chatAboutCard(card) {
  if (!card) return Promise.resolve();
  const go = (threadId) => openChat(threadId ? { threadId, cards: [card] } : { cards: [card] });
  if (card.origin === "chat" && card.srcId) return Promise.resolve(go(card.srcId));
  return require("./api")
    .get(`/v1/chat/threads?kind=chat&limit=1&cardId=${encodeURIComponent(card.id)}`)
    .then(
      ({ threads }) => go(threads && threads[0] ? threads[0].id : ""),
      () => go(""),
    );
}
// 解题 is a page of its own : opened on top, or gone back to when it is
// already in the stack, never stacked twice. replace: the page asking leaves
// (the chat page handing over a problem).
function openAsk(intent, { replace = false } = {}) {
  // 批改草稿, 整页作业 and 讲一遍 (without cards) have pages of their own.
  const tool = intent && !intent.threadId && (intent.photo === "draft" || intent.photo === "homework" ? intent.photo : intent.teach && !(intent.cards && intent.cards.length) ? "teach" : "");
  if (tool) return require("./learn").backTo(require("./tools").ROUTE[tool]);
  getApp().globalData.ask = intent || {};
  const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
  const plan = require("./learn").navPlan(pages, "pages/ask/index");
  if (replace && plan.kind === "navigateTo") plan.kind = "redirectTo";
  if (plan.kind === "back") wx.navigateBack({ delta: plan.delta });
  else if (plan.kind === "stay") {
    // Already on it: it takes the intent now.
    const page = pages[pages.length - 1];
    if (page && typeof page.onShow === "function") page.onShow();
  } else wx[plan.kind]({ url: plan.url });
  return plan;
}
// chats deleted on this phone in this run. A page still showing one
// (the 聊一聊 tab, the chat page) starts afresh when it shows again.
function chatDeleted(id) {
  const app = getApp().globalData;
  app.deletedChats = { ...(app.deletedChats || {}), [id]: true };
}
function chatGone(id) {
  const gone = getApp().globalData.deletedChats;
  return Boolean(id && gone && gone[id]);
}
module.exports = { openChat, openAsk, chatAboutCard, chatDeleted, chatGone };

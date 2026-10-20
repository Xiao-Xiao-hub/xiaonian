/*
 * 知识点共用动作：为详情和练习页面提供自评、标记、卡点求助与对话入口。
 * 函数接收调用页面并更新其 data；异步回包先核对页面存活、授权及账号，再刷新当前知识点。
 */
// What one knowledge point offers besides practice : the map's old
// detail sheet moved to the detail page (pages/knowledge), and its actions
// live here so any page about a point can use them.
//
// `page` is the calling page; these read and write its data:
//   busy, fail                      one action at a time, and its error line
//   stuckOpen, stuckText, stuckChoice, stuckReply, stuckSuggestName, stuckBusy,
//   stuckWait, stuckLost, stuckFallback the 卡住了 sheet (V4.2: the help is kept on
//                                   the server, GET …/stuck, and read again
//                                   after leaving; closing the sheet keeps it)
// `point` is { id, name, stuck, self }; `page.refresh` reads the point again
// after a mark. A guest is asked first (gate.ask) and nothing is sent.
const api = require("./api");
const auth = require("./auth");
const gate = require("./gate");
const { errorText } = require("./format");
const { openAsk } = require("./chat-entry");

const TONE = "light";
// The detail page is about a concept, not one problem.
const STUCK_OPTIONS = ["概念没懂", "条件没分清", "这一步不明白"];
const STUCK_CLOSED = {
  stuckOpen: false,
  stuckText: "",
  stuckChoice: "",
  stuckReply: null,
  stuckSuggestName: "",
  stuckWait: 0,
  stuckLost: false,
  stuckFallback: false,
};
// The server gives the model up to 120 s; the page waits a little longer,
// then reads the kept help every few seconds until it is there.
const STUCK_TIMEOUT = 130000;
const STUCK_POLL = 4000;
const STUCK_POLLS = 40;
// The conversation 接着聊 opened for this help, so a second tap goes back to
// it instead of starting another.
const THREAD_KEY = "stuck_thread:";

function guest() {
  return gate.state() === "guest";
}
// A reply belongs to the account and the page that asked.
function owned(page) {
  const owner = (auth.getUser() || {}).id;
  return () =>
    page.alive !== false &&
    !page.unloaded &&
    auth.hasConsent() &&
    owner === (auth.getUser() || {}).id;
}
// 我会了 / 其实还没会 / 现在懂了: one mark, then the point is read again.
function markPoint(page, point, action) {
  if (!point || page.data.busy) return Promise.resolve();
  if (guest()) return Promise.resolve(gate.ask());
  const active = owned(page);
  page.setData({ busy: true, fail: "" });
  return api
    .post("/v1/learn/marks", { action, pointId: point.id })
    .then(() => {
      if (active() && typeof page.refresh === "function") return page.refresh();
    })
    .catch((error) => {
      if (active() && !api.needsConsent(error)) page.setData({ fail: errorText(error) });
    })
    .finally(() => {
      if (active()) page.setData({ busy: false });
    });
}
function toggleSelf(page, point) {
  return markPoint(page, point, point && point.self ? "unself" : "self");
}
// 问一问 (mode guide, opens 解题) and 讲一遍 (mode teach, pages/teach, G5).
function startChat(page, point, mode, text) {
  if (!point || page.data.busy) return Promise.resolve();
  if (guest()) return Promise.resolve(gate.ask());
  // 讲一遍 opens its own page on this point; the chat is made there
  // on the first sentence, with the point's key points behind 小狸's questions.
  if (mode === "teach") {
    wx.navigateTo({ url: `/pages/teach/index?pointId=${encodeURIComponent(point.id)}&name=${encodeURIComponent(point.name || "")}` });
    return Promise.resolve();
  }
  const active = owned(page);
  page.setData({ busy: true, fail: "" });
  return api
    .post("/v1/chat/threads", {
      mode,
      pointId: point.id,
      tone: TONE,
      ...(text ? { text } : {}),
      // 问 AI about a point opens on 解题 and is listed there.
      origin: "solve",
    })
    .then(({ thread }) => {
      if (!active()) return;
      openAsk({ threadId: thread.id });
    })
    .catch((error) => {
      if (active() && !api.needsConsent(error)) page.setData({ fail: errorText(error) });
    })
    .finally(() => {
      if (active()) page.setData({ busy: false });
    });
}
// 记一张卡, or 把这个问题记下来 with what the student said.
function collectCard(point, quote) {
  if (!point) return;
  if (guest()) return gate.ask();
  const said = String(quote || "").trim();
  getApp().globalData.collect = {
    mode: "message",
    origin: "map",
    scene: "study",
    type: "question",
    mine: "",
    quote: said,
    quotes: said ? [said] : [],
    pointId: point.id,
    pointName: point.name,
  };
  wx.navigateTo({ url: "/pages/collect/index" });
}
function openCard(id) {
  if (id) wx.navigateTo({ url: `/pages/card/index?id=${encodeURIComponent(id)}` });
}
// 我的卡: the 卡片 tab, filtered to this point.
function openCards(point) {
  if (!point) return;
  getApp().globalData.cardFilter = { pointId: point.id, pointName: point.name };
  wx.switchTab({ url: "/pages/deck/index" });
}
function openMistakes(point) {
  if (point)
    wx.navigateTo({ url: `/pages/mistakes/index?pointId=${encodeURIComponent(point.id)}` });
}
// 卡住了 opens the sheet (nothing is marked until the student sends). On a
// point already stuck it is 接着解决卡点: the sheet opens on the help kept for
// it; 现在懂了 is its own button (understood).
function openStuck(page, point) {
  if (!point) return;
  if (guest()) return gate.ask();
  if (page.data.stuckReply || page.data.stuckBusy) return page.setData({ stuckOpen: true });
  page.setData({ ...STUCK_CLOSED, stuckOpen: true });
  if (point.stuck) return loadStuck(page, point);
}
// Closing only hides the sheet: it is not 懂了, and the reply stays.
function closeStuck(page) {
  page.setData({ stuckOpen: false });
}
// 现在懂了: the mark goes, and with it the kept help.
function understood(page, point) {
  stopStuck(page);
  return markPoint(page, point, "unstuck").then(() => {
    if (page.data.fail) return;
    try {
      wx.removeStorageSync(THREAD_KEY + point.id);
    } catch (error) {}
    page.setData({ ...STUCK_CLOSED, stuckBusy: false });
  });
}
function stopStuck(page) {
  clearInterval(page.stuckClock);
  clearTimeout(page.stuckPoll);
  page.stuckClock = null;
  page.stuckPoll = null;
}
// Seconds since sending, on the sheet while 小狸 thinks.
function tick(page, since) {
  clearInterval(page.stuckClock);
  page.stuckClock = setInterval(() => {
    if (page.unloaded) return stopStuck(page);
    page.setData({ stuckWait: Math.floor((Date.now() - since) / 1000) });
  }, 1000);
}
// The help kept for this 卡住了: ready shows it, running waits for it, failed
// keeps what the student wrote to send again.
function loadStuck(page, point, nameOf, tries = 0, since = Date.now()) {
  const active = owned(page);
  return api
    .get(`/v1/learn/points/${encodeURIComponent(point.id)}/stuck`)
    .then(({ help }) => {
      if (!active()) return;
      if (!help) return page.setData({ stuckBusy: false, stuckLost: false });
      if (help.status === "ready" && help.reply) {
        stopStuck(page);
        return page.setData({
          stuckBusy: false,
          stuckLost: false,
          stuckText: help.text,
          stuckReply: help.reply,
          stuckSuggestName:
            (help.reply.suggest && nameOf && nameOf(help.reply.suggest)) || "",
        });
      }
      if (help.status === "running" && tries < STUCK_POLLS) {
        if (!page.stuckClock) tick(page, Date.parse(help.at) || since);
        page.setData({ stuckBusy: true, stuckText: help.text });
        page.stuckPoll = setTimeout(
          () => loadStuck(page, point, nameOf, tries + 1, since),
          STUCK_POLL,
        );
        return;
      }
      stopStuck(page);
      page.setData({ stuckBusy: false, stuckText: help.text, stuckLost: true });
    })
    .catch((error) => {
      if (!active() || api.needsConsent(error)) return;
      stopStuck(page);
      page.setData({ stuckBusy: false, fail: errorText(error) });
    });
}
// Sends what the student is stuck on: the point is marked stuck and the AI
// asks one question back (with 2–3 answers to tap), maybe pointing at a
// point to look at first. `nameOf(id)` names that point.
function sendStuck(page, point, nameOf) {
  const text = String(page.data.stuckText || "").trim();
  if (!point || !text || page.data.stuckBusy) return Promise.resolve();
  const active = owned(page);
  const since = Date.now();
  page.setData({ stuckBusy: true, stuckWait: 0, stuckLost: false, stuckFallback: false, fail: "" });
  tick(page, since);
  let waiting = false;
  return api
    .post(`/v1/learn/points/${encodeURIComponent(point.id)}/stuck`, { text }, { timeout: STUCK_TIMEOUT })
    .then((reply) => {
      if (!active()) return;
      if (reply.crisis) return wx.navigateTo({ url: "/pages/crisis/index" });
      // The server's stand-in when the AI failed (not charged, not help used):
      // keep what the student wrote and ask for one more tap.
      if (reply.fallback) page.setData({ stuckFallback: true });
      else
        page.setData({
          stuckReply: reply,
          stuckSuggestName: (reply.suggest && nameOf && nameOf(reply.suggest)) || "",
        });
      if (typeof page.refresh === "function") page.refresh();
    })
    .catch((error) => {
      if (!active() || api.needsConsent(error)) return;
      // Gave up waiting or lost the line: the server may still be on it.
      if (error.code === "NETWORK") {
        waiting = true;
        return loadStuck(page, point, nameOf, 0, since);
      }
      page.setData({ fail: errorText(error) });
      if (typeof page.refresh === "function") page.refresh();
    })
    .finally(() => {
      if (waiting || !active()) return;
      stopStuck(page);
      page.setData({ stuckBusy: false });
    });
}
// 接着聊 and the answers to tap: one conversation that starts from the whole
// 卡点 (what the student said, 小狸's hint and question, the answer picked).
function stuckContext(point, text, reply, choice) {
  const lines = [`我在「${point.name}」卡住了：${text}`];
  if (reply && reply.hint) lines.push(`小狸的提示：${reply.hint}`);
  if (reply && reply.ask) lines.push(`小狸问：${reply.ask}`);
  if (choice) lines.push(`我的回答：${choice}`);
  return lines.join("\n");
}
function continueStuck(page, point, choice) {
  if (!point || page.data.busy) return Promise.resolve();
  if (guest()) return Promise.resolve(gate.ask());
  const text = String(page.data.stuckText || "").trim();
  let kept = null;
  try {
    kept = wx.getStorageSync(THREAD_KEY + point.id) || null;
  } catch (error) {}
  // The same help: back to its conversation.
  if (kept && kept.threadId && kept.text === text) {
    openAsk({ threadId: kept.threadId });
    return Promise.resolve();
  }
  const active = owned(page);
  page.setData({ busy: true, fail: "" });
  return api
    .post("/v1/chat/threads", {
      mode: "guide",
      pointId: point.id,
      tone: TONE,
      text: stuckContext(point, text, page.data.stuckReply, choice),
      origin: "solve",
    })
    .then(({ thread }) => {
      if (!active()) return;
      try {
        wx.setStorageSync(THREAD_KEY + point.id, { threadId: thread.id, text });
      } catch (error) {}
      openAsk({ threadId: thread.id });
    })
    .catch((error) => {
      if (active() && !api.needsConsent(error)) page.setData({ fail: errorText(error) });
    })
    .finally(() => {
      if (active()) page.setData({ busy: false });
    });
}

module.exports = {
  TONE,
  STUCK_OPTIONS,
  STUCK_CLOSED,
  markPoint,
  toggleSelf,
  startChat,
  collectCard,
  openCard,
  openCards,
  openMistakes,
  openStuck,
  closeStuck,
  sendStuck,
  understood,
  stopStuck,
  loadStuck,
  continueStuck,
  stuckContext,
};

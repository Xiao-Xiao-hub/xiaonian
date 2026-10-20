/*
 * 聊一聊标签页：复用 utils/chat-room 的会话行为，保留本页自己的布局与标签页导航。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
// 聊一聊 : the tab is the chat itself (utils/chat-room.js, shared
// with pages/chat). Before a chat is open it shows the last unfinished chat
// to go on with (接着聊 / 开新话题, once per chat) and the three latest chats
// as chips above the input; the clock at the top right opens all of them
// (pages/chat-history). Solving lives on its own page (解题, opened from 学习):
// its conversations are not listed here (GET /v1/chat/threads?kind=chat).
const api = require("../../utils/api");
const auth = require("../../utils/auth");
const gate = require("../../utils/gate");
const studyClock = require("../../utils/study-clock");
const room = require("../../utils/chat-room");
const { errorText } = require("../../utils/format");
const { unmark, plainAll } = require("../../utils/blocks");

const owner = () => (auth.getUser() || {}).id || "";
// The replay asked about once per chat (and again only after something new was said).
const SEEN = "zhiye_talk_replay_seen";
const CHIP_CHARS = 8;
// On a tab page the keyboard also covers the tab bar, which the page does not
// reach; the input rises by the rest.
function tabGap() {
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    return Math.max(0, Math.round(info.screenHeight - info.windowHeight));
  } catch (_) {
    return 0;
  }
}
// Short chip titles, cut by code point (no half emoji).
function chipTitle(title) {
  const chars = Array.from(String(title || "对话"));
  return chars.length > CHIP_CHARS ? `${chars.slice(0, CHIP_CHARS).join("")}…` : chars.join("");
}
function seen() {
  try {
    return wx.getStorageSync(`${SEEN}:${owner()}`) || {};
  } catch (_) {
    return {};
  }
}
function markSeen(item) {
  try {
    const all = seen();
    all[item.id] = item.lastAt || "";
    wx.setStorageSync(`${SEEN}:${owner()}`, all);
  } catch (_) {
    /* Asked again next time. */
  }
}
// What a message carried when it has no words: （图片）, or （文件） and its name.
function carried(m) {
  const list = Array.isArray(m.attachments) ? m.attachments : [];
  const files = list.filter((a) => a && a.kind !== "image").map((a) => `（文件）${a.name || ""}`);
  return (list.some((a) => a && a.kind === "image") ? ["（图片）"] : []).concat(files).join(" ");
}
// A message of the replay, as one short line (no bold, heading, list or $
// marks), or null when it has nothing to show. V4.2 FX5b : the server
// sends the learner's words as `plain` and replies as blocks, not `content`.
function line(m) {
  const raw = m.role === "user" ? m.plain || m.content || plainAll(m.blocks) : plainAll(m.blocks) || m.content || "";
  const text = unmark(String(raw || ""))
    .replace(/\*\*|__|`|\$/g, "")
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(text);
  const shown = chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : text || carried(m);
  return shown ? { id: m.id, mine: m.role === "user", text: shown } : null;
}

const base = room({ tab: true });

Page(
  studyClock.track({
    ...base,
    data: {
      ...base.data,
      guest: false,
      recent: [],
      replay: null,
      listLoaded: false,
      listError: "",
    },
    onLoad(options) {
      base.onLoad.call(this, options);
      this.gap = tabGap();
    },
    onShow() {
      if (!gate.check()) return;
      // 游客模式: the input only; nothing is asked of the server.
      if (gate.state() === "guest") {
        this.scope = "guest";
        return this.setData({ guest: true, consent: false, recent: [], replay: null, listLoaded: true, listError: "" });
      }
      const scope = `${owner()}#${auth.consentGeneration()}`;
      if (this.scope !== scope) {
        // Another account (or consent given again): nothing of the last one stays.
        this.scope = scope;
        this.nextOpen();
        this.setData({ guest: false, loading: false, thread: null, messages: [], pending: [], actions: [], draft: "", recent: [], replay: null, listLoaded: false, listError: "" });
      }
      base.onShow.call(this);
      this.loadRecent();
    },
    // The chips and the replay: the latest chats, newest first.
    loadRecent() {
      if (!this.data.consent) return Promise.resolve();
      const scope = this.scope;
      const version = (this.version || 0) + 1;
      this.version = version;
      return api
        .get("/v1/chat/threads?kind=chat&limit=12")
        .then(({ threads }) => {
          if (scope !== this.scope || version !== this.version) return;
          const list = threads || [];
          const recent = list.slice(0, 3).map((t) => ({ id: t.id, title: chipTitle(t.title) }));
          this.setData({ recent, listLoaded: true, listError: "" });
          const asked = seen();
          const open = list.find((t) => t.unfinished && asked[t.id] !== (t.lastAt || ""));
          if (!open) return this.setData({ replay: null });
          if (this.data.replay && this.data.replay.id === open.id) return;
          return api.get(`/v1/chat/threads/${encodeURIComponent(open.id)}?tone=light`).then(({ messages }) => {
            if (scope !== this.scope || version !== this.version) return;
            const said = (messages || []).filter((m) => (m.role === "user" || m.role === "assistant") && !m.crisis);
            this.setData({
              replay: { id: open.id, title: open.title || "对话", lastAt: open.lastAt || "", lines: said.map(line).filter(Boolean).slice(-3) },
            });
          });
        })
        .catch((error) => {
          if (scope === this.scope && !api.needsConsent(error))
            this.setData({ listLoaded: true, listError: errorText(error) });
        });
    },
    // 接着聊: the chat opens here; 开新话题: it is not asked about again.
    replayGo() {
      const replay = this.data.replay;
      if (!replay) return;
      markSeen(replay);
      this.setData({ replay: null });
      this.open(replay.id);
    },
    replayNew() {
      const replay = this.data.replay;
      if (replay) markSeen(replay);
      this.setData({ replay: null, focus: true });
    },
    openRecent(event) {
      if (this.data.guest) return gate.ask();
      const id = event.currentTarget.dataset.id;
      if (this.data.replay && this.data.replay.id === id) markSeen(this.data.replay);
      this.setData({ replay: null });
      this.open(id);
    },
    // Not while a reply is still coming : it belongs to this chat.
    openHistory() {
      if (this.data.guest) return gate.ask();
      if (this.data.sending) return;
      wx.navigateTo({ url: "/pages/chat-history/index" });
    },
    newTopic() {
      base.newTopic.call(this);
      this.loadRecent();
    },
    // A guest taps the input, ＋ or send: ask to agree first.
    guestTap() {
      gate.ask();
    },
  }),
);

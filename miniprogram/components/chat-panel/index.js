const chat = require("../../utils/chat-v2");
const { plainAll, unmark } = require("../../utils/blocks");
const { copyAi } = require("../../utils/copy");
// 对话共用展示片段。 The page picks
// one with `part`:
//   header   — mood offer, cards carried along (a tap opens one), related cards
//              (folded), break note
//   messages — compact bubbles (pages/chat, with compact); "在想…" until a reply
//              starts, "＋ 存成卡" under the newest finished reply, a long press
//              on any other bubble
//   related  — only the related cards (folded); 聊一聊 puts it under the newest
//              reply, the header keeps it for the other pages
//   teach    — "存成我的话" under one reply (pass `message`)
//   actions  — up to three chips, "更多 ›", "先放着", and the offer to store the chat
// The line quoting the user ("你自己说出了「…」") is gone; 聊一聊
// offers "记下刚才那句" as a chip instead.
// The header has no scene picker or 收尾: the page's "⋯" holds those.
// Events (detail in brackets): moodaccept, mooddecline, removecard {id},
// suggestadd {id}, suggestdismiss {id}, collect {id}, spot {id},
// teachsave {id, quote}, teachchange {id}, teachpick {id, quote}, mistake {id},
// action {key, value} (a chip, or one picked under 更多; key "park" is 先放着),
// wrap (聊得差不多了？存成一张卡), attachmore {key} (接着读后面).
Component({
  properties: {
    part: { type: String, value: "header" },
    thread: { type: Object, value: null },
    messages: { type: Array, value: [] },
    actions: { type: Array, value: [] },
    suggestions: { type: Array, value: [] },
    sceneCandidate: { type: Boolean, value: false },
    // Show "聊得差不多了？存成一张卡"; the page decides when, once per chat.
    wrapDue: { type: Boolean, value: false },
    // While a reply is written the chip row keeps its place, empty.
    sending: { type: Boolean, value: false },
    compact: { type: Boolean, value: false },
    breakReminder: { type: String, value: "" },
    message: { type: Object, value: null },
  },
  data: {
    row: { shown: [], more: [], park: null },
    collectId: "",
    suggestOpen: false,
  },
  observers: {
    actions(list) {
      this.setData({ row: chat.layout(list) });
    },
    messages(list) {
      this.setData({ collectId: chat.collectTarget(list) });
    },
    // Another chat starts with its related cards folded again.
    "thread.id"(id) {
      if (id !== this.threadId) {
        this.threadId = id;
        if (this.data.suggestOpen) this.setData({ suggestOpen: false });
      }
    },
  },
  lifetimes: {
    attached() {
      this.setData({
        row: chat.layout(this.data.actions),
        collectId: chat.collectTarget(this.data.messages),
      });
    },
  },
  methods: {
    // A card carried along opens on tap, back to the card (20-chat).
    openCard(e) {
      const id = e.currentTarget.dataset.id;
      if (id) wx.navigateTo({ url: `/pages/card/index?id=${encodeURIComponent(id)}` });
    },
    event(e) {
      this.triggerEvent(e.currentTarget.dataset.event, e.currentTarget.dataset);
    },
    wrap() {
      this.triggerEvent("wrap");
    },
    // "接着读后面" under a long document.
    attachMore(e) {
      this.triggerEvent("attachmore", e.detail);
    },
    toggleSuggest() {
      this.setData({ suggestOpen: !this.data.suggestOpen });
    },
    more() {
      const items = this.data.row.more;
      if (!items.length) return;
      wx.showActionSheet({
        itemList: items.map((item) => item.text),
        success: ({ tapIndex }) => {
          const item = items[tapIndex];
          if (item)
            this.triggerEvent("action", { key: item.key, value: item.value });
        },
      });
    },
    // An older bubble: store it as a card, put it in 错题本, or copy it.
    hold(e) {
      const id = e.currentTarget.dataset.id;
      const message = this.data.messages.find((item) => item.id === id);
      // Not yet on the server (local_/wait_ ids), or still being written.
      if (!message || message.status !== "done" || /^(local|wait)_/.test(id))
        return;
      const text = plainAll(message.blocks) || unmark(message.content || "");
      if (!text) return;
      const items = chat.holdItems(message, this.data.thread);
      wx.showActionSheet({
        itemList: items,
        success: ({ tapIndex }) => {
          const item = items[tapIndex];
          if (item === "存成卡") return this.triggerEvent("collect", { id });
          if (item === "收进错题本") return this.triggerEvent("mistake", { id });
          // AI replies are copied with "（AI 生成）" at the end; my own words as they are.
          if (item === "复制")
            return message.role === "assistant"
              ? copyAi(text).catch(() => {})
              : wx.setClipboardData({ data: text });
        },
      });
    },
  },
});

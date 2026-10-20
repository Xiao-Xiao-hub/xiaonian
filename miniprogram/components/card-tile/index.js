const { view } = require("../../utils/cards");
// A card on the wall (v4 样张 10-notes): kind, title, one line with its colour
// marks and the stage word in the kind's own words (V4.2: no percentage). `picking` shows the round check
// box of 多选 on every card; `selected` fills it. `row` is the one-line block
// of the 卡片 tab and 随心记's 最近 : name, one line, the stage word.
Component({
  options: { addGlobalClass: true },
  properties: {
    card: { type: Object, value: {} },
    row: { type: Boolean, value: false },
    selected: { type: Boolean, value: false },
    picking: { type: Boolean, value: false },
    // 到期待回顾 : a small 待回顾 badge on the wall card; V4.2 only for
    // cards that are reviewed (follow review), not 待办 or 接着聊 ones.
    due: { type: Boolean, value: false },
  },
  observers: {
    card(value) {
      this.setData({ cardView: view(value || {}) });
    },
  },
  methods: {
    tap() {
      this.triggerEvent("tap", { card: this.data.cardView });
    },
    hold() {
      this.triggerEvent("longpress", { card: this.data.cardView });
    },
  },
});

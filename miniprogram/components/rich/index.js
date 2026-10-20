const { baseUrl } = require("../../utils/request");
const { plain, glueBlocks, stripTail } = require("../../utils/blocks");
// Category names shown when a colour mark is tapped.
const MARK_NAMES = { key: "重点", way: "方法", fx: "公式", warn: "易错" };
// Draws the content blocks the server sends (docs/api.md): paragraphs, lists,
// tables and formulas, which are PNGs sized in em so they follow the font size.
Component({
  options: { addGlobalClass: true },
  properties: {
    blocks: { type: Array, value: [] },
    // The paragraph still being written, as plain text (mark syntax hidden).
    tail: { type: String, value: "" },
    // Tapping a block offers to quote or copy it.
    tappable: { type: Boolean, value: false },
  },
  data: { base: "", broken: {}, retry: {}, view: [], tailText: "" },
  // What is drawn: a formula and the punctuation right after it never part.
  observers: {
    blocks(blocks) {
      this.setData({ view: glueBlocks(blocks) });
    },
    tail(tail) {
      this.setData({ tailText: stripTail(tail) });
    },
  },
  lifetimes: {
    attached() {
      this.setData({
        base: baseUrl().replace(/\/$/, ""),
        view: glueBlocks(this.data.blocks),
        tailText: stripTail(this.data.tail),
      });
    },
  },
  methods: {
    // A formula image that does not load is fetched once more (a weak network
    // drops a request now and then), then shows its TeX instead.
    onBroken(event) {
      const id = event.currentTarget.dataset.id;
      if (!id || this.data.broken[id]) return;
      if (!this.data.retry[id]) this.setData({ [`retry.${id}`]: true });
      else this.setData({ [`broken.${id}`]: true });
    },
    // A tapped mark says what kind it is; a tappable block handles the tap itself.
    onMark(event) {
      const name = MARK_NAMES[event.currentTarget.dataset.mk];
      if (name && !this.data.tappable) wx.showToast({ title: name, icon: "none", duration: 1000 });
    },
    onTap(event) {
      if (!this.data.tappable) return;
      const index = event.currentTarget.dataset.index;
      const block = this.data.blocks[index];
      if (block) this.triggerEvent("pick", { index, text: plain(block) });
    },
  },
});

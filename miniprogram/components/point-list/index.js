// The bank list : chapters of knowledge points, one row each with
// its section, tier, problem count and progress (utils/bank.js view).
// A tap on a row fires `pick` with { id, ready }; the page decides what to do.
// chapterId shows one chapter only ("" for all).
Component({
  options: { addGlobalClass: true },
  properties: {
    chapters: { type: Array, value: [] },
    chapterId: { type: String, value: "" },
    // V4.2 题库: a row of problem chips under each point; a tap fires `item`
    // with { id, index }. Other lists (讲一遍's picker) leave it off.
    showItems: { type: Boolean, value: false },
  },
  methods: {
    item(event) {
      const { id, index } = event.currentTarget.dataset;
      if (id) this.triggerEvent("item", { id, index: Number(index) });
    },
    pick(event) {
      const { id, ready } = event.currentTarget.dataset;
      if (id) this.triggerEvent("pick", { id, ready: Boolean(ready) });
    },
  },
});

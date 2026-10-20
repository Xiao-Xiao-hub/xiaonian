// The brainstorm report (v3): 关联 / 可以改进 / 可以拓展 / 建议, each line with
// the cards it came from. Takes the shape from brainstorm/view.js reportView.
Component({
  options: { styleIsolation: "apply-shared" },
  properties: {
    // null until the report is in; any type, so null does not warn.
    report: { type: null, value: null },
  },
  methods: {
    openCard(event) {
      const id = event.currentTarget.dataset.id;
      if (!id) return;
      wx.navigateTo({ url: `/pages/card/index?id=${encodeURIComponent(id)}` });
    },
  },
});

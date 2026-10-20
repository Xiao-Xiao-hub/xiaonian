// Taps : decided in gesture.wxs like the star map; pages/map/hit.js
// finds the box under the spot. The native taps stay as a fallback and
// hit.once lets one tap act once.
const hit = require("../../hit");

Component({
  // The landscape page styles the formulas and keys drawn by rich inside.
  options: { addGlobalClass: true },
  data: { left: 0, top: 0, pressed: "" },
  lifetimes: {
    ready() {
      this.createSelectorQuery()
        .select(".viewport")
        .boundingClientRect((rect) => {
          if (!rect) return;
          this.setData({ left: rect.left, top: rect.top });
          this.triggerEvent("ready", {
            width: rect.width,
            height: rect.height,
          });
        })
        .exec();
    },
  },
  properties: {
    view: { type: String, value: "task" },
    layout: { type: Object, value: null },
    motion: { type: String, value: "0,0,.72,0" },
    landscape: { type: Boolean, value: false },
    // Zoomed in: each point shows its first formula and key.
    detail: { type: Boolean, value: false },
  },
  methods: {
    gestureStart() {
      this.triggerEvent("dragging", { dragging: true });
    },
    gestureSettle(detail) {
      // Not a tap in the WXS (a drag, a long press, a pinch, a cancel): the
      // native tap that may follow is ignored too.
      this.ignoreTapUntil = detail.moved || detail.tap === false ? Date.now() + 180 : 0;
      this.triggerEvent("dragging", { dragging: false });
      this.triggerEvent("settle", detail);
    },
    gesturePress(spot) {
      const found = spot && spot.s ? hit.stage(this.data.layout, this.data.view, spot) : null;
      const pressed = found ? found.id : "";
      if (pressed !== this.data.pressed) this.setData({ pressed });
    },
    gestureTap(spot) {
      this.gesturePress({});
      const found = hit.stage(this.data.layout, this.data.view, spot);
      if (!found || !hit.once(this)) return;
      if (found.kind === "group") this.triggerEvent("group", { id: found.id, group: found.group });
      else this.triggerEvent("node", { id: found.id });
    },
    nodeTap(event) {
      if (Date.now() < (this.ignoreTapUntil || 0) || !hit.once(this)) return;
      this.triggerEvent("node", event.currentTarget.dataset);
    },
    groupTap(event) {
      if (Date.now() < (this.ignoreTapUntil || 0) || !hit.once(this)) return;
      this.triggerEvent("group", event.currentTarget.dataset);
    },
  },
});

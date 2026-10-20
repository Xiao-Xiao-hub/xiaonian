// The v4 star map stage: one plane with the star layer (far) and the card
// layer (near), panned and pinched by the same WXS gesture as the old stage.
// Layout comes from pages/map/stars.js.
//
// Taps : the WXS gesture decides a tap and calls gestureTap with the
// spot; pages/map/hit.js finds the star, card or 练一题 under it. The native
// taps stay as a fallback; hit.once lets one tap act once.
const hit = require("../../hit");

Component({
  options: { addGlobalClass: true },
  data: { left: 0, top: 0, pressed: "", pressAct: "" },
  properties: {
    layout: { type: Object, value: null },
    motion: { type: String, value: "0,0,.4348,0" },
  },
  lifetimes: {
    ready() {
      this.createSelectorQuery()
        .select(".viewport")
        .boundingClientRect((rect) => {
          if (!rect) return;
          this.setData({ left: rect.left, top: rect.top });
          this.triggerEvent("ready", { width: rect.width, height: rect.height });
        })
        .exec();
    },
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
    tapped() {
      return Date.now() < (this.ignoreTapUntil || 0);
    },
    // The finger is down (spot) or has moved off / lifted ({}): mark what is
    // under it so it looks pressed at once.
    gesturePress(spot) {
      const found = spot && spot.s ? hit.sky(this.data.layout, spot) : null;
      const pressed = found ? found.id : "",
        pressAct = found ? found.act : "";
      if (pressed !== this.data.pressed || pressAct !== this.data.pressAct)
        this.setData({ pressed, pressAct });
    },
    gestureTap(spot) {
      this.gesturePress({});
      const found = hit.sky(this.data.layout, spot);
      if (found) this.fire(found.act, found.id);
    },
    fire(act, id) {
      if (!id || !hit.once(this)) return;
      this.triggerEvent(act === "practice" ? "practice" : "node", { id });
    },
    starTap(event) {
      if (!this.tapped()) this.fire("node", event.currentTarget.dataset.id);
    },
    practiceTap(event) {
      if (!this.tapped()) this.fire("practice", event.currentTarget.dataset.id);
    },
  },
});

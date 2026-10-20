// Page head for pages with "navigationStyle": "custom": a big left-aligned title with the blue highlighter line, a slot to its
// right, and room on the right for WeChat's capsule. See README.md.

// The native bar row lines up with the capsule: as tall as the capsule plus the
// same gap above and below it.
function layout() {
  let info = null;
  let capsule = null;
  try {
    info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync();
  } catch (e) {
    info = null;
  }
  try {
    capsule = typeof wx.getMenuButtonBoundingClientRect === "function" ? wx.getMenuButtonBoundingClientRect() : null;
  } catch (e) {
    capsule = null;
  }
  const width = (info && info.windowWidth) || 375;
  const statusTop = (info && info.statusBarHeight) || 20;
  if (!capsule || !capsule.height || !capsule.top) {
    return { statusTop, rowHeight: 44, rightGap: 104 };
  }
  const gap = Math.max(4, capsule.top - statusTop);
  return {
    statusTop,
    rowHeight: capsule.height + gap * 2,
    rightGap: Math.max(16, width - capsule.left + 12),
  };
}

Component({
  options: { addGlobalClass: true, multipleSlots: false },
  properties: {
    title: { type: String, value: "" },
    // "" | blue | yellow | mint | slate: a soft colour wash fading into the page.
    tint: { type: String, value: "" },
  },
  data: { statusTop: 20, rowHeight: 44, rightGap: 104, tintHeight: 280 },
  lifetimes: {
    attached() {
      const box = layout();
      this.setData({ ...box, tintHeight: box.statusTop + box.rowHeight + 236 });
    },
  },
});

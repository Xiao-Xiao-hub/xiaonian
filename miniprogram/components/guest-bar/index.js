// 游客模式提示条. Put <guest-bar /> at the top
// of a page; it shows itself only while gate.state is "guest" and checks again
// every time the page shows. 去同意 opens the welcome page.
const gate = require("../../utils/gate");
Component({
  options: { addGlobalClass: true },
  data: { guest: false },
  lifetimes: {
    attached() {
      this.refresh();
    },
  },
  pageLifetimes: {
    show() {
      this.refresh();
    },
  },
  methods: {
    refresh() {
      const guest = gate.state() === "guest";
      if (guest !== this.data.guest) this.setData({ guest });
    },
    agree() {
      wx.reLaunch({ url: "/pages/welcome/index" });
    },
  },
});

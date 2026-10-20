// The start of a study tool : its icon, name and one line, then
// 拍照 and 相册 (unless photo is false). A page puts its typing box (if any) in the slot.
const { asset } = require("../../utils/assets");
Component({
  options: { addGlobalClass: true },
  properties: {
    icon: { type: String, value: "" },
    title: { type: String, value: "" },
    lede: { type: String, value: "" },
    // 讲一遍 takes no photo.
    photo: { type: Boolean, value: true },
  },
  data: { src: "", broken: false },
  observers: {
    icon(name) {
      this.setData({ src: name ? asset(name) : "", broken: false });
    },
  },
  methods: {
    camera() {
      this.triggerEvent("pick", { source: "camera" });
    },
    album() {
      this.triggerEvent("pick", { source: "album" });
    },
    broken() {
      this.setData({ broken: true });
    },
  },
});

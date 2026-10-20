const api = require("../../utils/api");
// Attachments of a chat message, or the ones waiting to be sent.
//   items     — chat-v2 attachItem / attachView shapes
//   removable — the tray above the input: each has a ×, fires remove {key}
// A photo opens in the preview; a document is a block with its name and size,
// opened with wx.openDocument while this phone still has it. A failed
// upload fires retry {key} when tapped; "接着读后面" fires more {key}.
// Photos already sent are downloaded once (they need the Authorization header).
const cache = {};
Component({
  properties: {
    items: { type: Array, value: [] },
    removable: { type: Boolean, value: false },
    right: { type: Boolean, value: false },
  },
  data: { shown: [] },
  observers: {
    items(list) {
      this.show(list);
    },
  },
  lifetimes: {
    detached() {
      this.gone = true;
    },
  },
  methods: {
    show(list) {
      const shown = (list || []).map((item) => ({
        ...item,
        path: item.path || (item.imageId && cache[item.imageId]) || "",
      }));
      this.setData({ shown });
      shown.forEach((item) => {
        if (item.kind !== "image" || item.path || !item.imageId) return;
        api
          .download(`/v1/chat/images/${encodeURIComponent(item.imageId)}`, "图片")
          .then((path) => {
            cache[item.imageId] = path;
            if (this.gone) return;
            const i = this.data.shown.findIndex((x) => x.imageId === item.imageId);
            if (i >= 0) this.setData({ [`shown[${i}].path`]: path });
          })
          .catch(() => {});
      });
    },
    open(e) {
      const key = e.currentTarget.dataset.key;
      const item = this.data.shown.find((x) => x.key === key);
      if (!item) return;
      if (item.status === "failed") return this.triggerEvent("retry", { key });
      if (item.status === "up") return;
      if (item.kind !== "image") {
        if (!item.path)
          return wx.showToast({ title: "原文件不在这台手机上", icon: "none" });
        const type = (/\.([A-Za-z0-9]+)$/.exec(item.name) || [])[1];
        // txt and md are not opened by the system viewer.
        if (!type || !["pdf", "docx", "doc"].includes(type.toLowerCase()))
          return wx.showToast({ title: "这种文件不能预览", icon: "none" });
        return wx.openDocument({
          filePath: item.path,
          fileType: type.toLowerCase(),
          showMenu: true,
          fail: () => wx.showToast({ title: "打不开这份文件", icon: "none" }),
        });
      }
      const urls = this.data.shown
        .filter((x) => x.kind === "image" && x.path)
        .map((x) => x.path);
      if (item.path) wx.previewImage({ urls, current: item.path });
    },
    more(e) {
      this.triggerEvent("more", { key: e.currentTarget.dataset.key });
    },
    remove(e) {
      this.triggerEvent("remove", { key: e.currentTarget.dataset.key });
    },
  },
});

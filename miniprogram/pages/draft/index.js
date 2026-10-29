const { withShare } = require("../../utils/share");
/*
 * 草稿批改旧入口：仅把已有会话 id 转交给统一的 grade 批改页；保留旧链接兼容。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
// 批改草稿 is part of 批改 now (pages/grade). Kept for old links:
// it opens the same one there (?id=), or the start.
Page(withShare({
  onLoad(query) {
    const id = query && query.id;
    wx.redirectTo({ url: `/pages/grade/index${id ? `?id=${encodeURIComponent(id)}` : ""}` });
  },
}));

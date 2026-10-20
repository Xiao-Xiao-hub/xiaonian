/*
 * 危机求助页：展示求助与紧急联系入口；不继续普通对话引导，不作专业医疗判断。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
Page({
  callHotline() {
    wx.makePhoneCall({ phoneNumber: "12356" });
  },
  // V4.2 : 110 and 120 are tapped to call too.
  call(e) {
    const phone = e.currentTarget.dataset.phone;
    if (phone === "110" || phone === "120") wx.makePhoneCall({ phoneNumber: phone });
  },
  continueChat() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    // Opened with nothing under it: back to 聊一聊.
    wx.switchTab({ url: "/pages/talk/index" });
  },
});

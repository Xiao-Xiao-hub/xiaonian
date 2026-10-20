/*
 * 复制内容：整理可复制的文字并保留AI内容标记，使用微信剪贴板接口。
 * 用户原话和生成内容按不同来源处理，避免复制后失去内容来源提示。
 */
// Copying AI-written text adds "（AI 生成）" at the end (《人工智能生成合成内容标识办法》
// 第四条, 用户协议 6.5). Pass plain text: strip colour marks first with
// plain / unmark from utils/blocks.js.
const MARK = "（AI 生成）";
function copyAi(text) {
  const body = String(text || "").trimEnd();
  return new Promise((resolve, reject) =>
    wx.setClipboardData({
      data: body.endsWith(MARK) ? body : `${body}${MARK}`,
      success: resolve,
      fail: reject,
    }),
  );
}
module.exports = { copyAi, MARK };

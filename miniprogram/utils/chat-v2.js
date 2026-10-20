/*
 * 对话展示辅助：将会话、附件和引导动作转换成页面可展示或可跳转的数据。
 * 由对话页调用；保留服务端来源与状态，不在展示转换时擅自确认或生成业务结果。
 */
const SCENES = { study: "学习", life: "生活", mood: "心情" };
const TYPES = { spark: "灵感", idea: "想法", question: "问题", method: "思路" };

// The seven card kinds, by name.
function kindName(kind) {
  const types = require("./cards").TYPES;
  return (types[kind] && types[kind].name) || "";
}
function latestAssistant(messages) {
  return (
    (messages || [])
      .filter(
        (item) => item.role === "assistant" && item.status !== "streaming",
      )
      .pop() || null
  );
}
function actions(thread, messages, askPage, mathActions) {
  const last = latestAssistant(messages);
  if (!last || last.crisis) return [];
  const out = ((last.guide && last.guide.options) || [])
    .slice(0, thread && thread.scene === "study" ? 4 : 3)
    .map((text, index) => ({
      key: `guide-${index}`,
      text,
      ai: true,
      value: text,
    }));
  if (thread && thread.mode === "teach") {
    if (last.quote) return [];
    out.push({ key: "teachDone", text: "讲完了", primary: true });
    return out;
  }
  // 聊一聊 : the next steps come from what was said — store what
  // came up as the card kind it is, keep the sentence the user found, or stop
  // here. No fixed 我来说说 / 先放着 (typing is always there).
  if (!askPage) {
    const guide = last.guide || {};
    const card = guide.card || null;
    const kind = card && (kindName(card.kind) ? card.kind : card.type);
    if (card && card.title)
      out.push({ key: "card", text: `存成${kindName(kind) || "卡"}`, value: last.id });
    if (guide.spot) out.push({ key: "spot", text: "记下刚才那句", value: last.id });
    if (guide.end) out.push({ key: "end", text: "先聊到这儿" });
    return out;
  }
  // The ask page's own next steps: a problem's, or 举个例子 / 讲简单点 / 出题练.
  out.push(...(mathActions || []));
  if (!thread || !thread.problem) {
    // 直接说答案 is gone : the AI options above already cover it. The
    // server still takes mode "solution" from older clients.
    out.push(
      { key: "self", text: "我来说说" },
      { key: "park", text: "先放着" },
    );
  }
  if (askPage && thread && thread.problem && last.guide)
    out.push({ key: "park", text: "先放着" });
  return out;
}
// The row under a reply: at most three chips (the main action first, then
// two AI options), the rest behind "更多 ›", and 先放着 as a link at the end.
function layout(list) {
  const items = (list || []).filter((item) => item.key !== "park");
  const park = (list || []).find((item) => item.key === "park") || null;
  const primary = items.find((item) => item.primary) || null;
  const ai = items.filter((item) => item.ai && item !== primary);
  const plain = items.filter(
    (item) => !item.ai && !item.link && item !== primary,
  );
  const shown = (primary ? [primary] : [])
    .concat(ai.slice(0, 2), plain, ai.slice(2))
    .slice(0, 3);
  let more = ai
    .concat(
      plain,
      items.filter((item) => item.link && item !== primary),
    )
    .filter((item) => !shown.includes(item));
  // An action sheet holds six items; typing is always there.
  if (more.length > 6) more = more.filter((item) => item.key !== "self");
  return { shown, more: more.slice(0, 6), park };
}
// The long-press menu of a finished message. 收进错题本 only for a reply that
// worked through a problem (guided), or in a chat about a problem — but not a
// reply there about something else (guided false, not the full solution).
function holdItems(message, thread) {
  const mistake =
    message &&
    message.role === "assistant" &&
    (message.guided === true ||
      (Boolean(thread && thread.problem) &&
        !(message.guided === false && message.mode !== "solution")));
  return mistake ? ["存成卡", "收进错题本", "复制"] : ["存成卡", "复制"];
}
// The one reply that carries "＋ 存成卡": the newest finished AI reply.
function collectTarget(messages) {
  const last = (messages || [])
    .filter((item) => item.role === "assistant")
    .pop();
  if (!last || last.crisis || last.status !== "done") return "";
  // A judge counts once its verdict is in.
  const filled =
    last.kind === "judge"
      ? Boolean(last.attempt && last.attempt.result)
      : Boolean(
          (last.blocks && last.blocks.length) || last.content || last.similar,
        );
  return filled ? last.id : "";
}
function quotes(messages) {
  const seen = new Set(),
    out = [];
  for (const message of messages || []) {
    if (message.role !== "user" || message.crisis || message.guideChoice)
      continue;
    const text = String(message.plain || message.content || "").trim();
    for (const part of text
      .split(/[。！？!?\n]/)
      .map((value) => value.trim())
      .filter(Boolean)) {
      if (part.length >= 10 && !seen.has(part)) {
        seen.add(part);
        out.push(part.slice(0, 300));
      }
    }
  }
  return out.slice(-8);
}
// Four messages from the user, then the page offers once to store the chat.
function shouldOfferWrap(messages) {
  return (
    (messages || []).filter((item) => item.role === "user" && !item.crisis)
      .length >= 4
  );
}
// The wrap draft that collect handed back on 关闭, while nothing new was said.
function keptWrap(threadId, count) {
  const kept = getApp().globalData.collect;
  if (!kept || kept.mode !== "wrap" || kept.threadId !== threadId) return null;
  return kept.count === count ? kept : null;
}
function collectIntent(message, thread, guide) {
  const user = message && message.role === "user";
  return {
    mode: "message",
    threadId: thread.id,
    messageId: message.id,
    scene: thread.scene,
    quote: user ? message.plain || message.content || "" : "",
    mine: (guide && guide.spot) || "",
    pointId:
      thread.pointId ||
      (thread.mistake &&
        thread.mistake.mapPoint &&
        thread.mistake.mapPoint.id) ||
      "",
    mistakeId: (thread.mistake && thread.mistake.id) || "",
    sawAnswer: Boolean(thread.problem),
  };
}
function selectedIds(thread) {
  return ((thread && thread.currentCards) || []).map((card) => card.id);
}
function teachQuotes(messages, current) {
  const out = quotes(messages);
  const value = String(current || "")
    .trim()
    .slice(0, 300);
  if (value.length >= 10 && !out.includes(value)) out.push(value);
  return out;
}
function teachTarget(thread) {
  const cards = (thread && thread.currentCards) || [];
  return cards.length === 1 ? cards[0] : null;
}
function teachCollectIntent(message, thread, quote, messages) {
  return {
    ...collectIntent(message, thread, null),
    quote,
    mine: quote,
    quotes: teachQuotes(messages, quote),
  };
}

// ---- attachments  ------------------------------------------------------
// Photos and documents sent in a chat: picked here, uploaded one by one to
// POST /v1/chat/attachments, sent with attachmentIds. The limits are the
// server's; checking them here only saves a wasted upload.
const ATTACH_MAX = 4;
const IMAGE_MAX = 5 * 1024 * 1024;
const FILE_MAX = 10 * 1024 * 1024;
const FILE_EXT = ["txt", "md", "markdown", "docx", "pdf"];
// Photos the server takes (HEIC and GIF are not).
const IMAGE_EXT = ["jpg", "jpeg", "png"];
const SOURCES = ["拍照", "相册", "聊天里的文件"];
function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
}
function sizeText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}
// The short label on a file block.
function badge(name) {
  const ext = extOf(name);
  if (ext === "docx") return "DOC";
  if (ext === "markdown") return "MD";
  return ext ? ext.toUpperCase().slice(0, 4) : "文件";
}
// One line when a picked file cannot be sent; "" when it can.
function attachProblem(item) {
  if (item.kind === "image") {
    if (!IMAGE_EXT.includes(extOf(item.name))) return "只能发 JPG 或 PNG 图片";
    return item.size > IMAGE_MAX ? "图片超过 5 MB，换一张小一点的" : "";
  }
  if (!FILE_EXT.includes(extOf(item.name)))
    return "这种文件还打不开，换成 Word、PDF、TXT 或 MD 试试";
  return item.size > FILE_MAX ? "文件超过 10 MB，换一份小一点的" : "";
}
let seq = 0;
function attachItem({ kind, name, size, path }) {
  return {
    key: `a${Date.now().toString(36)}${(seq += 1)}`,
    kind,
    name: String(name || (kind === "image" ? "图片" : "文件")),
    size: Number(size) || 0,
    sizeText: sizeText(size),
    badge: kind === "image" ? "" : badge(name),
    path: path || "",
    status: "up",
  };
}
// A message's attachments as the page shows them; `paths` maps an attachment
// id to the photo already on this phone, so it is not downloaded again.
function attachView(list, paths) {
  return (Array.isArray(list) ? list : []).map((a) => ({
    key: a.id,
    id: a.id,
    kind: a.kind,
    name: a.name,
    size: a.size,
    sizeText: sizeText(a.size),
    badge: a.kind === "image" ? "" : badge(a.name),
    imageId: a.imageId || "",
    path: (paths && paths[a.id]) || "",
    status: "ok",
    ...readPart(a),
  }));
}
// A document longer than the server reads : which part was read and
// whether more is left, said on the block.
function readPart(a) {
  if (!a || a.kind !== "file" || !a.read) return { more: false, readText: "" };
  const from = Number(a.from) || 0,
    read = Number(a.read) || 0;
  const more = Boolean(a.truncated);
  if (!more && !from) return { more: false, readText: "" };
  return {
    from,
    read,
    more,
    readText: from
      ? `读了第 ${from + 1}–${from + read} 字${more ? "，后面还有" : "，读完了"}`
      : `只读了前 ${read} 字，后面还有`,
  };
}
// "拍照 / 相册 / 聊天里的文件"; resolves the index picked, or -1.
function chooseSource() {
  return new Promise((resolve) =>
    wx.showActionSheet({
      itemList: SOURCES,
      success: ({ tapIndex }) => resolve(tapIndex),
      fail: () => resolve(-1),
    }),
  );
}
// Resolves the files picked (attachItem shapes), [] on cancel; `fail` gets the
// picker's error (utils/pick pickFailed).
function pickAttachments(source, room, fail) {
  const count = Math.max(1, Math.min(ATTACH_MAX, room));
  return new Promise((resolve) => {
    const failed = (error) => {
      if (fail) fail(error);
      resolve([]);
    };
    if (source === 2)
      return wx.chooseMessageFile({
        count,
        type: "file",
        extension: ["txt", "md", "docx", "pdf"],
        success: ({ tempFiles }) =>
          resolve(
            (tempFiles || []).map((f) =>
              attachItem({ kind: "file", name: f.name, size: f.size, path: f.path }),
            ),
          ),
        fail: failed,
      });
    wx.chooseMedia({
      count,
      mediaType: ["image"],
      sourceType: [source === 0 ? "camera" : "album"],
      sizeType: ["compressed"],
      success: ({ tempFiles }) =>
        resolve(
          (tempFiles || []).map((f) => {
            const ext = extOf(f.tempFilePath) || "jpg";
            return attachItem({
              kind: "image",
              name: `图片.${ext}`,
              size: f.size,
              path: f.tempFilePath,
            });
          }),
        ),
      fail: failed,
    });
  });
}

module.exports = {
  SCENES,
  TYPES,
  latestAssistant,
  actions,
  layout,
  holdItems,
  collectTarget,
  quotes,
  shouldOfferWrap,
  keptWrap,
  collectIntent,
  selectedIds,
  teachQuotes,
  teachTarget,
  teachCollectIntent,
  ATTACH_MAX,
  sizeText,
  attachProblem,
  attachItem,
  attachView,
  readPart,
  kindName,
  chooseSource,
  pickAttachments,
};

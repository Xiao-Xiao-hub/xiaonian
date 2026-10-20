/*
 * 资料收录入口：选择文字或图片输入，保存后进入原文校对；草稿通过 utils/drafts 按账号保存。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const gate = require("../../utils/gate");
const { countChars, errorText } = require("../../utils/format");
const { pickFailed } = require("../../utils/pick");
const auth = require("../../utils/auth");
const { draftGet, draftSet } = require("../../utils/drafts");
const TEXT_LIMIT = 2000;
const IMAGE_LIMIT = 5 * 1024 * 1024;
Page({
  data: {
    kind: "note",
    mode: "image",
    image: "",
    text: "",
    answer: "",
    chars: 0,
    limit: TEXT_LIMIT,
    busy: false,
    error: "",
  },
  // V4 约定 4: no consent and no guest mode goes to the welcome page.
  onShow() {
    this.alive = true;
    if (!gate.check()) return;
  },
  onLoad(query) {
    const kind = query.kind === "problem" ? "problem" : "note";
    this.account = (auth.getUser() || {}).id || "";
    this.setData({ kind });
    wx.setNavigationBarTitle({ title: kind === "problem" ? "放一道题进来" : "学一份资料" });
    // what was typed comes back after leaving the page.
    const draft = draftGet(`capture:${kind}`, this.account);
    if (draft && (draft.text || draft.answer))
      this.setData({
        mode: "text",
        text: String(draft.text || ""),
        answer: String(draft.answer || ""),
        chars: countChars(draft.text || ""),
      });
  },
  onHide() {
    this.keepDraft();
  },
  // a result that comes back after the page was closed no longer
  // replaces whatever page is open now; the material is in 我的资料.
  onUnload() {
    this.alive = false;
    this.keepDraft();
  },
  keepDraft() {
    if (!this.account || this.sent) return;
    const { kind, text, answer } = this.data;
    draftSet(
      `capture:${kind}`,
      this.account,
      String(text || "").trim() || String(answer || "").trim() ? { text, answer } : null,
    );
  },
  // Long text, several pictures or a file go through 导入 (it keeps the text).
  openImport() {
    const text = String(this.data.text || "");
    const kept = this.account && draftGet("source", this.account);
    // pictures, a file or a send still waiting there stay as they
    // are (this text stays here); words there keep theirs, this goes after.
    const busy = kept && (kept.upload || kept.pending || (kept.files || []).length);
    const before = kept && !busy ? String(kept.text || "").replace(/\s+$/, "") : "";
    if (this.account && text.trim() && !busy && !before.includes(text.trim()))
      draftSet("source", this.account, {
        text: before ? `${before}\n\n${text}` : text,
        own: Boolean(before && kept.own),
        sourceType: "text",
        files: [],
        startPage: 1,
      });
    wx.navigateTo({ url: "/pages/import/source/index" });
  },
  useImage() {
    this.setData({ mode: "image", error: "" });
  },
  useText() {
    this.setData({ mode: "text", error: "" });
  },
  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      sizeType: ["compressed"],
      success: ({ tempFiles }) => {
        const file = tempFiles && tempFiles[0];
        if (!file) return;
        if (file.size > IMAGE_LIMIT) {
          this.setData({ error: "这张图有点大（5MB 以内），裁一下或换一张", image: "" });
          return;
        }
        this.setData({ image: file.tempFilePath, error: "" });
      },
      fail: pickFailed,
    });
  },
  previewImage() {
    if (this.data.image) wx.previewImage({ urls: [this.data.image] });
  },
  onText(event) {
    const text = event.detail.value;
    this.setData({ text, chars: countChars(text) });
  },
  onAnswer(event) {
    this.setData({ answer: event.detail.value });
  },
  submit() {
    const { kind, mode, image, text, answer, chars, busy } = this.data;
    if (busy) return;
    if (mode === "image" && !image) return this.setData({ error: "先选一张图" });
    if (mode === "text" && !chars) return this.setData({ error: "先写点内容" });
    if (mode === "text" && chars > TEXT_LIMIT)
      return this.setData({
        error:
          kind === "problem"
            ? `有 ${chars} 字，有点长了（${TEXT_LIMIT} 字以内）`
            : `有 ${chars} 字，超过 ${TEXT_LIMIT} 字的长资料用导入整理`,
      });
    this.setData({ busy: true, error: "" });
    const created =
      mode === "image"
        ? api.upload(kind, image).then((data) => data.material)
        : api.post("/v1/materials", {
            kind,
            text,
            ...(kind === "problem" && answer.trim() ? { answer: answer.trim() } : {}),
          });
    created
      .then((material) => {
        this.sent = true;
        draftSet(`capture:${kind}`, this.account, null);
        if (this.alive) wx.redirectTo({ url: `/pages/proofread/index?id=${material.id}` });
      })
      .catch((error) => {
        if (this.alive && !api.needsConsent(error)) this.setData({ error: errorText(error) });
      })
      .finally(() => this.alive && this.setData({ busy: false }));
  },
});

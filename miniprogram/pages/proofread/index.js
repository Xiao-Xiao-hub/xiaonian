/*
 * 原文校对页：等待识别任务，允许修订文字并确认材料版本，然后进入学习流程。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const gate = require("../../utils/gate");
const { countChars, errorText } = require("../../utils/format");
const TEXT_LIMIT = 2000;
Page({
  data: {
    id: "",
    loading: true,
    kind: "note",
    title: "",
    text: "",
    answer: "",
    chars: 0,
    limit: TEXT_LIMIT,
    version: 0,
    confirmed: false,
    heading: "看看认得对不对",
    extraOpen: false,
    loadFailed: false,
    hasImage: false,
    doubts: [],
    ocr: null,
    recognizing: false,
    busy: false,
    error: "",
  },
  // V4 约定 4: no consent and no guest mode goes to the welcome page.
  onShow() {
    if (!gate.check()) return;
  },
  onLoad(query) {
    this.alive = true;
    this.setData({ id: query.id });
    this.load();
  },
  onUnload() {
    this.alive = false;
  },
  load() {
    this.setData({ loading: true, error: "", loadFailed: false });
    return api
      .get(`/v1/materials/${this.data.id}`)
      .then((detail) => {
        const current = detail.current;
        const confirmed = detail.status === "confirmed";
        const heading = confirmed ? "改一改" : detail.hasImage ? "看看认得对不对" : "再看一眼";
        this.setData({
          kind: detail.kind,
          title: detail.title,
          text: current ? current.text : "",
          answer: (current && current.answer) || "",
          chars: current ? current.chars : 0,
          version: detail.version,
          confirmed,
          heading,
          // A reference answer given earlier stays in sight.
          extraOpen: this.data.extraOpen || Boolean(current && current.answer),
          hasImage: detail.hasImage,
          doubts: (current && current.doubts) || [],
          ocr: detail.ocr,
        });
        wx.setNavigationBarTitle({ title: heading });
        if (detail.ocr && api.pending({ status: detail.ocr.status }))
          this.waitOcr({ id: detail.ocr.jobId, status: detail.ocr.status });
      })
      .catch((error) => {
        if (!api.needsConsent(error)) this.setData({ error: errorText(error), loadFailed: true });
      })
      .finally(() => this.setData({ loading: false }));
  },
  toggleExtra() {
    this.setData({ extraOpen: !this.data.extraOpen });
  },
  waitOcr(job) {
    this.setData({ recognizing: true });
    api
      .waitJob(job, () => this.alive)
      .then(() => this.load())
      .catch((error) => {
        if (error.code !== "CANCELLED" && !api.needsConsent(error)) this.setData({ error: errorText(error) });
      })
      .finally(() => this.alive && this.setData({ recognizing: false }));
  },
  retryOcr() {
    this.setData({ error: "" });
    api
      .post(`/v1/materials/${this.data.id}/ocr`)
      .then((job) => this.waitOcr(job))
      .catch((error) => !api.needsConsent(error) && this.setData({ error: errorText(error) }));
  },
  showImage() {
    api
      .download(`/v1/materials/${this.data.id}/image`)
      .then((path) => wx.previewImage({ urls: [path] }))
      .catch((error) => !api.needsConsent(error) && this.setData({ error: errorText(error) }));
  },
  onText(event) {
    const text = event.detail.value;
    this.setData({ text, chars: countChars(text) });
  },
  onAnswer(event) {
    this.setData({ answer: event.detail.value });
  },
  onTitle(event) {
    this.setData({ title: event.detail.value });
  },
  confirm() {
    const { id, kind, title, text, answer, chars, version, busy } = this.data;
    if (busy) return;
    if (!chars) return this.setData({ error: "还没有内容，先打几个字" });
    if (chars > TEXT_LIMIT)
      return this.setData({ error: `有 ${chars} 字，有点长了（${TEXT_LIMIT} 字以内），删掉一些再存` });
    this.setData({ busy: true, error: "" });
    api
      .put(`/v1/materials/${id}`, {
        expectedVersion: version,
        text,
        title: title.trim(),
        confirm: true,
        ...(kind === "problem" ? { answer: answer.trim() || null } : {}),
      })
      .then((detail) => api.openMaterial(detail, true))
      .catch((error) => {
        if (api.needsConsent(error)) return;
        if (error.code === "VERSION_CONFLICT")
          return wx.showModal({
            title: "内容变了",
            content: "这份内容在别处改过，重新打开再看一眼。",
            showCancel: false,
            success: () => this.load(),
          });
        this.setData({ error: errorText(error) });
      })
      .finally(() => this.setData({ busy: false }));
  },
});

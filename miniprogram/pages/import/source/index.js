const { withShare } = require("../../../utils/share");
/*
 * 导入来源页：选择文字、图片或文档，跟踪读取进度，校对原文后进入拆卡确认。
 * 页面中的请求标识、账号快照和 alive 状态用于拦截过期回包；不能仅因离开页面就删除另一份新草稿。
 */
const api = require("../../../utils/api");
const gate = require("../../../utils/gate");
const auth = require("../../../utils/auth");
const { errorText, countChars, monthDay } = require("../../../utils/format");
const {
  clientId,
  sizeText,
  pageLine,
  READ_STEPS,
  SPLIT_STEPS,
  READ_KINDS,
  draftGet,
  draftSet,
} = require("../view");
const { pickFailed } = require("../../../utils/pick");
const { watch } = require("../../../utils/job");
const { importRow } = require("../../../utils/import-row");

// one limit of 20000 characters is read; up to 60000 can be pasted
// and what is past the limit waits as the next import (restChars).
const TEXT_LIMIT = 20000;
const PASTE_LIMIT = 60000;
const FILE_LIMIT = 10 * 1024 * 1024;
const PHOTO_LIMIT = 5 * 1024 * 1024;
const FILE_TYPES = ["txt", "md", "docx", "pdf"];
const IMAGE_TYPES = ["jpg", "jpeg", "png"];
const SOURCES = [
  ["photo", "拍照或相册（最多 3 张）"],
  ["screenshot", "聊天截图（最多 3 张）"],
  ["file", "聊天里的文件"],
];
const owner = () => (auth.getUser() || {}).id || "";
const imported = (result) => result && (result.import || result);
const ENDED = ["failed", "unknown"];
const PHOTO_SOURCES = ["photo", "screenshot"];
// photos whose upload stopped part-way (the page was left): no read
// job ever started and some pictures never reached the server (received).
const uploadStuck = (item) =>
  Boolean(
    item &&
      PHOTO_SOURCES.includes(item.source) &&
      item.status === "reading" &&
      !item.job &&
      !item.failedJob &&
      Array.isArray(item.received) &&
      item.received.length < (item.pages || []).length,
  );
// A picked file is still on the phone (picked files go when the app restarts).
function present(file) {
  try {
    if (typeof wx.getFileSystemManager !== "function") return true;
    wx.getFileSystemManager().accessSync(file.path);
    return true;
  } catch (error) {
    return false;
  }
}

Page(withShare({
    data: {
      text: "",
      charCount: 0,
      own: false,
      sourceType: "text",
      files: [],
      startPage: 1,
      item: null,
      segmentsOpen: true,
      progress: "",
      busy: false,
      error: "",
      // the read or split job under way (or the one that failed), for
      // <task-progress>; `waiting` while it runs; `resume` an unfinished import.
      task: null,
      waiting: false,
      resume: null,
      // the read text can be fixed, merged and split (one segment open).
      segmentEdit: null,
      keptLine: "",
      restLine: "",
      unreadLine: "",
      nextPage: 0,
      // the import is being sent (no "可以先离开" then), and the
      // source of pictures that did not all arrive, to pick again.
      sending: false,
      repick: "",
      // what was read and what was not, in plain words; the link
      // that picks cleared pictures (or the PDF) again; every unfinished
      // import (openRows), listed in a sheet (listOpen).
      partialLine: "",
      repickLine: "",
      openRows: [],
      listOpen: false,
    },
    onLoad(query) {
      this.importId = (query && query.id) || "";
      this.pick = (!this.importId && query && query.pick) || "";
    },
    // 拍照 / 传图/文档 on 随心记 open the picker once, as soon as the page is up.
    onReady() {
      const pick = this.pick;
      this.pick = "";
      if (gate.state() !== "ok") return;
      if (pick === "file") this.chooseFile();
      else if (pick === "photo" || pick === "screenshot")
        this.choosePhotos({ currentTarget: { dataset: { source: pick } } });
    },
    // on a phone the photo / file picker hides this page (onHide) and
    // shows it again (onShow), before or after its success callback. Picks
    // and requests are only dropped when the page is closed or the account
    // changed; hiding only pauses the job polling, onShow picks it up again.
    onShow() {
      if (!gate.check()) return;
      // A guest has nothing here: offer the welcome page, send nothing.
      if (gate.state() !== "ok") return gate.ask({ leave: true });
      this.alive = true;
      this.hidden = false;
      this.epoch = this.epoch || 1;
      const current = owner();
      if (this.account && current && current !== this.account) {
        // What was under way belongs to the other account: drop it.
        this.epoch += 1;
        this.importId = "";
        this.setData({
          item: null,
          files: [],
          busy: false,
          progress: "",
          error: "换了账号，退出这页再进来",
        });
      }
      if (current) this.account = current;
      if (!this.importId && !this.restored && this.restoreDraft() && this.upload)
        this.resumeDraft();
      // A request still running finishes by itself; otherwise look again.
      if (this.importId && !this.data.busy) this.load();
      else if (!this.importId && !this.openChecked) this.checkOpen();
    },
    onHide() {
      this.hidden = true;
      this.keepDraft();
      this.pause();
    },
    onUnload() {
      this.keepDraft();
      this.stop();
    },
    // pasted text, picked files and the photos already sent survive
    // leaving the page, per account, until something has been read.
    restoreDraft() {
      this.restored = true;
      const draft = draftGet("source", this.account || owner());
      if (!draft) return false;
      const text = String(draft.text || "").slice(0, PASTE_LIMIT);
      const files = Array.isArray(draft.files) ? draft.files.slice(0, 3) : [];
      this.upload = draft.upload || null;
      this.pending = draft.pending || null;
      this.setData({
        text,
        charCount: countChars(text),
        own: Boolean(draft.own),
        sourceType: files.length ? draft.sourceType || "file" : "text",
        files,
        startPage: Math.max(1, Number(draft.startPage) || 1),
      });
      return true;
    },
    // pictures left part-way go on by themselves while they are
    // still on the phone; otherwise the import is given up and they are
    // picked again.
    resumeDraft() {
      const files = this.data.files;
      if (files.length && files.every(present)) {
        this.resumed = true;
        return this.readSource();
      }
      return this.dropUpload({ id: this.upload.id, source: this.upload.source });
    },
    // Opened from 随心记 (or 继续) on an import still waiting for pictures:
    // this phone's draft sends the missing ones, under the same clientId.
    resumeUpload(item) {
      const account = this.account || owner();
      const draft = draftGet("source", account) || {};
      const upload = draft.upload;
      const files = Array.isArray(draft.files) ? draft.files.slice(0, 3) : [];
      const pages = item.pages || [];
      const mine =
        upload &&
        (upload.id ? upload.id === item.id : upload.source === item.source) &&
        files.length === pages.length;
      if (!mine || this.resumed || !files.every(present)) return this.dropUpload(item);
      this.resumed = true;
      this.restored = true;
      this.importId = "";
      const received = item.received || [];
      const missing = pages.findIndex((page) => !received.includes(page.n));
      this.upload = { ...upload, id: item.id, done: Math.max(0, missing) };
      this.pending = null;
      const text = String(draft.text || "").slice(0, PASTE_LIMIT);
      this.setData({
        item: null,
        task: null,
        waiting: false,
        busy: false,
        text,
        charCount: countChars(text),
        own: Boolean(item.own),
        sourceType: upload.source,
        files,
        error: "",
      });
      return this.readSource();
    },
    // The pictures are not on this phone any more: the half-sent import is
    // given up first, then the picker is offered again. Pasted text stays.
    dropUpload(item) {
      const epoch = this.epoch;
      const account = owner();
      this.setData({ busy: true, error: "" });
      return Promise.resolve(
        item.id && api.post(`/v1/imports/${encodeURIComponent(item.id)}/abandon`),
      )
        .then(() => {
          if (!this.bindOwner(epoch, account)) return;
          const draft = draftGet("source", this.account || account);
          const other = draft && draft.upload && draft.upload.id && draft.upload.id !== item.id;
          if (draft && !other)
            draftSet("source", this.account || account, {
              ...draft,
              sourceType: "text",
              files: [],
              upload: null,
            });
          this.importId = "";
          this.upload = null;
          this.setData({
            item: null,
            task: null,
            waiting: false,
            files: [],
            sourceType: "text",
            repick: PHOTO_SOURCES.includes(item.source) ? item.source : "photo",
          });
          if (!this.restored) this.restoreDraft();
        })
        .catch((error) => {
          if (!this.active(epoch, account) || api.needsConsent(error)) return;
          this.setData({ error: errorText(error) });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ busy: false });
        });
    },
    repickPhotos() {
      if (this.data.busy) return Promise.resolve();
      return this.choosePhotos({
        currentTarget: { dataset: { source: this.data.repick || "photo" } },
      });
    },
    keepDraft() {
      const account = this.account || owner();
      if (!account || !this.restored) return;
      if (this.importId && !this.upload) return draftSet("source", account, null);
      const { text, own, sourceType, files, startPage } = this.data;
      const empty = !String(text || "").trim() && !files.length && !this.upload;
      draftSet(
        "source",
        account,
        empty
          ? null
          : {
              text,
              own,
              sourceType,
              files,
              startPage,
              upload: this.upload || null,
              // the clientId of text or a file sent and not yet
              // answered; a retry reuses it, so no second import is made.
              pending: this.pending || null,
            },
      );
    },
    pause() {
      if (this.watcher) this.watcher.pause();
    },
    // Leaving only stops asking; the job goes on and the import keeps it.
    stop() {
      this.alive = false;
      this.epoch = (this.epoch || 0) + 1;
      if (this.watcher) this.watcher.stop();
      this.watcher = null;
    },
    // A lost session (owner empty, e.g. a failed re-login after a 401) is
    // not another account: the error still shows and busy still clears.
    // Another account bumps the epoch in onShow.
    active(epoch, account) {
      return (
        this.alive &&
        epoch === this.epoch &&
        (!account || !owner() || owner() === account) &&
        (!this.account || !owner() || owner() === this.account)
      );
    },
    bindOwner(epoch, account) {
      if (!this.active(epoch, account)) return false;
      if (!this.account && owner()) this.account = owner();
      return true;
    },
    textInput(event) {
      const text = String(event.detail.value || "").slice(0, PASTE_LIMIT);
      // Other words are another import.
      if (text !== this.data.text) this.pending = null;
      this.setData({
        text,
        charCount: countChars(text),
        sourceType: "text",
        error: "",
      });
    },
    startInput(event) {
      const value = Math.max(1, Math.floor(Number(event.detail.value) || 1));
      if (value !== this.data.startPage) this.pending = null;
      this.setData({ startPage: value });
    },
    chooseSource() {
      if (this.data.busy) return;
      wx.showActionSheet({
        itemList: SOURCES.map((entry) => entry[1]),
        success: ({ tapIndex }) => {
          const source = (SOURCES[tapIndex] || [])[0];
          if (source === "file") this.chooseFile();
          else if (source)
            this.choosePhotos({ currentTarget: { dataset: { source } } });
        },
      });
    },
    // Pickers resolve once reading has started from the picked files (or
    // nothing was picked), so a pick never needs a second tap.
    choosePhotos(event) {
      const sourceType = event.currentTarget.dataset.source || "photo";
      const epoch = this.epoch;
      const account = owner();
      return new Promise((resolve) =>
        wx.chooseMedia({
          count: 3,
          mediaType: ["image"],
          sourceType: sourceType === "photo" ? ["album", "camera"] : ["album"],
          sizeType: ["compressed"],
          success: (result) =>
            resolve(
              this.usePhotos(
                (result.tempFiles || []).map((file) => ({
                  path: file.tempFilePath,
                  size: file.size,
                })),
                sourceType,
                epoch,
                account,
              ),
            ),
          fail: (error) => {
            if (this.active(epoch, account)) pickFailed(error);
            resolve();
          },
        }),
      );
    },
    usePhotos(picked, sourceType, epoch, account) {
      if (!this.bindOwner(epoch, account)) return;
      const files = picked.slice(0, 3);
      if (!files.length) return;
      this.upload = null;
      this.pending = null;
      if (files.some((file) => Number(file.size) > PHOTO_LIMIT)) {
        this.setData({
          error: "有张图太大了（每张 5 MB 以内），原来的内容还在",
        });
        return;
      }
      this.setData({
        sourceType,
        files: files.map((file, index) => ({
          path: file.path,
          name: `图片 ${index + 1}`,
          size: file.size || 0,
          sizeText: sizeText(file.size),
          ext: "IMG",
        })),
        error: "",
        repick: "",
      });
      return this.readSource();
    },
    // Any file from a chat: pictures go through the screenshot reader,
    // documents through the file reader.
    chooseFile() {
      const epoch = this.epoch;
      const account = owner();
      return new Promise((resolve) =>
        wx.chooseMessageFile({
          count: 1,
          type: "all",
          success: (result) => resolve(this.useFile(result, epoch, account)),
          fail: (error) => {
            if (this.active(epoch, account)) pickFailed(error);
            resolve();
          },
        }),
      );
    },
    useFile(result, epoch, account) {
      if (!this.bindOwner(epoch, account)) return;
      const file = (result.tempFiles || [])[0];
      if (!file) return;
      const ext = String(file.name || file.path || "")
        .split(".")
        .pop()
        .toLowerCase();
      if (IMAGE_TYPES.includes(ext))
        return this.usePhotos(
          [{ path: file.path, size: file.size }],
          "screenshot",
          epoch,
          account,
        );
      if (!FILE_TYPES.includes(ext)) {
        wx.showToast({ title: "只支持图片、txt、md、docx、pdf", icon: "none" });
        return;
      }
      if (Number(file.size) > FILE_LIMIT) {
        this.setData({
          error: "文件太大了（10 MB 以内），原来的内容还在",
        });
        return;
      }
      this.upload = null;
      this.pending = null;
      const pdf = ext === "pdf";
      this.setData({
        sourceType: "file",
        // a PDF waits for its start page and 开始读.
        startPage: pdf ? this.nextStart || 1 : 1,
        files: [
          {
            path: file.path,
            name: file.name,
            size: file.size || 0,
            sizeText: sizeText(file.size),
            ext: ext.toUpperCase(),
          },
        ],
        error: "",
      });
      this.nextStart = 0;
      if (pdf) return this.keepDraft();
      return this.readSource();
    },
    clearFiles() {
      if (this.data.busy) return;
      this.upload = null;
      this.pending = null;
      this.setData({ files: [], sourceType: "text", error: "" });
      this.keepDraft();
    },
    load() {
      if (!this.importId) return Promise.resolve();
      const epoch = this.epoch;
      const account = owner();
      this.setData({ busy: true, error: "" });
      return api
        .get(`/v1/imports/${encodeURIComponent(this.importId)}`)
        .then((item) => {
          // A half-sent import goes on sending (or is given up) first.
          if (this.bindOwner(epoch, account)) return this.adopt(item);
        })
        .catch((error) => {
          if (!this.active(epoch, account) || api.needsConsent(error)) return;
          this.setData({ error: errorText(error) });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ busy: false });
        });
    },
    adopt(item) {
      if (!item) return;
      // Never 认这几页 / 跳过 for pictures that did not arrive.
      if (uploadStuck(item)) return this.resumeUpload(item);
      this.importId = item.id;
      const failedPages = (item.pages || [])
        .filter((page) => !page.ok)
        .map((page) => page.n);
      const task = this.taskFor(item);
      const range = item.pageRange || {};
      const pdfMore = Boolean(item.truncated && item.source === "pdf" && range.to);
      const restChars = Number(item.restChars) || 0;
      const unread = item.unread || {};
      const limit = Number(item.limit) || TEXT_LIMIT;
      // a scan can have both more pages and text past the limit;
      // both are said and both can be imported next.
      const kept = [
        restChars ? `先读了前 ${limit} 字以内的整段，还剩 ${restChars} 字` : "",
        pdfMore ? (restChars ? `这次读到第 ${range.to} 页` : `读到第 ${range.to} 页为止`) : "",
        !restChars && !pdfMore && item.truncated ? `读到 ${limit} 字为止` : "",
      ].filter(Boolean);
      // Pages read with no words say so; skipped pages are only "not read".
      const job = item.job || item.failedJob || null;
      const noWords = Boolean(
        job &&
          ((job.status === "succeeded" && job.result && (job.result.failed || []).length) ||
            (job.error && job.error.code === "IMPORT_NO_TEXT")),
      );
      const someRead = (item.pages || []).some((page) => page.ok);
      const missing = Array.isArray(item.missingPages) ? item.missingPages : [];
      // The pictures (or the PDF) of pages not read were cleared.
      const repickLine =
        missing.length && !api.pending(item.job) && ["reading", "read"].includes(item.status)
          ? item.source === "pdf"
            ? "重新选这个文件"
            : "重新选这几页的图片"
          : "";
      // A read that failed with no words says which pages once, on the
      // failed task with its 重试, not again in a notice above it.
      const onTask = Boolean(
        task && !api.pending(task.job) && noWords && failedPages.length && !repickLine,
      );
      if (onTask) task.error = `第 ${failedPages.join("、")} 页没认出字，可以再试一次`;
      this.setData({
        item: {
          ...item,
          pageLine: pageLine(item),
          failedPages: failedPages.join("、"),
        },
        keptLine: kept.join("；"),
        partialLine: item.partial && !onTask
          ? `${noWords ? `第 ${failedPages.join("、")} 页没认出字` : `有几页没读出来（第 ${failedPages.join("、")} 页）`}${someRead ? "，读出来的还在" : ""}`
          : "",
        repickLine,
        nextPage: pdfMore ? range.to + 1 : 0,
        restLine: restChars ? "接着导剩下的" : "",
        unreadLine: [
          unread.formulas ? `有 ${unread.formulas} 个公式是图片格式，没读出来` : "",
          unread.images ? `${unread.images} 张图片没读` : "",
        ]
          .filter(Boolean)
          .join("，"),
        own: Boolean(item.own),
        progress: "",
        task,
        waiting: Boolean(task && api.pending(task.job)),
      });
      if (item.status === "picking" || item.status === "saved")
        return this.openSplit();
      // Hidden: onShow loads it again and asks then. A failed read shows its
      // own 重试 instead.
      if (item.needsOcr && !task && !this.ocrAsked && !this.hidden) {
        this.ocrAsked = true;
        this.askOcr(item.needsOcr);
      }
      if (api.pending(item.job)) this.watchJob(item.job);
    },
    // The running job, or the read/split job that just failed (V4.2: the
    // import went back a step and keeps what it had, so 重试 redoes only it).
    taskFor(item) {
      const split = item.status === "splitting";
      if (api.pending(item.job))
        return {
          phase: split ? "split" : "read",
          steps: split ? SPLIT_STEPS : READ_STEPS,
          job: item.job,
          error: "",
          canSkip: false,
        };
      const failed = [item.job, item.failedJob].find(
        (job) => job && ENDED.includes(job.status),
      );
      if (!failed) return null;
      const read = READ_KINDS.includes(failed.kind);
      if (read ? item.status !== "reading" : item.status !== "read") return null;
      return {
        phase: read ? "read" : "split",
        steps: read ? READ_STEPS : SPLIT_STEPS,
        job: failed,
        error: "",
        canSkip: read && (item.pages || []).some((page) => page.ok),
      };
    },
    readSource() {
      if (this.data.busy) return Promise.resolve();
      const epoch = this.epoch;
      const account = owner();
      const kind = this.data.sourceType;
      const text = this.data.text.trim();
      if (kind === "text" && !text) {
        this.setData({ error: "先贴一段文字，或者拍照、选文件" });
        return Promise.resolve();
      }
      if (kind !== "text" && !this.data.files.length) {
        this.setData({ error: "没找到选好的文件，再选一次" });
        return Promise.resolve();
      }
      this.setData({
        busy: true,
        sending: true,
        error: "",
        progress: "正在读，稍等…",
      });
      // text or a file sent again before it was answered keeps
      // its clientId (kept in the draft), so the server returns that import.
      const cid =
        this.pending && this.pending.kind === kind ? this.pending.cid : clientId(kind);
      if (kind !== "photo" && kind !== "screenshot") {
        this.pending = { cid, kind };
        this.keepDraft();
      }
      let request;
      if (kind === "text") {
        request = api.post("/v1/imports", {
          clientId: cid,
          text,
          own: this.data.own,
        });
      } else if (kind === "file") {
        const start = Math.max(1, Number(this.data.startPage) || 1);
        request = api.uploadTo(
          `/v1/imports/file?clientId=${encodeURIComponent(cid)}&start=${start}&own=${this.data.own ? 1 : 0}`,
          this.data.files[0].path,
        );
      } else {
        // photos already sent are not sent again (same clientId).
        const upload = this.upload && this.upload.source === kind ? this.upload : null;
        request = this.uploadPhotos(upload ? upload.cid : cid, kind, epoch, account, upload ? upload.done : 0);
      }
      return Promise.resolve(request)
        .then((result) => {
          if (!this.bindOwner(epoch, account)) return;
          const item = imported(result);
          if (!item)
            return this.setData({
              error: "没读到内容，再试一次",
              progress: "",
            });
          this.upload = null;
          this.pending = null;
          this.importId = item.id;
          draftSet("source", this.account || account, null);
          this.adopt(item);
        })
        .catch((error) => {
          if (!this.active(epoch, account) || api.needsConsent(error)) return;
          this.setData({ error: errorText(error), progress: "" });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ busy: false, sending: false });
        });
    },
    uploadPhotos(cid, source, epoch, account, from = 0) {
      const files = this.data.files.slice();
      let latest = null;
      // the clientId is kept before the first picture goes, so
      // coming back sends the rest under it.
      const known = this.upload && this.upload.cid === cid ? this.upload.id : "";
      this.upload = { cid, source, done: from, id: known || "" };
      this.keepDraft();
      return files
        .reduce(
          (chain, file, index) =>
            chain.then(() => {
              if (index < from) return;
              if (!this.active(epoch, account))
                throw Object.assign(new Error("页面已关闭"), {
                  code: "CANCELLED",
                });
              this.setData({
                progress: `正在上传第 ${index + 1}/${files.length} 张`,
              });
              const url = `/v1/imports/photo?clientId=${encodeURIComponent(cid)}&source=${source}&index=${index}&count=${files.length}&own=${this.data.own ? 1 : 0}`;
              return api.uploadTo(url, file.path).then((result) => {
                if (!this.active(epoch, account))
                  throw Object.assign(new Error("页面已关闭"), {
                    code: "CANCELLED",
                  });
                latest = result;
                // Kept from the first photo on: coming back sends the rest.
                const item = imported(result);
                this.upload = {
                  cid,
                  source,
                  done: index + 1,
                  id: (item && item.id) || this.upload.id || "",
                };
                this.keepDraft();
              });
            }),
          Promise.resolve(),
        )
        .then(() => latest);
    },
    watchJob(job) {
      // Hidden: onShow loads the import again, which starts watching.
      if (!job || !api.pending(job) || this.hidden) return;
      if (this.watcher) this.watcher.stop();
      const epoch = this.epoch;
      const account = owner();
      this.watcher = watch(job, {
        onUpdate: (next) => {
          if (this.bindOwner(epoch, account)) this.showJob(next);
        },
        // Done either way: the import moved on (or went back a step).
        onDone: (next) => {
          if (!this.bindOwner(epoch, account)) return;
          this.showJob(next);
          this.load();
        },
        onError: (error, { retrying }) => {
          if (!this.active(epoch, account) || api.needsConsent(error)) return;
          this.setData({
            error: retrying ? "网不太好，连上后接着看" : errorText(error),
          });
        },
      });
    },
    showJob(job) {
      const task = this.data.task;
      if (!task || !job || task.job.id !== job.id) return;
      this.setData({
        task: { ...task, job },
        waiting: api.pending(job),
        error: "",
      });
    },
    // <task-progress bind:retry>: read the pages that failed again, or split
    // again; nothing is uploaded or read twice.
    retryTask() {
      const task = this.data.task;
      if (!task || this.data.busy) return Promise.resolve();
      if (task.phase === "split") return this.splitCards();
      return this.rereadPages();
    },
    rereadPages() {
      const item = this.data.item || {};
      // nothing left to read again: the pictures are picked first.
      if (!Number(item.retryPages) && (item.missingPages || []).length)
        return this.repickMissing();
      const failed = (item.pages || []).filter((page) => !page.ok).length;
      // retryPages is 0 once the pictures expired: the server says so.
      return this.confirmOcr(Number(item.retryPages) || failed || 1);
    },
    // the pictures of the pages not read (or the PDF) picked again
    // after they were cleared; only those pages are read, the rest is kept.
    repickMissing() {
      const item = this.data.item;
      const missing = (item && item.missingPages) || [];
      if (this.data.busy || !item || !missing.length) return Promise.resolve();
      const epoch = this.epoch;
      const account = owner();
      const pdf = item.source === "pdf";
      return new Promise((resolve) => {
        const fail = (error) => {
          if (this.active(epoch, account)) pickFailed(error);
          resolve();
        };
        if (pdf)
          wx.chooseMessageFile({
            count: 1,
            type: "file",
            extension: ["pdf"],
            success: (result) =>
              resolve(this.sendMissing((result.tempFiles || []).slice(0, 1), missing, epoch, account)),
            fail,
          });
        else
          wx.chooseMedia({
            count: missing.length,
            mediaType: ["image"],
            sourceType: item.source === "photo" ? ["album", "camera"] : ["album"],
            sizeType: ["compressed"],
            success: (result) =>
              resolve(
                this.sendMissing(
                  (result.tempFiles || []).map((file) => ({
                    path: file.tempFilePath,
                    size: file.size,
                  })),
                  missing,
                  epoch,
                  account,
                ),
              ),
            fail,
          });
      });
    },
    sendMissing(files, missing, epoch, account) {
      if (!this.bindOwner(epoch, account) || !files.length) return;
      const pdf = this.data.item.source === "pdf";
      if (pdf && !/\.pdf$/i.test(String(files[0].name || files[0].path || ""))) {
        wx.showToast({ title: "选原来那份 PDF", icon: "none" });
        return;
      }
      if (files.some((file) => Number(file.size) > (pdf ? FILE_LIMIT : PHOTO_LIMIT))) {
        this.setData({
          error: pdf ? "文件太大了（10 MB 以内）" : "有张图太大了（每张 5 MB 以内）",
        });
        return;
      }
      const id = encodeURIComponent(this.importId);
      const picked = files.slice(0, missing.length);
      let latest = null;
      this.setData({ busy: true, error: "" });
      return picked
        .reduce(
          (chain, file, index) =>
            chain.then(() => {
              if (!this.active(epoch, account))
                throw Object.assign(new Error("页面已关闭"), { code: "CANCELLED" });
              this.setData({
                progress:
                  picked.length > 1 ? `正在上传第 ${index + 1}/${picked.length} 张` : "正在上传…",
              });
              return api
                .uploadTo(`/v1/imports/${id}/page${pdf ? "" : `?n=${missing[index]}`}`, file.path)
                .then((result) => {
                  latest = imported(result) || latest;
                });
            }),
          Promise.resolve(),
        )
        .then(() => {
          if (!this.bindOwner(epoch, account) || !latest) return;
          this.setData({ progress: "" });
          this.adopt(latest);
          const pages = Number(latest.retryPages) || 0;
          if (pages) return this.confirmOcr(pages, epoch, account);
        })
        .catch((error) => {
          if (!this.active(epoch, account) || api.needsConsent(error)) return;
          this.setData({ error: errorText(error), progress: "" });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ busy: false });
        });
    },
    skipFailed() {
      if (this.data.busy) return Promise.resolve();
      return this.confirmOcr(0);
    },
    leave() {
      wx.navigateBack({
        fail: () => wx.switchTab({ url: "/pages/notes/index" }),
      });
    },
    // The import entry: an unfinished import from before can go on or go.
    // all of them, however old (all=1); the newest in the bar,
    // the others one tap away in a list.
    checkOpen() {
      this.openChecked = true;
      const epoch = this.epoch;
      const account = owner();
      return Promise.resolve()
        .then(() => api.get("/v1/imports?open=1&all=1"))
        .then((result) => {
          if (!this.active(epoch, account) || this.importId) return;
          const items = (result && result.items) || [];
          this.showOpen(
            items.map((item) => ({ ...importRow(item), id: item.id, status: item.status, when: monthDay(item.updatedAt) })),
          );
        })
        .catch(() => {});
    },
    showOpen(rows) {
      const first = rows[0];
      this.setData({
        openRows: rows,
        listOpen: Boolean(this.data.listOpen && rows.length),
        resume: first
          ? {
              id: first.id,
              status: first.status,
              title: first.title || "上次的导入",
            }
          : null,
      });
    },
    resumeOpen() {
      const resume = this.data.resume;
      if (!resume || this.data.busy) return;
      return this.openImport(resume);
    },
    openImport(row) {
      this.importId = row.id;
      this.setData({ resume: null, listOpen: false });
      if (row.status === "picking") return this.openSplit();
      return this.load();
    },
    showOpenList() {
      if (this.data.openRows.length) this.setData({ listOpen: true });
    },
    closeOpenList() {
      this.setData({ listOpen: false });
    },
    openFromList(event) {
      const row = this.data.openRows.find((item) => item.id === event.currentTarget.dataset.id);
      if (!row || this.data.busy) return;
      return this.openImport(row);
    },
    dropFromList(event) {
      return this.dropOpen(event.currentTarget.dataset.id);
    },
    resumeDrop() {
      const resume = this.data.resume;
      if (!resume) return Promise.resolve();
      return this.dropOpen(resume.id);
    },
    dropOpen(id) {
      if (!id || this.data.busy) return Promise.resolve();
      const epoch = this.epoch;
      const account = owner();
      this.setData({ busy: true, error: "" });
      return api
        .post(`/v1/imports/${encodeURIComponent(id)}/abandon`)
        .then(() => {
          // what was ticked on its cards goes with it.
          draftSet(`pick:${id}`, this.account || account, null);
          if (this.bindOwner(epoch, account))
            this.showOpen(this.data.openRows.filter((row) => row.id !== id));
        })
        .catch((error) => {
          if (!this.active(epoch, account) || api.needsConsent(error)) return;
          this.setData({ error: errorText(error) });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ busy: false });
        });
    },
    askOcr(needs) {
      const epoch = this.epoch;
      const account = owner();
      const pages = Math.min(
        Number(needs.pages) || 0,
        Number(needs.available) || 0,
      );
      // Button labels stay within four characters, the dialog's limit.
      wx.showModal({
        title: "有几页是图片",
        content: pages
          ? `认这 ${pages} 页图片里的字，会用掉一些额度。`
          : "额度用完了，先跳过这几页吧。",
        showCancel: Boolean(pages),
        confirmText: pages ? "认这几页" : "好",
        cancelText: "跳过",
        success: (result) => {
          if (!this.bindOwner(epoch, account)) return;
          this.confirmOcr(pages && result.confirm ? pages : 0, epoch, account);
        },
      });
    },
    confirmOcr(pages, epoch = this.epoch, account = owner()) {
      this.setData({
        busy: true,
        error: "",
        progress: pages ? "正在认图片里的字…" : "正在跳过这几页…",
      });
      return api
        .post(`/v1/imports/${encodeURIComponent(this.importId)}/read`, {
          pages,
        })
        .then((result) => {
          if (this.bindOwner(epoch, account)) this.adopt(imported(result));
        })
        .catch((error) => {
          if (!this.active(epoch, account) || api.needsConsent(error)) return;
          this.setData({ error: errorText(error), progress: "" });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ busy: false });
        });
    },
    toggleSegments() {
      this.setData({ segmentsOpen: !this.data.segmentsOpen });
    },
    // one segment opened in full to fix, merge or split; the whole
    // list goes back as `segments` (each with the number it came from).
    openSegment(event) {
      if (this.data.busy || !this.data.item) return;
      const n = Number(event.currentTarget.dataset.n);
      const segments = this.data.item.segments || [];
      const index = segments.findIndex((segment) => segment.n === n);
      if (index < 0) return;
      this.setData({
        segmentEdit: {
          n,
          text: segments[index].text,
          first: index === 0,
          last: segments.length === 1,
        },
        error: "",
      });
    },
    segmentInput(event) {
      this.setData({
        "segmentEdit.text": String(event.detail.value || "").slice(0, TEXT_LIMIT),
      });
    },
    closeSegment() {
      this.setData({ segmentEdit: null });
    },
    noop() {},
    // 好了: the text as fixed; a blank line in it splits the segment there.
    saveSegment() {
      const edit = this.data.segmentEdit;
      if (!edit) return Promise.resolve();
      const parts = String(edit.text || "")
        .split(/\n[ \t　]*\n/)
        .map((part) => part.trim())
        .filter(Boolean);
      if (!parts.length) return this.dropSegment();
      return this.sendSegments((segment) =>
        segment.n === edit.n
          ? parts.map((text) => ({ text, from: segment.n }))
          : [segment],
      );
    },
    mergeSegment() {
      const edit = this.data.segmentEdit;
      if (!edit || edit.first) return Promise.resolve();
      const segments = (this.data.item && this.data.item.segments) || [];
      const index = segments.findIndex((segment) => segment.n === edit.n);
      const previous = segments[index - 1];
      if (!previous) return Promise.resolve();
      const text = `${previous.text}\n${String(edit.text || "").trim()}`.trim();
      return this.sendSegments((segment) =>
        segment.n === previous.n
          ? [{ text, from: previous.n }]
          : segment.n === edit.n
            ? []
            : [segment],
      );
    },
    dropSegment() {
      const edit = this.data.segmentEdit;
      if (!edit) return Promise.resolve();
      if (edit.last) {
        this.setData({ error: "这是最后一段了，留着它吧" });
        return Promise.resolve();
      }
      return this.sendSegments((segment) => (segment.n === edit.n ? [] : [segment]));
    },
    sendSegments(change) {
      if (this.data.busy || !this.data.item) return Promise.resolve();
      const segments = (this.data.item.segments || []).flatMap((segment) =>
        change(segment).map((part) => ({
          text: part.text,
          from: part.from || segment.n,
        })),
      );
      const epoch = this.epoch;
      const account = owner();
      this.setData({ busy: true, error: "" });
      return api
        .patch(`/v1/imports/${encodeURIComponent(this.importId)}`, { segments })
        .then((result) => {
          if (!this.bindOwner(epoch, account)) return;
          this.setData({ segmentEdit: null });
          this.adopt(imported(result));
        })
        .catch((error) => {
          if (!this.active(epoch, account) || api.needsConsent(error)) return;
          this.setData({ error: `${errorText(error)}，原文没变` });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ busy: false });
        });
    },
    // the text past the limit becomes the next import, read already.
    importRest() {
      if (this.data.busy || !this.importId) return Promise.resolve();
      const epoch = this.epoch;
      const account = owner();
      this.setData({ busy: true, error: "" });
      return api
        .post(`/v1/imports/${encodeURIComponent(this.importId)}/rest`, {
          clientId: this.restClient || (this.restClient = clientId("rest")),
        })
        .then((result) => {
          if (!this.bindOwner(epoch, account)) return;
          const item = imported(result);
          if (!item) return;
          this.restClient = "";
          this.redirected = false;
          this.adopt(item);
        })
        .catch((error) => {
          if (!this.active(epoch, account) || api.needsConsent(error)) return;
          this.setData({ error: errorText(error) });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ busy: false });
        });
    },
    // a PDF past 20 pages goes on from the next page, as a new import.
    readMore() {
      const next = Number(this.data.nextPage) || 0;
      if (this.data.busy || !next) return Promise.resolve();
      const file = this.data.files[0];
      this.importId = "";
      this.redirected = false;
      this.setData({ item: null, task: null, waiting: false, startPage: next, error: "" });
      if (file && file.ext === "PDF") return this.readSource();
      // The file is gone (the page was closed): pick it again, from page next.
      this.nextStart = next;
      this.setData({ files: [], sourceType: "text" });
      return this.chooseFile();
    },
    splitCards() {
      if (this.data.busy || !this.importId) return Promise.resolve();
      const epoch = this.epoch;
      const account = owner();
      this.setData({ busy: true, error: "", progress: "正在拆，稍等…" });
      return api
        .post(`/v1/imports/${encodeURIComponent(this.importId)}/cards`, {
          clientId: clientId("split"),
        })
        .then((result) => {
          if (this.bindOwner(epoch, account)) this.adopt(imported(result));
        })
        .catch((error) => {
          if (!this.active(epoch, account) || api.needsConsent(error)) return;
          this.setData({ error: errorText(error), progress: "" });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ busy: false });
        });
    },
    openSplit() {
      // Hidden: onShow loads the import again and goes on from there.
      if (!this.importId || this.redirected || this.hidden) return;
      this.redirected = true;
      wx.redirectTo({
        url: `/pages/import/split/index?id=${encodeURIComponent(this.importId)}`,
      });
    },
    cancel() {
      if (!this.importId) return wx.navigateBack();
      const epoch = this.epoch;
      const account = owner();
      wx.showModal({
        title: "不导了？",
        content: "已经存好的卡还在。",
        confirmText: "不导了",
        cancelText: "接着导",
        success: (result) => {
          if (!result.confirm || !this.bindOwner(epoch, account)) return;
          this.setData({ busy: true, error: "" });
          api
            .del(`/v1/imports/${encodeURIComponent(this.importId)}`)
            .then(() => {
              if (this.bindOwner(epoch, account)) wx.navigateBack();
            })
            .catch((error) => {
              if (!this.active(epoch, account) || api.needsConsent(error))
                return;
              this.setData({ error: errorText(error) });
            })
            .finally(() => {
              if (this.active(epoch, account)) this.setData({ busy: false });
            });
        },
      });
    },
  }));

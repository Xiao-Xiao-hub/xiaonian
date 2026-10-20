/*
 * 共享对话行为：由 talk 与 chat 页面调用 room 获得生命周期、发送、附件和草稿处理。
 * 页面保留各自的 WXML；草稿按账号与会话分开，晚到响应不能写进别的账号或新会话。
 * 依赖在 room 内加载，便于页面重建与测试替换；每条消息都要有所属会话。
 *
 */
// One conversation of 聊一聊 : opening it, writing and sending, the
// chips under a reply, attachments, mood, cards and 存成卡. Shared by the
// 聊一聊 tab (pages/talk) and the chat page (pages/chat, for chats opened from a
// card, a brainstorm or an older link); each page keeps its own WXML.
//
//   Page(studyClock.track({...room,...the page's own options }))
//
// room({ tab: true }) on the tab: a problem chat opens 解题 on top instead of
// replacing the page, and the keyboard lift leaves out the tab bar (page.gap).
// The modules are required when a page is built, so a page built again (tests)
// gets the stubs in place then.
//
// Every message is sent with a threadId: a first jot sent without one waits
// for a scene choice that this page never sends.
const TONE = "light";
// Unsent words and attachments, per account and chat (or "new").
const DRAFT = "zhiye_chat_draft";
// The server drops an upload left unsent for a day; an older draft keeps only its words.
const DRAFT_FILES_MS = 20 * 60 * 60 * 1000;
// Photos and documents sent from this phone open from the local file (attachment id → path).
const paths = {};

function room({ tab = false } = {}) {
  const api = require("./api");
  const auth = require("./auth");
  const gate = require("./gate");
  const stream = require("./stream");
  const keyboard = require("./keyboard");
  const { errorText } = require("./format");
  const { markBlocks } = require("./blocks");
  const chat = require("./chat-v2");
  const { openAsk, chatGone } = require("./chat-entry");
  const { pickFailed } = require("./pick");

  const owner = () => (auth.getUser() || {}).id || "";
  // Messages without server blocks (local bubbles, older payloads): colour marks are drawn, never shown as [[k:…]].
  const blocks = (text) => (text ? markBlocks(text) : []);
  // bare: only photos or documents, no words, so no empty bubble under them.
  const decorate = (item) => {
    const b = item.blocks || blocks(item.content),
      att = chat.attachView(item.attachments, paths);
    return {
      ...item,
      blocks: b,
      tail: item.tail || "",
      thinking: Boolean(item.thinking),
      errorText: item.error ? item.error.message : "",
      // V4.2 FX5b : the server sends a user's words as `plain`.
      plain: item.plain || item.content || "",
      attachments: att,
      bare: item.role === "user" && att.length > 0 && !b.length && !item.plain && !item.content,
    };
  };
  const view = (thread) => (thread ? { ...thread, currentCards: thread.currentCards || [] } : null);
  const local = (id, text, att) => {
    const m = decorate({ id: `local_${id}`, role: "user", status: "done", content: text });
    m.attachments = att || [];
    m.bare = !text && m.attachments.length > 0;
    return m;
  };
  const waiting = (id) => decorate({ id: `wait_${id}`, role: "assistant", status: "streaming" });
  const store = {
    get(key) {
      try {
        return wx.getStorageSync(key) || null;
      } catch (_) {
        return null;
      }
    },
    set(key, value) {
      try {
        wx.setStorageSync(key, value);
      } catch (_) {
        /* A full storage keeps only what is on screen. */
      }
    },
    drop(key) {
      try {
        wx.removeStorageSync(key);
      } catch (_) {
        /* Nothing to drop. */
      }
    },
  };
  const draftKey = (threadId) => `${DRAFT}:${owner()}:${threadId || "new"}`;
  const FRESH = {
    thread: null,
    messages: [],
    pending: [],
    actions: [],
    suggestions: [],
    sceneCandidate: false,
    breakReminder: "",
    draft: "",
    notice: "",
    error: "",
  };

  return {
    data: {
      consent: false,
      ...FRESH,
      sending: false,
      loading: false,
      busy: "",
      wrapWait: 0,
      focus: false,
      kb: 0,
    },
    onLoad(options) {
      this.alive = true;
      this.follow = true;
      this.lastTop = 0;
      this.suggested = "";
      this.pendingMood = "";
      // Opened by the mood consent page with nothing under it: switch only if it reports a yes.
      this.query =
        options && options.threadId
          ? { threadId: decodeURIComponent(options.threadId), pendingMood: true }
          : null;
    },
    onShow() {
      if (!gate.check()) return;
      this.hidden = false;
      const consent = auth.hasConsent();
      this.setData({ consent });
      if (!consent) return;
      // Deleted from the history meanwhile : nothing is sent to it.
      if (this.data.thread && chatGone(this.data.thread.id)) {
        if (this.request) this.request.abort();
        this.dropThread();
      }
      const app = getApp(),
        intent = app.globalData.chat || this.query;
      app.globalData.chat = null;
      this.query = null;
      // Back from the mood consent page or card-pick.
      if (this.pendingMood) this.moodBack();
      if (this.picking) return this.picked();
      // Picked elsewhere : they wait above the input here, uploading.
      if (intent && intent.files && intent.files.length) {
        this.setData({ draft: intent.text || "", focus: true });
        return this.addFiles(intent.files);
      }
      if (intent && intent.entry === "jot" && intent.text) return this.jot(intent);
      if (intent && intent.threadId)
        return this.open(intent.threadId, false, intent.cards).then(() => {
          const now = this.data.thread;
          if (intent.pendingMood && now && now.id === intent.threadId && this.consented())
            return this.patch({ scene: "mood" });
          if (intent.wrap && now && now.id === intent.threadId) return this.openWrap();
        });
      if (intent && intent.cards && intent.cards.length)
        return this.startWith(intent.cards, intent.teach, intent.brainstormId);
      if (intent && intent.text) return this.setData({ draft: intent.text, focus: true });
      // Back after the network dropped mid-answer: the server kept writing.
      // Back from 存成卡: whether the cards are stored now.
      const t = this.data.thread;
      if (t && (this.stale || t.wrapReady)) return this.open(t.id, !this.stale);
      // Words left here last time come back.
      if (!this.data.draft && !this.data.pending.length) this.restoreDraft();
    },
    onHide() {
      this.hidden = true;
      this.keepDraft();
      keyboard.reset(this);
    },
    // Unsent attachments stay with the draft : the server copy goes
    // only when one is removed, or after a day unsent.
    onUnload() {
      this.alive = false;
      this.keepDraft();
      clearTimeout(this.pollTimer);
      clearTimeout(this.scrollTimer);
      clearTimeout(this.settleTimer);
      clearTimeout(this.draftTimer);
      clearInterval(this.wrapTimer);
      if (this.request) this.request.abort();
    },
    onPageScroll({ scrollTop }) {
      if (scrollTop < this.lastTop - 40) this.follow = false;
      this.lastTop = scrollTop;
    },

    // ---- drafts  ------------------------------------------------------
    keepDraft() {
      clearTimeout(this.draftTimer);
      if (!owner()) return;
      const t = this.data.thread,
        key = draftKey(t && t.id),
        text = this.data.draft || "",
        files = this.data.pending
          .filter((x) => x.status === "ok" && x.id)
          .map((x) => ({
            key: x.key,
            id: x.id,
            kind: x.kind,
            name: x.name,
            size: x.size,
            sizeText: x.sizeText,
            badge: x.badge,
            path: x.path || "",
            imageId: x.imageId || "",
            readText: x.readText || "",
            more: Boolean(x.more),
            from: x.from || 0,
            read: x.read || 0,
            status: "ok",
          }));
      if (!text.trim() && !files.length) return store.drop(key);
      store.set(key, { text, files, at: Date.now() });
    },
    // Soon after typing stops, so a closed app keeps the words too.
    keepDraftSoon() {
      clearTimeout(this.draftTimer);
      this.draftTimer = setTimeout(() => this.keepDraft(), 600);
    },
    restoreDraft() {
      const t = this.data.thread,
        kept = owner() ? store.get(draftKey(t && t.id)) : null;
      if (!kept || (!kept.text && !(kept.files || []).length)) return false;
      const fresh = Date.now() - (Number(kept.at) || 0) < DRAFT_FILES_MS;
      const files = fresh ? (kept.files || []).filter((x) => x && x.id) : [];
      files.forEach((x) => {
        if (x.path) paths[x.id] = x.path;
      });
      this.setData({ draft: String(kept.text || ""), pending: files });
      return true;
    },
    clearDraft(threadId) {
      clearTimeout(this.draftTimer);
      if (owner()) store.drop(draftKey(threadId));
    },

    // ---- opening and starting --------------------------------------------------
    // Another chat starts with its own related cards, mood offer and break note.
    show(thread, list) {
      const same = Boolean(this.data.thread && this.data.thread.id === thread.id),
        current = view(thread);
      if (!same) this.keepDraft();
      this.sceneTurn(current);
      this.setData({
        thread: current,
        messages: list,
        actions: this.acts(current, list),
        ...(same ? {} : { suggestions: [], sceneCandidate: false, breakReminder: "", draft: "", pending: [] }),
      });
      if (!same) this.restoreDraft();
    },
    // poll: a quiet refresh while the server is still writing. cards: a card's
    // chat that may be gone; then a new chat about the card starts.
    // V4.2 FX5b : each open the learner asks for is numbered; an answer
    // that is not the latest, for another account or another chat is dropped.
    open(id, poll, cards) {
      this.stale = false;
      const seq = poll ? this.openSeq || 0 : this.nextOpen(),
        who = owner();
      if (!poll) this.setData({ loading: true, error: "", notice: "" });
      const latest = () => this.alive && seq === (this.openSeq || 0) && owner() === who;
      return api
        .get(`/v1/chat/threads/${encodeURIComponent(id)}?tone=${TONE}`)
        .then(({ thread, messages }) => {
          if (!latest() || !thread || thread.id !== id) return;
          const before = this.data.thread;
          if (poll && (!before || before.id !== id)) return;
          // A photographed question (opened from a card's source) reads properly only on 解题.
          if (!poll && messages.some((m) => m.kind === "problem"))
            return openAsk({ threadId: thread.id }, { replace: !tab });
          const list = messages.map(decorate);
          this.show(thread, list);
          if (!poll) {
            this.follow = true;
            this.toLatest();
          } else this.scrollDown(false);
          clearTimeout(this.pollTimer);
          if (list.some((m) => m.status === "streaming"))
            this.pollTimer = setTimeout(() => {
              const now = this.data.thread;
              if (this.alive && !this.hidden && now && now.id === thread.id && !this.data.sending)
                this.open(thread.id, true);
            }, 4000);
          if (list.some((m) => m.role === "assistant")) this.suggest();
        })
        .catch((e) => {
          if (poll || !latest() || api.needsConsent(e)) return;
          if (cards && cards.length && e.code === "NOT_FOUND") return this.startWith(cards);
          this.setData({ error: errorText(e) });
        })
        .finally(() => {
          if (!poll && latest()) this.setData({ loading: false });
        });
    },
    // Any open still on its way no longer lands (a new topic, a dropped chat).
    nextOpen() {
      this.openSeq = (this.openSeq || 0) + 1;
      return this.openSeq;
    },
    // The chat on screen is gone (deleted): the page starts afresh, and the
    // words typed into it stay, as a new chat's draft.
    dropThread(error) {
      const t = this.data.thread,
        draft = this.data.draft;
      clearTimeout(this.pollTimer);
      this.nextOpen();
      if (t) this.clearDraft(t.id);
      this.suggested = "";
      this.lastSend = null;
      this.setData({ ...FRESH, draft, sending: false, loading: false, error: error || "" });
      this.keepDraft();
    },
    // 开新话题: the chat on screen stays as it is; the page starts empty.
    newTopic() {
      if (this.data.sending) return;
      this.keepDraft();
      clearTimeout(this.pollTimer);
      this.nextOpen();
      this.suggested = "";
      this.lastSend = null;
      this.setData({ ...FRESH, loading: false, focus: true });
      this.restoreDraft();
    },
    // A jot from 随心记: the chat is made first, then the jot is sent in it.
    jot(intent) {
      const text = String(intent.text || "").trim(),
        att = intent.attachments || [];
      if ((!text && !att.length) || this.data.sending) return;
      const id = stream.clientId(),
        cardIds = (intent.cardIds || (intent.cards || []).map((c) => c.id)).slice(0, 3);
      this.follow = true;
      if (!this.data.thread) this.clearDraft("");
      else this.keepDraft();
      this.nextOpen();
      this.setData({
        ...FRESH,
        loading: false,
        messages: [local(id, text, att), waiting(id)],
        sending: true,
      });
      // Only attachments: the chat is named after the first document (or 图片).
      const seed = text || (att.filter((a) => a.kind === "file")[0] || {}).name || "图片",
        ids = att.map((a) => a.id);
      return api
        .post("/v1/chat/threads", {
          text: seed,
          entry: "jot",
          cardIds,
          pointId: intent.pointId || undefined,
          tone: TONE,
        })
        .then(({ thread }) => {
          if (!this.alive) return;
          this.setData({ thread: view(thread), sending: false });
          return this.send({ text, entry: "jot", mode: "auto", ...(ids.length ? { attachmentIds: ids } : {}) }, att);
        })
        .catch((e) => {
          if (!this.alive) return;
          this.setData({ messages: [], sending: false });
          if (!api.needsConsent(e)) this.setData({ draft: text, pending: att, error: errorText(e) });
          this.keepDraft();
        });
    },
    create(body) {
      const seq = this.nextOpen();
      this.setData({ loading: true, error: "", notice: "" });
      return api
        .post("/v1/chat/threads", { ...body, tone: TONE })
        .then(({ thread }) => {
          if (!this.alive || seq !== this.openSeq) return;
          this.show(thread, []);
          this.setData({ focus: true });
        })
        .catch((e) => {
          if (this.alive && !api.needsConsent(e)) this.setData({ error: errorText(e) });
        })
        .finally(() => {
          if (this.alive) this.setData({ loading: false });
        });
    },
    // A chat about cards: from a card, a brainstorm (with its id, so the chat knows the report), or cards picked here first.
    startWith(cards, teach, brainstormId) {
      const card = cards[0];
      return this.create({
        text: card.title || "讲讲这张卡",
        mode: teach ? "teach" : "guide",
        cardIds: cards.map((c) => c.id).slice(0, 3),
        ...(brainstormId ? { brainstormId } : {}),
      });
    },
    startTeach() {
      return this.create({ text: "讲一遍", mode: "teach" });
    },

    // ---- sending ---------------------------------------------------------------
    input(e) {
      this.setData({ draft: e.detail.value });
      this.keepDraftSoon();
      this.studyTouch();
    },
    // 学习时长 : only a chat about study counts; life and mood do not.
    studyOff() {
      return !(this.data.thread && this.data.thread.scene === "study");
    },
    // V4.2 FX5b : the clock settles the time so far before a chat turns
    // to life or mood (or back), so neither side's time is counted as the other.
    sceneTurn(next) {
      const off = !(next && next.scene === "study");
      if (off !== this.studyOff() && typeof this.studyTouch === "function") this.studyTouch();
    },
    blur() {
      keyboard.reset(this);
      if (this.data.focus) this.setData({ focus: false });
    },
    // the page is not pushed up by the keyboard; the input rises above it
    // (utils/keyboard.js). On the tab the keyboard also covers the tab bar.
    keyboardHeight(e) {
      keyboard.change(this, e, () => this.toLatest(), this.gap);
    },
    submit() {
      const text = this.data.draft.trim(),
        pending = this.data.pending;
      if (this.data.sending || this.data.loading) return;
      if (pending.some((x) => x.status === "up")) return this.setData({ notice: "附件还在传，传好了再发" });
      if (pending.some((x) => x.status === "failed"))
        return this.setData({ notice: "有附件没传上，点一下再试，或者删掉" });
      if (!text && !pending.length) return;
      if (!this.data.thread) return this.jot({ text, attachments: pending });
      const ids = pending.map((x) => x.id);
      this.send({ text, mode: "auto", ...(ids.length ? { attachmentIds: ids } : {}) }, pending);
    },

    // ---- attachments  ------------------------------------------------------
    // ＋: 拍照, 相册 or 聊天里的文件; each uploads at once and waits above the input.
    plus() {
      if (this.data.sending) return;
      const room = chat.ATTACH_MAX - this.data.pending.length;
      if (room <= 0) return this.setData({ error: `一次最多发 ${chat.ATTACH_MAX} 个附件` });
      chat
        .chooseSource()
        .then((i) => (i < 0 ? [] : chat.pickAttachments(i, room, pickFailed)))
        .then((list) => {
          if (this.alive && list.length) this.addFiles(list);
        });
    },
    addFiles(list) {
      const room = chat.ATTACH_MAX - this.data.pending.length,
        ok = [];
      let error = "";
      list.forEach((f) => {
        const problem = chat.attachProblem(f);
        if (problem) error = problem;
        else if (ok.length < room) ok.push({ ...f, status: "up" });
        else error = `一次最多发 ${chat.ATTACH_MAX} 个附件`;
      });
      this.setData({ pending: this.data.pending.concat(ok), error, notice: "" });
      this.uploadAll(ok);
    },
    // Photos upload together; documents one after another (the server reads one at a time).
    uploadAll(list) {
      let line = Promise.resolve();
      list.forEach((f) => {
        if (f.kind === "image") this.upload(f);
        else
          line = line.then(() =>
            this.alive && this.data.pending.some((x) => x.key === f.key) ? this.upload(f) : null,
          );
      });
    },
    upload(f) {
      const t = this.data.thread,
        query = `name=${encodeURIComponent(f.name)}${t ? `&threadId=${encodeURIComponent(t.id)}` : ""}${
          f.from ? `&from=${f.from}` : ""
        }`;
      return api
        .uploadTo(`/v1/chat/attachments?${query}`, f.path)
        .then((a) => {
          const i = this.alive ? this.data.pending.findIndex((x) => x.key === f.key) : -1;
          // Removed (or the page closed) while it was uploading.
          if (i < 0) return api.del(`/v1/chat/attachments/${encodeURIComponent(a.id)}`).catch(() => {});
          paths[a.id] = f.path;
          this.setData({
            [`pending[${i}]`]: {
              ...this.data.pending[i],
              id: a.id,
              imageId: a.imageId || "",
              status: "ok",
              ...chat.readPart(a),
            },
          });
          this.keepDraft();
        })
        .catch((e) => {
          if (!this.alive) return;
          const i = this.data.pending.findIndex((x) => x.key === f.key);
          if (api.needsConsent(e)) return;
          // A file the server cannot take goes; one that failed on the way stays, to try again.
          const final = e.statusCode >= 400 && e.statusCode < 500 && e.code !== "DAILY_LIMIT";
          if (i >= 0)
            this.setData(
              final
                ? { pending: this.data.pending.filter((x) => x.key !== f.key) }
                : { [`pending[${i}].status`]: "failed" },
            );
          this.setData({ error: errorText(e) });
        });
    },
    retryattach(e) {
      const key = e.detail.key,
        i = this.data.pending.findIndex((x) => x.key === key);
      if (i < 0 || this.data.pending[i].status !== "failed") return;
      this.setData({ [`pending[${i}].status`]: "up", error: "" });
      this.upload(this.data.pending[i]);
    },
    unpend(e) {
      const key = e.detail.key,
        item = this.data.pending.find((x) => x.key === key);
      if (!item) return;
      if (item.id) api.del(`/v1/chat/attachments/${encodeURIComponent(item.id)}`).catch(() => {});
      this.setData({ pending: this.data.pending.filter((x) => x.key !== key) });
      this.keepDraft();
    },
    // "接着读后面" under a long document sent from this phone: its next part
    // waits above the input, read from where the last one stopped.
    attachmore(e) {
      const key = e.detail.key;
      let found = null;
      this.data.messages.forEach((m) =>
        (m.attachments || []).forEach((a) => {
          if (a.key === key) found = a;
        }),
      );
      if (!found || !found.path || !found.more) return;
      if (this.data.pending.length >= chat.ATTACH_MAX)
        return this.setData({ error: `一次最多发 ${chat.ATTACH_MAX} 个附件` });
      const next = {
        ...chat.attachItem({ kind: "file", name: found.name, size: found.size, path: found.path }),
        from: (found.from || 0) + (found.read || 0),
      };
      this.setData({
        pending: this.data.pending.concat(next),
        draft: this.data.draft || "接着看后面这部分",
        error: "",
      });
      this.upload(next);
    },
    send(payload, att) {
      const thread = this.data.thread;
      if (this.data.sending || !thread) return;
      const again = Boolean(payload.clientId),
        id = payload.clientId || stream.clientId(),
        body = { ...payload, clientId: id, tone: TONE, threadId: thread.id };
      // 再试一次 repeats the words; with attachments it is the same message again (same clientId), so the server answers it once more.
      this.lastSend = payload.attachmentIds ? { ...payload, clientId: id } : payload;
      this.follow = true;
      this.clearDraft(thread.id);
      this.setData({
        messages: this.data.messages
          .filter((m) => !/^(local|wait)_/.test(m.id))
          .concat(again ? [waiting(id)] : [local(id, payload.text, att), waiting(id)]),
        ...(payload.attachmentIds ? { pending: [] } : {}),
        actions: [],
        draft: "",
        sending: true,
        error: "",
        notice: "",
      });
      this.scrollDown(true);
      // Events of this send belong to this chat only.
      this.request = stream.send("/v1/chat/send", body, (event) => this.onEvent(event, id, thread.id));
      return this.request.promise
        .then(({ finished }) => {
          if (!finished) this.stale = true;
        })
        .catch((e) => {
          if (!this.alive || e.code === "CANCELLED") return;
          if (e.code === "NETWORK") {
            this.stale = true;
            return this.setData({ notice: e.message });
          }
          if (api.needsConsent(e)) return;
          const now = this.data.thread;
          // Another chat opened meanwhile: the words wait in that chat's draft.
          if (!now || now.id !== thread.id) {
            if (payload.text && !payload.clientId && owner())
              store.set(draftKey(thread.id), { text: payload.text, files: [], at: Date.now() });
            return;
          }
          // The chat was deleted (elsewhere): the words come back on a fresh page.
          if (e.code === "NOT_FOUND") {
            this.setData({ draft: this.data.draft || payload.text || "" });
            return this.dropThread(errorText(e));
          }
          // Nothing came back: drop the bubbles and give the words back. Attachments go back too, unless the server already bound them to a kept message (STILL_ANSWERING comes after that, chat/service.ts prepare) or one is gone.
          const spent = e.code === "STILL_ANSWERING" || e.code === "ATTACHMENT_NOT_FOUND",
            back = spent ? [] : att || [];
          if (spent && att && att.length) wx.showToast({ title: "附件要重新选", icon: "none" });
          this.setData({
            messages: this.data.messages.filter((m) => m.id !== `local_${id}` && m.id !== `wait_${id}`),
            draft: this.data.draft || payload.text || "",
            pending: this.data.pending.length ? this.data.pending : back,
            error: errorText(e),
          });
          this.keepDraft();
        })
        .finally(() => {
          this.request = null;
          if (!this.alive) return;
          const now = this.data.thread;
          this.setData({ sending: false, actions: this.acts(now, this.data.messages) });
          this.suggest();
          if (now && now.id === thread.id && (this.stale || this.data.messages.some((m) => m.status === "streaming")))
            this.open(now.id);
        });
    },
    index(id) {
      return this.data.messages.findIndex((m) => m.id === id);
    },
    onEvent(event, cid, threadId) {
      if (!this.alive) return;
      const now = this.data.thread;
      // A reply still coming for a chat no longer on screen is left alone; a
      // crisis still opens the crisis page.
      if (threadId && (!now || now.id !== threadId)) {
        if (event.e === "crisis") wx.navigateTo({ url: "/pages/crisis/index" });
        return;
      }
      const patch = {};
      switch (event.e) {
        case "crisis": {
          patch.thread = view(event.thread);
          patch.messages = this.data.messages
            .filter((m) => m.id !== `wait_${cid}`)
            .map((m) => (m.id === `local_${cid}` ? decorate(event.question) : m));
          if (!patch.messages.some((m) => m.id === event.question.id)) patch.messages.push(decorate(event.question));
          patch.actions = [];
          patch.sending = false;
          patch.error = "";
          break;
        }
        // Sent with a threadId, the offer comes before the reply (pending false); only a pending one gets no reply.
        case "scene_candidate": {
          if (event.thread) patch.thread = view(event.thread);
          patch.sceneCandidate = true;
          let list = this.data.messages;
          if (event.pending) list = list.filter((m) => m.id !== `wait_${cid}`);
          if (event.question) list = list.map((m) => (m.id === `local_${cid}` ? decorate(event.question) : m));
          patch.messages = list;
          break;
        }
        case "break_reminder":
          patch.breakReminder = event.text;
          break;
        case "start": {
          patch.thread = view(event.thread);
          const q = this.index(`local_${cid}`),
            r = this.index(`wait_${cid}`);
          if (q >= 0) patch[`messages[${q}]`] = decorate(event.question);
          if (r >= 0) patch[`messages[${r}].id`] = event.replyId;
          break;
        }
        case "thread":
          patch.thread = view(event.thread);
          break;
        case "thinking": {
          const i = this.index(event.id);
          if (i >= 0) patch[`messages[${i}].thinking`] = true;
          break;
        }
        case "blocks": {
          const i = this.index(event.id);
          if (i < 0) break;
          patch[`messages[${i}].blocks`] = this.data.messages[i].blocks.concat(event.blocks);
          patch[`messages[${i}].thinking`] = false;
          break;
        }
        case "tail": {
          const i = this.index(event.id);
          if (i < 0) break;
          patch[`messages[${i}].tail`] = event.text;
          patch[`messages[${i}].thinking`] = false;
          break;
        }
        case "done": {
          const i = this.index(event.message.id);
          if (i >= 0) patch[`messages[${i}]`] = decorate(event.message);
          break;
        }
        case "recheck":
          patch[`messages[${this.data.messages.length}]`] = decorate({
            id: event.id,
            role: "assistant",
            kind: "recheck",
            status: "streaming",
            thinking: true,
          });
          break;
        case "error": {
          const i = event.id ? this.index(event.id) : -1;
          if (i >= 0)
            patch[`messages[${i}]`] = decorate({
              ...this.data.messages[i],
              status: "failed",
              thinking: false,
              tail: "",
              error: { code: event.code, message: event.message },
            });
          else patch.error = event.message;
          break;
        }
        default:
          return;
      }
      if (patch.thread) this.sceneTurn(patch.thread);
      this.setData(patch);
      if (event.e === "crisis") return wx.navigateTo({ url: "/pages/crisis/index" });
      this.scrollDown();
    },
    // Opening a chat lands on its newest message; formulas grow the page after the first render, so look again.
    toLatest() {
      this.follow = true;
      this.lastTop = 0;
      clearTimeout(this.settleTimer);
      const go = () => {
        if (this.alive && this.follow) wx.pageScrollTo({ scrollTop: 1e6, duration: 0 });
      };
      if (wx.nextTick) wx.nextTick(go);
      else go();
      this.settleTimer = setTimeout(() => {
        go();
        this.settleTimer = setTimeout(go, 600);
      }, 300);
    },
    scrollDown(now) {
      if (!this.follow || (this.scrollTimer && !now)) return;
      const run = () => {
        this.scrollTimer = null;
        wx.pageScrollTo({ scrollTop: 1e6, duration: now ? 0 : 200 });
      };
      if (now) return run();
      this.scrollTimer = setTimeout(run, 300);
    },

    // ---- under a reply -------------------------------------------------------------
    // Chips under the newest reply; none after a crisis or while a reply is still being written.
    acts(thread, list) {
      const last = list[list.length - 1],
        reply = list.filter((m) => m.role === "assistant").pop();
      if (!last || last.crisis || !reply || reply.status === "streaming") return [];
      if (reply.status === "failed")
        return this.lastSend ? [{ key: "retry", text: "再试一次", primary: true }] : [];
      return chat.actions(thread, list, false);
    },
    panelAction(e) {
      const { key, value } = e.detail;
      if (key && key.startsWith("guide-")) return this.send({ text: value, mode: "auto" });
      if (key === "card") return this.collectCard(value);
      if (key === "spot") return this.spot({ detail: { id: value } });
      if (key === "end") return this.finish();
      if (key === "teachDone") return this.send({ text: "讲完了", teachDone: true, mode: "auto" });
      if (key === "retry" && this.lastSend) return this.send(this.lastSend);
    },
    // 先聊到这儿: the chat is no longer offered to go on with (until something new is said).
    finish() {
      const t = this.data.thread;
      if (!t) return;
      this.setData({ actions: [] });
      return api
        .patch(`/v1/chat/threads/${t.id}`, { ended: true, tone: TONE })
        .then(() => {
          if (this.alive) this.setData({ notice: "好，先聊到这儿。想接着聊，随时回来。" });
        })
        .catch((e) => {
          if (this.alive && !api.needsConsent(e)) this.setData({ error: errorText(e) });
        });
    },
    // Related cards: fetched at most once per question.
    suggest() {
      const t = this.data.thread;
      if (!t) return;
      const last = this.data.messages.filter((m) => m.role === "user").pop(),
        key = `${t.id}#${last ? last.id : ""}`;
      if (key === this.suggested) return;
      this.suggested = key;
      return api
        .post(`/v1/chat/threads/${t.id}/suggest-cards`, { text: (last && last.plain) || "" })
        .then(({ cards }) => {
          const now = this.data.thread;
          if (this.alive && now && now.id === t.id) this.setData({ suggestions: cards || [] });
        })
        .catch(() => {});
    },

    // ---- the page's ⋯ ----------------------------------------------------------------
    // What the chat is about, 讲一遍, cards, storing the chat, a new topic. Before a chat: a new one to teach, or with cards.
    more() {
      const t = this.data.thread;
      if (this.data.loading || (!t && this.data.sending)) return;
      if (!t)
        return wx.showActionSheet({
          itemList: ["讲一遍", "带上一张卡"],
          success: ({ tapIndex }) => (tapIndex === 0 ? this.startTeach() : this.pickCards()),
        });
      const items = [{ text: `这段在聊：${chat.SCENES[t.scene] || "学习"}`, run: () => this.sceneMenu() }];
      if (t.scene !== "mood")
        items.push(
          t.mode === "teach"
            ? { text: "不讲了，接着聊", run: () => this.patch({ mode: "guide" }) }
            : { text: "讲一遍", run: () => this.patch({ mode: "teach" }) },
        );
      items.push({ text: "带上一张卡", run: () => this.pickCards() });
      if (t.mode !== "teach" && this.data.messages.length)
        items.push({ text: "聊完了，存成卡", run: () => this.openWrap() });
      items.push({ text: "开新话题", run: () => this.newTopic() });
      wx.showActionSheet({
        itemList: items.map((x) => x.text),
        success: ({ tapIndex }) => items[tapIndex] && items[tapIndex].run(),
      });
    },
    // A mood chat stays one, so it gets no menu.
    sceneMenu() {
      const t = this.data.thread;
      if (!t) return;
      if (t.scene === "mood") return wx.showToast({ title: "心情对话不切换，新开一段就行", icon: "none" });
      const scenes = ["study", "life", "mood"];
      wx.showActionSheet({
        itemList: scenes.map((s) => chat.SCENES[s]),
        success: ({ tapIndex }) => {
          const scene = scenes[tapIndex];
          if (!scene || scene === t.scene) return;
          if (scene === "mood") return this.askMood();
          this.patch({ scene });
        },
      });
    },
    // sure: the user already said yes to the offer above the chat.
    askMood(sure) {
      if (!this.data.thread) return;
      if (sure === true) return this.patch({ scene: "mood" });
      wx.showModal({
        title: "换成聊心情？",
        content: "换了以后这段就一直算心情，存下的是心情卡。想聊别的，新开一段就好。",
        confirmText: "换成心情",
        cancelText: "先不用",
        success: ({ confirm }) => {
          if (confirm) this.patch({ scene: "mood" });
        },
      });
    },
    patch(value) {
      const t = this.data.thread;
      if (!t) return Promise.resolve();
      return api
        .patch(`/v1/chat/threads/${t.id}`, { ...value, tone: TONE })
        .then(({ thread }) => {
          const now = this.data.thread;
          if (!this.alive || !now || now.id !== thread.id) return;
          const current = view(thread);
          this.sceneTurn(current);
          this.setData({ thread: current, sceneCandidate: false, actions: this.acts(current, this.data.messages) });
        })
        .catch((e) => {
          if (e.code === "MOOD_CONSENT_REQUIRED") return this.moodConsent(t.id);
          if (!api.needsConsent(e)) wx.showToast({ title: errorText(e), icon: "none" });
        });
    },
    // The switch waits until the consent page reports a yes (moodBack).
    moodConsent(id) {
      this.pendingMood = id;
      getApp().globalData.moodConsentReturn = null;
      this.setData({ moodConsented: false, sceneCandidate: false });
      wx.navigateTo({
        url: `/pages/mood-consent/index?next=${encodeURIComponent(`/pages/chat/index?threadId=${id}`)}`,
      });
    },
    // Whether the consent page just said yes; read once.
    consented() {
      const app = getApp(),
        back = app.globalData.moodConsentReturn;
      app.globalData.moodConsentReturn = null;
      const yes = Boolean(back && back.moodConsented) || Boolean(this.data.moodConsented);
      if (this.data.moodConsented) this.setData({ moodConsented: false });
      return yes;
    },
    moodBack() {
      const id = this.pendingMood;
      this.pendingMood = "";
      const t = this.data.thread;
      if (this.consented() && t && t.id === id) this.patch({ scene: "mood" });
    },
    moodaccept() {
      this.askMood(true);
    },
    mooddecline() {
      this.setData({ sceneCandidate: false });
    },

    // ---- cards ---------------------------------------------------------------------
    pickCards() {
      const app = getApp();
      app.globalData.cardPick = { mode: "chat", selected: chat.selectedIds(this.data.thread), limit: 3 };
      app.globalData.pickedCards = null;
      this.picking = true;
      wx.navigateTo({ url: "/pages/card-pick/index?mode=chat&limit=3" });
    },
    // Back from card-pick: carry the cards along, or start a chat with them.
    picked() {
      this.picking = false;
      const app = getApp(),
        cards = app.globalData.pickedCards;
      app.globalData.pickedCards = [];
      if (!Array.isArray(cards)) return;
      if (this.data.thread) return this.updateCards(cards.map((c) => c.id).slice(0, 3));
      if (cards.length) return this.startWith(cards);
    },
    // Resolves whether the cards were saved.
    updateCards(ids, dismissIds) {
      const t = this.data.thread;
      if (!t) return Promise.resolve(false);
      return api
        .put(`/v1/chat/threads/${t.id}/cards`, { cardIds: ids, dismissIds: dismissIds || [], tone: TONE })
        .then(({ thread }) => {
          if (this.alive) this.setData({ thread: view(thread) });
          return true;
        })
        .catch((e) => {
          if (!api.needsConsent(e)) wx.showToast({ title: errorText(e), icon: "none" });
          return false;
        });
    },
    suggestadd(e) {
      const id = e.detail.id,
        ids = chat.selectedIds(this.data.thread);
      if (ids.includes(id)) return;
      if (ids.length >= 3) return wx.showToast({ title: "一次最多带 3 张卡", icon: "none" });
      this.updateCards(ids.concat(id)).then((saved) => {
        if (saved) this.setData({ suggestions: this.data.suggestions.filter((c) => c.id !== id) });
      });
    },
    suggestdismiss(e) {
      const id = e.detail.id,
        t = this.data.thread;
      if (t) api.post(`/v1/chat/threads/${t.id}/suggest-cards`, { omitIds: [id] }).catch(() => {});
      this.setData({ suggestions: this.data.suggestions.filter((c) => c.id !== id) });
    },
    removecard(e) {
      this.updateCards(chat.selectedIds(this.data.thread).filter((id) => id !== e.detail.id));
    },

    // ---- storing as a card -------------------------------------------------------------
    // Collect says "存好了，在卡片里" itself.
    toCollect(intent) {
      getApp().globalData.collect = intent;
      wx.navigateTo({ url: "/pages/collect/index" });
    },
    // Long press → 收进错题本: the server finds the problem in the chat (409 when there is none).
    mistake(e) {
      const thread = this.data.thread,
        id = e.detail.id;
      if (!thread || !id) return Promise.resolve();
      return api
        .post(`/v1/chat/messages/${encodeURIComponent(id)}/mistake`, { tone: TONE })
        .then((result) => {
          const now = this.data.thread;
          if (this.alive && result && result.thread && now && now.id === thread.id)
            this.setData({ thread: view(result.thread) });
          wx.showToast({ title: "收进错题本了", icon: "none" });
        })
        .catch((e) => {
          if (this.alive && !api.needsConsent(e)) this.setData({ error: errorText(e) });
        });
    },
    collect(e) {
      const m = this.data.messages.find((x) => x.id === e.detail.id);
      if (!m || !this.data.thread) return;
      this.toCollect({ ...chat.collectIntent(m, this.data.thread, m.guide), quotes: chat.quotes(this.data.messages) });
    },
    // "存成待办" and the like: what the reply found worth keeping, as its kind.
    collectCard(id) {
      const m = this.data.messages.find((x) => x.id === id),
        card = m && m.guide && m.guide.card;
      if (!m || !card || !this.data.thread) return;
      this.toCollect({
        ...chat.collectIntent(m, this.data.thread, m.guide),
        type: card.kind || card.type || "",
        title: card.title || "",
        quotes: chat.quotes(this.data.messages),
      });
    },
    spot(e) {
      const m = this.data.messages.find((x) => x.id === e.detail.id);
      if (!m || !this.data.thread || !m.guide) return;
      this.toCollect({
        ...chat.collectIntent(m, this.data.thread, m.guide),
        mine: m.guide.spot,
        quotes: chat.quotes(this.data.messages),
      });
    },
    // 聊完了，存成卡: AI drafts the cards, the collect page stores them. The
    // wait says how long it has been (it can take a while on a long chat).
    openWrap() {
      const t = this.data.thread;
      if (!t || this.data.busy) return;
      const count = this.data.messages.length,
        kept = chat.keptWrap(t.id, count);
      if (kept) return this.toCollect(kept);
      // V4.2 FX5b : the quotes are this chat's, taken now; the account too.
      const who = owner(),
        quotes = chat.quotes(this.data.messages);
      const started = Date.now();
      clearInterval(this.wrapTimer);
      this.wrapTimer = setInterval(() => {
        if (this.alive) this.setData({ wrapWait: Math.round((Date.now() - started) / 1000) });
      }, 5000);
      this.setData({ busy: "wrap", wrapWait: 0, error: "" });
      return api
        .post(`/v1/chat/threads/${t.id}/wrap`, { action: "open" }, { timeout: 150000 })
        .then((draft) => {
          if (!this.alive) return;
          const now = this.data.thread;
          if (!now || now.id !== t.id || owner() !== who) return;
          this.setData({ thread: { ...now, wrapReady: true } });
          // Finished while the learner was elsewhere: only 理好的卡还没存 waits.
          if (!this.hidden) this.toCollect({ mode: "wrap", threadId: t.id, count, draft, quotes });
        })
        .catch((e) => {
          if (this.alive && !api.needsConsent(e)) this.setData({ error: errorText(e) });
        })
        .finally(() => {
          clearInterval(this.wrapTimer);
          if (this.alive) this.setData({ busy: "", wrapWait: 0 });
        });
    },
    teachActive(account, threadId) {
      return this.alive && owner() === account && this.data.thread && this.data.thread.id === threadId;
    },
    teachchange(e) {
      const i = this.index(e.detail.id),
        message = this.data.messages[i];
      if (i < 0 || !message || !message.quote) return;
      this.setData({
        [`messages[${i}].quoteChoices`]: chat.teachQuotes(this.data.messages, message.selectedQuote || message.quote),
      });
    },
    teachpick(e) {
      const i = this.index(e.detail.id),
        message = this.data.messages[i],
        value = String(e.detail.quote || "").trim();
      if (i < 0 || !message || !chat.teachQuotes(this.data.messages, message.quote).includes(value)) return;
      this.setData({ [`messages[${i}].selectedQuote`]: value, [`messages[${i}].quoteChoices`]: [] });
    },
    teachsave(e) {
      const i = this.index(e.detail.id),
        message = this.data.messages[i],
        thread = this.data.thread,
        quote = String(e.detail.quote || (message && message.selectedQuote) || (message && message.quote) || "").trim();
      if (i < 0 || !message || !thread || thread.mode !== "teach" || message.mineSaving || message.mineSaved) return;
      if (quote.length < 10) return this.setData({ error: "这句短了点，换一句长一点的" });
      const target = chat.teachTarget(thread);
      if (!target) return this.toCollect(chat.teachCollectIntent(message, thread, quote, this.data.messages));
      const account = owner(),
        threadId = thread.id;
      this.setData({ [`messages[${i}].mineSaving`]: true, error: "" });
      return api
        .get(`/v1/cards/${encodeURIComponent(target.id)}`)
        .then((card) =>
          this.teachActive(account, threadId)
            ? api.post(`/v1/cards/${encodeURIComponent(target.id)}/mine`, { version: card.version, text: quote })
            : undefined,
        )
        .then((result) => {
          if (!result || !this.teachActive(account, threadId)) return;
          if (result.crisis) return wx.navigateTo({ url: "/pages/crisis/index" });
          this.setData({
            [`messages[${i}].mineSaved`]: true,
            [`messages[${i}].selectedQuote`]: quote,
            [`messages[${i}].quoteChoices`]: [],
          });
          wx.showToast({ title: "存下了", icon: "success" });
        })
        .catch((error) => {
          if (this.teachActive(account, threadId) && !api.needsConsent(error))
            this.setData({ error: errorText(error) });
        })
        .finally(() => {
          if (this.teachActive(account, threadId)) this.setData({ [`messages[${i}].mineSaving`]: false });
        });
    },
    // A guest is offered the welcome page (用户协议和隐私政策).
    agree() {
      gate.ask();
    },
    noop() {},
  };
}

module.exports = room;
module.exports.DRAFT = DRAFT;
module.exports.paths = paths;

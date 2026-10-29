// Steps as editable lines : one box per step, delete a step, add one.
// Fires `change` with { lines } on every edit; the page keeps the lines.
// a deleted step can be put back for a few seconds (撤销).
// a step shows typeset (<rich>, POST /v1/render through utils/tex),
// not its TeX; tapping it opens its text, with the typeset step under the box
// while it is edited. An empty step is a box at once. Plain steps, or a
// render that failed, show as written.
// A step that is all formula ("\frac{1}{2}x") is typeset whole; one with
// words in it only where it has $…$ (utils/tex lineBlocks, V4.2 FX5b).
const { lineBlocks: typeset, lineTex } = require("../../utils/tex");
// Typing waits this long before the step is typeset again.
const WAIT = 400;
Component({
  options: { addGlobalClass: true },
  properties: {
    lines: { type: Array, value: [] },
    max: { type: Number, value: 40 },
    placeholder: { type: String, value: "写下这一步" },
    // 步骤属于当前题目；切换题目后，不能把另一题已删除的步骤恢复到这里。
    owner: { type: String, value: "" },
  },
  data: { undo: null, views: [], editing: -1, preview: null },
  observers: {
    lines(lines) {
      this.show(lines);
    },
    // Set again with the same value, nothing changes.
    owner(owner) {
      if (owner === this.owned) return;
      this.owned = owner;
      clearTimeout(this.undoTimer);
      this.setData({ undo: null, editing: -1, preview: null });
    },
  },
  lifetimes: {
    attached() {
      this.owned = this.data.owner;
      this.show(this.data.lines);
    },
    detached() {
      clearTimeout(this.undoTimer);
      clearTimeout(this.typeTimer);
    },
  },
  methods: {
    emit(lines) {
      this.triggerEvent("change", { lines });
    },
    // What is known at once; the rest is typeset after a short pause.
    show(lines) {
      this.known = this.known || new Map();
      const views = (lines || []).map((line) => this.known.get(line) || null);
      const patch = { views };
      if (this.data.editing >= views.length) patch.editing = -1;
      this.setData(patch);
      clearTimeout(this.typeTimer);
      const todo = (lines || []).filter((line) => String(line || "").trim() && !this.known.has(line));
      if (!todo.length) return Promise.resolve();
      return new Promise((resolve) => {
        this.typeTimer = setTimeout(() => resolve(this.typeset(todo)), this.once ? WAIT : 0);
      });
    },
    typeset(todo) {
      return Promise.all(
        todo.map((line) =>
          typeset(line).then((blocks) => {
            // A render that failed (server busy, network) is tried again next time.
            if (blocks || !lineTex(line)) this.known.set(line, blocks);
          }),
        ),
      ).then(() => {
        // The first steps go at once; typing after that waits a moment.
        this.once = true;
        const lines = this.data.lines || [];
        const editing = this.data.editing;
        const patch = { views: lines.map((line) => this.known.get(line) || null) };
        // The preview keeps the last typeset text until the new one is in.
        if (editing >= 0 && this.known.has(lines[editing])) patch.preview = this.known.get(lines[editing]);
        this.setData(patch);
      });
    },
    edit(event) {
      const i = Number(event.currentTarget.dataset.index);
      if (!(i >= 0 && i < this.data.lines.length)) return;
      this.setData({ editing: i, preview: this.data.views[i] || null });
    },
    done() {
      this.setData({ editing: -1, preview: null });
    },
    input(event) {
      const i = Number(event.currentTarget.dataset.index);
      const lines = this.data.lines.slice();
      lines[i] = event.detail.value;
      if (this.data.editing !== i) this.setData({ editing: i, preview: null });
      this.emit(lines);
    },
    remove(event) {
      const i = Number(event.currentTarget.dataset.index);
      const lines = this.data.lines;
      if (!(i >= 0 && i < lines.length)) return;
      const editing = this.data.editing;
      this.setData({
        undo: { index: i, text: lines[i], no: i + 1 },
        ...(editing === i ? { editing: -1, preview: null } : editing > i ? { editing: editing - 1 } : {}),
      });
      clearTimeout(this.undoTimer);
      this.undoTimer = setTimeout(() => this.setData({ undo: null }), 5000);
      this.emit(lines.filter((_, k) => k !== i));
    },
    restore() {
      const undo = this.data.undo;
      if (!undo) return;
      clearTimeout(this.undoTimer);
      const lines = this.data.lines.slice();
      lines.splice(Math.min(undo.index, lines.length), 0, undo.text);
      const editing = this.data.editing;
      this.setData({ undo: null, ...(editing >= undo.index ? { editing: editing + 1 } : {}) });
      this.emit(lines);
    },
    // A new step opens as a box, ready to type in.
    add() {
      if (this.data.lines.length >= this.data.max) return;
      this.setData({ editing: this.data.lines.length, preview: null });
      this.emit(this.data.lines.concat(""));
    },
  },
});

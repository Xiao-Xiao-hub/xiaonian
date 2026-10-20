// 数字键盘 : the blanks of a number problem and a pad to fill
// them; no system keyboard. The page keeps the values:
//   <numpad blanks="{{problem.blanks}}" values="{{answers}}" active="{{numActive}}"
//           disabled="{{done}}" bindchange="onPad" />
// change { values, active }: after each key or a tap on another blank.
// the pad never hands the answer in; the page's 提交 is the only way.
// With several blanks, 下一空 moves to the next blank still open (dimmed when
// there is none); one blank has no such key.
// The pad keeps its own copy of the values: the page's values come back a
// moment after each change, so a quick second key builds on the first, and a
// late echo of an earlier change is not taken for a new value.
const input = require("./input");

const KEYS = [
  ["7", "8", "9", "back"],
  ["4", "5", "6", "-"],
  ["1", "2", "3", "/"],
  ["0", ".", "ok"],
];
const LABEL = { back: "⌫", "-": "−", "/": "分数", ok: "下一空" };
const ARIA = { back: "删除", "-": "负号", "/": "分数线", ".": "小数点", ok: "下一空" };

function slots(blanks, values, active) {
  return (blanks || []).map((b, i) => ({
    key: `b${i}`,
    label: b.label || "",
    note: b.note || "",
    on: i === active,
    ...input.shown((values || [])[i]),
  }));
}

// The next blank after the active one that is still open; -1 when none.
function otherOpen(values, active) {
  const n = values.length;
  for (let k = 1; k < n; k++) {
    const i = (Number(active || 0) + k) % n;
    if (!input.valid(values[i])) return i;
  }
  return -1;
}

Component({
  options: { addGlobalClass: true },
  properties: {
    blanks: { type: Array, value: [] },
    values: { type: Array, value: [] },
    active: { type: Number, value: 0 },
    disabled: { type: Boolean, value: false },
  },
  data: {
    slots: [],
    // Several blanks: 下一空 shows; `ready` when another blank is still open.
    multi: false,
    ready: false,
    keys: KEYS.map((row, r) =>
      row.map((k) => ({
        k,
        id: `${r}-${k}`,
        text: LABEL[k] || k,
        aria: ARIA[k] || k,
        cls: k === "ok" ? "ok" : /\d/.test(k) ? "" : "fn",
      })),
    ),
  },
  observers: {
    "blanks, values, active": function (blanks, values, active) {
      this.sync(blanks, values, active);
    },
  },
  methods: {
    // The page's values: an echo of a change sent from here (and of any sent
    // before it) is dropped; anything else is the page's own (a new problem).
    sync(blanks, values, active) {
      const n = (blanks || []).length;
      const state = {
        values: Array.from({ length: n }, (_, i) => String((values || [])[i] || "")),
        active: Number(active) || 0,
      };
      const sent = this.sent || [];
      const at = sent.indexOf(JSON.stringify(state));
      const same = JSON.stringify(blanks || []) === this.blanksKey;
      if (at >= 0 && same) this.sent = sent.slice(at + 1);
      else {
        this.sent = [];
        this.state = state;
        this.blanksKey = JSON.stringify(blanks || []);
      }
      this.show();
    },
    current() {
      if (!this.state) this.sync(this.data.blanks, this.data.values, this.data.active);
      return { values: this.state.values.slice(), active: this.state.active };
    },
    show() {
      const { values, active } = this.state;
      this.setData({
        slots: slots(this.data.blanks, values, active),
        multi: values.length > 1,
        ready: otherOpen(values, active) >= 0,
      });
    },
    change(values, active) {
      this.state = { values, active };
      this.sent = (this.sent || []).concat(JSON.stringify(this.state)).slice(-20);
      this.show();
      this.triggerEvent("change", { values: values.slice(), active });
    },
    pick(event) {
      if (this.data.disabled) return;
      const i = Number(event.currentTarget.dataset.index);
      const { values, active } = this.current();
      if (i !== active) this.change(values, i);
    },
    key(event) {
      if (this.data.disabled) return;
      const k = event.currentTarget.dataset.k;
      const { values, active: at } = this.current();
      if (!values.length) return;
      const active = Math.min(Math.max(0, at), values.length - 1);
      if (k === "ok") {
        const open = otherOpen(values, active);
        if (open >= 0) this.change(values, open);
        return;
      }
      const next = input.press(values[active], k);
      if (next === values[active]) return;
      values[active] = next;
      this.change(values, active);
    },
  },
});

"use strict";
// V4.1 G4 : the number pad for bank blanks. Input rules are pure
// (components/numpad/input.js); the component turns keys into change/submit.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const pad = require(path.join(root, "components/numpad/input.js"));

const type = (keys, start = "") => keys.reduce((v, k) => pad.press(v, k), start);

test("pad input: digits, one point per number, one fraction bar, sign toggles", () => {
  assert.equal(type(["1", "2"]), "12");
  assert.equal(type(["0", "5"]), "5");
  assert.equal(type(["."]), "0.");
  assert.equal(type(["1", ".", "5", "."]), "1.5");
  assert.equal(type(["/"]), "", "no bar before a digit");
  assert.equal(type(["3", "/", "4"]), "3/4");
  assert.equal(type(["3", "/", "4", "/"]), "3/4", "one bar");
  assert.equal(type(["3", "/", ".", "5"]), "3/0.5");
  assert.equal(type(["3", "-"]), "-3");
  assert.equal(type(["3", "-", "-"]), "3");
  assert.equal(type(["-", "3", "/", "4"]), "-3/4");
  assert.equal(type(["3", "/", "4", "back", "back"]), "3");
  assert.equal(type(["x"]), "", "unknown key");
  const long = type(Array(30).fill("9"));
  assert.equal(long.length, pad.MAX);
});

test("pad valid: ends in a digit; ASCII only", () => {
  for (const v of ["0", "2", "-3", "0.5", "3/4", "-3/4", "1.5/2"]) assert.ok(pad.valid(v), v);
  for (const v of ["", "-", "3/", "0.", "3/4/5", "½", "√2", "--1"]) assert.ok(!pad.valid(v), v);
});

test("pad shown: a fraction stacks, the minus in front", () => {
  assert.deepEqual(pad.shown("-3/4"), {
    empty: false,
    neg: true,
    frac: true,
    num: "3",
    den: "4",
    text: "-3/4",
  });
  assert.equal(pad.shown("3/").frac, true);
  assert.equal(pad.shown("3/").den, "");
  assert.equal(pad.shown("").empty, true);
  assert.equal(pad.nextOpen(["1", "", "2"], 0), 1);
  assert.equal(pad.nextOpen(["", "1", "2"], 1), 0);
  assert.equal(pad.nextOpen(["1", "2"], 0), -1);
});

function component() {
  let def;
  global.Component = (value) => {
    def = value;
  };
  const file = path.join(root, "components/numpad/index.js");
  delete require.cache[file];
  require(file);
  const events = [];
  const c = {
    data: { ...structuredClone(def.data), blanks: [], values: [], active: 0, disabled: false },
    setData(patch) {
      Object.assign(this.data, patch);
    },
    triggerEvent(name, detail) {
      events.push([name, detail]);
    },
    ...def.methods,
  };
  const set = (patch) => {
    Object.assign(c.data, patch);
    def.observers["blanks, values, active"].call(c, c.data.blanks, c.data.values, c.data.active);
  };
  const key = (k) => c.key({ currentTarget: { dataset: { k } } });
  return { c, def, events, set, key };
}

// 确定 used to hand the answer in once every blank was filled, so a
// stray tap submitted. It is now 下一空 and only moves; 提交 is the page's.
test("numpad: keys change the active blank; 下一空 jumps to an open blank and never submits", () => {
  const { c, def, events, set, key } = component();
  assert.deepEqual(
    def.data.keys.map((row) => row.map((k) => k.text)),
    [
      ["7", "8", "9", "⌫"],
      ["4", "5", "6", "−"],
      ["1", "2", "3", "分数"],
      ["0", ".", "下一空"],
    ],
  );
  set({ blanks: [{ label: "a" }, { label: "b" }], values: ["", ""], active: 0 });
  assert.equal(c.data.slots.length, 2);
  assert.equal(c.data.slots[0].on, true);
  key("3");
  assert.deepEqual(events.pop(), ["change", { values: ["3", ""], active: 0 }]);
  set({ values: ["3", ""] });
  key("ok");
  assert.deepEqual(events.pop(), ["change", { values: ["3", ""], active: 1 }]);
  set({ active: 1 });
  key("/");
  assert.equal(events.length, 0, "no bar before a digit: nothing changes");
  key("1");
  set({ values: ["3", "1"] });
  events.length = 0;
  key("/");
  set({ values: ["3", "1/"] });
  assert.equal(c.data.slots[1].frac, true);
  assert.deepEqual(events.pop(), ["change", { values: ["3", "1/"], active: 1 }]);
  assert.equal(c.data.ready, false, "下一空 dims: no other blank is open");
  key("ok");
  assert.equal(events.length, 0, "下一空 on the only open blank stays put");
  key("2");
  set({ values: ["3", "1/2"] });
  events.length = 0;
  key("ok");
  assert.equal(events.length, 0, "every blank filled: 下一空 does nothing, nothing is submitted");
  // A tap on the other blank moves to it; disabled ignores everything.
  c.pick({ currentTarget: { dataset: { index: 0 } } });
  assert.deepEqual(events.pop(), ["change", { values: ["3", "1/2"], active: 0 }]);
  set({ disabled: true });
  key("5");
  c.pick({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(events.length, 0);
});

test("numpad template: no system keyboard, stacked fractions, page binds it on blanks", () => {
  const wxml = fs.readFileSync(path.join(root, "components/numpad/index.wxml"), "utf8");
  assert.doesNotMatch(wxml, /<input/);
  assert.match(wxml, /frac/);
  const page = fs.readFileSync(path.join(root, "pages/point/index.wxml"), "utf8");
  assert.match(page, /<numpad[^>]*bindchange="onPad"/s);
  assert.doesNotMatch(page, /<numpad[^>]*bindsubmit/s, "only the page's 提交 submits");
  const json = JSON.parse(fs.readFileSync(path.join(root, "pages/point/index.json"), "utf8"));
  assert.equal(json.usingComponents.numpad, "/components/numpad/index");
});

test("pad input: the minus counts toward MAX; -0 is sent as 0, 3/0 is left for the server", () => {
  const full = type(Array(pad.MAX).fill("9"));
  assert.equal(pad.press(full, "-"), full, "no minus past MAX");
  const neg = type(["-", ...Array(pad.MAX - 1).fill("9")]);
  assert.equal(neg.length, pad.MAX);
  assert.equal(pad.press(neg, "9"), neg);
  assert.equal(pad.press(neg, "-"), neg.slice(1), "the minus can always come off");
  // Typing goes through "-0" on the way to "-0.5".
  assert.equal(type(["-", "0", ".", "5"]), "-0.5");
  assert.equal(pad.normalize("-0"), "0");
  assert.equal(pad.normalize("-0.00"), "0.00");
  assert.equal(pad.normalize("-0/3"), "0/3");
  assert.equal(pad.normalize("-0.5"), "-0.5");
  assert.equal(pad.normalize("-10"), "-10");
  assert.equal(pad.normalize("3/0"), "3/0");
  assert.equal(pad.normalize(""), "");
});

test("numpad: quick keys build on each other; a late echo is not taken back; the page's own change is", () => {
  const { c, events, set, key } = component();
  set({ blanks: [{ label: "" }], values: [""], active: 0 });
  assert.equal(c.data.ready, false);
  // Two keys before the page's values come back.
  key("3");
  key("5");
  assert.deepEqual(events.map((e) => e[1].values), [["3"], ["35"]]);
  assert.equal(c.data.slots[0].text, "35");
  assert.equal(c.data.ready, false, "one blank: no 下一空 to light");
  assert.equal(c.data.multi, false);
  // The echoes arrive late, in order: the pad stays at 35.
  set({ values: ["3"] });
  assert.equal(c.data.slots[0].text, "35");
  key("1");
  assert.deepEqual(events.at(-1)[1].values, ["351"]);
  set({ values: ["35"] });
  set({ values: ["351"] });
  assert.equal(c.data.slots[0].text, "351");
  // A new problem: the page sets its own values.
  set({ blanks: [{ label: "a" }, { label: "b" }], values: ["", ""], active: 0 });
  assert.equal(c.data.slots.length, 2);
  assert.equal(c.data.slots[0].text, "");
  assert.equal(c.data.ready, true, "two empty blanks: 下一空 can move on");
  key("7");
  assert.deepEqual(events.at(-1), ["change", { values: ["7", ""], active: 0 }]);
  // The page clears the same problem: taken, not an echo.
  set({ values: ["", ""] });
  assert.equal(c.data.slots[0].text, "");
});

test("numpad template: 下一空 dims when no other blank is open, hides with one blank", () => {
  const wxml = fs.readFileSync(path.join(root, "components/numpad/index.wxml"), "utf8");
  assert.match(wxml, /item\.k==='ok'&&!ready\?'off'/);
  assert.match(wxml, /item\.k==='ok'&&!multi\?'np-none'/);
  const wxss = fs.readFileSync(path.join(root, "components/numpad/index.wxss"), "utf8");
  assert.match(wxss, /\.np-key\.ok\.off/);
});

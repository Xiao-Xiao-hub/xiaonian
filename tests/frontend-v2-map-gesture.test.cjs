const test = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path");
const context = { module: { exports: {} } };
vm.runInNewContext(
  fs.readFileSync(
    path.join(
      __dirname,
      "../miniprogram/pages/map/components/stage/gesture.wxs",
    ),
    "utf8",
  ),
  context,
);
const g = context.module.exports;
function owner() {
  const state = {},
    calls = [];
  const classes = new Set(["mid"]);
  return {
    state,
    calls,
    classes,
    getState: () => state,
    selectComponent: () => ({
      setStyle() {},
      removeClass: (c) => classes.delete(c),
      addClass: (c) => classes.add(c),
    }),
    callMethod: (name, value) => calls.push([name, value]),
  };
}
function event(touches, time = 0) {
  return {
    touches: touches.map(([pageX, pageY]) => ({ pageX, pageY })),
    timeStamp: time,
    currentTarget: { dataset: { left: 20, top: 100 } },
  };
}
test("pinch uses viewport coordinates, preserves the focal point and isolates each map instance", () => {
  const a = owner(),
    b = owner();
  g.motionChanged("0,0,0.5", null, a);
  g.motionChanged("8,9,0.7", null, b);
  g.start(
    event([
      [80, 200],
      [120, 200],
    ]),
    a,
  );
  g.move(
    event(
      [
        [60, 200],
        [140, 200],
      ],
      16,
    ),
    a,
  );
  assert.equal(a.state.motion.s, 1);
  assert.equal(a.state.motion.tx, -80);
  assert.equal(a.state.motion.ty, -100);
  assert.equal(b.state.motion.tx, 8);
  assert.equal(b.state.motion.s, 0.7);
  assert.ok(a.classes.has("near"));
  assert.equal(a.classes.has("mid"), false);
  g.end(event([], 32), a);
  assert.equal(a.calls.at(-1)[0], "gestureSettle");
  assert.equal(a.calls.at(-1)[1].moved, true);
});
test("lifting one finger from a pinch continues dragging without jumping or settling early", () => {
  const a = owner();
  g.motionChanged("0,0,0.5", null, a);
  g.start(
    event([
      [80, 200],
      [120, 200],
    ]),
    a,
  );
  g.move(
    event(
      [
        [60, 200],
        [140, 200],
      ],
      16,
    ),
    a,
  );
  g.end(event([[60, 200]], 32), a);
  const x = a.state.motion.tx,
    y = a.state.motion.ty;
  g.move(event([[70, 205]], 48), a);
  assert.equal(a.state.motion.tx, x + 10);
  assert.equal(a.state.motion.ty, y + 5);
  assert.equal(a.calls.filter(([name]) => name === "gestureSettle").length, 0);
});

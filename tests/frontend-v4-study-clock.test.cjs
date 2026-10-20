// 学习时长的计时规则 (V4.md 约定 6): utils/study-clock.js with a fake clock.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const clockPath = path.join(root, "utils/study-clock.js");
const gatePath = path.join(root, "utils/gate.js");
const MIN = 60 * 1000;

function fresh(storage = {}) {
  global.wx = {
    getStorageSync: (key) => storage[key],
    setStorageSync: (key, value) => {
      storage[key] = value;
    },
  };
  delete require.cache[clockPath];
  delete require.cache[gatePath];
  return require(clockPath);
}
// A clock with fake time and timers; posts are recorded.
function harness(options = {}) {
  const lib = fresh();
  let now = 1_000_000;
  let timers = [];
  const posts = [];
  let allowed = options.allowed !== undefined ? options.allowed : true;
  const clock = lib.create({
    now: () => now,
    post: (seconds) => {
      posts.push(seconds);
      return options.post ? options.post(seconds) : Promise.resolve({ recorded: true });
    },
    allowed: () => allowed,
    setInterval: (fn, ms) => {
      const timer = { fn, ms, next: now + ms };
      timers.push(timer);
      return timer;
    },
    clearInterval: (timer) => {
      timers = timers.filter((t) => t !== timer);
    },
  });
  // Moves time forward, firing interval timers on the way.
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      now = due.next;
      due.next += due.ms;
      due.fn();
      await Promise.resolve();
    }
    now = end;
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    clock,
    lib,
    posts,
    advance,
    flush,
    timers: () => timers,
    setAllowed: (value) => {
      allowed = value;
    },
  };
}

test.afterEach(() => {
  delete global.wx;
});

test("time counts only within 2 minutes of the last touch", async () => {
  const h = harness();
  h.clock.start();
  await h.advance(5 * MIN);
  // Opening the page counts as a touch: 2 of the 5 minutes.
  assert.equal(Math.round(h.clock.pending()), 120);
  h.clock.touch();
  await h.advance(1 * MIN);
  h.clock.touch();
  await h.advance(30 * 1000);
  await h.clock.stop();
  assert.deepEqual(h.posts, [210]);
  assert.equal(h.clock.pending(), 0);
});

test("leaving the page sends what was timed and stops the timer", async () => {
  const h = harness();
  h.clock.start();
  assert.equal(h.timers().length, 1);
  await h.advance(40 * 1000);
  const sent = await h.clock.stop();
  assert.equal(sent, true);
  assert.deepEqual(h.posts, [40]);
  assert.equal(h.timers().length, 0);
  // Nothing in front: touches and time do not count.
  h.clock.touch();
  await h.advance(10 * MIN);
  await h.clock.stop();
  assert.deepEqual(h.posts, [40]);
});

test("a page shown before the last one hid keeps its own time", async () => {
  const h = harness();
  const a = { id: "a" };
  const b = { id: "b" };
  h.clock.start(a);
  await h.advance(30 * 1000);
  // The next page shows first, then the one before it hides.
  h.clock.start(b);
  await h.clock.stop(a);
  assert.deepEqual(h.posts, [30]);
  await h.advance(60 * 1000);
  h.clock.touch();
  await h.advance(30 * 1000);
  await h.clock.stop(b);
  assert.deepEqual(h.posts, [30, 90]);
  assert.equal(h.timers().length, 0);
});

test("time while the page says it is not study is not counted", async () => {
  const h = harness();
  const page = { mood: false, studyOff() { return this.mood; } };
  h.clock.start(page);
  await h.advance(60 * 1000);
  page.mood = true;
  h.clock.touch();
  await h.advance(60 * 1000);
  await h.clock.stop(page);
  assert.deepEqual(h.posts, [60]);
});

test("every full 5 minutes of study is sent while the page stays open", async () => {
  const h = harness();
  h.clock.start();
  for (let i = 0; i < 24; i++) {
    await h.advance(30 * 1000);
    h.clock.touch();
  }
  await h.flush();
  // 12 minutes touched all along: two reports of 300, the rest on leaving.
  assert.deepEqual(h.posts, [300, 300]);
  await h.clock.stop();
  assert.deepEqual(h.posts, [300, 300, 120]);
});

test("a few seconds wait for the next page instead of a request", async () => {
  const h = harness();
  h.clock.start();
  await h.advance(3 * 1000);
  await h.clock.stop();
  assert.deepEqual(h.posts, []);
  h.clock.start();
  await h.advance(4 * 1000);
  await h.clock.stop();
  assert.deepEqual(h.posts, [7]);
});

test("one report never goes over 900 seconds", async () => {
  const h = harness({ post: () => Promise.reject(new Error("offline")) });
  h.clock.start();
  for (let i = 0; i < 40; i++) {
    await h.advance(30 * 1000);
    h.clock.touch();
  }
  await h.flush();
  await h.clock.stop();
  await h.flush();
  assert.ok(h.posts.every((s) => s >= 1 && s <= 900));
  // Failed reports are kept, but only one report's worth.
  assert.ok(h.clock.pending() <= 900);
});

test("guests and turned-off statistics send nothing", async () => {
  const h = harness({ allowed: false });
  h.clock.start();
  await h.advance(3 * MIN);
  await h.clock.stop();
  assert.deepEqual(h.posts, []);
  assert.equal(h.timers().length, 0);

  // Turned off while timing: what was timed is dropped.
  const g = harness();
  g.clock.start();
  await g.advance(MIN);
  g.setAllowed(false);
  await g.clock.stop();
  assert.deepEqual(g.posts, []);
  assert.equal(g.clock.pending(), 0);
});

test("the server saying recorded: false turns the clock off on this phone", async () => {
  const h = harness({ post: () => Promise.resolve({ recorded: false }) });
  h.clock.start();
  await h.advance(MIN);
  await h.clock.stop();
  assert.equal(wx.getStorageSync(h.lib.PREF_KEY), "0");
});

test("the shared clock follows gate and the stored switch", () => {
  const storage = {};
  const lib = fresh(storage);
  const gate = require(gatePath);
  const config = require(path.join(root, "utils/config.js"));
  storage[gate.CONSENT_KEY] = { v: config.PRIVACY_VERSION, age: "adult", at: "x" };
  // Allowed: start sets a timer (cleared again by stop).
  const realSet = global.setInterval,
    realClear = global.clearInterval;
  let set = 0;
  global.setInterval = () => {
    set++;
    return 1;
  };
  global.clearInterval = () => {};
  try {
    lib.clock().start();
    assert.equal(set, 1);
    lib.clock().stop();
    lib.setEnabled(false);
    lib.clock().start();
    assert.equal(set, 1);
    lib.setEnabled(true);
    delete storage[gate.CONSENT_KEY];
    storage[gate.GUEST_KEY] = "1";
    lib.clock().start();
    assert.equal(set, 1);
  } finally {
    global.setInterval = realSet;
    global.clearInterval = realClear;
  }
});

test("track keeps the page's own hooks and adds studyTouch", () => {
  const lib = fresh();
  const calls = [];
  const options = lib.track({
    data: { x: 1 },
    onShow() {
      calls.push(["show", this.id]);
    },
    onHide() {
      calls.push("hide");
    },
    other() {
      return 42;
    },
  });
  assert.deepEqual(options.data, { x: 1 });
  assert.equal(options.other(), 42);
  for (const name of ["onShow", "onHide", "onUnload", "studyTouch"])
    assert.equal(typeof options[name], "function", name);
  // Without consent the clock itself does nothing; the page hooks still run.
  global.wx.reLaunch = () => {};
  options.onShow.call({ id: "p" });
  options.onHide.call({ id: "p" });
  options.onUnload.call({ id: "p" });
  options.studyTouch.call({ id: "p" });
  assert.deepEqual(calls, [["show", "p"], "hide"]);
});

test("only study chats and study cards are study time; the switch goes with the account", () => {
  // V4.2 : the chat page's code is utils/chat-room.js; life and mood are not study.
  const chat = fs.readFileSync(path.join(root, "utils/chat-room.js"), "utf8");
  const card = fs.readFileSync(path.join(root, "pages/card/index.js"), "utf8");
  assert.match(chat, /studyOff\(\) \{\s+return !\(this\.data\.thread && this\.data\.thread\.scene === "study"\);/);
  assert.match(chat, /input\(e\) \{\s+this\.setData\(\{ draft: e\.detail\.value \}\);[\s\S]{0,40}this\.studyTouch\(\);/);
  assert.match(card, /studyOff\(\) \{\s+return !\(this\.data\.card && this\.data\.card\.scene === "study"\);/);
  const lib = fresh({ zhiye_study_time: "0" });
  const storage = { zhiye_study_time: "0", "zhiye_last_point:u1": { pointId: "p" } };
  global.wx = {
    getStorageSync: (key) => storage[key],
    setStorageSync: (key, value) => {
      storage[key] = value;
    },
    removeStorageSync: (key) => {
      delete storage[key];
    },
  };
  const spacePath = path.join(root, "utils/learning-space.js");
  delete require.cache[spacePath];
  require(spacePath).clear("u1");
  assert.equal(storage[lib.PREF_KEY], undefined);
  assert.equal(storage["zhiye_last_point:u1"], undefined);
});

test("the study pages are hooked up and nothing reminds about streaks", () => {
  const pages = ["ask", "learn", "map", "point", "chapter", "practice", "problem", "mistakes", "chat", "card", "review"];
  for (const name of pages) {
    const js = fs.readFileSync(path.join(root, `pages/${name}/index.js`), "utf8");
    const wxml = fs.readFileSync(path.join(root, `pages/${name}/index.wxml`), "utf8");
    assert.match(js, /studyClock\.track\(/, name);
    assert.match(wxml, /capture-bind:touchstart="studyTouch"/, name);
  }
  const source = fs.readFileSync(clockPath, "utf8");
  assert.doesNotMatch(source, /showToast|showModal|requestSubscribeMessage/);
});

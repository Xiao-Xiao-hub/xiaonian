/*
 * 有效学习时长采集：跟随页面生命周期记录前台学习区间，再上报给服务端。
 * 页面离开、进入非学习场景或账号变化时停止旧区间，不能把后台等待计作学习时长。
 */
// 学习时长. A study page is timed while
// it is in front and someone touched it in the last 2 minutes. What was timed is
// sent on leaving the page, on onHide and every full 5 minutes. Nothing is sent
// for a guest or with the statistics turned off, and nothing ever reminds anyone
// of a streak.
//
// Hooking up a page takes two lines:
//   index.js    Page(studyClock.track({...the page's own options }))
//   index.wxml  capture-bind:touchstart="studyTouch" on the page's outer view
// track keeps the page's own onShow / onHide / onUnload and calls them first.
// A page whose time is not study right now (a mood chat) says so with a
// studyOff method returning true; that time is not counted.
const gate = require("./gate");

const ACTIVE_MS = 2 * 60 * 1000;
const FLUSH_SECONDS = 5 * 60;
const MAX_REPORT = 900;
// Leftovers under this wait for the next page instead of a request of their own.
const MIN_REPORT = 5;
const TICK_MS = 30 * 1000;
// "0" once the learner turned the statistics off; on unless that.
const PREF_KEY = "zhiye_study_time";

function enabledFromStorage() {
  try {
    return wx.getStorageSync(PREF_KEY) !== "0";
  } catch (_) {
    return true;
  }
}

// deps: now, post(seconds) -> Promise<{ recorded }>, allowed -> boolean,
// setInterval / clearInterval.
function create(deps) {
  let pending = 0; // seconds timed and not sent yet, for every page
  let session = null; // the page in front: { owner, mark, until, timer }
  let sending = false;

  // Counts up to now: only the part still inside 2 minutes of the last touch,
  // and none of it while the page in front says it is not study.
  function settle(now) {
    if (!session) return;
    const end = Math.min(now, session.until);
    const page = session.owner;
    const off = Boolean(page && typeof page.studyOff === "function" && page.studyOff());
    if (end > session.mark && !off) pending += (end - session.mark) / 1000;
    session.mark = Math.max(session.mark, now);
  }
  function send(force) {
    if (sending || !deps.allowed()) {
      if (!deps.allowed()) pending = 0;
      return Promise.resolve(false);
    }
    const seconds = Math.min(MAX_REPORT, Math.floor(pending));
    if (seconds < (force ? MIN_REPORT : FLUSH_SECONDS)) return Promise.resolve(false);
    pending -= seconds;
    sending = true;
    return Promise.resolve()
      .then(() => deps.post(seconds))
      .then((result) => {
        if (result && result.recorded === false) {
          pending = 0;
          setEnabled(false);
        }
        return true;
      })
      .catch(() => {
        // Kept for the next try, but never more than one report's worth.
        pending = Math.min(MAX_REPORT, pending + seconds);
        return false;
      })
      .then((sent) => {
        sending = false;
        return sent;
      });
  }
  function tick() {
    settle(deps.now());
    if (pending >= FLUSH_SECONDS) send(false);
  }
  // A page shown takes the clock over, so the page before it hiding after
  // that (the order is not fixed) does not stop the new page's time.
  function start(owner) {
    if (!deps.allowed()) return stop();
    const now = deps.now();
    if (session) settle(now);
    else session = { owner, mark: now, until: now, timer: null };
    session.owner = owner;
    // Opening a page is itself a tap.
    session.until = now + ACTIVE_MS;
    if (!session.timer) session.timer = deps.setInterval(tick, TICK_MS);
  }
  function touch() {
    if (!session) return;
    const now = deps.now();
    settle(now);
    session.until = now + ACTIVE_MS;
  }
  function stop(owner) {
    if (session && (owner === undefined || session.owner === owner)) {
      settle(deps.now());
      if (session.timer) deps.clearInterval(session.timer);
      session = null;
    }
    return send(true);
  }
  return {
    start,
    touch,
    stop,
    tick,
    pending: () => pending,
  };
}

function setEnabled(on) {
  try {
    wx.setStorageSync(PREF_KEY, on ? "1" : "0");
  } catch (_) {
    /* Only decides whether to time. */
  }
}

let shared = null;
function clock() {
  if (!shared)
    shared = create({
      now: () => Date.now(),
      post: (seconds) => require("./api").post("/v1/me/study-time", { seconds }),
      allowed: () => gate.state() === "ok" && enabledFromStorage(),
      setInterval: (fn, ms) => {
        const id = setInterval(fn, ms);
        // Under Node (the tests) the timer must not keep the process alive.
        if (id && typeof id.unref === "function") id.unref();
        return id;
      },
      clearInterval: (id) => clearInterval(id),
    });
  return shared;
}

// Wraps a page's options: its own hooks run first, then the clock's.
function track(options) {
  const own = options || {};
  const chain = (name, after) =>
    function chained(...args) {
      const result = typeof own[name] === "function" ? own[name].apply(this, args) : undefined;
      after(this);
      return result;
    };
  return {
    ...own,
    onShow: chain("onShow", (page) => clock().start(page)),
    onHide: chain("onHide", (page) => clock().stop(page)),
    onUnload: chain("onUnload", (page) => clock().stop(page)),
    studyTouch(...args) {
      clock().touch();
      if (typeof own.studyTouch === "function") return own.studyTouch.apply(this, args);
    },
  };
}

module.exports = {
  ACTIVE_MS,
  FLUSH_SECONDS,
  MAX_REPORT,
  PREF_KEY,
  create,
  track,
  setEnabled,
  clock,
};

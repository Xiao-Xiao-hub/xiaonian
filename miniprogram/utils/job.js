/*
 * 任务轮询：围绕一个服务端 job 提供暂停、恢复、停止、进度和完成回调。
 * 暂时断网等错误按间隔退避；停止时推进 generation，晚到的旧轮询不能继续更新页面。
 */
// V4.2 W0: shared job polling for long waits (import read/split, brainstorm,
// and later 批改 / 讲一遍). One watcher per job:
//   const w = watch(job, { onUpdate, onDone, onError });
//   onHide -> w.pause; onShow -> w.resume; onUnload -> w.stop
// stop only stops asking; the job keeps running on the server.
// A short offline spell (no network, 5xx, 429, timeouts) is retried with a
// growing pause instead of giving up; onError(error, { retrying: true })
// lets the page say so. Anything else (404, consent, account change) stops
// and reports onError(error, { retrying: false }).
// utils/api is looked up on each poll, so tests can swap it per page.
const api = () => require("./api");

const PENDING = ["queued", "running"];
const pending = (job) => Boolean(job && PENDING.includes(job.status));

function transient(error) {
  if (!error) return false;
  const status = Number(error.statusCode) || 0;
  return (
    error.code === "NETWORK" ||
    status >= 500 ||
    status === 429 ||
    /TIMEOUT/.test(String(error.code || ""))
  );
}

function watch(job, options = {}) {
  const interval = options.interval || 1500;
  const maxDelay = options.maxDelay || 15000;
  const call = (name, ...args) => {
    if (typeof options[name] === "function") options[name](...args);
  };
  let current = job;
  let timer = null;
  let paused = false;
  let stopped = !pending(job);
  let busy = false;
  let delay = interval;
  // Bumped by stop; answers to an older generation are dropped.
  let generation = 0;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const schedule = (ms) => {
    clear();
    if (stopped || paused || busy) return;
    timer = setTimeout(tick, ms);
  };
  function tick() {
    timer = null;
    if (stopped || paused || busy) return;
    busy = true;
    const mine = generation;
    Promise.resolve()
      .then(() => api().get(`/v1/jobs/${encodeURIComponent(current.id)}`))
      .then((next) => {
        busy = false;
        if (mine !== generation || stopped) return;
        delay = interval;
        current = next || current;
        call("onUpdate", current);
        if (pending(current)) return schedule(interval);
        stopped = true;
        call("onDone", current);
      })
      .catch((error) => {
        busy = false;
        if (mine !== generation || stopped) return;
        if (transient(error)) {
          delay = Math.min(maxDelay, delay * 2);
          call("onError", error, { retrying: true });
          return schedule(delay);
        }
        stopped = true;
        call("onError", error, { retrying: false });
      });
  }

  if (stopped) {
    // Already finished: report it on the next turn, like a poll would.
    setTimeout(() => {
      if (generation === 0 && job) call("onDone", job);
    }, 0);
  } else schedule(interval);

  return {
    pause() {
      paused = true;
      clear();
    },
    // Asks right away (the page was away), then keeps the usual pace.
    resume() {
      if (stopped) return;
      paused = false;
      delay = interval;
      schedule(0);
    },
    stop() {
      stopped = true;
      generation += 1;
      clear();
    },
    job: () => current,
    active: () => !stopped,
  };
}

const FAILED = ["failed", "unknown", "cancelled"];
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// 将服务端任务进度转换为 task-progress 组件的数据：
// steps 是按真实阶段排列的 {key,label}；sinceMs 是进度未变的时间，elapsedMs 是任务运行时间。
// floor 与 lastIndex 保存上次展示位置，进度条不倒退，任务成功前不能显示 100%。
// 只有服务端报告已进入下一阶段，前一阶段才能标为完成。排队任务不勾选步骤，进度条为空。
// 运行中的任务若未上报阶段或重启丢失进度，停留在已知阶段内缓慢推进，不越过该阶段终点。
// 尚未获得 job 时，没有完成阶段的依据；当前步骤为第一步，进度只随时间变化。
// vague 等待将阶段合成一行展示；unit 表示 progress.step 的单位，默认“批”，逐题时用“题”。
function progressView(steps, job, options = {}) {
  const list = (steps || []).filter((step) => step && step.key);
  const n = Math.max(1, list.length);
  const elapsedMs = Math.max(0, Number(options.elapsedMs) || 0);
  const sinceMs = Math.max(0, Number(options.sinceMs) || 0);
  const expectMs = Number(options.expectMs) || 60000;
  const floor = Number(options.floor) || 0;
  const last = Number(options.lastIndex) || 0;
  const status = job ? job.status : "queued";
  const progress = (job && job.progress) || {};
  const done = status === "succeeded";
  const failed = FAILED.includes(status) || Boolean(options.error);
  let index = list.findIndex((step) => step.key === progress.stage);
  const queued = Boolean(job) && status === "queued" && !failed;
  const tick = 1 - Math.exp(-sinceMs / Math.max(5000, expectMs / n));
  let raw;
  if (index >= 0) {
    // Within the step: batches, pages or streamed text; time otherwise.
    const stream = progress.expect
      ? clamp((Number(progress.chars) || 0) / progress.expect, 0, 1)
      : 0.8 * tick;
    let inner;
    if (progress.steps)
      inner = ((clamp(progress.step || 1, 1, progress.steps) - 1) + stream) / progress.steps;
    else if (progress.pages)
      inner = ((clamp(progress.page || 1, 1, progress.pages) - 1) + 0.8 * tick) / progress.pages;
    else inner = stream;
    raw = ((index + clamp(inner, 0, 0.95)) / n) * 100;
  } else if (job && !done && !failed) {
    index = queued ? -1 : clamp(last, 0, n - 1);
    raw = queued ? 0 : ((index + 0.8 * tick) / n) * 100;
  } else if (!job && !failed) {
    index = 0;
    raw = 95 * (1 - Math.exp(-elapsedMs / expectMs));
  } else {
    // A finished job no longer carries its stage: keep the last one seen.
    raw = 95 * (1 - Math.exp(-elapsedMs / expectMs));
    index = done
      ? n - 1
      : failed
        ? clamp(last, 0, n - 1)
        : Math.min(n - 1, Math.max(last, Math.floor((raw / 100) * n)));
  }
  const percent = done
    ? 100
    : failed && floor
      ? Math.round(floor)
      : Math.round(clamp(Math.max(floor, raw), 0, 95));
  const rows = list.map((step, i) => {
    let state = i < index ? "done" : i === index ? "now" : "todo";
    if (done) state = "done";
    else if (failed && i === index) state = "stop";
    let note = "";
    if (state === "now" && progress.stage === step.key) {
      if (progress.pages)
        note = `第 ${clamp(progress.page || 1, 1, progress.pages)}/${progress.pages} 页`;
      else if (progress.steps > 1)
        note = `第 ${clamp(progress.step || 1, 1, progress.steps)}/${progress.steps} ${options.unit || "批"}`;
    }
    return { key: step.key, label: step.label, state, note };
  });
  if (options.vague && !job && rows.length > 1)
    rows.splice(0, rows.length, { key: rows[0].key, label: list.map((step) => step.label).join(" · "), state: rows[0].state, note: "" });
  const message = failed
    ? options.error ||
      (job && job.error && job.error.message) ||
      "这次没跑完，可以再试一次"
    : "";
  return { rows, percent, done, failed, queued, message, index };
}

function elapsedText(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (seconds < 60) return `已用 ${seconds} 秒`;
  const rest = seconds % 60;
  return `已用 ${Math.floor(seconds / 60)} 分${rest ? ` ${rest} 秒` : ""}`;
}

module.exports = { watch, pending, transient, progressView, elapsedText };

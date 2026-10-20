// V4.2 W0: progress for a long job (导入识图、拆卡、头脑风暴; later 批改、讲一遍).
// <task-progress steps="{{steps}}" job="{{job}}" bind:retry="retry" />
// Properties:
//   steps      [{key,label}] in the job's stage order (job.progress.stage)
//   job        the public job (status, progress, error, createdAt); null while
//              the request that creates it is still on its way
//   startedAt  ms epoch on this phone; default job.createdAt (server clock)
//   error      text that overrides the job's own (e.g. a failed request)
//   expectSec  rough length, for the time-based part of the bar (60)
//   slowAfter  seconds before the "可以先去做别的" line (25)
//   retryText  "重试"; leaveText: "" (no leave link)
//   busy       disables 重试 while the page is starting a retry
//   unit       what progress.step counts: "批" (default), "题"
//   vague      no stages from the server, only time: the bar moves but no
//              percentage is shown (V4.2 FX2: 讲完了, AI 加练)
// Events: retry, leave. On success the bar fills; the page moves on itself.
const clock = require("../../utils/clock");
const { progressView, elapsedText } = require("../../utils/job");

Component({
  options: { addGlobalClass: true },
  properties: {
    steps: { type: Array, value: [] },
    job: { type: Object, value: null },
    startedAt: { type: Number, value: 0 },
    error: { type: String, value: "" },
    expectSec: { type: Number, value: 60 },
    slowAfter: { type: Number, value: 25 },
    retryText: { type: String, value: "重试" },
    leaveText: { type: String, value: "" },
    busy: { type: Boolean, value: false },
    unit: { type: String, value: "批" },
    vague: { type: Boolean, value: false },
  },
  data: {
    rows: [],
    percent: 0,
    elapsed: "",
    slow: false,
    done: false,
    failed: false,
    message: "",
  },
  observers: {
    "steps, job, error, startedAt": function () {
      this.update();
    },
  },
  lifetimes: {
    attached() {
      this.update();
    },
    detached() {
      this.halt();
    },
  },
  pageLifetimes: {
    show() {
      this.update();
    },
    hide() {
      this.halt();
    },
  },
  methods: {
    started() {
      if (this.properties.startedAt) return this.properties.startedAt;
      const job = this.properties.job;
      const created = job && Date.parse(job.createdAt || "");
      // createdAt is server time; compare it with the server-adjusted clock.
      if (created) return Date.now() - Math.max(0, clock.now() - created);
      return this.attachedAt || (this.attachedAt = Date.now());
    },
    update() {
      const { steps, job, error, expectSec, slowAfter } = this.properties;
      const id = (job && job.id) || "";
      if (id !== this.jobId) {
        // Another job (a retry): start the bar over.
        this.jobId = id;
        this.floor = 0;
        this.lastIndex = 0;
      }
      const progress = (job && job.progress) || {};
      const sign = `${job ? job.status : ""}|${progress.stage || ""}|${progress.page || ""}|${progress.step || ""}`;
      if (sign !== this.sign) {
        this.sign = sign;
        this.signAt = Date.now();
      }
      const elapsedMs = Math.max(0, Date.now() - this.started());
      const view = progressView(steps, job, {
        elapsedMs,
        sinceMs: Date.now() - this.signAt,
        expectMs: (expectSec || 60) * 1000,
        floor: this.floor,
        lastIndex: this.lastIndex,
        error,
        unit: this.properties.unit,
        vague: this.properties.vague,
      });
      this.floor = view.percent;
      this.lastIndex = view.index;
      const waiting = !view.done && !view.failed;
      this.setData({
        rows: view.rows,
        percent: view.percent,
        done: view.done,
        failed: view.failed,
        message: view.message,
        // not started yet, so no step is done.
        elapsed: waiting
          ? `${view.queued ? "排队中 · " : ""}${elapsedText(elapsedMs)}`
          : "",
        slow: waiting && elapsedMs >= (slowAfter || 25) * 1000,
      });
      if (waiting) this.tick();
      else this.halt();
    },
    tick() {
      if (this.timer) return;
      this.timer = setInterval(() => this.update(), 1000);
    },
    halt() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    },
    retry() {
      if (this.properties.busy) return;
      this.triggerEvent("retry", { jobId: this.jobId });
    },
    leave() {
      this.triggerEvent("leave");
    },
  },
});

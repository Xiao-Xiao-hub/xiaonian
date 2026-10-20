// V4.2 W0: 随心记 "进行中" — unfinished imports and brainstorms of the last
// 7 days, one row each; tapping opens the page that picks it up again.
// Hidden when there is nothing. Refreshes every time the page shows.
const api = require("../../utils/api");
const gate = require("../../utils/gate");

const { importRow, PENDING, RETRY } = require("../../utils/import-row");

function brainstormRow(item) {
  const job = item.job || null;
  const running = Boolean(job && PENDING.includes(job.status));
  let state;
  if (["ready", "paused"].includes(item.status)) state = "想好了，接着看";
  else if (running) state = "在想";
  else state = RETRY;
  return {
    key: `brainstorm-${item.id}`,
    title: item.title || `${item.count || ""} 张卡的头脑风暴`,
    state,
    retry: state === RETRY,
    url: `/pages/brainstorm/process/index?id=${encodeURIComponent(item.id)}`,
  };
}

// Newest first across both lists.
function stripRows(imports, brainstorms) {
  const items = (list) => (list && Array.isArray(list.items) ? list.items : []);
  return [
    ...items(imports).map((item) => ({ at: item.updatedAt, row: importRow(item) })),
    ...items(brainstorms).map((item) => ({ at: item.updatedAt, row: brainstormRow(item) })),
  ]
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
    .slice(0, 5)
    .map((entry) => entry.row);
}

Component({
  options: { addGlobalClass: true },
  data: { rows: [] },
  lifetimes: {
    attached() {
      this.refresh();
    },
  },
  pageLifetimes: {
    show() {
      this.refresh();
    },
  },
  methods: {
    refresh() {
      if (gate.state() !== "ok") {
        if (this.data.rows.length) this.setData({ rows: [] });
        return Promise.resolve();
      }
      // attached and the first show come together: ask once.
      if (this.loading) return this.loading;
      const quiet = () => null;
      this.loading = Promise.all([
        api.get("/v1/imports?open=1").catch(quiet),
        api.get("/v1/brainstorms?open=1").catch(quiet),
      ])
        .then(([imports, brainstorms]) => {
          // Both failed (offline): keep what was shown.
          if (!imports && !brainstorms) return;
          this.setData({ rows: stripRows(imports, brainstorms) });
        })
        .finally(() => {
          this.loading = null;
        });
      return this.loading;
    },
    open(event) {
      const url = event.currentTarget.dataset.url;
      if (url) wx.navigateTo({ url });
    },
  },
});

module.exports = { stripRows };

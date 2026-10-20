/*
 * 导入记录展示：将服务端导入状态转换为列表文案、进度和继续处理入口。
 * 列表应展示真实处理状态，不把部分读取或失败记录显示成全部完成。
 */
// V4.2 W0: one unfinished import as a row — its title, where it stopped and
// the page that picks it up again. shared by 随心记's strip and
// the import page's full list (moved here from components/task-strip).
const PENDING = ["queued", "running"];
const ENDED = ["failed", "unknown", "cancelled"];
const RETRY = "没跑完，点开重试";
const NO_TEXT = "没认出字，点开看看";

function importRow(item) {
  const job = item.job || null;
  const running = Boolean(job && PENDING.includes(job.status));
  // A failed read stays on the import after "先用读到的"; only the step the
  // import is at counts.
  const readJob = Boolean(job && ["import_read", "import_scan_pdf"].includes(job.kind));
  const ended = Boolean(
    job &&
      ENDED.includes(job.status) &&
      (item.status === "reading" ? readJob : item.status === "read" ? !readJob : true),
  );
  // pictures that did not all arrive (the page was left while sending).
  const unsent = Boolean(
    !job &&
      item.status === "reading" &&
      ["photo", "screenshot"].includes(item.source) &&
      item.pages &&
      (Number(item.retryPages) || 0) < item.pages.total,
  );
  let state;
  if (item.status === "picking") state = "可以挑卡了";
  else if (unsent) state = "图片没传完，点开接着传";
  // a read where no page gave words (free) says so.
  else if (ended && job.error && job.error.code === "IMPORT_NO_TEXT") state = NO_TEXT;
  else if (ended) state = RETRY;
  else if (item.status === "splitting") state = running ? "拆卡中" : RETRY;
  else if (item.status === "reading")
    state = !running
      ? "读了一部分，点开接着弄"
      : item.pages && item.pages.total
        ? `第 ${Math.min(item.pages.done + 1, item.pages.total)}/${item.pages.total} 页`
        : "在读";
  else state = "读好了，接着拆卡";
  const page = item.status === "picking" ? "split" : "source";
  return {
    key: `import-${item.id}`,
    title: item.title || "一次导入",
    state,
    retry: state === RETRY || state === NO_TEXT,
    url: `/pages/import/${page}/index?id=${encodeURIComponent(item.id)}`,
  };
}

module.exports = { importRow, PENDING, ENDED, RETRY };

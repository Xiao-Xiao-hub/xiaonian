/*
 * 管理台纯数据函数：将接口统计转换为金额、比例、日期、趋势和分页结果。
 * 不访问 DOM、不发送请求；浏览器行为在 app.js，纯函数测试在 tests/admin-model.test.mjs。
 */
export function dateTime(value) {
  const date = new Date(value);
  return !value || Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "short",
        timeStyle: "medium",
        timeZone: "Asia/Shanghai",
      }).format(date);
}
export function number(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("zh-CN")
    : "—";
}
export function duration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0)
    return "—";
  if (seconds < 60) return `${Math.round(seconds * 10) / 10} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  const hours = Math.floor(seconds / 3600);
  return hours < 24
    ? `${hours} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`
    : `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}
// Never turn an unconnected billing source into a zero-cost claim.
export function costLabel(cost) {
  if (
    cost?.status !== "available" ||
    typeof cost.amount !== "number" ||
    !Number.isFinite(cost.amount) ||
    cost.amount < 0 ||
    !cost.currency
  )
    return "尚未接入账单";
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: cost.currency,
    }).format(cost.amount);
  } catch {
    return "金额格式待核对";
  }
}
export function usageTrend(rows = []) {
  const count = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : 0;
  const data = rows.map((row) => ({
    date: row.date,
    calls: count(row.calls),
    tokens: count(row.promptTokens) + count(row.completionTokens),
    jobs: count(row.jobs),
    chatAnswers: count(row.chatAnswers),
    photos: count(row.photos),
    unknownJobs: count(row.unknown ?? row.unknownJobs),
  }));
  const max = Math.max(1, ...data.map((row) => row.calls));
  return data.map((row) => ({ ...row, height: row.calls / max }));
}
export function pageSlice(items, requestedPage = 1, pageSize = 20) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.max(
    1,
    Math.min(
      pages,
      Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1,
    ),
  );
  return {
    rows: items.slice((page - 1) * pageSize, page * pageSize),
    page,
    pages,
    total: items.length,
  };
}
// Totals across job kinds; the success rate counts finished jobs only.
export function jobTotals(kinds) {
  const sum = (key) =>
    kinds.reduce((total, kind) => total + (Number(kind[key]) || 0), 0);
  const succeeded = sum("succeeded");
  const failed = sum("failed");
  const unknown = sum("unknown");
  const pending = sum("queued") + sum("running");
  const finished = succeeded + failed + unknown;
  return {
    total: finished + pending,
    pending,
    failed,
    unknown,
    successRate: finished ? succeeded / finished : null,
  };
}
// The live queue covers every creation date, unlike the seven-day job summary.
export function queuePending(queue) {
  if (
    !queue ||
    !Number.isSafeInteger(queue.queued) ||
    !Number.isSafeInteger(queue.running) ||
    queue.queued < 0 ||
    queue.running < 0
  )
    return null;
  return queue.queued + queue.running;
}
export function percent(ratio) {
  return typeof ratio === "number" && Number.isFinite(ratio)
    ? `${Math.round(ratio * 100)}%`
    : "—";
}
export function ratio(part, whole) {
  return whole > 0 ? part / whole : null;
}
export function bytes(value) {
  let size = Number(value);
  if (value === null || !Number.isFinite(size) || size < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${unit ? size.toFixed(1) : size} ${units[unit]}`;
}
// 地图题反馈 (quality view): headers and one row per point, counts only.
export const MAP_REPORT_REASONS = {
  judge: "判错了",
  problem: "题目或答案有错",
  unclear: "看不懂",
  other: "其他问题",
};
export function mapReportTable(items = []) {
  return {
    headers: [
      "知识点",
      "章",
      "反馈",
      "人数",
      ...Object.values(MAP_REPORT_REASONS),
    ],
    rows: items.map((item) => [
      item.name,
      item.chapter,
      item.total,
      item.users,
      ...Object.keys(MAP_REPORT_REASONS).map(
        (reason) => item.reasons?.[reason] ?? 0,
      ),
    ]),
  };
}

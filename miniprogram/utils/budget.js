/*
 * 额度提示：将服务端费用额度转换为页面警示、剩余额度和等待提示。
 * 只解释服务端结果，不在前端扣费；旧响应中的次数额度仍按既有兼容规则显示。
 */
// the daily and weekly allowance, as the server's used percentages
// (`budget` in /v1/me/usage and /v1/chat/usage). A server without budgets
// sends none; pages then keep their old count lines.
const DAY_MS = 86400000;
function valid(budget) {
  return Boolean(
    budget &&
      budget.day &&
      budget.week &&
      typeof budget.day.pct === "number" &&
      typeof budget.week.pct === "number",
  );
}
// The day resets at the next midnight, the week on Monday; when the week
// ends tonight both read 明天.
function reset(resetAt, now = Date.now()) {
  const ms = Date.parse(resetAt);
  if (!ms) return "";
  return ms - now <= DAY_MS ? "明天 0 点恢复" : "下周一 0 点恢复";
}
function line(budget) {
  return valid(budget)
    ? `今天已用 ${budget.day.pct}% · 本周已用 ${budget.week.pct}%`
    : "";
}
// One line once either window reaches 80%; "" before that.
function low(budget, now = Date.now()) {
  if (!valid(budget)) return "";
  const { day, week } = budget;
  if (week.pct >= 100) return `这周的额度用完了，${reset(week.resetAt, now)}`;
  if (day.pct >= 100) return `今天的额度用完了，${reset(day.resetAt, now)}`;
  if (week.pct >= 80) return `本周已用 ${week.pct}%，${reset(week.resetAt, now)}`;
  if (day.pct >= 80) return `今天已用 ${day.pct}%，${reset(day.resetAt, now)}`;
  return "";
}
module.exports = { valid, reset, line, low };

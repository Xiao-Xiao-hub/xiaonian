/*
 * 共用文案格式：格式化日期、时长、资料类型和错误，供页面保持一致显示。
 * 设备本地日期与服务端业务日期用途不同；修改日期提示时保留对应时区测试。
 */
const clock = require("./clock");

function pad(n) {
  return String(n).padStart(2, "0");
}
function date(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? ""
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// "今天 14:05", "昨天 09:30" or "9月28日".
function when(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date(clock.now());
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const diff =
    (start - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
  if (diff === 0) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 1) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
// "9月30日 星期二", by the phone's calendar.
function today() {
  const d = new Date(clock.now());
  return `${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[d.getDay()]}`;
}
// What went wrong, in one plain sentence. The request id only goes to the log.
function errorText(error) {
  if (error && error.requestId)
    console.warn("request failed", error.code || "", error.requestId);
  return (error && error.message) || "没成功，再试一次";
}
// Non-whitespace characters, the same count the server enforces.
function countChars(text) {
  return String(text || "").replace(/\s/g, "").length;
}
// Splits text so numbers can be emphasised: [{ text, num }].
function highlightNumbers(text) {
  return String(text || "")
    .split(/(\d+(?:\.\d+)?%?)/)
    .filter(Boolean)
    .map((part) => ({ text: part, num: /^\d/.test(part) }));
}
// The model sometimes repeats the label the page already shows ("第 1 条提示：", "完整解析：").
function stripLead(text) {
  return String(text || "").replace(
    /^\s*(?:第\s*[1-3一二三]\s*条\s*提示|提示\s*[1-3一二三]|完整解析)\s*[:：]\s*/,
    "",
  );
}
// "2026-10-02" -> "今天" / "明天" / "10月2日". Due dates are Beijing dates (the server
// counts days in UTC+8), so today is the Beijing date too, whatever the phone's zone.
function dueText(day) {
  const [y, m, d] = String(day || "")
    .split("-")
    .map(Number);
  if (!y || !m || !d) return "";
  const now = new Date(clock.now() + 8 * 3600000);
  const start = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const diff = Math.round((Date.UTC(y, m - 1, d) - start) / 86400000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "明天";
  return `${m}月${d}日`;
}
// "2026-10-05" or an ISO time -> "10/5". Times read on the Beijing calendar, like
// the server's days, so an answer at 07:00 Beijing is not shown as the day before.
function monthDay(value) {
  const text = String(value || "");
  const ms = text.includes("T") ? Date.parse(text) : NaN;
  const day = Number.isNaN(ms) ? text : new Date(ms + 8 * 3600000).toISOString();
  const match = day.match(/^(?:\d{4}-)?(\d{2})-(\d{2})/);
  return match ? `${Number(match[1])}/${Number(match[2])}` : "";
}
const KIND = { note: "资料", problem: "题目" };
// Where a reference answer came from, in plain words (README §6.2).
const SOURCE = {
  user: "你给的答案",
  rule: "算过一遍，对得上",
  ai: "AI 给的，还没算过",
};
// Green once the program confirmed it, amber while nobody has, red when the
// program got something else.
const SOURCE_TONE = { user: "ink", rule: "green", ai: "amber" };
function sourceOf(answer) {
  if (!answer) return { text: "", tone: "" };
  if (answer.disputed) return { text: "我又算了一遍，对不上，你也核一下", tone: "red" };
  return {
    text: SOURCE[answer.source] || "",
    tone: SOURCE_TONE[answer.source] || "",
  };
}
function citeText(citations) {
  return citations && citations.length ? `第 ${citations.join("、")} 段` : "";
}
// An ISO time as "2026-10-14 09:30" on the Beijing calendar.
function stamp(value) {
  const ms = Date.parse(String(value || ""));
  if (Number.isNaN(ms)) return "";
  const text = new Date(ms + 8 * 3600000).toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 16)}`;
}
// Today's Beijing date ("2026-10-14"), or that many days later.
function beijingDay(days = 0) {
  return new Date(clock.now() + 8 * 3600000 + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
module.exports = {
  stamp,
  beijingDay,
  date,
  when,
  today,
  errorText,
  countChars,
  highlightNumbers,
  stripLead,
  citeText,
  dueText,
  monthDay,
  KIND,
  sourceOf,
};

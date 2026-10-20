const { TYPES: CARD_TYPES, KIND_TYPE: EXTRA_KIND_TYPE } = require("../../utils/cards");
// the seven kinds a candidate can be (cards.kind); the first four are
// also the four-way type old clients know.
const KINDS = ["spark", "idea", "question", "method", "todo", "knowledge", "note"];
const TYPES = Object.fromEntries(KINDS.map((kind) => [kind, CARD_TYPES[kind].name]));
const KIND_TYPE = Object.fromEntries(
  KINDS.map((kind) => [kind, EXTRA_KIND_TYPE[kind] || kind]),
);
const kindOf = (item) =>
  TYPES[item && item.kind] ? item.kind : TYPES[item && item.type] ? item.type : "idea";
const SCENES = { study: "学习", life: "生活", mood: "心情" };

function clientId(prefix = "import") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function sizeText(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

// Page counts help while pictures are read; character counts stay hidden.
function jobLine(job, phase) {
  if (!job) return "";
  if (job.status === "succeeded") return phase === "split" ? "拆好了" : "读完了";
  if (!["queued", "running"].includes(job.status)) return "";
  const progress = job.progress || {};
  if (progress.pages)
    return `正在认第 ${Math.min(progress.page || 1, progress.pages)}/${progress.pages} 页`;
  if (progress.thinking) return "读完了，在想怎么拆…";
  return phase === "split" ? "正在拆，稍等…" : "正在读，稍等…";
}

function pageLine(item) {
  if (item.pageRange && item.pageRange.from)
    return item.pageRange.from === item.pageRange.to
      ? `第 ${item.pageRange.from} 页`
      : `第 ${item.pageRange.from}–${item.pageRange.to} 页`;
  const pages = (item.pages || []).map((page) => page.n).filter(Boolean);
  if (!pages.length) return "";
  return pages.length === 1
    ? `第 ${pages[0]} 页`
    : `第 ${pages[0]}–${pages[pages.length - 1]} 页`;
}

function candidateView(candidate, edit, selected, pointAccepted) {
  const merged = { ...candidate, ...(edit || {}) };
  // An edit that picked a four-way type (older drafts) wins over the kind.
  const kind = edit && edit.type && !edit.kind ? edit.type : kindOf(merged);
  const type = CARD_TYPES[kind] || CARD_TYPES.idea;
  const src = Array.isArray(merged.src) ? merged.src : [];
  return {
    ...merged,
    kind,
    selected: Boolean(selected),
    typeName: TYPES[kind] || "卡片",
    typeIcon: type.icon,
    typeStyle: `--type-main:${type.main};--type-ink:${type.ink};--type-wash:${type.wash};--type-border:${type.border}`,
    sceneName: SCENES[merged.scene] || "",
    srcLabel: src.length ? `出自第 ${src.join("、")} 段` : "看原文",
    tags: (merged.tags || []).slice(0, 3),
    pointAccepted: Boolean(pointAccepted),
    pointName: merged.pointName || "这个知识点",
  };
}

// Sentences of a text, in order, with their end marks (for picking one).
function sentences(text) {
  return (String(text || "").match(/[^。！？!?；;\n]+[。！？!?；;]*/g) || [])
    .map((part) => part.trim())
    .filter(Boolean);
}

// drafts kept while the import pages are left (per account). Storage
// can fail (full, or not there in tests): a draft is a convenience only.
// The drafts live in the main package (utils/drafts) for the capture page.
const { draftGet, draftSet } = require("../../utils/drafts");

// the real stages of the import jobs, for <task-progress>.
const READ_STEPS = [{ key: "read", label: "认图片里的字" }];
const SPLIT_STEPS = [
  { key: "split", label: "拆成卡" },
  { key: "check", label: "检查一遍" },
];
const READ_KINDS = ["import_read", "import_scan_pdf"];

module.exports = {
  READ_STEPS,
  SPLIT_STEPS,
  READ_KINDS,
  TYPES,
  KINDS,
  KIND_TYPE,
  kindOf,
  sentences,
  draftGet,
  draftSet,
  SCENES,
  clientId,
  sizeText,
  jobLine,
  pageLine,
  candidateView,
};

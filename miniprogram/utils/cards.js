/*
 * 卡片展示辅助：转换类型、场景、标签、来源与状态，为列表和详情生成一致视图。
 * 保留用户原话和AI内容的来源区别；编辑与保存仍走 cards 接口。
 */
const TYPES = {
  spark: {
    name: "灵感",
    mark: "✦",
    cls: "spark",
    main: "#DD6418",
    ink: "#A3460C",
    wash: "#FFF1E5",
    border: "#FBD3B5",
    close: "长成",
    icon: "/assets/icons/card-spark.svg",
  },
  idea: {
    name: "想法",
    mark: "“",
    cls: "idea",
    main: "#3D6FF2",
    ink: "#1D4ED0",
    wash: "#ECF2FF",
    border: "#C8D7FD",
    close: "落地",
    icon: "/assets/icons/card-idea.svg",
  },
  question: {
    name: "问题",
    mark: "?",
    cls: "question",
    main: "#E2477E",
    ink: "#AD2459",
    wash: "#FDEDF3",
    border: "#F5C3D5",
    close: "解决",
    icon: "/assets/icons/card-question.svg",
  },
  method: {
    name: "思路",
    mark: "↗",
    cls: "method",
    main: "#0E9584",
    ink: "#0A6B5F",
    wash: "#E3F6F2",
    border: "#B2E3DA",
    close: "用上",
    icon: "/assets/icons/card-method.svg",
  },
  // three more kinds (cards.kind); old clients still see the four types.
  todo: {
    name: "待办",
    mark: "□",
    cls: "todo",
    main: "#F29B0F",
    ink: "#A2650A",
    wash: "#FFF4DE",
    border: "#F6D394",
    close: "做完",
    icon: "/assets/icons/card-todo.svg",
  },
  knowledge: {
    name: "知识点",
    mark: "≡",
    cls: "knowledge",
    main: "#2D4766",
    ink: "#29466A",
    wash: "#EDF1F6",
    border: "#D3DDE9",
    close: "记住",
    icon: "/assets/icons/card-knowledge.svg",
  },
  note: {
    name: "随手记",
    mark: "·",
    cls: "note",
    main: "#8F959E",
    ink: "#646A73",
    wash: "#F2F3F5",
    border: "#DFE1E6",
    close: "收好",
    icon: "/assets/icons/card-note.svg",
  },
};
// The four-way type each kind is stored under for old clients.
const KIND_TYPE = { todo: "idea", knowledge: "method", note: "idea" };
const kindOf = (card) =>
  TYPES[card.kind] ? card.kind : TYPES[card.type] ? card.type : "idea";

const SLOT_LABELS = {
  seed: "核心",
  expand: "往哪展开",
  claim: "我认为",
  why: "因为",
  ask: "问句",
  known: "已知",
  stuck: "卡在哪",
  cause: "错因",
  when: "什么时候用",
  steps: "步骤",
  example: "例子",
  pitfall: "易错",
};
const SCENES = { study: "学习", life: "生活", mood: "心情" };
const ORIGINS = {
  jot: "随心记",
  chat: "聊天",
  import: "导入",
  brainstorm: "头脑风暴",
  mistake: "错题本",
  map: "学习地图",
  note: "旧随心记",
};
const TAG_COLORS = [
  { name: "灰蓝", bg: "#D3DDE9", ink: "#29466A" },
  { name: "雾蓝", bg: "#CFE3EA", ink: "#1E5163" },
  { name: "浅棕", bg: "#E9D9CA", ink: "#64422A" },
  { name: "浅灰", bg: "#E2E3E5", ink: "#3F444B" },
  { name: "藏青", bg: "#2D4766", ink: "#FFFFFF" },
  { name: "岩蓝", bg: "#2E5A68", ink: "#FFFFFF" },
  { name: "咖啡", bg: "#5B4131", ink: "#FFFFFF" },
  { name: "深灰", bg: "#474C53", ink: "#FFFFFF" },
];

// one rule for the wall and the card page. A card with a
// summary, organized slots or a next step counts as 已整理, whoever tidied
// it (V4.2 servers already send it so in `stage`; older ones do not).
function tidied(card) {
  return Boolean(
    card.summary ||
      card.next ||
      (card.slots || []).some((slot) => slot && String(slot.text || "").trim()),
  );
}
function stage(card) {
  const organized =
    card.organizedAt || card.organized_at || tidied(card)
      ? "organized"
      : "written";
  if (card.scene === "mood") return card.mine ? "clear" : organized;
  const current =
    card.stage ||
    (card.mine
      ? card.closedAt || card.closed_at
        ? "closed"
        : "clear"
      : organized);
  return current === "written" ? organized : current;
}
function title(card) {
  const value = String(card.title || "").trim();
  if (value)
    return { text: value, ai: card.titleBy === "ai" || card.title_by === "ai" };
  const fallback = String(card.quote || card.summary || "")
    .trim()
    .slice(0, 16);
  return { text: fallback || "还没起名", ai: false };
}
const shortDate = require("./format").monthDay;
const { markBlocks } = require("./blocks");
// Stage words and progress.
const STAGES = {
  written: { name: "已记下", pct: 25 },
  organized: { name: "已整理", pct: 50 },
  clear: { name: "已说清", pct: 75 },
  closed: { name: "已完成", pct: 100 },
};
const MOOD_PCT = { written: 33, organized: 67, clear: 100 };
// the stage in each kind's own words; the last one is what "done"
// means for it. 随手记 shows no stage; a 待办 is either to do or done.
const DONE_WORDS = {
  spark: "长成了",
  idea: "落地了",
  question: "弄明白了",
  method: "用上了",
  knowledge: "记住了",
  todo: "做完了",
};
function stageWord(kind, current, mood) {
  if (mood) return STAGES[current === "closed" ? "clear" : current].name;
  if (kind === "note") return current === "closed" ? "收好了" : "";
  if (current === "closed") return DONE_WORDS[kind] || STAGES.closed.name;
  if (kind === "todo") return "要做";
  return STAGES[current].name;
}
// 提醒频率  in words.
const REMIND_EVERY = { day: "每天", week: "每周" };
// The tile's line under the title as text runs, colour marks kept: the
// summary (summaryMarked when a server sends the marked one; `summary` comes
// with the marks taken out), else the first organized slot (slotsMarked from
// v4 servers, plain slots from older ones), else my words.
function sumParts(card) {
  const slots = card.slotsMarked || card.slots || [];
  const first = slots.find((slot) => slot && String(slot.text || "").trim());
  const text = String(
    card.summaryMarked ||
      card.summary ||
      (first && first.text) ||
      card.mine ||
      "",
  ).trim();
  const block = markBlocks(text)[0];
  return block
    ? block.c.map((x) => ({
        v: x.v,
        cls: x.mk ? `mk ${x.mk}${x.hi ? " hi" : ""}` : "",
      }))
    : [];
}
// "已完成" cards go last in 全部; the order inside each part stays.
function doneLast(cards) {
  const list = cards || [];
  return list.filter((c) => !c.done).concat(list.filter((c) => c.done));
}
function tagView(tag) {
  const color = TAG_COLORS[Number(tag.color)] || TAG_COLORS[0];
  return {
    ...tag,
    colorName: color.name,
    style: `background:${color.bg};color:${color.ink}`,
  };
}
function view(card) {
  const raw = card || {},
    kind = kindOf(raw),
    type = TYPES[kind],
    current = stage(raw),
    dots = raw.scene === "mood" ? 3 : 4;
  const filled =
    current === "closed"
      ? 4
      : current === "clear"
        ? 3
        : current === "organized"
          ? 2
          : 1;
  return {
    ...raw,
    type: raw.type || KIND_TYPE[kind] || kind,
    kind,
    typeName: type.name,
    typeMark: type.mark,
    typeClass: type.cls,
    typeMain: type.main,
    typeInk: type.ink,
    typeWash: type.wash,
    typeBorder: type.border,
    typeIcon: type.icon,
    typeStyle: `--type-main:${type.main};--type-ink:${type.ink};--type-wash:${type.wash};--type-border:${type.border}`,
    closeName: type.close,
    closedOn: shortDate(raw.closedAt || raw.closed_at),
    sceneName: SCENES[raw.scene] || "生活",
    sourceName: ORIGINS[raw.origin] || "卡片",
    stage: current,
    stageName: stageWord(kind, current, raw.scene === "mood"),
    // Progress bar: 25 / 50 / 75 / 100. A mood card has three
    // steps and is through at 已说清: 33 / 67 / 100.
    pct: raw.scene === "mood" ? MOOD_PCT[current] || 100 : STAGES[current].pct,
    done: current === "closed",
    sumParts: sumParts(raw),
    dots,
    stageDots: Array.from({ length: dots }, (_, index) => index < filled),
    titleView: title(raw),
    // a 待办 is done without words, so the stage alone says closed.
    closed: current === "closed",
    favorite: raw.favorite === true,
    mood: raw.scene === "mood",
    tags: (raw.tags || []).map(tagView),
  };
}
// 心情卡 show with the other cards unless the learner turns them off
// (我的 → 卡片里显示心情卡). Kept per account on this phone.
const MOOD_KEY = "zhiye_show_mood:";
function showMood(account) {
  try {
    return wx.getStorageSync(MOOD_KEY + (account || "")) !== "0";
  } catch (_) {
    return true;
  }
}
function setShowMood(account, on) {
  try {
    wx.setStorageSync(MOOD_KEY + (account || ""), on ? "1" : "0");
  } catch (_) {}
}
// The scene filter a card list sends: the one chosen, else study,life while
// 心情卡 are hidden, else none (all scenes, as before).
function sceneParam(account, chosen) {
  return chosen || (showMood(account) ? "" : "study,life");
}
function selectedViews(cards, ids) {
  const set = new Set(ids || []);
  return cards.filter((card) => set.has(card.id));
}
module.exports = {
  TYPES,
  KIND_TYPE,
  SLOT_LABELS,
  SCENES,
  ORIGINS,
  TAG_COLORS,
  stage,
  title,
  shortDate,
  tagView,
  view,
  doneLast,
  STAGES,
  REMIND_EVERY,
  selectedViews,
  showMood,
  setShowMood,
  sceneParam,
};

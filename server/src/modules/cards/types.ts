export const CARD_TYPES = ["spark", "idea", "question", "method"] as const;
export const CARD_SCENES = ["study", "life", "mood"] as const;
export const CARD_ORIGINS = [
  "jot",
  "chat",
  "import",
  "brainstorm",
  "mistake",
  "map",
  "note",
] as const;
export type CardType = (typeof CARD_TYPES)[number];
// One definition of the four card types for every prompt and judge.
export const CARD_TYPE_LABELS: Record<CardType, string> = {
  spark: "灵感：突然冒出来、还没展开的念头或点子，比如“突然想到…”“要是…会怎样”；还没下判断，也没有具体做法",
  idea: "想法：已经成形的看法、判断、打算或决定，比如“我觉得…”“我打算…”“应该…”",
  question: "问题：自己还不知道答案、想弄清楚的疑问或困惑",
  method: "思路：做一类事的方法、步骤或解题套路，以后能照着重复用，比如“先…再…”“遇到…就…”",
};
export const CARD_TYPE_GUIDE = `卡片类型只能是：${CARD_TYPES.map((t) => `${t}=${CARD_TYPE_LABELS[t]}`).join("；")}。区分：灵感只是一个新冒出的点子，一旦表了态或定了要做就是想法；想法说“是什么、该不该、要不要”，思路说“具体怎么做”且能复用；问题必须是用户还没有答案、想弄清的，反问或已经有答案的不算问题。按用户自己的话判断，拿不准时在灵感和想法之间选更贴近原话的一个。`;
// V4.2 kinds: the four types plus 待办 / 知识点 / 随手记, kept in the
// nullable cards.kind column. cards.type (CHECKed, read by old clients) stays
// one of the four, derived by KIND_TYPE. CARD_TYPE_LABELS / GUIDE above stay
// four-way for the prompts whose output schema still only takes a type.
export const CARD_KINDS = [...CARD_TYPES, "todo", "knowledge", "note"] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export const KIND_TYPE: Record<CardKind, CardType> = {
  spark: "spark",
  idea: "idea",
  question: "question",
  method: "method",
  todo: "idea",
  knowledge: "method",
  note: "idea",
};
export const kindType = (kind: CardKind): CardType => KIND_TYPE[kind];
// One definition of the seven kinds for the judge and the tidy prompt.
export const CARD_KIND_LABELS: Record<CardKind, string> = {
  spark: "灵感：突然冒出来、还没展开的点子或设想，比如“突然想到…”“要是…会怎样”；还没下判断，也没定下要做",
  idea: "想法：自己的看法、判断、取舍或长期打算，还值得接着想，比如“我觉得…”“…比…更…”“我打算以后…”",
  question: "问题：自己还不知道答案、想弄清楚的疑问或困惑",
  method: "思路：做一类事的方法、步骤或解题套路，以后能照着重复用，比如“先…再…”“遇到…就…”",
  todo: "待办：要去做的具体事情或安排，有明确的动作，常带时间或清单，比如“周五前交…”“明天去…”“记得…”“买…”“下周计划…”“这个月目标…”",
  knowledge: "知识点：课本或学科里要记住的事实、概念、定义、公式、定理或规则，比如“…是…”“…等于…”“…年…”",
  note: "随手记：心情感受、记下的生活琐事和信息，或说不清属于哪类的零碎内容，比如“今天好累”“…在…楼”“…不错”",
};
export const CARD_KIND_GUIDE = `卡片类型只能是：${CARD_KINDS.map((k) => `${k}=${CARD_KIND_LABELS[k]}`).join("；")}。区分：定了要去做的具体事情是待办，只是表态或长期打算是想法；要背要记的学科知识是知识点，生活里的信息和心情是随手记；想法说“是什么、该不该”，思路说“具体怎么做”且能复用；问题必须是用户还没有答案、想弄清的。按用户自己的话判断，拿不准时选随手记。`;
// V4.2 after-save follow-up (cards.follow): 回顾 / 问做了没 / 接着聊 / 不追问.
export const CARD_FOLLOWS = ["review", "done", "chat", "none"] as const;
export type CardFollow = (typeof CARD_FOLLOWS)[number];
export const KIND_FOLLOW: Record<CardKind, CardFollow> = {
  todo: "done",
  knowledge: "review",
  question: "chat",
  idea: "chat",
  method: "review",
  spark: "none",
  note: "none",
};
// The follow-up a card gets when nothing chose one: by kind, none for mood.
export const defaultFollow = (kind: CardKind, scene: string): CardFollow =>
  scene === "mood" ? "none" : KIND_FOLLOW[kind];
// The stored kind counts only while it still matches cards.type: a v4.1
// server (rollback) or an old client may have changed the type since.
export const effectiveKind = (kind: unknown, type: CardType): CardKind =>
  typeof kind === "string" &&
  (CARD_KINDS as readonly string[]).includes(kind) &&
  KIND_TYPE[kind as CardKind] === type
    ? (kind as CardKind)
    : type;
// The same rule in SQL, for filters and counts over a cards table alias.
export const kindSql = (c = "c") =>
  `(CASE WHEN ${c}.kind IN ('todo','note') AND ${c}.type='idea' THEN ${c}.kind WHEN ${c}.kind='knowledge' AND ${c}.type='method' THEN ${c}.kind ELSE ${c}.type END)`;
// 收好: a 待办 is done once closed; the other kinds also need the user's words
// (a v4.1 server only knows the second rule).
export const closedSql = (c = "c") =>
  `(${c}.closed_at IS NOT NULL AND (${c}.mine IS NOT NULL OR ${kindSql(c)}='todo'))`;
// Only unmistakable questions skip the judge; everything else is judged.
export const ruleType = (text: string): CardType | undefined =>
  /[?？]\s*$|^\s*(?:为什么|为啥|怎么办|如何|是否|能否)|吗\s*[。.!！]?\s*$/.test(text)
    ? "question"
    : undefined;
export type CardScene = (typeof CARD_SCENES)[number];
export type CardOrigin = (typeof CARD_ORIGINS)[number];
export type CardTag = {
  id: string;
  name: string;
  color: number;
  by: "user" | "ai";
};
export type CardView = {
  id: string;
  type: CardType;
  // one of the seven kinds (type is its four-way value for old clients).
  kind: CardKind;
  // what happens after saving; derived from kind and scene when unset.
  follow: CardFollow;
  // V4.2 合并: set on a merged original, the merged card's id.
  mergedInto: string | null;
  scene: CardScene;
  title: string;
  titleBy: "user" | "ai";
  summary: string | null;
  // The summary as stored, colour marks kept, for the 0.6.0 card wall.
  summaryMarked: string | null;
  summaryBy: "user" | "ai" | null;
  mine: string | null;
  quote: string | null;
  quoteOn: string | null;
  // Plain text: colour marks taken out, for clients that show slots as text
  // (0.2.x / 0.4.0). slotsMarked is the same list as stored, marks kept
  // ("先[[k:约分]]再求导"), for clients that draw them (v4).
  slots: unknown[];
  slotsMarked: unknown[];
  open: unknown[];
  next: unknown;
  organizedAt: string | null;
  closedAt: string | null;
  origin: CardOrigin;
  srcId: string | null;
  messageId: string | null;
  mistakeId: string | null;
  sawAnswer: boolean;
  useCount: number;
  pointId: string | null;
  resume: "on" | "off" | "manual";
  crisis: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  stage: "written" | "organized" | "clear" | "closed";
  tags: CardTag[];
  favorite: boolean;
  // Business date (YYYY-MM-DD) the learner asked to be reminded on.
  remindOn: string | null;
  // v4 提醒频率: the reminder repeats every day or week; null is a one-off date.
  remindEvery: RemindEvery | null;
};
export type RemindEvery = "day" | "week";

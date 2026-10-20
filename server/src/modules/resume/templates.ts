// Program templates: no model call, no invented personal history.
// Each pool is written to fit the options optionsFor gives the same kind.
const questions: Record<string, string[]> = {
  decide: [
    "这件事定下来了吗？不急。",
    "心里有眉目了吗？慢慢来。",
    "现在倾向哪边？还没定也没关系。",
  ],
  verify: [
    "现在有答案了吗？暂时没有也没关系。",
    "这件事弄清楚了吗？",
    "查到了吗？不急。",
  ],
  idea: [
    "现在怎么想？定下来了吗？",
    "这个想法，现在定了吗？慢慢来。",
    "想好怎么做了吗？不急。",
  ],
  question: [
    "现在有答案了吗？想到哪说到哪就好。",
    "这个问题解决了吗？不急。",
    "这个问题，现在想通了吗？",
  ],
  next: [
    "那件事做了吗？慢慢来。",
    "这一步有进展了吗？",
    "这一步做了吗？不急。",
  ],
  promise: [
    "约好的事做了吗？",
    "说好的这件事，做了吗？慢慢来。",
    "这件事进展怎么样？慢慢来。",
  ],
  spark: ["它还让你心动吗？", "还想往下想吗？", "这个念头，还想接着想吗？"],
  method: [
    "还记得第一步吗？想不起来也没关系。",
    "先别看卡，第一步是什么？",
    "这条思路的第一步，还记得吗？",
  ],
  mood: [
    "现在回头看，感觉怎么样？",
    "回头看看，现在的感受有变化吗？",
    "现在心情好些了吗？不急。",
  ],
  brainstorm: [
    "头脑风暴理好了，有空看看？",
    "结果好了，想看看吗？",
    "理好的结果，想看看吗？",
  ],
  import: [
    "拆好了，挑一挑？",
    "卡片拆好了，有空看看？",
    "想接着挑这次导入的卡吗？",
  ],
  batch: [
    "这几张卡放一起，来次头脑风暴？",
    "想把这几张卡放在一起看看吗？",
    "这几张有些联系，一起头脑风暴？",
  ],
  retest: [
    "换一道题，自己试一次？错了也没关系。",
    "不看提示再做一次？",
    "想看看这次能不能自己做出来吗？",
  ],
  review: ["想回头练一题吗？", "这次自己试试看？", "这个点想再看看吗？"],
  mistake: [
    "这道题想再试一次吗？",
    "卡住的那步，想再做一次吗？",
    "想自己再做一次吗？",
  ],
  // V4.2 follow-up modes (cards.follow), used when tidy left no question of
  // its own: 回顾 asks whether it is remembered, 待办 whether it got done,
  // 接着聊 offers to talk on.
  recall: [
    "还记得这张卡说的是什么吗？",
    "先别看卡，还想得起来吗？",
    "这一条，现在还记得吗？",
  ],
  todo: ["这件事做了吗？不急。", "做完了吗？慢慢来。", "这一件，做了吗？"],
  chat: [
    "想接着聊聊这个吗？",
    "这件事，还想往下聊聊吗？",
    "想再接着想想吗？",
  ],
  // a reminder on a card that asks nothing (随手记, 灵感, 不追问):
  // a light look back.
  look: [
    "回头看看这张卡，有想补的吗？",
    "隔几天再看，有新的想法吗？",
    "又翻到这一张，想补点什么吗？",
  ],
  // Learning cards answer with "做一题 / 还在想 / 写一句".
  study: [
    "想做一题试试吗？不急。",
    "换道题试试，看现在会不会？",
    "这个点，现在能自己做出来吗？",
  ],
};
export function questionFor(kind: string, rotation: number, learning = false) {
  const pool =
    learning && !["retest", "review", "mistake"].includes(kind)
      ? questions.study!
      : (questions[kind] ?? questions.idea!);
  return pool[rotation % pool.length]!;
}
export function optionsFor(kind: string, canClose: boolean, learning: boolean) {
  if (learning) return ["做一题", "还在想", "写一句"];
  if (kind in FOLLOW_OPTIONS) return FOLLOW_OPTIONS[kind]!;
  if (kind === "mood") return ["好一些了", "差不多", "写一句"];
  if (kind === "method") return ["想起来了", "想不起来", "写一句"];
  if (kind === "spark") return ["想接着想", "先收着", "写一句"];
  if (["brainstorm", "import", "batch"].includes(kind))
    return ["看看", "先放着"];
  return [
    canClose
      ? kind === "question" || kind === "verify"
        ? "解决了"
        : kind === "next" || kind === "promise"
          ? "做了"
          : "定了"
      : "有些想法",
    "还在想",
    "写一句",
  ];
}
// the answers of the follow-up modes; the first means it worked out
// (记住了 / 做了 / 接着聊), the second not yet. 不用提醒 turns the card off.
export const FOLLOW_OPTIONS: Record<string, string[]> = {
  recall: ["记住了", "有点忘", "不用提醒"],
  todo: ["做了", "还没", "不用提醒"],
  chat: ["接着聊", "先放着", "不用提醒"],
  look: ["没有了", "写一句", "不用提醒"],
};
// What each answer does, for clients that act on meaning rather than words.
export const FOLLOW_ACTS: Record<string, string[]> = {
  recall: ["remember", "forgot", "never"],
  todo: ["close", "later", "never"],
  chat: ["chat", "later", "never"],
  look: ["answer", "write", "never"],
};
export function actFor(option: string) {
  return (
    (
      {
        记住了: "remember",
        有点忘: "forgot",
        做了: "close",
        定了: "close",
        解决了: "close",
        已完成: "close",
        还没: "later",
        先放着: "later",
        还在想: "later",
        还在进行: "later",
        先收着: "later",
        接着聊: "chat",
        想接着想: "chat",
        不用提醒: "never",
        写一句: "write",
        补充一句: "write",
        做一题: "practice",
        看看: "open",
      } as Record<string, string>
    )[option] ?? "answer"
  );
}

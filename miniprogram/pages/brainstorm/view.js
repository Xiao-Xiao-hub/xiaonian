const { cards: exampleCards } = require("../../utils/examples");
const { view: cardView, TYPES: CARD_KINDS, KIND_TYPE } = require("../../utils/cards");

const TYPES = {
  spark: "灵感",
  idea: "想法",
  question: "问题",
  method: "思路",
};
// V4.2 : a conclusion can be saved as any of the seven kinds.
const KINDS = Object.fromEntries(
  Object.keys(CARD_KINDS).map((id) => [id, CARD_KINDS[id].name]),
);
const kindType = (kind) => KIND_TYPE[kind] || kind;
const SCENES = { study: "学习", life: "生活", mood: "心情" };
const STANCES = [
  ["depends", "看情况"],
  ["a", "前者更对"],
  ["b", "后者更对"],
  ["unsure", "还没想好"],
];
// V4.2 : what the difference is decides the box title and the answers:
// 要查一查 (one of them is right), 要选一个, or only a different angle (no
// answer). Results from before have no kind and keep "哪张更对".
const TENSION_KINDS = {
  verify: { name: "要查一查", stances: ["a", "b", "unsure"] },
  choose: { name: "要选一个", stances: ["a", "b", "depends", "unsure"] },
  differ: { name: "角度不同", stances: [] },
};
const text = (value) => String(value == null ? "" : value);
const aiText = (value, edited) => ({ text: text(value), ai: !edited });
const asCards = (items) =>
  (items || []).map((card) => cardView(card.card || card));
// By code point, so an emoji is never cut in half.
const short = (card) => {
  const title = Array.from(
    text(card && ((card.titleView && card.titleView.text) || card.title)),
  );
  return title.length > 6 ? `${title.slice(0, 6).join("")}…` : title.join("");
};
// Stance labels name the two cards, e.g. 「替换的前提」更对 (选「…」 when the
// user picks one, 「…」对 when it can be checked).
const stanceName = (id, aCard, bCard, kind) => {
  const card = id === "a" ? short(aCard) : id === "b" ? short(bCard) : "";
  if (card)
    return kind === "choose"
      ? `选「${card}」`
      : kind === "verify"
        ? `「${card}」对`
        : `「${card}」更对`;
  if (kind === "verify" && id === "unsure") return "还要查";
  return (STANCES.find(([key]) => key === id) || [])[1] || "";
};
const refs = (ids, cards) =>
  (ids || [])
    .map((number) => {
      const card = cards[Number(number) - 1];
      return card ? { ...card, ref: Number(number) } : null;
    })
    .filter(Boolean);
function graphLayout(groups, tensions, conclusion) {
  // Wide and tall enough for a 16-character card title in three lines.
  const groupWidth = 220,
    groupGap = 18,
    left = 20,
    groupTop = 20,
    groupHeight = 64,
    cardTop = 132,
    cardHeight = 130,
    cardGap = 12;
  const positions = new Map();
  const graphGroups = groups.map((group, groupIndex) => {
    const x = left + groupIndex * (groupWidth + groupGap);
    const cards = group.cards.map((card, cardIndex) => {
      const y = cardTop + cardIndex * (cardHeight + cardGap),
        placed = {
          ...card,
          graphStyle: `left:${x}rpx;top:${y}rpx;width:${groupWidth}rpx;height:${cardHeight}rpx`,
        };
      positions.set(card.ref, {
        x: x + groupWidth / 2,
        bottom: y + cardHeight,
      });
      return placed;
    });
    return {
      ...group,
      cards,
      graphStyle: `left:${x}rpx;top:${groupTop}rpx;width:${groupWidth}rpx`,
      stemStyle: `left:${x + groupWidth / 2 - 2}rpx;top:${groupTop + groupHeight}rpx;height:${cardTop - groupTop - groupHeight}rpx`,
    };
  });
  const groupRight =
      left + Math.max(0, graphGroups.length - 1) * (groupWidth + groupGap),
    endLeft = groupRight + groupWidth + 34,
    lastCenter = groupRight + groupWidth / 2,
    firstCenter = left + groupWidth / 2,
    trunkRight = conclusion ? endLeft + 2 : lastCenter;
  let maxBottom = Math.max(
    cardTop + cardHeight,
    ...Array.from(positions.values()).map((position) => position.bottom),
  );
  const ties = [];
  tensions.forEach((tension, index) => {
    const a = positions.get(tension.aCard && tension.aCard.ref),
      b = positions.get(tension.bCard && tension.bCard.ref);
    if (!a || !b) return;
    const ax = a.x === b.x ? a.x - groupWidth / 2 + 10 : a.x,
      bx = a.x === b.x ? b.x + groupWidth / 2 - 10 : b.x,
      base = Math.max(a.bottom, b.bottom) + 24 + index * 18,
      minX = Math.min(ax, bx),
      maxX = Math.max(ax, bx);
    ties.push({
      id: tension.id,
      aStyle: `left:${ax - 1}rpx;top:${a.bottom}rpx;height:${base - a.bottom}rpx`,
      bStyle: `left:${bx - 1}rpx;top:${b.bottom}rpx;height:${base - b.bottom}rpx`,
      baseStyle: `left:${minX}rpx;top:${base - 2}rpx;width:${maxX - minX}rpx`,
    });
    maxBottom = Math.max(maxBottom, base + 4);
  });
  return {
    groups: graphGroups,
    ties,
    width: Math.max(
      750,
      conclusion ? endLeft + 230 : groupRight + groupWidth + 20,
    ),
    // Wider than the screen: the page says it scrolls.
    scrolls:
      (conclusion ? endLeft + 230 : groupRight + groupWidth + 20) > 750,
    height: Math.max(340, maxBottom + 28),
    trunkStyle: `left:${firstCenter}rpx;top:${groupTop + 30}rpx;width:${Math.max(0, trunkRight - firstCenter)}rpx`,
    endStyle: `left:${endLeft}rpx;top:${groupTop - 2}rpx`,
  };
}
const changed = (original, current, key) =>
  text(original && original[key]) !== text(current && current[key]);
function itemView(raw = {}) {
  const result = raw.result || {};
  const picks = raw.picks || {};
  const cards = asCards(raw.cards || raw.cardSnapshots);
  const sourceGroups = Array.isArray(picks.groups)
    ? picks.groups
    : result.groups || [];
  const sourceTensions = Array.isArray(picks.tensions)
    ? picks.tensions
    : result.tensions || [];
  const sourceMore = Array.isArray(picks.more) ? picks.more : result.more || [];
  const sourceDirections = Array.isArray(picks.directions)
    ? picks.directions
    : result.directions || [];
  const sourceDrafts = Array.isArray(picks.drafts)
    ? picks.drafts
    : result.drafts || [];
  const sourceIfs = Array.isArray(picks.ifs) ? picks.ifs : result.ifs || [];
  const originals = (key) =>
    new Map((result[key] || []).map((entry) => [entry.id, entry]));
  const groupOriginals = originals("groups"),
    tensionOriginals = originals("tensions"),
    moreOriginals = originals("more"),
    directionOriginals = originals("directions"),
    draftOriginals = originals("drafts"),
    ifOriginals = originals("ifs");
  const groups = sourceGroups.map((group, index) => ({
    ...group,
    index,
    nameView: aiText(
      group.name,
      changed(groupOriginals.get(group.id), group, "name"),
    ),
    commonView: aiText(
      group.common,
      changed(groupOriginals.get(group.id), group, "common"),
    ),
    cards: refs(group.cards, cards),
  }));
  const tensions = sourceTensions.map((entry, index) => {
    const aCard = refs([entry.a], cards)[0],
      bCard = refs([entry.b], cards)[0],
      kind = TENSION_KINDS[entry.kind] ? entry.kind : "";
    const ids = kind
      ? TENSION_KINDS[kind].stances
      : STANCES.map(([id]) => id);
    return {
      ...entry,
      index,
      aCard,
      bCard,
      kindName: kind ? TENSION_KINDS[kind].name : "这两张说的不一样",
      noteView: aiText(
        entry.note,
        changed(tensionOriginals.get(entry.id), entry, "note"),
      ),
      stance: entry.choice || "",
      stanceName:
        entry.choice && ids.includes(entry.choice)
          ? stanceName(entry.choice, aCard, bCard, kind)
          : "",
      stances: ids.map((id) => ({
        id,
        name: stanceName(id, aCard, bCard, kind),
        selected: (entry.choice || "") === id,
      })),
    };
  });
  const more = sourceMore.map((entry, index) => ({
    ...entry,
    index,
    cardView: cardView({
      type: entry.type,
      scene: raw.scene,
      title: entry.title,
      titleBy: "ai",
    }),
    titleView: aiText(
      entry.title,
      changed(moreOriginals.get(entry.id), entry, "title"),
    ),
    selected: Boolean(entry.selected),
    fromCards: refs(entry.from, cards),
  }));
  const directions = sourceDirections.map((entry, index) => ({
    ...entry,
    index,
    titleView: aiText(
      entry.title,
      changed(directionOriginals.get(entry.id), entry, "title"),
    ),
    whyView: aiText(
      entry.why,
      changed(directionOriginals.get(entry.id), entry, "why"),
    ),
    fromCards: refs(entry.from, cards),
  }));
  const drafts = sourceDrafts.map((entry, index) => ({
    ...entry,
    index,
    textView: aiText(
      entry.text,
      changed(draftOriginals.get(entry.id), entry, "text"),
    ),
    fromCards: refs(entry.from, cards),
  }));
  const condition = sourceIfs[0] || {};
  const originalCondition = ifOriginals.get(condition.id);
  const ifViews = sourceIfs.map((entry, index) => ({
    ...entry,
    index,
    ifView: aiText(entry.if, changed(ifOriginals.get(entry.id), entry, "if")),
    fromCards: refs(entry.from, cards),
  }));
  const ask = picks.ask === undefined ? result.ask : picks.ask;
  const facts = raw.facts || {};
  const factLines = Array.isArray(facts)
    ? facts
    : [
        ...(facts.commonPrereqs || []).map(
          (entry) => `这 ${entry.count} 张都要先弄懂「${entry.name}」`,
        ),
        ...(facts.mistakeCauses || []).map(
          (entry) => `错题里有 ${entry.count} 次都是“${entry.cause}”`,
        ),
        ...(facts.sawAnswer ? [`有 ${facts.sawAnswer} 张看过答案`] : []),
      ];
  const conclusion = text(picks.conclusion && picks.conclusion.text),
    graph = graphLayout(groups, tensions, conclusion);
  return {
    ...raw,
    result,
    picks,
    cards,
    count: raw.count || cards.length,
    sceneName: SCENES[raw.scene] || "",
    titleView: aiText(
      picks.title ?? result.title ?? raw.title,
      picks.title != null && picks.title !== result.title,
    ),
    groups,
    graph,
    tensions,
    more,
    directions,
    drafts,
    ifViews,
    ask: ask
      ? {
          ...ask,
          qView: aiText(ask.q, Boolean(result.ask && ask.q !== result.ask.q)),
        }
      : null,
    ifs: sourceIfs,
    facts: factLines,
    conditionView: aiText(
      condition.if,
      changed(originalCondition, condition, "if"),
    ),
    conclusion,
    thenText: text(condition.then),
    conclusionType: conclusionKind(raw.scene, picks.conclusion, sourceDrafts),
    savedCards: asCards(raw.outCards || raw.savedCards),
  };
}
// What the conclusion is saved as : the kind chosen, else what the
// AI said the draft used (or the first draft) is, else by scene as before.
function conclusionKind(scene, conclusion, drafts) {
  const chosen = conclusion && (conclusion.kind || conclusion.type);
  if (KINDS[chosen]) return chosen;
  const used =
    conclusion &&
    conclusion.draftId &&
    (drafts || []).find((entry) => entry.id === conclusion.draftId);
  const suggested =
    (used && used.kind) ||
    ((drafts || []).find((entry) => KINDS[entry.kind]) || {}).kind;
  if (KINDS[suggested]) return suggested;
  return scene === "study" ? "method" : "idea";
}
// The AI report (v3): sections in a fixed order, empty ones dropped; null when
// there is no report or nothing in it. V4.2 : plainer names.
const REPORT_SECTIONS = [
  ["links", "怎么连起来"],
  ["improve", "还可以想清楚"],
  ["expand", "还能往哪想"],
  ["advice", "下一步"],
];
function reportView(report) {
  const sections = (report && report.sections) || {};
  const out = REPORT_SECTIONS.map(([key, name]) => ({
    key,
    name,
    items: (Array.isArray(sections[key]) ? sections[key] : [])
      .filter((entry) => entry && text(entry.text).trim())
      .map((entry, index) => ({
        id: `${key}-${index}`,
        text: text(entry.text),
        cards: (entry.cards || [])
          .filter((card) => card && card.id)
          .map((card) => ({ id: String(card.id), title: text(card.title) || "一张卡" })),
      })),
  })).filter((section) => section.items.length);
  return out.length ? out : null;
}
// V4.2 : the report was written before the groups or differences changed.
const reportStale = (report) => Boolean(report && report.stale);
// What of the groups and differences a report is written from, to tell
// unsent edits apart (the server keeps its own basis for saved ones).
const reportBasis = (groups, tensions) =>
  JSON.stringify([
    (groups || []).map((group) => [group.name, group.common, group.cards]),
    (tensions || []).map((tension) => [tension.a, tension.b, tension.note]),
  ]);
// Unsaved edits on the process and conclude pages, kept per
// account and brainstorm until the server has them: a reload on onShow or
// leaving the page does not lose them. Each page writes the lists it edits.
const DRAFT_KEY = "zhiye_bs_draft:";
const DRAFT_FIELDS = [
  "title",
  "groups",
  "tensions",
  "more",
  "ifs",
  "directions",
  "drafts",
  "ask",
  "conclusion",
];
function readDraft(account, id) {
  try {
    const value = wx.getStorageSync(`${DRAFT_KEY}${account}:${id}`);
    return value && typeof value === "object" ? value : null;
  } catch (_) {
    return null;
  }
}
function writeDraft(account, id, patch) {
  if (!account || !id) return;
  try {
    wx.setStorageSync(`${DRAFT_KEY}${account}:${id}`, {
      ...(readDraft(account, id) || {}),
      ...patch,
    });
  } catch (_) {}
}
// Drops the fields the server now has (all of them without a list).
function clearDraft(account, id, fields) {
  if (!account || !id) return;
  try {
    const draft = readDraft(account, id);
    const next = { ...(draft || {}) };
    (fields || DRAFT_FIELDS).forEach((field) => delete next[field]);
    if (Object.keys(next).length)
      wx.setStorageSync(`${DRAFT_KEY}${account}:${id}`, next);
    else wx.removeStorageSync(`${DRAFT_KEY}${account}:${id}`);
  } catch (_) {}
}
// raw with the draft laid over its picks. A list whose items are not all in
// this result (another brainstorm, or stale) is left out.
function withDraft(raw, draft) {
  if (!raw || !draft || !["ready", "paused"].includes(raw.status)) return raw;
  const result = raw.result || {},
    picks = { ...(raw.picks || {}) };
  DRAFT_FIELDS.forEach((field) => {
    if (!(field in draft)) return;
    const value = draft[field];
    if (Array.isArray(value)) {
      const ids = new Set((result[field] || []).map((entry) => entry.id));
      if (!value.every((entry) => entry && ids.has(entry.id))) return;
    }
    picks[field] = value;
  });
  return { ...raw, picks };
}
function jobLine(job) {
  if (!job) return "";
  return job.status === "queued"
    ? "马上开始"
    : job.status === "running"
      ? "在帮你理一理…"
      : job.status === "succeeded"
        ? "理好了"
        : ["failed", "unknown"].includes(job.status)
          ? "这次没理完"
          : "";
}
// Empty required fields fall back to what AI wrote, so a half-edited box still saves.
function cleanPicks(picks, result = {}) {
  const out = { ...picks };
  const restore = (key, fields) => {
    if (!Array.isArray(out[key])) return;
    const originals = new Map((result[key] || []).map((entry) => [entry.id, entry]));
    out[key] = out[key]
      .map((entry) => {
        const next = { ...entry },
          original = originals.get(entry.id) || {};
        fields.forEach((field) => {
          if (!text(next[field]).trim()) next[field] = original[field];
        });
        return next;
      })
      .filter((entry) => fields.every((field) => text(entry[field]).trim()));
  };
  if (Array.isArray(out.groups))
    out.groups = out.groups.filter((group) => (group.cards || []).length);
  restore("groups", ["common"]);
  restore("tensions", ["note"]);
  restore("more", ["title"]);
  restore("ifs", ["if"]);
  restore("directions", ["title", "why"]);
  restore("drafts", ["text"]);
  if ("title" in out && !text(out.title).trim()) {
    if (result.title) out.title = result.title;
    else delete out.title;
  }
  if (out.ask) {
    const options = (out.ask.options || []).filter((value) => text(value).trim());
    out.ask = text(out.ask.q).trim()
      ? { ...out.ask, options }
      : result.ask || null;
  }
  return out;
}
function example() {
  const cards = Array.from({ length: 4 }, (_, index) => ({
    ...exampleCards[index % exampleCards.length],
    id: String(index + 1),
    title:
      [
        "替换的前提是什么",
        "加减里不能直接替换",
        "先看运算结构",
        "替换能让计算更快",
        "还没分清等价关系",
        "画一张替换条件表",
      ][index] || exampleCards[index % exampleCards.length].title,
  }));
  return itemView({
    id: "example",
    example: true,
    status: "picking",
    scene: "study",
    cards,
    facts: ["这 2 张都要先弄懂「无穷小比较」", "错题里有 2 次都是“条件没检查”"],
    result: {
      title: "第 1 章卡在哪",
      groups: [
        {
          id: "g1",
          name: "想要的",
          common: "想把替换条件说清",
          cards: [1, 4],
        },
        { id: "g2", name: "顾虑", common: "加减结构容易用错", cards: [2, 3] },
      ],
      tensions: [
        { id: "t1", a: 2, b: 1, note: "替换条件还没对上", kind: "choose" },
      ],
      more: [
        {
          id: "m1",
          type: "question",
          title: "加减里为什么不能替换",
          from: [1],
        },
        { id: "m2", type: "spark", title: "画一张替换条件表", from: [4] },
      ],
      ifs: [{ id: "i1", if: "替换条件能说清", from: [1, 2] }],
      directions: [
        {
          id: "r1",
          title: "先列出能替换的条件",
          why: "几张卡都在问替换何时成立",
          from: [1, 2],
        },
        {
          id: "r2",
          title: "把错误放回原式检查",
          why: "加减结构是这次的主要矛盾",
          from: [2, 3],
        },
      ],
      drafts: [
        {
          id: "d1",
          text: "先看运算结构，再决定能不能替换",
          from: [1, 2],
          kind: "method",
        },
      ],
    },
    picks: {
      more: [
        {
          id: "m1",
          type: "question",
          title: "加减里为什么不能替换",
          from: [1],
          selected: true,
        },
        {
          id: "m2",
          type: "spark",
          title: "画一张替换条件表",
          from: [4],
          selected: true,
        },
      ],
      tensions: [
        {
          id: "t1",
          a: 2,
          b: 1,
          note: "替换条件还没对上",
          kind: "choose",
          choice: "depends",
        },
      ],
      conclusion: {
        text: "先看运算结构，再决定能不能替换",
        type: "method",
        kind: "method",
      },
    },
  });
}
module.exports = {
  TYPES,
  KINDS,
  kindType,
  SCENES,
  STANCES,
  TENSION_KINDS,
  itemView,
  reportView,
  reportStale,
  reportBasis,
  readDraft,
  writeDraft,
  clearDraft,
  withDraft,
  jobLine,
  cleanPicks,
  example,
};

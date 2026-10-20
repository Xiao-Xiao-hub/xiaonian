import type { SqliteStore } from "../../shared/store.js";
import { chinaDate } from "../../shared/time.js";
import { CALC_MAP } from "../learn/calc-map.js";

export type Reflection = {
  key: string;
  text: string;
  url: string | null;
  at: string;
};
type Types = { cards: boolean; study: boolean };
type Card = Record<string, any>;
const excerpt = (s: unknown) =>
  Array.from(String(s || ""))
    .slice(0, 30)
    .join("");
const date = (s: unknown) =>
  chinaDate(Date.parse(String(s)))
    .slice(5)
    .split("-")
    .map(Number)
    .join("/");

// References alone are persisted in events. Rebuild every display from the
// current owned source so deleted, disabled or crisis content cannot reappear.
function eligibleCards(store: SqliteStore, userId: string): Card[] {
  return store.db
    .prepare(
      "SELECT c.* FROM cards c WHERE c.user_id=? AND c.scene<>'mood' AND c.crisis=0 AND c.resume<>'off' AND c.merged_into IS NULL AND (c.origin<>'note' OR EXISTS(SELECT 1 FROM card_versions v WHERE v.card_id=c.id AND v.by='system' AND v.kind='type')) ORDER BY c.updated_at DESC,c.id",
    )
    .all(userId);
}

export function lookbacks(
  store: SqliteStore,
  userId: string,
  types: Types,
): Reflection[] {
  const result: Reflection[] = [];
  if (types.cards)
    for (const card of eligibleCards(store, userId)) {
      const url = `/pages/card/index?id=${encodeURIComponent(String(card.id))}`;
      if (card.closed_at && card.mine) {
        result.push({
          key: `closed:${card.id}:${card.closed_at}`,
          at: String(card.closed_at),
          url,
          text: `${date(card.closed_at)} 你定下“${excerpt(card.mine)}”。这一步记在卡里了。`,
        });
        continue;
      }
      const versions = store.db
        .prepare(
          "SELECT id,data,created_at FROM card_versions WHERE user_id=? AND card_id=? AND kind='mine' AND by='user' ORDER BY id DESC LIMIT 2",
        )
        .all(userId, card.id);
      if (versions.length !== 2) continue;
      const current = JSON.parse(String(versions[0]!.data)).text;
      const previous = JSON.parse(String(versions[1]!.data)).text;
      if (
        !current ||
        !previous ||
        current === previous ||
        current !== card.mine
      )
        continue;
      result.push({
        key: `mine:${versions[0]!.id}`,
        at: String(versions[0]!.created_at),
        url,
        text: `${date(versions[1]!.created_at)} 你写下“${excerpt(previous)}”。现在改成“${excerpt(current)}”，变化留在这张卡里。`,
      });
    }
  if (types.study)
    for (const row of store.db
      .prepare(
        "SELECT r.* FROM retests r WHERE r.user_id=? AND r.result='right' AND r.done_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM resume_items i WHERE i.user_id=r.user_id AND i.src='point' AND i.src_id=r.point_id AND i.state='never') ORDER BY r.done_at DESC,r.id DESC",
      )
      .all(userId)) {
      const chapter = CALC_MAP.chapters.find((c) =>
        c.points.some((p) => p.id === row.point_id),
      );
      const point = chapter?.points.find((p) => p.id === row.point_id);
      if (
        !point ||
        store.db
          .prepare(
            "SELECT 1 FROM map_chapters WHERE user_id=? AND chapter_id=?",
          )
          .get(userId, chapter!.id)
      )
        continue;
      result.push({
        key: `retest:${row.id}`,
        at: String(row.done_at),
        url: `/pages/point/index?id=${encodeURIComponent(point.id)}`,
        text: `${date(row.created_at)} 留下的「${point.name}」，${date(row.done_at)} 你不看提示做出来了。`,
      });
    }
  return result.sort(
    (a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key),
  );
}

export function greeting(
  store: SqliteStore,
  userId: string,
  at: string,
  cards: boolean,
  key?: string,
): Reflection | null {
  const card = cards
    ? eligibleCards(store, userId).find(
        (c) => c.quote && (!key || key === `greet:${c.id}`),
      )
    : undefined;
  if (key && key !== "greet:empty" && !card) return null;
  const local = new Date(Date.parse(at) + 8 * 3600000);
  const hour = local.getUTCHours();
  const hello =
    hour < 5 ? "夜深了" : hour < 11 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
  const variants = [
    "今天过得怎么样？有什么想记下的，随时写一句。",
    "今天有什么新念头吗？想到哪写到哪就好。",
    "有想接着想的事，慢慢记下来就好。",
  ];
  const quote =
    card && key !== "greet:empty"
      ? `${date(card.quote_on || card.created_at)} 你记下“${excerpt(card.quote)}”。`
      : "";
  return {
    key: key || (card ? `greet:${card.id}` : "greet:empty"),
    at,
    url: null,
    text: `${hello}。${quote}${variants[local.getUTCDate() % variants.length]}`,
  };
}

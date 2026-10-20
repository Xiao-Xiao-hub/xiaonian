import type { SqliteStore } from "../../shared/store.js";

// Called inside the independent-answer transaction. The event records exactly
// which existing cards qualified at that moment, not a client supplied result.
export function recordLearningPass(
  store: SqliteStore,
  userId: string,
  pointId: string,
  at: string,
  source: "retest" | "review",
) {
  return recordPass(store, userId, "point", pointId, at, source);
}

export function recordMistakePass(
  store: SqliteStore,
  userId: string,
  mistakeId: string,
  at: string,
) {
  return recordPass(store, userId, "mistake", mistakeId, at, "mistake");
}

function recordPass(
  store: SqliteStore,
  userId: string,
  kind: "point" | "mistake",
  id: string,
  at: string,
  source: string,
) {
  const column = kind === "point" ? "point_id" : "mistake_id";
  const cards = store.db
    .prepare(
      `SELECT id,mine,type FROM cards WHERE user_id=? AND ${column}=? AND scene='study' AND crisis=0 AND type IN ('question','method') AND closed_at IS NULL AND merged_into IS NULL`,
    )
    .all(userId, id) as { id: string; mine: string | null; type: string }[];
  const cardIds = cards.map((c) => String(c.id));
  const result = store.db
    .prepare(
      "INSERT INTO events(user_id,name,data,created_at) VALUES(?,'learning_pass',?,?)",
    )
    .run(userId, JSON.stringify({ kind, id, source, cardIds }), at);
  const proofId = Number(result.lastInsertRowid);
  for (const card of cards)
    if (card.type === "question" && card.mine) {
      store.db
        .prepare(
          "UPDATE cards SET closed_at=?,updated_at=?,version=version+1 WHERE id=? AND user_id=?",
        )
        .run(at, at, card.id, userId);
      store.db
        .prepare(
          "INSERT INTO card_versions(card_id,user_id,kind,by,data,created_at) VALUES(?,?,'close','system',?,?)",
        )
        .run(card.id, userId, JSON.stringify({ source, proofId }), at);
      store.db
        .prepare(
          "INSERT INTO events(user_id,name,data,created_at) VALUES(?,'card_close',?,?)",
        )
        .run(userId, JSON.stringify({ source }), at);
    }
  return { proofId, cardIds };
}

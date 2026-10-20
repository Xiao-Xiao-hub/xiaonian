import type { SqliteStore } from "./store.js";
// Product analytics: what people use, not what they write. Never put learning
// content, answers or model output into `data`.
export function logEvent(
  store: SqliteStore,
  userId: string | null,
  name: string,
  data: Record<string, string | number | boolean | null> = {},
) {
  store.db
    .prepare("INSERT INTO events(user_id,name,data,created_at) VALUES(?,?,?,?)")
    .run(userId, name, JSON.stringify(data), store.now());
}

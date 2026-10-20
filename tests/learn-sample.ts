// The sketch's sample progress (docs/design/learning-map-sketch/README.md, 示例数字),
// built relative to `today` so every number holds on any weekday:
// 27/89 做对, 390 XP, Lv.10 66/76, 本周做对 4 个 +60, 2 points due today,
// 下一步 中值与应用再做对 1 个重点, 全书 起步 · 已到基础段 3/6.
// Used by the tests and by scripts/seed_learn.ts. Synthetic data, not a real learner.
import type { SqliteStore } from "../server/src/shared/store.js";
import { addDays } from "../server/src/shared/time.js";

// D 做对过, R 该复习 (done, due today), H 自评, S 看过, U! 没碰过 + red dot,
// W 做对过 this week. Points not listed are untouched (chapters 4–6 entirely).
export const SAMPLE_STATES: Record<string, "D" | "R" | "H" | "S" | "U!" | "W"> =
  {
    "limit-function": "D",
    "limit-one-sided": "D",
    "limit-infinitesimal": "D",
    "limit-rules": "D",
    "limit-important-sin": "D",
    "limit-important-e": "D",
    "limit-order": "H",
    "limit-continuity": "D",
    "limit-zero-theorem": "S",
    "limit-equivalent": "R",
    "limit-1-to-inf": "D",
    "limit-discontinuity": "U!",
    "limit-epsilon-n": "S",
    "limit-squeeze": "D",
    "limit-monotone": "D",
    "limit-uniform": "D",
    "derivative-definition": "D",
    "derivative-tangent": "D",
    "derivative-rules": "D",
    "derivative-chain": "R",
    "derivative-second": "D",
    "derivative-higher": "D",
    "derivative-implicit": "S",
    "application-mvt": "D",
    "application-monotonic": "D",
    "application-convexity": "D",
    "application-extremum": "W",
    "application-asymptote": "W",
    "application-curvature": "H",
    "application-lhopital": "D",
    "application-lhopital-other": "D",
    "application-taylor-expand": "W",
    "application-optimization": "W",
    "application-taylor-remainder": "S",
  };

export type SampleRow = {
  pointId: string;
  correctAt: string | null;
  selfAt: string | null;
  seenAt: string | null;
  reviewedOn: string | null;
  dueOn: string | null;
  interval: number | null;
  red: boolean;
};

// An ISO time on a Beijing date; `minute` keeps the order stable.
const at = (date: string, minute: number) =>
  new Date(
    Date.parse(`${date}T00:00:00+08:00`) + minute * 60_000,
  ).toISOString();

export function sampleRows(today: string): SampleRow[] {
  // Older than any Monday-start week that contains today.
  const old = addDays(today, -10);
  return Object.entries(SAMPLE_STATES).map(([pointId, s], i) => {
    const row: SampleRow = {
      pointId,
      correctAt: null,
      selfAt: null,
      seenAt: null,
      reviewedOn: null,
      dueOn: null,
      interval: null,
      red: false,
    };
    if (s === "D")
      // Done 10 days ago, first review passed 3 days ago, next in 21 days.
      Object.assign(row, {
        correctAt: at(old, i),
        reviewedOn: addDays(today, -3),
        interval: 21,
        dueOn: addDays(today, 18),
      });
    else if (s === "R")
      Object.assign(row, {
        correctAt: at(addDays(today, -7), i),
        interval: 7,
        dueOn: today,
      });
    else if (s === "W")
      Object.assign(row, {
        correctAt: at(today, i),
        interval: 7,
        dueOn: addDays(today, 7),
      });
    else if (s === "H") row.selfAt = at(old, i);
    else if (s === "S") row.seenAt = at(old, i);
    else row.red = true;
    return row;
  });
}

// Replaces the user's map progress with the sample.
export function seedSample(store: SqliteStore, userId: string, today: string) {
  const now = new Date().toISOString();
  store.transaction(() => {
    store.db.prepare("DELETE FROM map_points WHERE user_id=?").run(userId);
    store.db.prepare("DELETE FROM map_chapters WHERE user_id=?").run(userId);
    const insert = store.db.prepare(
      "INSERT INTO map_points(user_id,point_id,correct_at,self_at,seen_at,practice_on,reviewed_on,due_on,interval,red,updated_at) VALUES(?,?,?,?,?,NULL,?,?,?,?,?)",
    );
    for (const r of sampleRows(today))
      insert.run(
        userId,
        r.pointId,
        r.correctAt,
        r.selfAt,
        r.seenAt,
        r.reviewedOn,
        r.dueOn,
        r.interval,
        r.red ? 1 : 0,
        now,
      );
  });
}

/*
 * 学习时长：接收客户端上报的有效学习区间，按用户与业务日期累计。
 * routes.ts 校验请求；累计值用于学习记录，不作为实际学习效果或掌握程度的证明。
 */
import type { SqliteStore } from "../../shared/store.js";
import { addDays, chinaDate } from "../../shared/time.js";
import type { User } from "../../shared/domain.js";
// 学习时长. The client only reports seconds; the day is the
// server's Beijing date. Everything shown is worked out from whole minutes per
// day, so the four numbers and the heat map always agree:
//   minutes      floor(seconds / 60) for each day; a day with 0 is not a study day
//   totalMinutes the sum over every recorded day (all history, not only 126 days)
//   totalDays    every study day ever (V4.2: 我的 shows 累计 N 天)
//   currentStreak study days in a row ending today, or yesterday when today has
//                 nothing yet (so the number does not drop to 0 every morning)
//   bestStreak   the longest such run ever
export const MAX_REPORT = 900;
export const MAX_DAY = 86400;
// 18 weeks.
export const WINDOW_DAYS = 126;
type DayRow = { day: string; seconds: number };
const minutesOf = (seconds: number) => Math.floor(seconds / 60);
export class StudyTimeService {
  constructor(private store: SqliteStore) {}
  private today() {
    return chinaDate(Date.parse(this.store.now()));
  }
  // Adds to today's total, capped at a full day. Nothing is kept while the
  // learner has turned the statistics off.
  record(user: User, seconds: number) {
    if (user.studyTime === false) return { recorded: false };
    const day = this.today();
    this.store.db
      .prepare(
        "INSERT INTO study_days(user_id,day,seconds,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET seconds=MIN(?,study_days.seconds+excluded.seconds),updated_at=excluded.updated_at",
      )
      .run(user.id, day, Math.min(seconds, MAX_DAY), this.store.now(), MAX_DAY);
    const row = this.store.db
      .prepare("SELECT seconds FROM study_days WHERE user_id=? AND day=?")
      .get(user.id, day) as { seconds: number };
    return { recorded: true, day, today: minutesOf(row.seconds) };
  }
  view(user: User) {
    const today = this.today();
    const rows = (
      this.store.db
        .prepare(
          "SELECT day,seconds FROM study_days WHERE user_id=? ORDER BY day",
        )
        .all(user.id) as DayRow[]
    )
      .map((row) => ({ day: row.day, minutes: minutesOf(row.seconds) }))
      .filter((row) => row.minutes > 0);
    const from = addDays(today, -(WINDOW_DAYS - 1));
    let best = 0,
      run = 0,
      previous = "";
    for (const row of rows) {
      run = previous && addDays(previous, 1) === row.day ? run + 1 : 1;
      best = Math.max(best, run);
      previous = row.day;
    }
    const studied = new Set(rows.map((row) => row.day));
    let current = 0;
    let cursor = studied.has(today) ? today : addDays(today, -1);
    while (studied.has(cursor)) {
      current++;
      cursor = addDays(cursor, -1);
    }
    return {
      enabled: user.studyTime !== false,
      // Today's Beijing date, so the heat map does not trust the phone's clock.
      day: today,
      today: rows.find((row) => row.day === today)?.minutes ?? 0,
      days: rows.filter((row) => row.day >= from && row.day <= today),
      totalMinutes: rows.reduce((sum, row) => sum + row.minutes, 0),
      totalDays: rows.length,
      currentStreak: current,
      bestStreak: best,
    };
  }
  erase(userId: string) {
    const result = this.store.db
      .prepare("DELETE FROM study_days WHERE user_id=?")
      .run(userId);
    return { deleted: Number(result.changes) };
  }
  // For the export: every recorded day as stored.
  export(userId: string) {
    return (
      this.store.db
        .prepare(
          "SELECT day,seconds,updated_at FROM study_days WHERE user_id=? ORDER BY day",
        )
        .all(userId) as { day: string; seconds: number; updated_at: string }[]
    ).map((row) => ({
      day: row.day,
      seconds: row.seconds,
      minutes: minutesOf(row.seconds),
      updatedAt: row.updated_at,
    }));
  }
}

/*
 * 首页汇总：将学习记录、复习任务、错题和最近会话组织为首页可直接展示的数据。
 * 由 routes.ts 调用；聚合本人已有记录，不在读取首页时发起模型生成。
 */
import type { SqliteStore } from "../../shared/store.js";
import {
  addDays,
  chinaDate,
  chinaDayStart,
  now as businessNow,
} from "../../shared/time.js";
import type { ChatService } from "../chat/service.js";
import type { MistakeService } from "../mistakes/service.js";
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
// Everything the home page shows, in one request. Only what the learner actually
// did counts: questions asked, answers judged and reviews done.
export class HomeService {
  constructor(
    private store: SqliteStore,
    private chat: ChatService,
    private mistakes: MistakeService,
    private clock: () => Date = businessNow,
  ) {}
  summary(userId: string) {
    const ms = this.clock().getTime();
    const today = chinaDate(ms);
    const since = chinaDayStart(ms);
    const db = this.store.db;
    // China dates (UTC+8) on which the learner did something.
    const days = new Set(
      (
        db
          .prepare(
            `SELECT d FROM (
              SELECT date(created_at,'+8 hours') AS d FROM messages WHERE user_id=? AND role='user'
              UNION SELECT date(created_at,'+8 hours') FROM attempts WHERE user_id=?
              UNION SELECT date(l.created_at,'+8 hours') FROM review_logs l JOIN reviews r ON r.id=l.review_id WHERE r.user_id=?
            ) ORDER BY d DESC LIMIT 400`,
          )
          .all(userId, userId, userId) as { d: string }[]
      ).map((r) => r.d),
    );
    // A streak still counts while today is not over: it runs up to yesterday.
    let day = days.has(today) ? today : addDays(today, -1);
    let streak = 0;
    while (days.has(day)) {
      streak++;
      day = addDays(day, -1);
    }
    const week = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(today, i - 6);
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      return { date, label: WEEKDAYS[weekday]!, active: days.has(date) };
    });
    const count = (sql: string, ...args: string[]) =>
      (db.prepare(sql).get(...args) as { n: number }).n;
    const asked = count(
      "SELECT COUNT(*) AS n FROM messages WHERE user_id=? AND role='user' AND kind IN ('text','problem','steps') AND created_at>=?",
      userId,
      since,
    );
    const answered = count(
      "SELECT COUNT(*) AS n FROM attempts WHERE user_id=? AND result IS NOT NULL AND created_at>=?",
      userId,
      since,
    );
    const correct = count(
      "SELECT COUNT(*) AS n FROM attempts WHERE user_id=? AND json_extract(result,'$.verdict')='correct' AND created_at>=?",
      userId,
      since,
    );
    const reviewDue = count(
      "SELECT COUNT(*) AS n FROM reviews WHERE user_id=? AND due_on<=?",
      userId,
      today,
    );
    const reviewTotal = count(
      "SELECT COUNT(*) AS n FROM reviews WHERE user_id=?",
      userId,
    );
    return {
      today,
      streak,
      todayDone: days.has(today),
      week,
      todayStats: { asked, answered, correct },
      reviews: { due: reviewDue, total: reviewTotal },
      mistakes: this.mistakes.counts(userId),
      threads: this.chat.list(userId).slice(0, 3),
      usage: this.chat.usage(userId),
    };
  }
}

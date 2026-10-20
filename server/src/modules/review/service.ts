/*
 * 资料复习：按复习盒和到期日安排已加入复习的材料，记录“记得／忘了”的结果。
 * routes.ts 连接复习页；此模块负责资料复习，学习地图的做题复习在 learn 模块中。
 */
import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/domain.js";
import type { SqliteStore } from "../../shared/store.js";
import { addDays, chinaDate, now as businessNow } from "../../shared/time.js";
import type { MaterialService } from "../materials/service.js";
import type { Explanation } from "../study/prompts.js";
import type { HintsData, Reference, StudyService } from "../study/service.js";
// Leitner boxes 1-5: days until the next review once a card sits in that box.
export const INTERVALS = [1, 2, 4, 7, 15];
export type Outcome = "remembered" | "forgot";
type Row = {
  id: string;
  material_id: string;
  box: number;
  due_on: string;
  last_reviewed_at: string | null;
};
export class ReviewService {
  constructor(
    private store: SqliteStore,
    private materials: MaterialService,
    private study: StudyService,
    private now: () => Date = businessNow,
  ) {}
  today() {
    return chinaDate(this.now().getTime());
  }
  // Adding twice keeps the existing schedule.
  add(userId: string, materialId: string) {
    const material = this.materials.own(userId, materialId);
    if (material.status !== "confirmed")
      throw new AppError(409, "NOT_CONFIRMED", "这份内容还没确认，先看看认得对不对");
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO reviews(id,user_id,material_id,box,due_on,created_at) VALUES(?,?,?,1,?,?)",
      )
      .run(
        `rev_${randomUUID().replaceAll("-", "")}`,
        userId,
        materialId,
        addDays(this.today(), INTERVALS[0]!),
        this.now().toISOString(),
      );
    return this.schedule(materialId)!;
  }
  remove(userId: string, materialId: string) {
    this.materials.own(userId, materialId);
    this.store.db
      .prepare("DELETE FROM reviews WHERE material_id=?")
      .run(materialId);
  }
  schedule(materialId: string) {
    const row = this.store.db
      .prepare("SELECT box,due_on FROM reviews WHERE material_id=?")
      .get(materialId) as { box: number; due_on: string } | undefined;
    return row ? { box: row.box, dueOn: row.due_on } : null;
  }
  list(userId: string) {
    const rows = this.store.db
      .prepare(
        "SELECT r.*,m.kind,m.title FROM reviews r JOIN materials m ON m.id=r.material_id WHERE r.user_id=? ORDER BY r.due_on,r.created_at,r.rowid",
      )
      .all(userId) as (Row & { kind: string; title: string })[];
    const today = this.today();
    const due = rows.filter((r) => r.due_on <= today);
    return {
      today,
      due: due.map((r) => this.card(userId, r)),
      upcoming: rows
        .filter((r) => r.due_on > today)
        .map((r) => ({
          id: r.id,
          materialId: r.material_id,
          kind: r.kind,
          title: r.title,
          box: r.box,
          dueOn: r.due_on,
        })),
      counts: { due: due.length, total: rows.length },
    };
  }
  // Remembered moves the card up a box; forgot sends it back to box 1.
  answer(userId: string, reviewId: string, outcome: Outcome) {
    const row = this.store.db
      .prepare("SELECT * FROM reviews WHERE id=? AND user_id=?")
      .get(reviewId, userId) as Row | undefined;
    if (!row) throw new AppError(404, "NOT_FOUND", "复习卡片不存在");
    const box = outcome === "remembered" ? Math.min(5, row.box + 1) : 1;
    const dueOn = addDays(this.today(), INTERVALS[box - 1]!);
    const at = this.now().toISOString();
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE reviews SET box=?,due_on=?,last_reviewed_at=? WHERE id=?",
        )
        .run(box, dueOn, at, row.id);
      this.store.db
        .prepare(
          "INSERT INTO review_logs(id,review_id,outcome,box_before,box_after,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          `rvl_${randomUUID().replaceAll("-", "")}`,
          row.id,
          outcome,
          row.box,
          box,
          at,
        );
    });
    return { id: row.id, box, dueOn };
  }
  // Front: what to recall. Back: the explanation points, or the answer and key steps.
  private card(userId: string, row: Row) {
    const material = this.materials.own(userId, row.material_id);
    const version = material.currentVersion;
    const current = this.materials.version(material.id, version);
    const base = {
      id: row.id,
      materialId: material.id,
      kind: material.kind,
      title: material.title,
      box: row.box,
      dueOn: row.due_on,
      lastReviewedAt: row.last_reviewed_at,
    };
    if (material.kind === "note") {
      const explain = this.study.latest(material.id, "explain", version)
        ?.data as Explanation | undefined;
      const points = (explain?.points ?? []).map((p) => ({
        title: p.title,
        explanation: p.explanation,
      }));
      return {
        ...base,
        prompt: points.length
          ? `不看原文，说出这份资料的 ${points.length} 个重点。`
          : "不看原文，回想这份资料讲了什么。",
        question: "",
        points,
        answer: null,
        steps: [],
        // the whole text, not a silent first 600 characters.
        text: points.length ? "" : (current?.text ?? ""),
      };
    }
    const hints = this.study.latest(material.id, "hints", version)?.data as
      | HintsData
      | undefined;
    const given = current?.answer;
    const answer: Reference | null =
      hints?.answer ?? (given ? { value: given, source: "user" } : null);
    return {
      ...base,
      prompt: "先在纸上把这道题再做一遍，再翻开看答案。",
      question: current?.text ?? "",
      points: [],
      answer,
      steps: hints?.complete ? hints.levels.slice(1) : [],
      text: "",
    };
  }
}

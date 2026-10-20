/*
 * 错题记录：收集作答或批改中发现的问题，管理章节归类、掌握状态和再次练习。
 * 由学习与对话服务写入，routes.ts 提供列表和操作；每次读取或修改都限定当前用户。
 */
import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/domain.js";
import type { SqliteStore } from "../../shared/store.js";
import { addDays, chinaDate, now as businessNow } from "../../shared/time.js";
import type { Jev } from "../../providers/jev.js";
import { readable } from "../render/markdown.js";
import type { ToolLinkService } from "../learn/tool-links.js";
import { recordMistakePass } from "../cards/learning.js";
import { CALC_MAP } from "../learn/calc-map.js";
// Chapters of a first-year calculus course (同济版目录) offered to Jev; the
// descriptions are the decision rules.
export const CHAPTERS: Record<string, [label: string, rule: string]> = {
  limit: [
    "函数与极限",
    "求极限、无穷小的比较、函数的连续性与间断点；不论用洛必达法则还是泰勒展开求极限，都归这一类",
  ],
  derivative: [
    "导数与微分",
    "求导数、微分、高阶导数，隐函数和参数方程求导，切线与法线",
  ],
  application: [
    "中值定理与导数应用",
    "微分中值定理，单调性、极值与最值、凹凸性与拐点、渐近线，用导数证明不等式",
  ],
  indefinite: [
    "不定积分",
    "求原函数或不定积分：换元法、分部积分、有理函数积分",
  ],
  definite: [
    "定积分及其应用",
    "定积分计算、变上限积分、反常积分，求面积、体积、弧长等应用",
  ],
  ode: ["微分方程", "求解常微分方程，或根据条件建立微分方程"],
  space: [
    "向量与空间解析几何",
    "向量运算，空间平面与直线，曲面与空间曲线的方程",
  ],
  multivariable: [
    "多元函数微分",
    "偏导数、全微分、多元复合函数与隐函数求导、多元极值、方向导数与梯度",
  ],
  multiple: ["重积分", "二重积分、三重积分的计算与应用"],
  line: [
    "曲线与曲面积分",
    "两类曲线积分和曲面积分，格林公式、高斯公式、斯托克斯公式",
  ],
  series: [
    "无穷级数",
    "数项级数的敛散性、幂级数的收敛域与和函数、函数展开成幂级数、傅里叶级数",
  ],
  other: ["其他", "不是高等数学的题，或看不出属于哪一章"],
};
export type MistakeStatus = "open" | "mastered";
type Row = Record<string, unknown>;
// The grade reply ends with "**结论**：过程正确" or "**结论**：第 2 步有误，……".
const CONCLUSION = /\*\*结论\*\*\s*[:：]\s*([^\n]+?)\s*$/;
// Some lead with it instead: "**过程正确。**", "**结论先行：** 第 1 步有误，……".
const LEAD =
  /^(?:结论[^:：]{0,4}[:：]\s*)?((?:过程(?:全部)?正确|第\s*\d+\s*步(?:有误|出错|错了))[^\n]*)/;
// "过程正确，但漏了积分常数 C" still loses marks; "没有遗漏" does not.
const SHORT = /(?<!(?:没有?|未|无|不)遗?)(?:漏|缺|忘)/;
export function gradeConclusion(reply: string) {
  const line = CONCLUSION.exec(reply.trim())?.[1];
  if (!line) {
    const first = reply.trim().split("\n")[0]!.replaceAll("**", "").trim();
    const lead = LEAD.exec(first)?.[1];
    if (!lead) return null;
    const text = readable(lead).replace(/[。.]$/, "");
    return { correct: /^过程/.test(text) && !SHORT.test(text), text };
  }
  const text = readable(line);
  if (/有误|错误|不对|出错/.test(text) || SHORT.test(text))
    return { correct: false, text };
  if (/正确/.test(text)) return { correct: true, text };
  return null;
}
// Problems the learner got wrong, one entry per problem. An entry comes from a
// judged answer or from a graded worked solution. It is due the day after, and
// is mastered when the problem (or a similar one) is got right once it is due:
// getting it right the same day, just after seeing the solution, does not count.
export class MistakeService {
  constructor(
    private store: SqliteStore,
    private jev: Jev,
    private clock: () => Date = businessNow,
    private log?: (error: unknown, context: string) => void,
    private toolLinks?: ToolLinkService,
  ) {}
  private today() {
    return chinaDate(this.clock().getTime());
  }
  private isProblem(userId: string, materialId: string) {
    return Boolean(
      this.store.db
        .prepare(
          "SELECT 1 FROM materials WHERE id=? AND user_id=? AND kind='problem' AND status='confirmed'",
        )
        .get(materialId, userId),
    );
  }
  // A judged answer to a problem (not to a generated quiz item). A practice
  // problem comes with its chapter, so it is not classified.
  judged(
    userId: string,
    materialId: string,
    answer: string,
    verdict: string,
    cause: string | null,
    chapter?: string,
    sourceVersion?: number,
  ) {
    if (!this.isProblem(userId, materialId)) return;
    if (verdict === "incorrect")
      this.record(
        userId,
        materialId,
        "judge",
        answer,
        cause,
        chapter,
        sourceVersion,
      );
    else if (verdict === "correct") this.master(userId, materialId);
  }
  // A graded worked solution, read from the conclusion line of the reply.
  graded(
    userId: string,
    materialId: string,
    reply: string,
    sourceVersion?: number,
  ) {
    const found = gradeConclusion(reply);
    if (!found || !this.isProblem(userId, materialId)) return;
    if (found.correct) this.master(userId, materialId);
    else
      this.record(
        userId,
        materialId,
        "grade",
        "",
        found.text.slice(0, 80),
        undefined,
        sourceVersion,
      );
  }
  private record(
    userId: string,
    materialId: string,
    source: "judge" | "grade",
    answer: string,
    cause: string | null,
    chapter?: string,
    sourceVersion?: number,
  ) {
    const time = this.clock();
    const at = time.toISOString();
    const due = addDays(chinaDate(time.getTime()), 1);
    const existing = this.store.db
      .prepare("SELECT id FROM mistakes WHERE user_id=? AND material_id=?")
      .get(userId, materialId) as { id: string } | undefined;
    const id = existing?.id ?? `mis_${randomUUID().replaceAll("-", "")}`;
    if (existing) {
      this.store.db
        .prepare(
          "UPDATE mistakes SET wrong=wrong+1,status='open',source=?,answer=CASE WHEN ?<>'' THEN ? ELSE answer END,cause=COALESCE(?,cause),due_on=?,mastered_at=NULL,mastered_by=NULL,updated_at=? WHERE id=?",
        )
        .run(source, answer, answer, cause, due, at, existing.id);
    } else
      this.insert(id, userId, materialId, source, answer, cause, chapter, due, at);
    // Both a first mistake and a later wrong attempt can revive a dismissed
    // map reminder; a known practice chapter does not limit point matching.
    this.toolLinks?.observeWrong(userId, materialId, id, sourceVersion);
  }
  private insert(
    id: string,
    userId: string,
    materialId: string,
    source: "judge" | "grade",
    answer: string,
    cause: string | null,
    chapter: string | undefined,
    due: string,
    at: string,
    wrong = 1,
  ) {
    this.store.db
      .prepare(
        "INSERT INTO mistakes(id,user_id,material_id,source,answer,cause,chapter,wrong,status,due_on,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'open',?,?,?)",
      )
      .run(
        id,
        userId,
        materialId,
        source,
        answer,
        cause,
        chapter ?? null,
        wrong,
        due,
        at,
        at,
      );
    if (!chapter) void this.classify(id, materialId);
  }
  // The learner files a problem from a conversation by hand. An open entry is
  // left as it is; a mastered one is reopened. filed by hand it has not
  // gone wrong yet, so it starts at wrong=0 (no 错过 1 次 on a right answer).
  addManual(userId: string, materialId: string) {
    if (!this.isProblem(userId, materialId))
      throw new AppError(
        409,
        "NOT_A_PROBLEM",
        "这条不像一道题，没法收进错题本",
      );
    const time = this.clock();
    const at = time.toISOString();
    const due = addDays(chinaDate(time.getTime()), 1);
    const existing = this.store.db
      .prepare(
        "SELECT id,status FROM mistakes WHERE user_id=? AND material_id=?",
      )
      .get(userId, materialId) as { id: string; status: string } | undefined;
    if (!existing)
      this.insert(
        `mis_${randomUUID().replaceAll("-", "")}`,
        userId,
        materialId,
        "judge",
        "",
        null,
        undefined,
        due,
        at,
        0,
      );
    else if (existing.status !== "open")
      this.store.db
        .prepare(
          "UPDATE mistakes SET status='open',due_on=?,mastered_at=NULL,mastered_by=NULL,updated_at=? WHERE id=?",
        )
        .run(due, at, existing.id);
    return this.forMaterial(userId, materialId)!;
  }
  private master(userId: string, materialId: string) {
    const at = this.clock().toISOString();
    const row = this.store.db
      .prepare(
        "SELECT id FROM mistakes WHERE user_id=? AND material_id=? AND status='open' AND due_on<=?",
      )
      .get(userId, materialId, this.today());
    if (!row) return;
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE mistakes SET status='mastered',mastered_at=?,mastered_by='redo',updated_at=? WHERE user_id=? AND material_id=? AND status='open' AND due_on<=?",
        )
        .run(at, at, userId, materialId, this.today());
      recordMistakePass(this.store, userId, String(row.id), at);
    });
  }
  // The entry of one problem, for the conversation it was asked in.
  forMaterial(userId: string, materialId: string) {
    const row = this.store.db
      .prepare(
        "SELECT id,status,wrong,due_on FROM mistakes WHERE user_id=? AND material_id=?",
      )
      .get(userId, materialId) as Row | undefined;
    if (!row) return null;
    const dueOn = String(row.due_on);
    return {
      id: String(row.id),
      status: String(row.status) as MistakeStatus,
      wrong: Number(row.wrong),
      dueOn,
      due: row.status === "open" && dueOn <= this.today(),
      mapPoint: this.toolLinks?.pointForMistake(userId, String(row.id)) ?? null,
    };
  }
  // Best effort: an entry without a chapter is listed under 其他.
  private async classify(id: string, materialId: string) {
    if (!this.jev.configured) return;
    try {
      const text = this.problemText(materialId);
      if (!text) return;
      const pick = await this.jev.choice(
        { problem: text.slice(0, 1500) },
        "这道题主要考查高等数学哪一章的内容？",
        Object.fromEntries(
          Object.entries(CHAPTERS).map(([key, [, rule]]) => [key, rule]),
        ),
      );
      const chapter =
        CHAPTERS[pick.choice] && pick.confidence >= 0.35
          ? pick.choice
          : "other";
      this.store.db
        .prepare("UPDATE mistakes SET chapter=? WHERE id=?")
        .run(chapter, id);
    } catch (error) {
      this.log?.(error, "mistake chapter not classified");
    }
  }
  private problemText(materialId: string) {
    const row = this.store.db
      .prepare(
        "SELECT v.text FROM materials m JOIN material_versions v ON v.material_id=m.id AND v.version=m.current_version WHERE m.id=?",
      )
      .get(materialId) as { text: string } | undefined;
    return row?.text ?? "";
  }
  private view(row: Row, userId: string) {
    const chapter = row.chapter ? String(row.chapter) : null;
    const dueOn = String(row.due_on);
    return {
      id: String(row.id),
      materialId: String(row.material_id),
      // The conversation the problem was asked in, if it still exists.
      threadId: (row.thread_id as string | null) ?? null,
      problem: String(row.text ?? ""),
      answer: String(row.answer ?? ""),
      cause: (row.cause as string | null) ?? null,
      source: String(row.source),
      chapter,
      chapterLabel: CHAPTERS[chapter ?? "other"]![0],
      wrong: Number(row.wrong),
      status: String(row.status) as MistakeStatus,
      dueOn,
      due: row.status === "open" && dueOn <= this.today(),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      masteredAt: (row.mastered_at as string | null) ?? null,
      // how it was filed as 弄懂了: 'self' (我会了), 'redo' (redone right
      // once due); null for entries mastered before V4.2 or by an older server.
      masteredBy:
        row.status === "mastered" && row.mastered_by
          ? (String(row.mastered_by) as "self" | "redo")
          : null,
      mapPoint: this.toolLinks?.pointForMistake(userId, String(row.id)) ?? null,
    };
  }
  // a page of the list (the first 200 when nothing is asked, as
  // before), optionally one chapter as counts groups it ('other' takes the
  // unclassified); `more` when rows are left past the page.
  list(
    userId: string,
    status: MistakeStatus = "open",
    pointId?: string,
    page: { offset?: number; limit?: number; chapter?: string } = {},
  ) {
    const offset = page.offset ?? 0;
    const limit = page.limit ?? 200;
    const rows = this.store.db
      .prepare(
        `SELECT k.*,v.text,(SELECT t.id FROM threads t WHERE t.material_id=k.material_id AND t.user_id=k.user_id ORDER BY t.updated_at DESC LIMIT 1) AS thread_id FROM mistakes k JOIN materials m ON m.id=k.material_id AND m.user_id=k.user_id LEFT JOIN material_versions v ON v.material_id=m.id AND v.version=m.current_version WHERE k.user_id=? AND k.status=? ${pointId ? "AND k.map_point_id=? AND k.map_version=m.current_version" : ""} ${page.chapter ? "AND COALESCE(k.chapter,'other')=?" : ""} ORDER BY k.due_on,k.updated_at DESC,k.id LIMIT ? OFFSET ?`,
      )
      .all(
        userId,
        status,
        ...(pointId ? [pointId] : []),
        ...(page.chapter ? [page.chapter] : []),
        limit + 1,
        offset,
      ) as Row[];
    return {
      items: rows.slice(0, limit).map((row) => this.view(row, userId)),
      more: rows.length > limit,
    };
  }
  counts(userId: string, pointId?: string) {
    const rows = this.store.db
      .prepare(
        `SELECT k.status,COALESCE(k.chapter,'other') AS chapter,SUM(CASE WHEN k.due_on<=? THEN 1 ELSE 0 END) AS due,COUNT(*) AS n FROM mistakes k JOIN materials m ON m.id=k.material_id AND m.user_id=k.user_id WHERE k.user_id=? ${pointId ? "AND k.map_point_id=? AND k.map_version=m.current_version" : ""} GROUP BY k.status,COALESCE(k.chapter,'other')`,
      )
      .all(this.today(), userId, ...(pointId ? [pointId] : [])) as {
      status: string;
      chapter: string;
      due: number;
      n: number;
    }[];
    const open = rows.filter((r) => r.status === "open");
    return {
      open: open.reduce((s, r) => s + r.n, 0),
      ...(pointId
        ? {
            point:
              CALC_MAP.chapters
                .flatMap((c) => c.points)
                .filter((p) => p.id === pointId)
                .map((p) => ({ id: p.id, name: p.name }))[0] ?? null,
          }
        : {}),
      due: open.reduce((s, r) => s + r.due, 0),
      mastered: rows
        .filter((r) => r.status === "mastered")
        .reduce((s, r) => s + r.n, 0),
      // Where the open ones are, most first.
      chapters: open
        .map((r) => ({
          chapter: r.chapter,
          label: CHAPTERS[r.chapter]?.[0] ?? CHAPTERS.other![0],
          n: r.n,
        }))
        .sort((a, b) => b.n - a.n),
    };
  }
  private own(userId: string, id: string) {
    const row = this.store.db
      .prepare("SELECT id FROM mistakes WHERE id=? AND user_id=?")
      .get(id, userId);
    if (!row) throw new AppError(404, "NOT_FOUND", "这道错题不存在或已删除");
  }
  // The learner can file a mistake as mastered, or put it back.
  setStatus(userId: string, id: string, status: MistakeStatus) {
    this.own(userId, id);
    const previous = this.store.db
      .prepare("SELECT status FROM mistakes WHERE id=? AND user_id=?")
      .get(id, userId);
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE mistakes SET status=?,mastered_at=?,mastered_by=?,due_on=CASE WHEN ?='open' THEN ? ELSE due_on END,updated_at=? WHERE id=?",
        )
        .run(
          status,
          status === "mastered" ? this.clock().toISOString() : null,
          status === "mastered" ? "self" : null,
          status,
          this.today(),
          this.clock().toISOString(),
          id,
        );
      if (status === "mastered" && previous?.status !== "mastered")
        recordMistakePass(this.store, userId, id, this.clock().toISOString());
    });
  }
  // Removes the entry only; the problem and its conversation stay.
  remove(userId: string, id: string) {
    this.own(userId, id);
    this.store.db.prepare("DELETE FROM mistakes WHERE id=?").run(id);
  }
}

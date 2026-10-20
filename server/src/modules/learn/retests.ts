import type { SqliteStore } from "../../shared/store.js";
import { addDays, chinaDate, now as businessNow } from "../../shared/time.js";
import { BANK } from "./problems.js";

export type RetestCause = "explanation" | "hint" | "ask" | "stuck" | "wrong";
export type RetestPrediction = "yes" | "unsure" | "no";
export type RetestResult = "right" | "wrong" | "hinted" | "early" | "dropped";

export type RetestRow = {
  id: number;
  user_id: string;
  point_id: string;
  cause: RetestCause;
  problem_index: number;
  round: 1 | 2;
  due_on: string;
  predicted: RetestPrediction | null;
  result: RetestResult | null;
  created_at: string;
  done_at: string | null;
};

type ScheduleMeta = {
  retestId: number;
  pointId: string;
  round: number;
  usedIndex: number;
  seenIndexes: number[];
  problemIndex: number;
  repeated: boolean;
};

export type RetestView = {
  id: number;
  cause: RetestCause;
  problemIndex: number;
  round: 1 | 2;
  dueOn: string;
  predicted: RetestPrediction | null;
  result: RetestResult | null;
  mode: boolean;
  repeated: boolean | null;
};

export function availableProblemIndexes(pointId: string): number[] {
  return (BANK[pointId] ?? []).map((_, index) => index);
}

// Prefer an unseen variant, then any unseen problem, then a different problem.
// `repeated` is fixed when scheduled and must not be recomputed after the bank changes.
// `avoid` : problems the detail page showed as its worked
// example, answer and solution; one comes back only when no other is left,
// so repeating the used problem beats it.
export function chooseRetestProblem(
  pointId: string,
  usedIndex: number,
  seenIndexes: number[] = [usedIndex],
  avoid: number[] = [],
) {
  const all = availableProblemIndexes(pointId);
  const rest = all.filter((index) => !avoid.includes(index));
  const available = rest.length ? rest : all;
  const seen = new Set(seenIndexes);
  const unseen = available.filter((index) => !seen.has(index));
  const problemIndex =
    unseen.find((index) => index >= 2) ??
    unseen[0] ??
    available.find((index) => index !== usedIndex) ??
    available[0] ??
    usedIndex;
  return { problemIndex, repeated: seen.has(problemIndex) };
}

export class RetestService {
  constructor(
    private readonly store: SqliteStore,
    private readonly clock: () => Date = businessNow,
  ) {}

  private stamp() {
    return this.clock().toISOString();
  }

  private day() {
    return chinaDate(this.clock().getTime());
  }

  current(userId: string, pointId: string): RetestRow | null {
    return (
      (this.store.db
        .prepare(
          "SELECT * FROM retests WHERE user_id=? AND point_id=? AND done_at IS NULL",
        )
        .get(userId, pointId) as RetestRow | undefined) ?? null
    );
  }

  due(userId: string, pointId: string, today = this.day()): RetestRow | null {
    const row = this.current(userId, pointId);
    return row && row.due_on <= today ? row : null;
  }

  private meta(userId: string, retestId: number): ScheduleMeta | null {
    const row = this.store.db
      .prepare(
        "SELECT data FROM events WHERE user_id=? AND name='retest_scheduled' AND json_extract(data,'$.retestId')=? ORDER BY id DESC LIMIT 1",
      )
      .get(userId, retestId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ScheduleMeta) : null;
  }

  private logSchedule(userId: string, meta: ScheduleMeta, at = this.stamp()) {
    this.store.db
      .prepare(
        "INSERT INTO events(user_id,name,data,created_at) VALUES(?,'retest_scheduled',?,?)",
      )
      .run(userId, JSON.stringify(meta), at);
  }

  // The problems the detail page has shown as its worked example
  // (map_points.attempts, learn/service.ts).
  private shown(userId: string, pointId: string): number[] {
    const row = this.store.db
      .prepare("SELECT attempts FROM map_points WHERE user_id=? AND point_id=?")
      .get(userId, pointId) as { attempts: string | null } | undefined;
    const attempts = (row?.attempts ? JSON.parse(row.attempts) : {}) as Record<
      string,
      { shownOn?: string }
    >;
    return Object.entries(attempts)
      .filter(([, item]) => item.shownOn)
      .map(([index]) => Number(index));
  }

  // The detail page has just shown problem `index` as its worked example
  // : an open retest on it moves to another problem when there is one,
  // as after help on it. The caller owns the transaction.
  moveOffExample(userId: string, pointId: string, index: number, at = this.stamp()) {
    const existing = this.current(userId, pointId);
    if (!existing || existing.problem_index !== index) return;
    const old = this.meta(userId, existing.id);
    const usedIndex = old?.usedIndex ?? index;
    const seenIndexes = old?.seenIndexes ?? [usedIndex];
    const chosen = chooseRetestProblem(
      pointId,
      usedIndex,
      seenIndexes,
      this.shown(userId, pointId),
    );
    if (chosen.problemIndex === existing.problem_index) return;
    this.store.db
      .prepare("UPDATE retests SET problem_index=? WHERE id=? AND user_id=?")
      .run(chosen.problemIndex, existing.id, userId);
    this.logSchedule(
      userId,
      {
        retestId: existing.id,
        pointId,
        round: existing.round,
        usedIndex,
        seenIndexes,
        ...chosen,
      },
      at,
    );
  }

  repeated(userId: string, retestId: number): boolean | null {
    return this.meta(userId, retestId)?.repeated ?? null;
  }

  view(userId: string, row: RetestRow, today = this.day()): RetestView {
    return {
      id: row.id,
      cause: row.cause,
      problemIndex: row.problem_index,
      round: row.round,
      dueOn: row.due_on,
      predicted: row.predicted,
      result: row.result,
      mode: row.done_at === null && row.due_on <= today,
      repeated: this.repeated(userId, row.id),
    };
  }

  schedule(userId: string, pointId: string, cause: RetestCause, usedIndex = 0) {
    const at = this.stamp(),
      today = chinaDate(Date.parse(at));
    return this.store.transaction(() =>
      this.scheduleInTransaction(userId, pointId, cause, usedIndex, at, today),
    );
  }

  markHelp(userId: string, pointId: string, cause: RetestCause, usedIndex = 0) {
    return this.store.transaction(() => {
      if (!availableProblemIndexes(pointId).length) return null;
      const at = this.stamp(),
        today = chinaDate(Date.parse(at));
      this.store.db
        .prepare(
          `INSERT INTO map_points(user_id,point_id,practice_on,updated_at) VALUES(?,?,?,?)
         ON CONFLICT(user_id,point_id) DO UPDATE SET practice_on=excluded.practice_on,updated_at=excluded.updated_at`,
        )
        .run(userId, pointId, today, at);
      return this.scheduleInTransaction(
        userId,
        pointId,
        cause,
        usedIndex,
        at,
        today,
      );
    });
  }

  scheduleInTransaction(
    userId: string,
    pointId: string,
    cause: RetestCause,
    usedIndex = 0,
    at = this.stamp(),
    today = chinaDate(Date.parse(at)),
  ) {
    if (!availableProblemIndexes(pointId).length) return null;
    const disabled = this.store.db
      .prepare(
        "SELECT 1 FROM resume_items WHERE user_id=? AND src='point' AND src_id=? AND state='never' LIMIT 1",
      )
      .get(userId, pointId);
    if (disabled) return null;
    const progress = this.store.db
      .prepare(
        "SELECT correct_at FROM map_points WHERE user_id=? AND point_id=?",
      )
      .get(userId, pointId) as { correct_at: string | null } | undefined;
    if (progress?.correct_at) return null;
    const existing = this.current(userId, pointId);
    if (existing) {
      if (existing.problem_index === usedIndex) {
        const old = this.meta(userId, existing.id);
        const seenIndexes = [
          ...new Set([...(old?.seenIndexes ?? []), usedIndex]),
        ];
        const chosen = chooseRetestProblem(
          pointId,
          usedIndex,
          seenIndexes,
          this.shown(userId, pointId),
        );
        if (chosen.problemIndex !== existing.problem_index) {
          this.store.db
            .prepare(
              "UPDATE retests SET problem_index=? WHERE id=? AND user_id=?",
            )
            .run(chosen.problemIndex, existing.id, userId);
          this.logSchedule(
            userId,
            {
              retestId: existing.id,
              pointId,
              round: existing.round,
              usedIndex,
              seenIndexes,
              ...chosen,
            },
            at,
          );
          existing.problem_index = chosen.problemIndex;
        }
      }
      return this.view(userId, existing, today);
    }
    const seenIndexes = [usedIndex];
    const chosen = chooseRetestProblem(
      pointId,
      usedIndex,
      seenIndexes,
      this.shown(userId, pointId),
    );
    const createdAt = at;
    const result = this.store.db
      .prepare(
        "INSERT INTO retests(user_id,point_id,cause,problem_index,round,due_on,created_at) VALUES(?,?,?,?,1,?,?)",
      )
      .run(
        userId,
        pointId,
        cause,
        chosen.problemIndex,
        addDays(today, 2),
        createdAt,
      );
    const row = this.current(userId, pointId)!;
    this.logSchedule(
      userId,
      {
        retestId: Number(result.lastInsertRowid),
        pointId,
        round: 1,
        usedIndex,
        seenIndexes,
        ...chosen,
      },
      at,
    );
    return this.view(userId, row, today);
  }

  predictInTransaction(
    userId: string,
    row: RetestRow,
    predicted: RetestPrediction,
  ) {
    this.store.db
      .prepare(
        "UPDATE retests SET predicted=? WHERE id=? AND user_id=? AND done_at IS NULL",
      )
      .run(predicted, row.id, userId);
  }

  finishInTransaction(
    userId: string,
    row: RetestRow,
    result: RetestResult,
    predicted: RetestPrediction | null = row.predicted,
    at = this.stamp(),
    today = chinaDate(Date.parse(at)),
  ) {
    const doneAt = at;
    this.store.db
      .prepare(
        "UPDATE retests SET predicted=?,result=?,done_at=? WHERE id=? AND user_id=? AND done_at IS NULL",
      )
      .run(predicted, result, doneAt, row.id, userId);
    let next: RetestRow | null = null;
    if ((result === "wrong" || result === "hinted") && row.round === 1) {
      const old = this.meta(userId, row.id);
      const seenIndexes = [
        ...new Set([...(old?.seenIndexes ?? []), row.problem_index]),
      ];
      const chosen = chooseRetestProblem(
        row.point_id,
        row.problem_index,
        seenIndexes,
        this.shown(userId, row.point_id),
      );
      const inserted = this.store.db
        .prepare(
          "INSERT INTO retests(user_id,point_id,cause,problem_index,round,due_on,created_at) VALUES(?,?,?,?,2,?,?)",
        )
        .run(
          userId,
          row.point_id,
          result === "wrong" ? "wrong" : "hint",
          chosen.problemIndex,
          addDays(today, 3),
          doneAt,
        );
      next = this.current(userId, row.point_id)!;
      this.logSchedule(
        userId,
        {
          retestId: Number(inserted.lastInsertRowid),
          pointId: row.point_id,
          round: 2,
          usedIndex: row.problem_index,
          seenIndexes,
          ...chosen,
        },
        at,
      );
    }
    const finished = this.store.db
      .prepare("SELECT * FROM retests WHERE id=? AND user_id=?")
      .get(row.id, userId) as RetestRow;
    return {
      finished: this.view(userId, finished, today),
      next: next ? this.view(userId, next, today) : null,
    };
  }

  drop(userId: string, pointId: string) {
    return this.store.transaction(() => {
      const row = this.current(userId, pointId);
      return row ? this.finishInTransaction(userId, row, "dropped") : null;
    });
  }

  summaryRows(userId: string, today = this.day()) {
    return this.store.db
      .prepare(
        "SELECT * FROM retests WHERE user_id=? AND (done_at IS NULL OR done_at>=?) ORDER BY created_at,id",
      )
      .all(userId, addDays(today, -1)) as RetestRow[];
  }
}

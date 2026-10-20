import { AppError } from "../../shared/domain.js";
import type { SqliteStore } from "../../shared/store.js";
import { now as businessNow } from "../../shared/time.js";

type MoodHooks = {
  // The chat and job owners can abort in-flight work before its rows disappear.
  // These hooks deliberately stay narrow: this service does not own streaming
  // controllers or the job runner.
  stopThreads?: (threadIds: readonly string[]) => void;
  stopJobs?: (userId: string, jobIds: readonly string[]) => void;
  removeThread?: (userId: string, threadId: string) => () => void;
};

type MoodRemoval = {
  threads: number;
  cards: number;
  brainstorms: number;
  imports: number;
  notes: number;
  jobs: number;
};

type IdRow = { id: string };

const ids = (rows: IdRow[]) => rows.map((row) => row.id);
const marks = (count: number) =>
  Array.from({ length: count }, () => "?").join(",");

export class MoodService {
  constructor(
    private readonly store: SqliteStore,
    private readonly hooks: MoodHooks = {},
    private readonly clock: () => Date = businessNow,
  ) {}

  // A child's account also needs the guardian's separate consent (儿童规则第十章),
  // kept as { kind: "guardian", scope: "mood" } in the user's consents.
  consent(userId: string, guardian = false) {
    const existing = this.store.getUser(userId);
    if (!existing) throw new AppError(404, "NOT_FOUND", "用户不存在");
    const child = existing.ageBand === "child";
    if (child && !guardian)
      throw new AppError(
        400,
        "GUARDIAN_REQUIRED",
        "未满 14 周岁要监护人同意，请家长勾选后再点同意",
      );
    const at = this.clock().toISOString();
    const consentedAt = existing.moodConsentAt ?? at;
    const recorded = (existing.consents ?? []).some(
      (c) => c.kind === "guardian" && c.scope === "mood",
    );
    if (existing.moodConsentAt && (!child || recorded)) return { consentedAt };
    const version =
      (existing.consents ?? []).filter((c) => c.kind === "docs").at(-1)
        ?.version ?? "";
    const next = {
      ...existing,
      moodConsentAt: consentedAt,
      ...(child
        ? {
            consents: [
              ...(existing.consents ?? []),
              { kind: "guardian" as const, scope: "mood" as const, version, at },
            ],
          }
        : {}),
    };
    this.store.db
      .prepare("UPDATE users SET data=? WHERE id=?")
      .run(JSON.stringify(next), userId);
    return { consentedAt };
  }

  list(userId: string) {
    const user = this.store.getUser(userId);
    if (!user) throw new AppError(404, "NOT_FOUND", "用户不存在");
    const rows = this.store.db
      .prepare(
        `SELECT t.id,t.title,t.scene,t.mood_cards,t.created_at,
      (SELECT content FROM messages WHERE thread_id=t.id AND role='user' ORDER BY created_at,rowid LIMIT 1) AS first,
      (SELECT count(*) FROM cards c WHERE c.user_id=t.user_id AND c.origin='chat' AND c.src_id=t.id) AS cards
      FROM threads t WHERE user_id=? AND (scene='mood' OR mood_cards=1) ORDER BY updated_at DESC,id`,
      )
      .all(userId);
    const view = (r: Record<string, unknown>) => ({
      id: String(r.id),
      title: String(r.first || r.title)
        .split(/[。！？!?\n]/)[0]!
        .slice(0, 40),
      date: String(r.created_at),
      cards: Number(r.cards),
    });
    const threads = rows.filter((r) => r.scene === "mood").map(view);
    const linkedThreads = rows.filter((r) => r.mood_cards === 1).map(view);
    const brainstorms = this.store.db
      .prepare(
        "SELECT id,COALESCE(json_extract(result,'$.title'),'头脑风暴') AS title,created_at AS date FROM brainstorms WHERE user_id=? AND scene='mood' ORDER BY updated_at DESC,id",
      )
      .all(userId);
    return {
      consentedAt: user.moodConsentAt ?? null,
      threads,
      linkedThreads,
      brainstorms,
      counts: {
        cards: Number(
          this.store.db
            .prepare(
              "SELECT count(*) AS n FROM cards WHERE user_id=? AND scene='mood'",
            )
            .get(userId)!.n,
        ),
        linkedThreads: linkedThreads.length,
        brainstorms: brainstorms.length,
      },
    };
  }

  remove(userId: string): MoodRemoval {
    return this.removeAll(userId, false);
  }

  withdrawConsent(userId: string): MoodRemoval {
    return this.removeAll(userId, true);
  }

  private removeAll(userId: string, withdrawConsent: boolean): MoodRemoval {
    if (!this.store.getUser(userId))
      throw new AppError(404, "NOT_FOUND", "用户不存在");

    // Read every design-specified association before any cascade deletes it.
    // There is no await below, so these ids and the following transaction form
    // one synchronous deletion operation in the Node process.
    const threadIds = ids(
      this.store.db
        .prepare(
          "SELECT id FROM threads WHERE user_id=? AND (scene='mood' OR mood_cards=1)",
        )
        .all(userId) as IdRow[],
    );
    const cardIds = ids(
      this.store.db
        .prepare("SELECT id FROM cards WHERE user_id=? AND scene='mood'")
        .all(userId) as IdRow[],
    );
    const brainstormIds = ids(
      this.store.db
        .prepare("SELECT id FROM brainstorms WHERE user_id=? AND scene='mood'")
        .all(userId) as IdRow[],
    );
    const importIds = ids(
      this.store.db
        .prepare(
          `SELECT DISTINCT src_id AS id FROM cards WHERE user_id=? AND scene='mood' AND origin='import' AND src_id IS NOT NULL
           UNION SELECT id FROM imports WHERE user_id=? AND EXISTS
           (SELECT 1 FROM json_each(COALESCE(candidates,'[]')) WHERE json_extract(value,'$.savedScene')='mood')`,
        )
        .all(userId, userId) as IdRow[],
    );
    // A legacy note copied into a mood card must go too, otherwise startup
    // backfill could recreate it after this deletion.
    const noteIds = ids(
      this.store.db
        .prepare(
          "SELECT DISTINCT src_id AS id FROM cards WHERE user_id=? AND scene='mood' AND origin='note' AND src_id IS NOT NULL",
        )
        .all(userId) as IdRow[],
    );
    const affectedIds = [
      ...threadIds,
      ...cardIds,
      ...brainstormIds,
      ...importIds,
      ...noteIds,
    ];
    const jobIds = this.jobsFor(userId, affectedIds);

    this.hooks.stopThreads?.(threadIds);
    this.hooks.stopJobs?.(userId, jobIds);

    const cleanup: (() => void)[] = [];
    const removed = this.store.transaction(() => {
      const now = this.clock().toISOString();
      for (const id of threadIds) {
        if (
          this.store.db
            .prepare("SELECT 1 FROM threads WHERE id=? AND user_id=?")
            .get(id, userId)
        ) {
          const unlink = this.hooks.removeThread?.(userId, id);
          if (unlink) cleanup.push(unlink);
        }
      }
      if (threadIds.length)
        this.store.db
          .prepare(
            `DELETE FROM threads WHERE user_id=? AND id IN (${marks(threadIds.length)})`,
          )
          .run(userId, ...threadIds);
      if (brainstormIds.length)
        this.store.db
          .prepare(
            `DELETE FROM brainstorms WHERE user_id=? AND id IN (${marks(brainstormIds.length)})`,
          )
          .run(userId, ...brainstormIds);
      // the text left past the import limit (imports.extra) goes too.
      if (importIds.length)
        this.store.db
          .prepare(
            `UPDATE imports SET segments='[]',candidates=NULL,extra=NULL WHERE user_id=? AND id IN (${marks(importIds.length)})`,
          )
          .run(userId, ...importIds);
      if (cardIds.length)
        this.store.db
          .prepare(
            `DELETE FROM cards WHERE user_id=? AND id IN (${marks(cardIds.length)})`,
          )
          .run(userId, ...cardIds);
      // a study or life original merged into a removed mood card comes
      // back on its own instead of staying hidden behind nothing.
      this.store.db
        .prepare(
          "UPDATE cards SET merged_into=NULL WHERE user_id=? AND merged_into IS NOT NULL AND merged_into NOT IN (SELECT id FROM cards WHERE user_id=?)",
        )
        .run(userId, userId);
      if (noteIds.length)
        this.store.db
          .prepare(
            `DELETE FROM notes WHERE user_id=? AND id IN (${marks(noteIds.length)})`,
          )
          .run(userId, ...noteIds);

      this.removeResume(userId, "card", cardIds);
      this.removeResume(userId, "brainstorm", brainstormIds);
      this.removeResume(userId, "import", importIds);
      this.invalidateJobs(userId, jobIds, now);
      // User-created labels are intentional organization and always remain.
      this.store.db
        .prepare(
          "DELETE FROM tags WHERE user_id=? AND by='ai' AND NOT EXISTS (SELECT 1 FROM card_tags WHERE card_tags.tag_id=tags.id)",
        )
        .run(userId);
      if (withdrawConsent)
        this.store.db
          .prepare(
            "UPDATE users SET data=json_remove(data,'$.moodConsentAt') WHERE id=?",
          )
          .run(userId);

      return {
        threads: threadIds.length,
        cards: cardIds.length,
        brainstorms: brainstormIds.length,
        imports: importIds.length,
        notes: noteIds.length,
        jobs: jobIds.length,
      };
    });
    cleanup.forEach((unlink) => unlink());
    return removed;
  }

  private removeResume(
    userId: string,
    src: "card" | "brainstorm" | "import",
    srcIds: string[],
  ) {
    if (!srcIds.length) return;
    this.store.db
      .prepare(
        `DELETE FROM resume_items WHERE user_id=? AND src=? AND src_id IN (${marks(srcIds.length)})`,
      )
      .run(userId, src, ...srcIds);
  }

  private jobsFor(userId: string, targetIds: string[]) {
    if (!targetIds.length) return [];
    return ids(
      this.store.db
        .prepare(
          `SELECT id FROM jobs WHERE user_id=? AND EXISTS (
            SELECT 1 FROM json_tree(jobs.params)
            WHERE json_tree.type='text' AND json_tree.value IN (${marks(targetIds.length)})
          )`,
        )
        .all(userId, ...targetIds) as IdRow[],
    );
  }

  private invalidateJobs(userId: string, jobIds: string[], now: string) {
    if (!jobIds.length) return;
    this.store.db
      .prepare(
        `UPDATE jobs SET params=?,params_hash='deleted:'||id,version=NULL,result=NULL,
          status=CASE WHEN status IN ('queued','running') THEN 'failed' ELSE status END,
          error_code=CASE WHEN status IN ('queued','running') THEN 'MOOD_DELETED' ELSE error_code END,
          error_message=CASE WHEN status IN ('queued','running') THEN '心情内容已删除' ELSE error_message END,
          finished_at=COALESCE(finished_at,?)
          WHERE user_id=? AND id IN (${marks(jobIds.length)})`,
      )
      .run(JSON.stringify({ deleted: true }), now, userId, ...jobIds);
  }
}

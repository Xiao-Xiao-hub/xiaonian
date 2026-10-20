/*
 * 随心记原始记录：保存原话、补充、整理结果和知识点关联，兼容既有笔记流程。
 * routes.ts 是接口入口；整理使用 JobRunner，卡片的新流程在 cards 模块维护。
 * 原话与整理结果分开存储；异步整理提交前重新核对版本，不能覆盖后来的人工编辑。
 */
import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/domain.js";
import type { SqliteStore } from "../../shared/store.js";
import { now as businessNow } from "../../shared/time.js";
import type { LlmClient } from "../../providers/llm.js";
import {
  JobError,
  publicJob,
  toJob,
  type Job,
  type JobHandler,
  type JobRunner,
} from "../jobs/runner.js";
import {
  NOTE_TEXT_LIMIT,
  NOTE_TITLE_LIMIT,
  SUPPLEMENT_LIMIT,
  SUPPLEMENT_COUNT,
  SOURCE_LIMIT,
  POINT_IDS,
  itemInput,
  notePrompt,
  noteSchema,
  type ModelNote,
  type NoteSource,
} from "./schema.js";
export { NOTE_TEXT_LIMIT, NOTE_TITLE_LIMIT } from "./schema.js";
type Row = Record<string, unknown>;
type Versions = { revision: number; resultVersion: number };
export type NoteResult = {
  sourceVersion: number;
  generatedAt: string;
  origin: "ai";
  items: (ModelNote["items"][number] & { id: string; edited: boolean })[];
  question: { prompt: string; options: { id: string; text: string }[] };
  nextStep: ModelNote["nextStep"];
};
export type Note = {
  id: string;
  text: string;
  title: string;
  status: "raw" | "organized";
  result: NoteResult | null;
  pointId: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
  sourceVersion: number;
  resultVersion: number;
  supplements: { id: string; text: string; createdAt: string }[];
  resultStale: boolean;
  aiJob: ReturnType<typeof publicJob> | null;
};
const missing = () => new AppError(404, "NOT_FOUND", "这条随心记不存在");
const changed = () =>
  new AppError(409, "NOTE_CHANGED", "这条随心记已更新，请重新载入后操作");
const uid = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
// Original words never go through normalization or Markdown.
const titleFrom = (text: string) =>
  Array.from(
    text
      .split(/\r\n|\r|\n/)
      .find((line) => line.trim())!
      .trim(),
  )
    .slice(0, 32)
    .join("");
export class NoteService {
  constructor(
    private readonly store: SqliteStore,
    private readonly clock: () => Date = businessNow,
    private readonly llm?: LlmClient,
  ) {}
  private own(userId: string, id: string): Row {
    const row = this.store.db
      .prepare("SELECT * FROM notes WHERE id=? AND user_id=?")
      .get(id, userId);
    if (!row) throw missing();
    return row;
  }
  private check(row: Row, v: Versions) {
    if (
      Number(row.revision) !== v.revision ||
      Number(row.result_version) !== v.resultVersion
    )
      throw changed();
  }
  private view(row: Row): Note {
    const id = String(row.id),
      result =
        row.result === null
          ? null
          : (JSON.parse(String(row.result)) as NoteResult);
    const supplements = this.store.db
      .prepare(
        "SELECT id,text,created_at FROM note_supplements WHERE note_id=? ORDER BY created_at,rowid",
      )
      .all(id)
      .map((s) => ({
        id: String(s.id),
        text: String(s.text),
        createdAt: String(s.created_at),
      }));
    const job = this.store.db
      .prepare(
        "SELECT * FROM jobs WHERE user_id=? AND kind='note_organize' AND version=? AND json_extract(params,'$.noteId')=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get(String(row.user_id), Number(row.revision), id);
    return {
      id,
      text: String(row.text),
      title: String(row.title),
      status: row.status as Note["status"],
      result,
      pointId: row.point_id === null ? null : String(row.point_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      revision: Number(row.revision),
      sourceVersion: Number(row.source_version),
      resultVersion: Number(row.result_version),
      supplements,
      resultStale: Boolean(
        result && result.sourceVersion !== Number(row.source_version),
      ),
      aiJob: job ? publicJob(toJob(job)) : null,
    };
  }
  // A retried create with the same clientId returns the note made the first time.
  create(userId: string, text: string, clientId?: string): Note {
    if (!text.trim()) throw new AppError(400, "TEXT_EMPTY", "请输入想记下的话");
    if (text.length > NOTE_TEXT_LIMIT)
      throw new AppError(
        400,
        "TEXT_TOO_LONG",
        "随心记最多保存 2000 字，请分条记录",
      );
    const id = uid("note"),
      iso = this.clock().toISOString();
    return this.store.transaction(() => {
      if (clientId) {
        const old = this.store.db
          .prepare("SELECT id,text FROM notes WHERE user_id=? AND client_id=?")
          .get(userId, clientId);
        if (old && old.text !== text)
          throw new AppError(
            409,
            "CLIENT_ID_REUSED",
            "这条随心记已保存过，请刷新后再试",
          );
        if (old) return this.detail(userId, String(old.id));
      }
      this.store.db
        .prepare(
          "INSERT INTO notes(id,user_id,text,title,status,result,point_id,created_at,updated_at,title_edited,client_id) VALUES(?,?,?,?,'raw',NULL,NULL,?,?,0,?)",
        )
        .run(id, userId, text, titleFrom(text), iso, iso, clientId ?? null);
      return this.detail(userId, id);
    });
  }
  list(userId: string, paging: { limit: number; offset: number }): Note[] {
    return this.store.db
      .prepare(
        "SELECT * FROM notes WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
      )
      .all(userId, paging.limit, paging.offset)
      .map((row) => this.view(row));
  }
  export(userId: string): Note[] {
    return this.store.db
      .prepare(
        "SELECT * FROM notes WHERE user_id=? ORDER BY created_at DESC,id DESC",
      )
      .all(userId)
      .map((row) => this.view(row));
  }
  detail(userId: string, id: string): Note {
    return this.view(this.own(userId, id));
  }
  rename(userId: string, id: string, input: string): Note {
    const title = input.trim();
    if (!title || title.length > NOTE_TITLE_LIMIT)
      throw new AppError(400, "VALIDATION_ERROR", "标题须为 1—80 字");
    const row = this.store.db
      .prepare(
        "UPDATE notes SET title=?,title_edited=1,updated_at=? WHERE id=? AND user_id=? RETURNING *",
      )
      .get(title, this.clock().toISOString(), id, userId);
    if (!row) throw missing();
    return this.view(row);
  }
  supplement(
    userId: string,
    id: string,
    body: { revision: number; clientId: string; text: string },
  ): Note {
    return this.store.transaction(() => {
      const row = this.own(userId, id),
        old = this.store.db
          .prepare(
            "SELECT text FROM note_supplements WHERE note_id=? AND client_id=?",
          )
          .get(id, body.clientId);
      if (old) {
        if (old.text !== body.text)
          throw new AppError(
            409,
            "CLIENT_ID_CONFLICT",
            "这次补充的内容已变化，请重新提交",
          );
        return this.view(row);
      }
      if (Number(row.revision) !== body.revision) throw changed();
      const note = this.view(row);
      if (!body.text.trim() || body.text.length > SUPPLEMENT_LIMIT)
        throw new AppError(400, "VALIDATION_ERROR", "补充须为 1—500 字");
      if (
        note.supplements.length >= SUPPLEMENT_COUNT ||
        note.text.length +
          note.supplements.reduce((n, s) => n + s.text.length, 0) +
          body.text.length >
          SOURCE_LIMIT
      )
        throw new AppError(
          400,
          "NOTE_LIMIT",
          "这条随心记的补充已满，请另存一条",
        );
      const iso = this.clock().toISOString();
      this.store.db
        .prepare(
          "INSERT INTO note_supplements(id,note_id,client_id,text,created_at) VALUES(?,?,?,?,?)",
        )
        .run(uid("ns"), id, body.clientId, body.text, iso);
      this.store.db
        .prepare(
          "UPDATE notes SET revision=revision+1,source_version=source_version+1,updated_at=? WHERE id=? AND user_id=?",
        )
        .run(iso, id, userId);
      return this.detail(userId, id);
    });
  }
  item(
    userId: string,
    id: string,
    itemId: string,
    versions: Versions,
    replacement: { group: "clear" | "decide" | "verify"; text: string } | null,
  ): Note {
    return this.store.transaction(() => {
      const row = this.own(userId, id);
      this.check(row, versions);
      const note = this.view(row);
      if (!note.result)
        throw new AppError(409, "NOTE_NOT_ORGANIZED", "请先整理这条随心记");
      if (!note.result.items.some((item) => item.id === itemId))
        throw new AppError(404, "NOT_FOUND", "这个事项不存在");
      if (replacement) itemInput.parse(replacement);
      note.result.items = replacement
        ? note.result.items.map((item) =>
            item.id === itemId
              ? { ...item, ...replacement, edited: true }
              : item,
          )
        : note.result.items.filter((item) => item.id !== itemId);
      this.store.db
        .prepare(
          "UPDATE notes SET result=?,revision=revision+1,result_version=result_version+1,updated_at=? WHERE id=? AND user_id=?",
        )
        .run(
          JSON.stringify(note.result),
          this.clock().toISOString(),
          id,
          userId,
        );
      return this.detail(userId, id);
    });
  }
  link(userId: string, id: string, pointId: string | null): Note {
    this.own(userId, id);
    if (pointId !== null && !POINT_IDS.has(pointId))
      throw new AppError(400, "VALIDATION_ERROR", "这个知识点不存在");
    this.store.db
      .prepare(
        "UPDATE notes SET point_id=?,updated_at=? WHERE id=? AND user_id=?",
      )
      .run(pointId, this.clock().toISOString(), id, userId);
    return this.detail(userId, id);
  }
  organize(
    userId: string,
    id: string,
    body: Versions & { refresh: boolean; retryUnknown?: boolean },
    runner: JobRunner,
  ) {
    const row = this.own(userId, id);
    this.check(row, body);
    const note = this.view(row);
    if (!body.refresh && note.result && !note.resultStale)
      return { job: null, reused: true };
    // The last try may have been billed; only an explicit retry spends again.
    if (note.aiJob?.status === "unknown" && !body.retryUnknown)
      throw new AppError(
        409,
        "JOB_UNKNOWN",
        "上次整理结果未知，可能已用掉额度；确认后再试",
      );
    if (!this.llm?.configured)
      throw new AppError(
        503,
        "AI_NOT_CONFIGURED",
        "AI 这会儿用不了，原话存好了",
      );
    const outcome = runner.enqueue({
      userId,
      kind: "note_organize",
      version: note.revision,
      params: {
        noteId: id,
        revision: note.revision,
        sourceVersion: note.sourceVersion,
        resultVersion: note.resultVersion,
      },
      refresh: body.refresh,
    });
    return { job: publicJob(outcome.job), reused: outcome.reused };
  }
  private snapshot(job: Job): Note {
    const row = this.store.db
      .prepare("SELECT * FROM notes WHERE id=? AND user_id=?")
      .get(String(job.params.noteId), job.userId);
    if (!row) throw new JobError("NOTE_DELETED", "这条随心记已删除");
    if (
      Number(row.revision) !== job.params.revision ||
      Number(row.source_version) !== job.params.sourceVersion ||
      Number(row.result_version) !== job.params.resultVersion
    )
      throw new JobError(
        "NOTE_CHANGED",
        "随心记已更新，旧整理未写入，请重新整理",
      );
    return this.view(row);
  }
  private sources(note: Note): NoteSource[] {
    return [
      { id: "original", text: note.text },
      ...note.supplements.map(({ id, text }) => ({ id, text })),
    ];
  }
  handlers(): Record<string, JobHandler> {
    return {
      note_organize: {
        quota: "notes",
        run: async (job, signal) => {
          const sources = this.sources(this.snapshot(job));
          if (!this.llm)
            throw new JobError("AI_NOT_CONFIGURED", "AI 这会儿用不了，过会儿再试");
          const { data, usage } = await this.llm.json(
            notePrompt(sources),
            noteSchema(sources),
            signal,
          );
          return { output: data, usage };
        },
        commit: (job, output) => {
          const note = this.snapshot(job),
            data = noteSchema(this.sources(note)).parse(output),
            iso = this.clock().toISOString();
          const result: NoteResult = {
            sourceVersion: note.sourceVersion,
            generatedAt: iso,
            origin: "ai",
            items: data.items.map((item) => ({
              ...item,
              id: uid("ni"),
              edited: false,
            })),
            question: {
              prompt: data.question.prompt,
              options: data.question.options.map((text, i) => ({
                id: `option_${i + 1}`,
                text,
              })),
            },
            nextStep: data.nextStep,
          };
          this.store.db
            .prepare(
              "UPDATE notes SET result=?,status='organized',title=CASE WHEN title_edited=0 THEN ? ELSE title END,result_version=result_version+1,updated_at=? WHERE id=? AND user_id=?",
            )
            .run(
              JSON.stringify(result),
              data.title.trim(),
              iso,
              note.id,
              job.userId,
            );
          return { noteId: note.id, resultVersion: note.resultVersion + 1 };
        },
      },
    };
  }
  remove(userId: string, id: string) {
    this.store.transaction(() => {
      this.own(userId, id);
      // Keep only a content-free quota receipt. Late commits cannot restore it.
      // Finished jobs keep their outcome (succeeded, failed, unknown) so the
      // admin counts and the "may have been billed" signal stay true.
      this.store.db
        .prepare(
          "UPDATE jobs SET params=?,params_hash='deleted:'||id,version=NULL,result=NULL,status=CASE WHEN status IN ('queued','running') THEN 'failed' ELSE status END,error_code=CASE WHEN status IN ('queued','running') THEN 'NOTE_DELETED' ELSE error_code END,error_message=CASE WHEN status IN ('queued','running') THEN '随心记已删除' ELSE error_message END,finished_at=COALESCE(finished_at,?) WHERE user_id=? AND kind='note_organize' AND json_extract(params,'$.noteId')=?",
        )
        .run(
          JSON.stringify({ deleted: true }),
          this.clock().toISOString(),
          userId,
          id,
        );
      this.store.db
        .prepare(
          "DELETE FROM resume_items WHERE user_id=? AND src='card' AND src_id IN (SELECT id FROM cards WHERE user_id=? AND origin='note' AND src_id=?)",
        )
        .run(userId, userId, id);
      this.store.db
        .prepare(
          "DELETE FROM cards WHERE user_id=? AND origin='note' AND src_id=?",
        )
        .run(userId, id);
      this.store.db
        .prepare("DELETE FROM notes WHERE id=? AND user_id=?")
        .run(id, userId);
    });
  }
}

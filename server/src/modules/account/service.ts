/*
 * 账号数据与额度：供“我的”和隐私页查询用量、导出本人资料、注销账号。
 * 入口在 routes.ts；读取和删除都带用户范围，注销还需协调任务停止与关联文件清理。
 */
import type { SqliteStore } from "../../shared/store.js";
import { chinaDate } from "../../shared/time.js";
import {
  AppError,
  ACCEPTED_PRIVACY_VERSIONS,
  PRIVACY_VERSION,
  type AgeBand,
  type Consent,
  type User,
} from "../../shared/domain.js";
import { createHash } from "node:crypto";
import { NOT_VOID, type JobRunner } from "../jobs/runner.js";
import type { MaterialService } from "../materials/service.js";
import { NoteService } from "../notes/service.js";
import { StudyTimeService } from "../study-time/service.js";
import { BUCKETS, type Bucket } from "../../shared/limits.js";
import type { Budget } from "../../shared/budget.js";
type Row = Record<string, unknown>;
const parse = (value: unknown) =>
  value === null || value === undefined ? null : JSON.parse(String(value));
// AI-generated content in the export (用户协议 6.5, 标识办法第五条): every such
// record carries the text label aiLabel "AI 生成"; one the model wrote whole also
// has aiGenerated: true, one it wrote in part lists those fields in
// aiGeneratedFields.
const AI_LABEL = "AI 生成";
const AI_MARK = { aiGenerated: true, aiLabel: AI_LABEL } as const;
const aiFields = <T extends object>(row: T, fields: string[]) =>
  fields.length ? { ...row, aiLabel: AI_LABEL, aiGeneratedFields: fields } : row;
const filled = (value: unknown) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  !(Array.isArray(value) && value.length === 0) &&
  !(typeof value === "object" && Object.keys(value).length === 0);
// A judged answer: comment, explanation and cause are written or filled in by
// a model (feedback, hints, the solution), even when the program judged the
// verdict. Only a choice question whose answer no model drafted has none.
const judged = (result: unknown) => {
  if (!result || typeof result !== "object") return result;
  const r = result as Record<string, unknown>;
  const reference = r.reference as { source?: string } | null | undefined;
  if (r.judge === "choice" && reference?.source !== "ai") return result;
  return aiFields(
    r,
    ["comment", "explanation", "cause"].filter((key) => filled(r[key])),
  );
};
// The consent records kept per account; older ones are dropped.
const MAX_CONSENTS = 50;
const AI_NOTE =
  "本文件含 AI 生成内容：标有 \"aiLabel\": \"AI 生成\" 的记录含大模型生成的内容；其中带 \"aiGenerated\": true 的整条由大模型生成，\"aiGeneratedFields\" 列出的字段由大模型生成或辅助生成，其余是你自己写下或选择的内容。AI 生成可能有误，注意核实。各条记录的 id 是内容编号。";
export class AccountService {
  constructor(
    private store: SqliteStore,
    private materials: MaterialService,
    private runner: JobRunner,
    private limits: Record<Bucket, number>,
    // V4.2 : the yuan budget; the count fields then mirror its percentages.
    private budget?: Budget,
  ) {}
  private save(user: User) {
    this.store.db
      .prepare("UPDATE users SET data=? WHERE id=?")
      .run(JSON.stringify(user), user.id);
  }
  private user(userId: string) {
    const user = this.store.getUser(userId);
    if (!user) throw new AppError(404, "NOT_FOUND", "没找到这个账号");
    return user;
  }
  // Agreeing to the three documents with an age band. A child
  // needs the guardian's consent, recorded next to it. The first time an
  // account becomes a child, related-card suggestions and personalised
  // recommendations go off (儿童规则 4.3); turning adult later leaves them as set.
  consent(
    userId: string,
    input: { version: string; ageBand: AgeBand; guardian?: boolean },
  ) {
    // The version before is still taken, so a phone that loaded the documents
    // just before an update can finish; the record keeps what it was shown.
    if (!ACCEPTED_PRIVACY_VERSIONS.includes(input.version))
      throw new AppError(
        400,
        "OLD_VERSION",
        "文件有更新，退出晓念重新打开后再同意",
      );
    if (input.ageBand === "child" && input.guardian !== true)
      throw new AppError(
        400,
        "GUARDIAN_REQUIRED",
        "未满 14 周岁要监护人同意，请家长点“监护人同意”",
      );
    return this.store.transaction(() => {
      const user = this.user(userId);
      const consents: Consent[] = [...(user.consents ?? [])];
      // Agreeing again to the same version and age band adds no record; a
      // withdrawal in between does.
      let lastIndex = consents.length - 1;
      while (lastIndex >= 0 && consents[lastIndex]!.kind === "guardian")
        lastIndex--;
      const last = consents[lastIndex];
      const same =
        last?.kind === "docs" &&
        last.version === input.version &&
        user.ageBand === input.ageBand &&
        (input.ageBand === "adult" ||
          consents
            .slice(lastIndex + 1)
            .some(
              (c) =>
                c.kind === "guardian" &&
                c.scope === "basic" &&
                c.version === input.version,
            ));
      const at = same ? last.at : this.store.now();
      if (!same) {
        consents.push({ kind: "docs", version: input.version, at });
        if (input.ageBand === "child")
          consents.push({
            kind: "guardian",
            scope: "basic",
            version: input.version,
            at,
          });
      }
      const next: User = {
        ...user,
        ageBand: input.ageBand,
        consents: consents.slice(-MAX_CONSENTS),
      };
      if (input.ageBand === "child" && user.ageBand !== "child") {
        next.suggestCards = false;
        next.personalized = false;
      }
      // 心情记录 agreed to without a guardian is asked again for a child; the
      // mood records themselves stay.
      if (
        input.ageBand === "child" &&
        !consents.some((c) => c.kind === "guardian" && c.scope === "mood")
      )
        delete next.moodConsentAt;
      this.save(next);
      return { ageBand: input.ageBand, version: input.version, at };
    });
  }
  // Revoking the consent: only recorded, nothing is deleted.
  withdraw(userId: string) {
    return this.store.transaction(() => {
      const user = this.user(userId);
      const at = this.store.now();
      const consents: Consent[] = [
        ...(user.consents ?? []),
        { kind: "withdraw", version: PRIVACY_VERSION, at },
      ];
      this.save({ ...user, consents: consents.slice(-MAX_CONSENTS) });
      return { withdrawn: true, at };
    });
  }
  // The latest agreement to the documents; nulls before the first one.
  consentOf(user: User) {
    const last = (user.consents ?? [])
      .filter((c) => c.kind === "docs")
      .at(-1);
    return {
      ageBand: user.ageBand ?? null,
      version: last?.version ?? null,
      at: last?.at ?? null,
    };
  }
  // 个性化学习推荐 and 学习时长统计; on unless turned off.
  prefs(user: User) {
    return {
      personalized: user.personalized !== false,
      studyTime: user.studyTime !== false,
    };
  }
  setPrefs(
    userId: string,
    input: { personalized?: boolean; studyTime?: boolean },
  ) {
    return this.store.transaction(() => {
      const next = { ...this.user(userId), ...input };
      this.save(next);
      return this.prefs(next);
    });
  }
  usage(userId: string) {
    const limit = (bucket: Bucket) =>
      this.runner.limit(userId, bucket) ?? this.limits[bucket];
    const view = this.budget?.view(userId);
    const stopped = view ? !this.budget!.allows(userId) : false;
    const buckets = Object.fromEntries(
      BUCKETS.map((bucket) => [
        bucket,
        view
          ? this.budget!.legacy(
              limit(bucket),
              view,
              this.runner.usedToday(userId, bucket),
              stopped,
            )
          : { used: this.runner.usedToday(userId, bucket), limit: limit(bucket) },
      ]),
    ) as Record<Bucket, { used: number; limit: number }>;
    return {
      date: chinaDate(Date.parse(this.store.now())),
      ...buckets,
      ...(view ? { budget: view } : {}),
    };
  }
  // Everything the learner submitted or produced, as plain JSON (images excluded).
  export(user: User) {
    const all = (sql: string, ...args: string[]) =>
      this.store.db.prepare(sql).all(...args) as Row[];
    const materials = all(
      "SELECT * FROM materials WHERE user_id=? ORDER BY created_at,rowid",
      user.id,
    ).map((m) => {
      const id = String(m.id);
      const review = all("SELECT * FROM reviews WHERE material_id=?", id)[0];
      return {
        id,
        kind: m.kind,
        title: m.title,
        status: m.status,
        currentVersion: m.current_version,
        hasImage: Boolean(m.image_path),
        createdAt: m.created_at,
        updatedAt: m.updated_at,
        versions: all(
          "SELECT version,origin,text,answer,created_at FROM material_versions WHERE material_id=? ORDER BY version",
          id,
        ).map((v) =>
          // Text read from a photo comes from the recognition model.
          aiFields(
            {
              version: v.version,
              origin: v.origin,
              text: v.text,
              answer: v.answer,
              createdAt: v.created_at,
            },
            v.origin === "ocr" ? ["text"] : [],
          ),
        ),
        generated: all(
          "SELECT id,kind,version,data,state,created_at FROM artifacts WHERE material_id=? ORDER BY created_at,rowid",
          id,
        ).map((a) => ({
          id: a.id,
          kind: a.kind,
          version: a.version,
          data: parse(a.data),
          state: parse(a.state),
          createdAt: a.created_at,
          ...AI_MARK,
        })),
        attempts: all(
          "SELECT artifact_id,item,version,answer,result,created_at FROM attempts WHERE material_id=? ORDER BY created_at,rowid",
          id,
        ).map((a) => ({
          artifactId: a.artifact_id,
          item: a.item,
          version: a.version,
          answer: a.answer,
          result: judged(parse(a.result)),
          createdAt: a.created_at,
        })),
        review: review
          ? {
              box: review.box,
              dueOn: review.due_on,
              lastReviewedAt: review.last_reviewed_at,
              log: all(
                "SELECT outcome,box_before,box_after,created_at FROM review_logs WHERE review_id=? ORDER BY created_at,rowid",
                String(review.id),
              ).map((l) => ({
                outcome: l.outcome,
                boxBefore: l.box_before,
                boxAfter: l.box_after,
                createdAt: l.created_at,
              })),
            }
          : null,
      };
    });
    const conversations = all(
      "SELECT * FROM threads WHERE user_id=? ORDER BY created_at,rowid",
      user.id,
    ).map((t) => ({
      id: t.id,
      title: t.title,
      materialId: t.material_id,
      scene: t.scene,
      mode: t.mode,
      moodCards: t.mood_cards === 1,
      data: parse(t.data),
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      messages: all(
        "SELECT id,role,kind,content,data,status,created_at FROM messages WHERE thread_id=? ORDER BY created_at,rowid",
        String(t.id),
      ).map((m) => ({
        id: m.id,
        role: m.role,
        kind: m.kind,
        content: m.content,
        data: parse(m.data),
        status: m.status,
        createdAt: m.created_at,
        ...(m.role === "assistant" ? AI_MARK : {}),
      })),
    }));
    const photos = all(
      "SELECT id,scan,created_at FROM chat_images WHERE user_id=? ORDER BY created_at,rowid",
      user.id,
    ).map((i) => ({
      id: i.id,
      recognized: parse(i.scan),
      createdAt: i.created_at,
      ...AI_MARK,
    }));
    // Photos and documents sent in a chat : the document's text as read,
    // no original file; a photo is listed under photos by its imageId.
    const chatAttachments = all(
      "SELECT id,thread_id,message_id,kind,image_id,name,size,type,text,chars,created_at FROM chat_attachments WHERE user_id=? ORDER BY created_at,rowid",
      user.id,
    ).map((a) => ({
      id: a.id,
      threadId: a.thread_id,
      messageId: a.message_id,
      kind: a.kind,
      imageId: a.image_id,
      name: a.name,
      size: a.size,
      type: a.type,
      ...(a.kind === "file"
        ? { text: a.text, truncated: Number(a.chars) > Array.from(String(a.text ?? "")).length }
        : {}),
      createdAt: a.created_at,
    }));
    const mistakes = all(
      "SELECT material_id,source,answer,cause,chapter,wrong,status,due_on,created_at,updated_at,mastered_at,mastered_by,map_point_id,map_version FROM mistakes WHERE user_id=? ORDER BY created_at,rowid",
      user.id,
    ).map((k) => ({
      ...(filled(k.cause) ? { aiLabel: AI_LABEL, aiGeneratedFields: ["cause"] } : {}),
      materialId: k.material_id,
      source: k.source,
      answer: k.answer,
      cause: k.cause,
      chapter: k.chapter,
      wrong: k.wrong,
      status: k.status,
      dueOn: k.due_on,
      createdAt: k.created_at,
      updatedAt: k.updated_at,
      masteredAt: k.mastered_at,
      // how it became 弄懂了 ('self' or 'redo'); null before.
      masteredBy: k.mastered_by,
      mapPointId: k.map_point_id,
      mapVersion: k.map_version,
    }));
    const notes = new NoteService(this.store).export(user.id);
    // Table names and JSON columns are fixed below, not supplied by a request.
    const ownedRows = (table: string, jsonColumns: string[] = []) =>
      all(`SELECT * FROM ${table} WHERE user_id=? ORDER BY rowid`, user.id).map(
        (row) =>
          Object.fromEntries(
            Object.entries(row)
              .filter(([name]) => name !== "user_id")
              .map(([name, value]) => [
                name.replace(/_([a-z])/g, (_match, letter: string) =>
                  letter.toUpperCase(),
                ),
                jsonColumns.includes(name) ? parse(value) : value,
              ]),
          ),
      );
    // New map columns must not silently disappear from a learner's export.
    const mapColumns = all("PRAGMA table_info(map_points)")
      .map((column) => String(column.name))
      .filter((name) => name !== "user_id");
    const mapSelection = mapColumns
      .map((name) => `"${name.replaceAll('"', '""')}"`)
      .join(",");
    const preferences = user as User &
      Partial<
        Record<
          "resume" | "moodConsentAt" | "taughtTo" | "suggestCards",
          unknown
        >
      >;
    // The learning map: progress per point, chapters set to 不学, and 这题有问题 reports.
    const learn = {
      points: all(
        `SELECT ${mapSelection} FROM map_points WHERE user_id=? ORDER BY point_id`,
        user.id,
      ).map((p) => {
        const point = Object.fromEntries(
          Object.entries(p).map(([name, value]) => [
            name.replace(/_([a-z])/g, (_match, letter: string) =>
              letter.toUpperCase(),
            ),
            name === "red"
              ? value === 1
              : // 0.6.0 题库 : per-problem answers, as an object;
              // V4.2 卡点 help likewise.
                ["attempts", "stuck_help"].includes(name) &&
                  typeof value === "string"
                ? JSON.parse(value)
                : value,
          ]),
        );
        // the 卡点 help's reply is written by the model.
        const help = point.stuckHelp as { reply?: object } | null | undefined;
        return help?.reply
          ? { ...point, stuckHelp: { ...help, reply: { ...help.reply, ...AI_MARK } } }
          : point;
      }),
      hiddenChapters: all(
        "SELECT chapter_id,hidden_at FROM map_chapters WHERE user_id=? ORDER BY hidden_at,chapter_id",
        user.id,
      ).map((c) => ({ chapterId: c.chapter_id, hiddenAt: c.hidden_at })),
      reports: all(
        "SELECT id,point_id,reason,note,answer,understood,verdict,created_at,COALESCE(bank_index,problem_index) AS problem_index,problem_kind,answer_json,understood_json FROM map_reports WHERE user_id=? ORDER BY created_at,rowid",
        user.id,
      ).map((r) => ({
        id: r.id,
        pointId: r.point_id,
        index: r.problem_index,
        problemKind: r.problem_kind,
        reason: r.reason,
        note: r.note,
        answer: r.answer_json === null ? r.answer : parse(r.answer_json),
        understood:
          r.understood_json === null ? r.understood : parse(r.understood_json),
        verdict: r.verdict,
        createdAt: r.created_at,
      })),
    };
    const exportedAt = this.store.now();
    return {
      // Implicit label first (标识办法第五条, 用户协议 6.5): what is generated,
      // the service provider and this export's number (from the account and
      // the time, so a restored backup exports the same file).
      aigc: {
        label: "AI 生成",
        provider: "晓念",
        exportId: `exp_${createHash("sha256").update(`${user.id}\n${exportedAt}`).digest("hex").slice(0, 32)}`,
        generatedAt: exportedAt,
        note: AI_NOTE,
      },
      format: "zhiye-export/1",
      exportedAt,
      note: "原图不在导出文件中，可在小程序里查看；删除资料或注销账号时会一并删除。",
      user: {
        id: user.id,
        nickname: user.nickname,
        avatar: user.avatar ? {
          type: user.avatar.type,
          bytes: user.avatar.bytes,
          updatedAt: user.avatar.updatedAt,
          note: "头像原图不在 JSON 导出中，可在“我的”查看、修改或清除；仅本人登录后可读取。",
        } : null,
        createdAt: user.createdAt,
        ageBand: user.ageBand ?? null,
        consents: user.consents ?? [],
        resume: preferences.resume,
        moodConsentAt: preferences.moodConsentAt,
        taughtTo: preferences.taughtTo,
        suggestCards: preferences.suggestCards,
        personalized: user.personalized !== false,
        studyTime: user.studyTime !== false,
      },
      materials,
      conversations,
      photos,
      chatAttachments,
      mistakes,
      learn,
      notes: notes.map((note) =>
        aiFields(note, filled(note.result) ? ["result"] : []),
      ),
      cards: ownedRows("cards", ["slots", "open", "next"]).map((card) =>
        aiFields(card, [
          ...(card.titleBy === "ai" ? ["title"] : []),
          ...(card.summaryBy === "ai" ? ["summary"] : []),
          ...(["slots", "open", "next"] as const).filter((name) =>
            filled(card[name]),
          ),
        ]),
      ),
      cardVersions: ownedRows("card_versions", ["data"]).map((version) =>
        version.by === "ai" ? { ...version, ...AI_MARK } : version,
      ),
      cardLinks: ownedRows("card_links"),
      cardUses: ownedRows("card_uses"),
      tags: ownedRows("tags").map((tag) =>
        tag.by === "ai" ? { ...tag, ...AI_MARK } : tag,
      ),
      cardTags: ownedRows("card_tags"),
      // 提醒频率 : which cards repeat their reminder, day or week.
      cardReminders: ownedRows("card_reminders"),
      resumeItems: ownedRows("resume_items").map((item) =>
        aiFields(item, item.quoteBy === "ai" ? ["quote"] : []),
      ),
      brainstorms: ownedRows("brainstorms", [
        "cards",
        "facts",
        "result",
        "picks",
        "out_cards",
      ]).map((b) =>
        aiFields(
          b,
          (["facts", "result"] as const).filter((name) => filled(b[name])),
        ),
      ),
      // Photo and screenshot imports are read by the recognition model; the
      // suggested cards come from the model.
      imports: ownedRows("imports", [
        "segments",
        "pages",
        "candidates",
        // text left past the import limit, as an object.
        "extra",
      ]).map(
        (i) =>
          aiFields(i, [
            ...(["photo", "screenshot"].includes(String(i.source)) &&
            filled(i.segments)
              ? ["segments"]
              : []),
            ...(filled(i.candidates) ? ["candidates"] : []),
          ]),
      ),
      retests: ownedRows("retests"),
      // 功能使用记录 (隐私政策 2.12), e.g. card_close, retest_scheduled, crisis_shown.
      events: all(
        "SELECT name,data,created_at FROM events WHERE user_id=? ORDER BY created_at,rowid",
        user.id,
      ).map((e) => ({
        name: e.name,
        data: parse(e.data),
        createdAt: e.created_at,
      })),
      // 学习时长 (隐私政策 2.10): seconds per Beijing day, as stored.
      studyDays: new StudyTimeService(this.store).export(user.id),
      artifactReports: all(
        "SELECT id,artifact_id,reason,note,created_at FROM reports WHERE user_id=? ORDER BY created_at,rowid",
        user.id,
      ).map((report) => ({
        id: report.id,
        artifactId: report.artifact_id,
        reason: report.reason,
        note: report.note,
        createdAt: report.created_at,
      })),
      quotaUsage: all(
        `SELECT date(created_at,'+8 hours') AS date,source,kind,COUNT(*) AS used FROM quota_receipts r WHERE user_id=? AND ${NOT_VOID} GROUP BY date(created_at,'+8 hours'),source,kind ORDER BY date,source,kind`,
        user.id,
      ),
    };
  }
  // Removing the user row cascades to materials, versions, jobs, results,
  // attempts, reviews, reports, conversations, photo records, mistakes and the learning
  // map's map_points, map_chapters and map_reports, personal notes, quota receipts
  // the study_days of 学习时长 and (through the cards) card_reminders;
  // sessions are removed first.
  erase(userId: string) {
    const count = (
      this.store.db
        .prepare("SELECT COUNT(*) AS n FROM materials WHERE user_id=?")
        .get(userId) as { n: number }
    ).n;
    this.store.transaction(() => {
      this.store.db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
      this.store.db.prepare("DELETE FROM users WHERE id=?").run(userId);
    });
    this.materials.removeImages(userId);
    this.store.audit(userId, "account.erase", userId, { materials: count });
  }
}

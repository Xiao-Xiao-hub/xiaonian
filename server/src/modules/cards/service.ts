/*
 * 卡片业务：负责卡片、标签、来源引用、版本、收藏和学习关联的读写。
 * routes.ts 处理接口输入，tidy.ts 负责模型整理，merge.ts 负责合并；这里维护归属与版本约束。
 * 更新时核对用户和版本；展示字段与数据库行之间的转换集中在 view，避免页面自行解释存储结构。
 */
import {
  slotSchema,
  openSchema,
  nextSchema,
  SLOT_KEYS,
  SLOT_LABELS,
  isQuote,
} from "./schema.js";
import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/domain.js";
import { logEvent } from "../../shared/events.js";
import type { SqliteStore } from "../../shared/store.js";
import { addDays, chinaDate, now as businessNow } from "../../shared/time.js";
import type { Jev } from "../../providers/jev.js";
import { CALC_MAP } from "../learn/calc-map.js";
import { splitVerify } from "../chat/prompts.js";
import { readable, unmark } from "../render/markdown.js";
import { POINT_IDS } from "../notes/schema.js";
import type { CrisisSafetyService } from "../safety/service.js";
import {
  CARD_ORIGINS,
  CARD_SCENES,
  CARD_TYPES,
  CARD_KINDS,
  CARD_KIND_LABELS,
  CARD_FOLLOWS,
  KIND_TYPE,
  closedSql,
  defaultFollow,
  effectiveKind,
  kindSql,
  ruleType,
  type CardFollow,
  type CardKind,
  type CardOrigin,
  type CardScene,
  type CardType,
  type CardView,
  type RemindEvery,
} from "./types.js";

// An AI reply or a question as plain text: no markdown marks, no colour
// marks, formulas written out ("lim(x→0) sin3x/x").
export const plainText = (value: string) =>
  readable(unmark(splitVerify(value).visible));
type Slot = { key: string; text: string; by?: string };
// Slots without their colour marks (what older clients show as text).
const plainSlots = (slots: Slot[]) =>
  slots.map((slot) =>
    typeof slot?.text === "string" ? { ...slot, text: unmark(slot.text) } : slot,
  );
// Cut at a sentence end when one is close enough, else mark the cut.
const clip = (value: string, n: number) => {
  const chars = Array.from(value);
  if (chars.length <= n) return value;
  const head = chars.slice(0, n).join("");
  const end = Math.max(...["。", "！", "？", "；", "!", "?"].map((m) => head.lastIndexOf(m)));
  return end >= n / 3 ? head.slice(0, end + 1) : `${chars.slice(0, n - 1).join("")}…`;
};
// A study exchange: formulas, or the words of a calculus problem.
const MATH_TEXT =
  /[=∫∑√]|\\(?:frac|lim|int|sqrt)|[a-z]\s*\^\s*\d|\b(?:lim|sin|cos|tan|ln|log)(?![a-z])|极限|导数|积分|微分|方程|求解/i;
const uid = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const missing = () => new AppError(404, "NOT_FOUND", "这张卡找不到了，可能已经删掉了");
const changed = () =>
  new AppError(409, "CARD_CHANGED", "这张卡刚有变化，刷新一下再改");
const invalid = (message: string) => new AppError(400, "INVALID_CARD", message);
// What PATCH, PUT tags and POST mine accept (routes.ts), here and in v4.1.
const MINE_MAX = 300,
  OPEN_MAX = 3,
  TAGS_MAX = 3;
const textOnly = (value: string) => value.replace(/[\s\p{P}\p{S}]/gu, "");
const is = <T extends readonly string[]>(
  values: T,
  value: string,
): value is T[number] => values.includes(value);
type Row = Record<string, unknown>;

export type CreateCardInput = {
  text?: string;
  quote?: string;
  type?: CardType;
  // one of the seven kinds; wins over type when both come.
  kind?: CardKind;
  follow?: CardFollow;
  // a retried save returns the card the first try made.
  clientId?: string;
  scene?: CardScene;
  title?: string;
  mine?: string;
  origin?: CardOrigin;
  srcId?: string;
  messageId?: string;
  mistakeId?: string;
  pointId?: string;
  remindEvery?: RemindEvery | null;
};
// 提醒频率 : days from one reminder to the next.
export const REMIND_DAYS: Record<RemindEvery, number> = { day: 1, week: 7 };
export type CreateCardOptions = {
  skipTidy?: boolean;
  // Internal generated-card seed. Public routes never expose this option.
  seedSummary?: string;
};
export type ApplyAIData = {
  title?: string;
  summary?: string;
  slots?: unknown[];
  open?: unknown[];
  next?: unknown;
  tags?: string[];
  followup?: { q: string; options: string[] };
  // tidy's follow-up mode and its 回顾 question for this card.
  follow?: CardFollow;
  ask?: { q: string; yes: string; no: string };
};
export type BrainstormCardData = {
  title?: { text: string; by: "user" | "ai" };
  summary?: { text: string; by: "user" | "ai" } | null;
  slots?: Array<{ key: string; text: string; by: "user" | "ai" }>;
  open?: Array<{
    key: string;
    cat: "decide" | "verify";
    text: string;
    by: "user" | "ai";
    answer?: string;
  }>;
  next?: {
    if: string;
    then: string;
    on?: string | null;
    by: "user" | "ai";
  } | null;
};

export class CardService {
  constructor(
    private readonly store: SqliteStore,
    private readonly safety: CrisisSafetyService,
    private readonly clock: () => Date = businessNow,
    private readonly onCreated?: (card: CardView) => void | Promise<void>,
    private readonly judge?: Pick<Jev, "choice">,
  ) {}
  private now() {
    return this.clock().toISOString();
  }
  // A merged original reads as gone unless the caller asks for it
  // (V4.2: new clients open it read-only from the merged card).
  private own(userId: string, id: string, merged = false): Row {
    const row = this.store.db
      .prepare("SELECT * FROM cards WHERE id=? AND user_id=?")
      .get(id, userId) as Row | undefined;
    if (!row || (row.merged_into != null && !merged)) throw missing();
    return row;
  }
  private tags(userId: string, id: string) {
    return this.store.db
      .prepare(
        "SELECT t.id,t.name,t.color,t.by FROM tags t JOIN card_tags ct ON ct.tag_id=t.id WHERE ct.card_id=? AND ct.user_id=? ORDER BY t.name",
      )
      .all(id, userId)
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        color: Number(r.color),
        by: r.by as "user" | "ai",
      }));
  }
  private view(row: Row): CardView {
    const mine = row.mine === null ? null : String(row.mine);
    const closedAt = row.closed_at === null ? null : String(row.closed_at);
    const slots = JSON.parse(String(row.slots)) as Slot[];
    const kind = effectiveKind(row.kind, row.type as CardType);
    return {
      id: String(row.id),
      type: row.type as CardType,
      kind,
      follow: is(CARD_FOLLOWS, String(row.follow))
        ? (row.follow as CardFollow)
        : defaultFollow(kind, String(row.scene)),
      mergedInto: row.merged_into == null ? null : String(row.merged_into),
      scene: row.scene as CardScene,
      title: String(row.title),
      titleBy: row.title_by as "user" | "ai",
      summary: row.summary === null ? null : unmark(String(row.summary)),
      summaryMarked: row.summary === null ? null : String(row.summary),
      summaryBy: row.summary_by as "user" | "ai" | null,
      mine,
      quote: row.quote === null ? null : String(row.quote),
      quoteOn: row.quote_on === null ? null : String(row.quote_on),
      slots: plainSlots(slots),
      slotsMarked: slots,
      open: JSON.parse(String(row.open)),
      next: row.next === null ? null : JSON.parse(String(row.next)),
      organizedAt: row.organized_at === null ? null : String(row.organized_at),
      closedAt,
      origin: row.origin as CardOrigin,
      srcId: row.src_id === null ? null : String(row.src_id),
      messageId: row.message_id === null ? null : String(row.message_id),
      mistakeId: row.mistake_id === null ? null : String(row.mistake_id),
      sawAnswer: Boolean(row.saw_answer),
      useCount: Number(row.use_count),
      pointId: row.point_id === null ? null : String(row.point_id),
      resume: row.resume as CardView["resume"],
      crisis: Boolean(row.crisis),
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      stage:
        closedAt && (mine || kind === "todo")
          ? "closed"
          : mine
            ? "clear"
            : row.organized_at
              ? "organized"
              : "written",
      tags: this.tags(String(row.user_id), String(row.id)),
      favorite: Boolean(row.favorite),
      remindOn: row.remind_on == null ? null : String(row.remind_on),
      remindEvery: this.remindEvery(String(row.id)),
    };
  }
  // whether the card's follow-up is the learner's own (the 之后
  // chips, 不提醒 on saving): the last user version that set one, unless a
  // later change of kind without one cleared it. Only an AI one is retidied.
  private followChosen(userId: string, id: string) {
    const last = this.store.db
      .prepare(
        "SELECT json_extract(data,'$.follow') AS follow FROM card_versions WHERE card_id=? AND user_id=? AND by='user' AND (json_extract(data,'$.follow') IS NOT NULL OR (kind='type' AND json_extract(data,'$.kind') IS NOT json_extract(data,'$.previousKind'))) ORDER BY id DESC LIMIT 1",
      )
      .get(id, userId);
    return last?.follow != null;
  }
  private remindEvery(cardId: string): RemindEvery | null {
    const every = this.store.db
      .prepare("SELECT every FROM card_reminders WHERE card_id=?")
      .get(cardId)?.every;
    return every === "day" || every === "week" ? every : null;
  }
  // Sets or clears a card's 提醒频率; the caller holds the transaction and
  // writes cards.remind_on itself.
  private setRemindEvery(
    userId: string,
    cardId: string,
    every: RemindEvery | null,
  ) {
    if (!every) {
      this.store.db
        .prepare("DELETE FROM card_reminders WHERE card_id=? AND user_id=?")
        .run(cardId, userId);
      return;
    }
    const now = this.now();
    this.store.db
      .prepare(
        "INSERT INTO card_reminders(card_id,user_id,every,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(card_id) DO UPDATE SET every=excluded.every,updated_at=excluded.updated_at",
      )
      .run(cardId, userId, every, now, now);
  }
  private version(row: Row, version: number) {
    if (Number(row.version) !== version) throw changed();
  }
  private addVersion(
    userId: string,
    cardId: string,
    kind: string,
    by: "user" | "ai" | "system",
    data: unknown = {},
  ) {
    this.store.db
      .prepare(
        "INSERT INTO card_versions(card_id,user_id,kind,by,data,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(cardId, userId, kind, by, JSON.stringify(data), this.now());
  }
  private verifySource(userId: string, data: CreateCardInput) {
    if (data.pointId && !POINT_IDS.has(data.pointId))
      throw invalid("没找到这个知识点");
    const own = (table: string, id?: string) =>
      !id ||
      Boolean(
        this.store.db
          .prepare(`SELECT 1 FROM ${table} WHERE id=? AND user_id=?`)
          .get(id, userId),
      );
    if (data.origin === "chat" && (!data.srcId || !own("threads", data.srcId)))
      throw invalid("没找到原来的对话");
    if (
      data.origin === "import" &&
      (!data.srcId || !own("imports", data.srcId))
    )
      throw invalid("没找到原来的导入");
    if (
      data.origin === "brainstorm" &&
      (!data.srcId || !own("brainstorms", data.srcId))
    )
      throw invalid("没找到原来的头脑风暴");
    if (
      data.origin === "mistake" &&
      (!(data.mistakeId ?? data.srcId) ||
        !own("mistakes", data.mistakeId ?? data.srcId))
    )
      throw invalid("没找到原来的错题");
    if (data.origin === "note" && (!data.srcId || !own("notes", data.srcId)))
      throw invalid("没找到原来的随心记");
    if (data.origin === "map" && !data.pointId)
      throw invalid("先选一个知识点");
    if (data.messageId && !own("messages", data.messageId))
      throw invalid("没找到原来的那句话");
    if (data.messageId && data.origin !== "chat")
      throw invalid("这句话要来自对话");
    if (data.mistakeId && !own("mistakes", data.mistakeId))
      throw invalid("没找到原来的错题");
  }
  // The student's own question before an AI reply: the nearest earlier user
  // message that was typed (not a tapped option) and not screened out.
  private askedBefore(userId: string, threadId: string, messageId: string) {
    const rows = this.store.db
      .prepare(
        "SELECT id,role,content,data FROM messages WHERE thread_id=? AND user_id=? ORDER BY created_at,rowid",
      )
      .all(threadId, userId);
    const at = rows.findIndex((row) => row.id === messageId);
    for (let i = at - 1; i >= 0; i--) {
      const row = rows[i]!;
      if (row.role !== "user") continue;
      const data = JSON.parse(String(row.data ?? "{}"));
      if (data.crisis || data.guideChoice) continue;
      const text = String(row.content ?? "").trim();
      if (!text) continue;
      return text.includes("$") ? plainText(text) : text;
    }
    return "";
  }
  private requireMood(userId: string, scene: CardScene) {
    if (scene === "mood" && !this.store.getUser(userId)?.moodConsentAt)
      throw new AppError(
        403,
        "MOOD_CONSENT_REQUIRED",
        "心情相关的内容，要先同意心情记录说明",
      );
  }
  private async choose(
    text: string,
    criteria: Record<string, string>,
    timeoutMs = 2000,
  ) {
    if (!this.judge) return null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.judge
          .choice(
            { text },
            "按文字表达的内容选择最适合的一项。",
            criteria,
            controller.signal,
          )
          .catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(null);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async create(
    userId: string,
    input: CreateCardInput,
    options: CreateCardOptions = {},
  ): Promise<{ card: CardView; crisis: boolean }> {
    const origin = input.origin ?? "jot";
    // A retried save (the first answer was lost) returns the first card.
    const replay = () => {
      if (!input.clientId) return undefined;
      const row = this.store.db
        .prepare(
          "SELECT c.* FROM card_versions v JOIN cards c ON c.id=v.card_id WHERE v.user_id=? AND v.kind='create' AND json_extract(v.data,'$.clientId')=? LIMIT 1",
        )
        .get(userId, input.clientId) as Row | undefined;
      return row ? { card: this.view(row), crisis: Boolean(row.crisis) } : undefined;
    };
    const first = replay();
    if (first) return first;
    this.verifySource(userId, { ...input, origin });
    let scene: CardScene =
      input.scene ??
      (input.pointId || origin === "mistake" || origin === "map"
        ? "study"
        : "life");
    let quote = (input.quote ?? input.text ?? "").trim(),
      summary: string | null = options.seedSummary?.trim().slice(0, 60) || null,
      seedTitle = "";
    // A study chat that is not about a problem or a point: the card's own
    // words decide between study and life (a 问 AI chat can be about anything).
    let judgeScene = false;
    if (origin === "chat") {
      const thread = this.store.db
        .prepare(
          "SELECT scene,material_id,data FROM threads WHERE id=? AND user_id=?",
        )
        .get(input.srcId!, userId)!;
      scene = thread.scene as CardScene;
      judgeScene =
        scene === "study" &&
        !thread.material_id &&
        !JSON.parse(String(thread.data)).pointId &&
        !input.pointId &&
        !input.mistakeId;
      if (input.messageId) {
        const message = this.store.db
          .prepare(
            "SELECT role,content,data FROM messages WHERE id=? AND thread_id=? AND user_id=?",
          )
          .get(input.messageId, input.srcId!, userId);
        if (!message) throw invalid("这句话不在原来的对话里");
        if (JSON.parse(String(message.data)).crisis)
          throw invalid("这条不能存成卡");
        if (message.role === "assistant") {
          // An AI reply: its gist as plain text, and the question the student
          // asked as their own words.
          summary = clip(plainText(String(message.content)), 60) || null;
          const asked = this.askedBefore(userId, input.srcId!, input.messageId);
          quote = asked ? Array.from(asked).slice(0, 1000).join("") : "";
          const first = asked.split(/[，。？！?!；;\n]/)[0]?.trim() ?? "";
          if (Array.from(first).length >= 2 && Array.from(first).length <= 16)
            seedTitle = first;
        } else {
          if (quote && !isQuote(quote, [String(message.content)]))
            throw invalid("原话要是这条里说过的");
          quote = quote || String(message.content).slice(0, 1000);
        }
      } else if (
        quote &&
        !this.store.db
          .prepare(
            "SELECT content FROM messages WHERE thread_id=? AND user_id=? AND role='user' AND COALESCE(json_extract(data,'$.crisis'),0)=0 AND COALESCE(json_extract(data,'$.guideChoice'),0)=0",
          )
          .all(input.srcId!, userId)
          .some((r) => isQuote(quote, [String(r.content)]))
      )
        throw invalid("原话要是你自己说过的");
      // 我的话 may be newly typed here, not only picked from the chat;
      // only a copy of the AI's words is turned away.
      if (input.mine) {
        // A tapped option is the AI's wording too.
        const said = (own: boolean) =>
          this.store.db
            .prepare(
              `SELECT content FROM messages WHERE thread_id=? AND user_id=? AND COALESCE(json_extract(data,'$.crisis'),0)=0 AND ${own ? "" : "NOT "}(role='user' AND COALESCE(json_extract(data,'$.guideChoice'),0)=0)`,
            )
            .all(input.srcId!, userId)
            .map((r) => String(r.content));
        if (
          isQuote(input.mine.trim(), said(false)) &&
          !isQuote(input.mine.trim(), said(true))
        )
          throw invalid("这句是 AI 说的，用你自己的话写一句");
      }
    }
    if (
      !is(CARD_ORIGINS, origin) ||
      !is(CARD_SCENES, scene) ||
      (origin === "jot" && scene === "mood")
    )
      throw invalid("填的内容不太对，再看一下");
    if (origin === "map" || origin === "mistake") scene = "study";
    this.requireMood(userId, scene);
    if (!quote && !summary && !input.mine) throw invalid("写点什么再存吧");
    if (quote.length > (origin === "jot" || origin === "note" ? 2000 : 1000))
      throw invalid("原话太长了，删短一点");
    if (
      input.mine &&
      (input.mine.trim().length < 2 || input.mine.length > 300)
    )
      throw invalid("我的话写一句就好，最多 300 个字");
    if ((input.title?.length ?? 0) > 16) throw invalid("标题最多 16 个字");
    const crisis = await this.safety.check(
      [quote, input.mine, input.title, summary].filter(Boolean).join("\n"),
      { scene, source: origin === "jot" ? "note" : origin },
    );
    let kind: CardKind | undefined = input.kind ?? input.type;
    if (!crisis && !kind && quote) {
      // The judge through the relay takes ~1.7s; 2s left it falling back.
      // seven kinds; a question mark is only a clue when it is unsure.
      const result = await this.choose(quote, CARD_KIND_LABELS, 4000);
      if (result && result.confidence >= 0.6 && is(CARD_KINDS, result.choice))
        kind = result.choice;
    }
    // Unsure: 随手记, which asks nothing later.
    kind ??= ruleType(quote) ?? "note";
    if (!is(CARD_KINDS, kind)) throw invalid("填的内容不太对，再看一下");
    const type = KIND_TYPE[kind];
    if (origin === "jot" && !input.scene) {
      const names = CALC_MAP.chapters.flatMap((c) =>
        c.points.map((p) => p.name),
      );
      if (
        /[=∫∑√]|\\(?:frac|lim|int|sqrt)|[a-z]\s*\^\s*\d/i.test(quote) ||
        names.some((name) => quote.includes(name))
      )
        scene = "study";
      else if (!crisis) {
        const result = await this.choose(quote, {
          study: "具体题目、公式或知识点",
          life: "计划、选择、感受和想法，包括学习安排",
        });
        scene =
          result?.choice === "study" && result.confidence >= 0.6
            ? "study"
            : "life";
      }
    }
    if (judgeScene && !crisis) {
      const text = [quote, summary].filter(Boolean).join("\n");
      if (text && !MATH_TEXT.test(text)) {
        // The same split as a jot's; saving waits a little longer for it.
        const result = await this.choose(
          text,
          {
            study: "具体题目、公式或知识点",
            life: "计划、选择、感受和想法，包括学习安排",
          },
          8000,
        );
        if (result?.choice === "life" && result.confidence >= 0.6)
          scene = "life";
      }
    }
    // Source or consent may have been removed while the judges were running.
    this.verifySource(userId, { ...input, origin });
    if (origin === "chat") {
      const now = this.store.db
        .prepare("SELECT scene FROM threads WHERE id=? AND user_id=?")
        .get(input.srcId!, userId)!.scene as CardScene;
      // The judged life stays only while the chat itself is still study.
      if (!(scene === "life" && now === "study" && judgeScene)) scene = now;
    }
    this.requireMood(userId, scene);
    if (!this.store.getUser(userId)) throw missing();
    const id = uid("card"),
      now = this.now(),
      title = input.title?.trim() || seedTitle;
    const sawAnswer =
      origin === "chat" && input.srcId
        ? Boolean(
            this.store.db
              .prepare(
                "SELECT 1 FROM messages WHERE thread_id=? AND user_id=? AND role='assistant' AND (json_extract(data,'$.mode')='solution' OR json_extract(data,'$.similar.revealed')=1) LIMIT 1",
              )
              .get(input.srcId, userId),
          )
        : false;
    const again = this.store.transaction(() => {
      const saved = replay();
      if (saved) return saved;
      this.store.db
        .prepare(
          "INSERT INTO cards(id,user_id,type,kind,follow,scene,title,title_by,mine,mine_at,quote,quote_on,origin,src_id,message_id,mistake_id,point_id,saw_answer,crisis,summary,summary_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          userId,
          type,
          kind,
          input.follow ?? null,
          scene,
          title,
          input.title?.trim() ? "user" : "ai",
          input.mine?.trim() || null,
          input.mine ? now : null,
          quote || null,
          quote ? chinaDate(this.clock().getTime()) : null,
          origin,
          input.srcId ?? null,
          input.messageId ?? null,
          input.mistakeId ??
            (origin === "mistake" ? input.srcId : null) ??
            null,
          input.pointId ?? null,
          sawAnswer ? 1 : 0,
          crisis ? 1 : 0,
          summary,
          summary ? "ai" : null,
          now,
          now,
        );
      this.addVersion(userId, id, "create", "user", {
        origin,
        type,
        kind,
        ...(input.clientId ? { clientId: input.clientId } : {}),
        // a follow-up picked on saving is the learner's choice.
        ...(input.follow ? { follow: input.follow } : {}),
      });
      if (input.remindEvery && !crisis) {
        this.setRemindEvery(userId, id, input.remindEvery);
        this.store.db
          .prepare("UPDATE cards SET remind_on=? WHERE id=? AND user_id=?")
          .run(
            addDays(
              chinaDate(this.clock().getTime()),
              REMIND_DAYS[input.remindEvery],
            ),
            id,
            userId,
          );
      }
      if (input.mine)
        this.addVersion(userId, id, "mine", "user", {
          text: input.mine.trim(),
        });
      logEvent(this.store, userId, "card_create", { origin, type, kind });
      return undefined;
    });
    if (again) return again;
    const card = this.view(this.own(userId, id));
    if (
      !options.skipTidy &&
      !crisis &&
      ["jot", "chat", "map", "mistake"].includes(origin)
    ) {
      try {
        await this.onCreated?.(card);
      } catch {
        /* The saved original survives unavailable tidy quota. */
      }
    }
    return { card, crisis };
  }
  list(
    userId: string,
    q: {
      type?: CardType[];
      kind?: CardKind[];
      tag?: string[];
      scene?: CardScene[];
      closed?: boolean;
      retest?: boolean;
      point?: string;
      search?: string;
      pick?: boolean;
      favorite?: boolean;
      cursor?: string;
      order?: "updated" | "created" | "used";
      limit?: number;
    } = {},
  ) {
    // merged originals stay behind their merged card.
    const where = ["c.user_id=?", "c.merged_into IS NULL"],
      args: (string | number | null)[] = [userId];
    if (q.type?.length) {
      where.push(`c.type IN (${q.type.map(() => "?").join(",")})`);
      args.push(...q.type);
    }
    if (q.kind?.length) {
      where.push(`${kindSql()} IN (${q.kind.map(() => "?").join(",")})`);
      args.push(...q.kind);
    }
    if (q.scene?.length) {
      where.push(`c.scene IN (${q.scene.map(() => "?").join(",")})`);
      args.push(...q.scene);
    }
    if (q.closed !== undefined)
      where.push(
        q.closed ? closedSql() : `NOT ${closedSql()}`,
      );
    if (q.point) {
      where.push("c.point_id=?");
      args.push(q.point);
    }
    if (q.tag?.length) {
      where.push(
        `EXISTS(SELECT 1 FROM card_tags x WHERE x.card_id=c.id AND x.tag_id IN (${q.tag.map(() => "?").join(",")}) AND x.user_id=c.user_id)`,
      );
      args.push(...q.tag);
    }
    if (q.retest !== undefined)
      where.push(
        q.retest
          ? "EXISTS(SELECT 1 FROM retests r WHERE r.user_id=c.user_id AND r.point_id=c.point_id AND r.done_at IS NULL)"
          : "NOT EXISTS(SELECT 1 FROM retests r WHERE r.user_id=c.user_id AND r.point_id=c.point_id AND r.done_at IS NULL)",
      );
    if (q.search) {
      where.push(
        "(c.title LIKE ? OR c.quote LIKE ? OR c.summary LIKE ? OR c.mine LIKE ? OR c.slots LIKE ? OR c.open LIKE ? OR c.next LIKE ? OR EXISTS(SELECT 1 FROM card_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.card_id=c.id AND ct.user_id=c.user_id AND t.name LIKE ?) OR EXISTS(SELECT 1 FROM card_versions v WHERE v.card_id=c.id AND v.user_id=c.user_id AND v.kind='supplement' AND json_extract(v.data,'$.text') LIKE ?))",
      );
      const like = `%${q.search}%`;
      args.push(like, like, like, like, like, like, like, like, like);
    }
    if (q.pick) where.push("c.crisis=0");
    if (q.favorite) where.push("c.favorite=1");
    const order =
      q.order === "created"
        ? "created_at"
        : q.order === "used"
          ? "use_count"
          : "updated_at";
    const direction = q.order === "created" ? "ASC" : "DESC";
    const comparison = direction === "ASC" ? ">" : "<";
    const total = Number(
      this.store.db
        .prepare(
          `SELECT count(*) AS n FROM cards c WHERE ${where.join(" AND ")}`,
        )
        .get(...args)!.n,
    );
    if (q.cursor) {
      const [at, id] = q.cursor.split("|");
      if (!at || !id) throw invalid("没打开，再试一次");
      const value = order === "use_count" ? Number(at) : at;
      if (typeof value === "number" && !Number.isFinite(value))
        throw invalid("没打开，再试一次");
      where.push(
        `(c.${order}${comparison}? OR (c.${order}=? AND c.id${comparison}?))`,
      );
      args.push(value, value, id);
    }
    const limit = Math.min(40, Math.max(1, q.limit ?? 40));
    const rows = this.store.db
      .prepare(
        `SELECT c.* FROM cards c WHERE ${where.join(" AND ")} ORDER BY c.${order} ${direction},c.id ${direction} LIMIT ?`,
      )
      .all(...args, limit + 1) as Row[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit),
      last = page.at(-1);
    return {
      data: page.map((r) => this.view(r)),
      total,
      cursor: more && last ? `${String(last[order])}|${String(last.id)}` : null,
    };
  }

  detail(userId: string, id: string, merged = false) {
    const card = this.view(this.own(userId, id, merged));
    const versions = this.store.db
      .prepare(
        "SELECT id,kind,by,data,created_at FROM card_versions WHERE card_id=? AND user_id=? ORDER BY id DESC",
      )
      .all(id, userId)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        by: r.by,
        data: JSON.parse(String(r.data)),
        createdAt: r.created_at,
      }));
    const links = this.store.db
      .prepare(
        "SELECT c.*,l.by AS link_by FROM card_links l JOIN cards c ON c.id=CASE WHEN l.a=? THEN l.b ELSE l.a END WHERE l.user_id=? AND (l.a=? OR l.b=?) AND c.user_id=? AND c.merged_into IS NULL ORDER BY l.created_at DESC",
      )
      .all(id, userId, id, id, userId)
      .map((r) => ({ ...this.view(r), linkBy: r.link_by }));
    const uses = this.store.db
      .prepare(
        "SELECT kind,ref_id,created_at FROM card_uses WHERE card_id=? AND user_id=? ORDER BY created_at DESC",
      )
      .all(id, userId);
    const retest = card.pointId
      ? (this.store.db
          .prepare(
            "SELECT * FROM retests WHERE user_id=? AND point_id=? ORDER BY (done_at IS NULL) DESC,created_at DESC LIMIT 1",
          )
          .get(userId, card.pointId) ?? null)
      : null;
    const tidied = versions.find((v) => v.by === "ai" && v.kind === "slots")
      ?.data as
      | {
          followup?: { q: string; options: string[] } | null;
          follow?: CardFollow;
          ask?: { q: string; yes: string; no: string } | null;
        }
      | undefined;
    const followup = tidied?.followup ?? null;
    // tidy's own 回顾 question for this card and the mode it fits.
    const followAsk =
      tidied?.follow && tidied.ask
        ? { follow: tidied.follow, ...tidied.ask }
        : null;
    const proof = this.store.db
      .prepare(
        `SELECT e.id FROM events e,json_each(e.data,'$.cardIds') c
      WHERE e.user_id=? AND e.name='learning_pass' AND c.value=? AND
      ((json_extract(e.data,'$.kind')='point' AND json_extract(e.data,'$.id')=?) OR
       (json_extract(e.data,'$.kind')='mistake' AND json_extract(e.data,'$.id')=?))
      ORDER BY e.id DESC LIMIT 1`,
      )
      .get(userId, id, card.pointId, card.mistakeId);
    // 补充 stays the learner's own, as 0.4.0–0.6.0 and v4.1 read it; the AI
    // words a type change or a merge moved here come apart.
    const added = (by: "user" | "ai") =>
      versions
        .filter((v) => v.kind === "supplement" && v.by === by)
        .reverse()
        .map((v) => ({
          text: String(v.data.text ?? ""),
          by,
          createdAt: String(v.createdAt),
        }));
    const supplements = added("user"),
      aiSupplements = added("ai");
    // Only items that can still show: a manual card shows promises, its own
    // reminder dates (V4.2 FX5c: any kind) and set times.
    const next =
      card.resume === "off"
        ? undefined
        : this.store.db
            .prepare(
              `SELECT min(due_on) AS d FROM resume_items WHERE user_id=? AND src='card' AND src_id=? AND state IN ('waiting','shown','snoozed')${card.resume === "manual" ? " AND (kind='promise' OR item_key LIKE 'remind:%' OR remind_at IS NOT NULL)" : ""}`,
            )
            .get(userId, id);
    // V4.2 合并: the originals behind a merged card (open read-only).
    const mergedFrom = (
      this.store.db
        .prepare(
          "SELECT * FROM cards WHERE merged_into=? AND user_id=? ORDER BY created_at,id",
        )
        .all(id, userId) as Row[]
    ).map((r) => this.view(r));
    return {
      ...card,
      versions,
      links,
      mergedFrom,
      uses,
      retest,
      followup,
      followAsk,
      learningProofId: proof ? Number(proof.id) : null,
      supplements,
      aiSupplements,
      nextResumeOn: next?.d == null ? null : String(next.d),
    };
  }
  async answer(
    userId: string,
    id: string,
    version: number,
    input: {
      kind: "open" | "followup";
      key?: string;
      action: "answer" | "done" | "thinking";
      text?: string;
    },
  ) {
    const card = this.detail(userId, id);
    this.version(this.own(userId, id), version);
    const open = card.open as { key: string; text: string; by?: string }[];
    if (input.kind === "open" && !open.some((item) => item.key === input.key))
      throw invalid("这个问题刚有变化，刷新一下再答");
    if (
      input.kind === "followup" &&
      (!card.followup || input.action === "done")
    )
      throw invalid("这个问题刚有变化，刷新一下再答");
    const text = input.text?.trim() ?? "";
    if (input.action === "answer" && (!text || text.length > 300))
      throw invalid("写一句，最多 300 个字");
    if (
      text &&
      (await this.safety.check(text, { scene: card.scene, source: "card" }))
    )
      return { card, crisis: true, offerMine: false };
    const now = this.now();
    this.store.transaction(() => {
      this.version(this.own(userId, id), version);
      if (input.kind === "open" && input.action === "done")
        this.store.db
          .prepare("UPDATE cards SET open=? WHERE id=? AND user_id=?")
          .run(
            JSON.stringify(open.filter((item) => item.key !== input.key)),
            id,
            userId,
          );
      this.store.db
        .prepare(
          `UPDATE cards SET version=version+1,updated_at=?${input.action === "thinking" ? "" : ",organized_at=COALESCE(organized_at,?)"} WHERE id=? AND user_id=?`,
        )
        .run(
          ...(input.action === "thinking"
            ? [now, id, userId]
            : [now, now, id, userId]),
        );
      this.addVersion(userId, id, "followup", "user", {
        ...input,
        text,
        ...(input.kind === "open"
          ? { open: open.find((item) => item.key === input.key) }
          : {}),
      });
    });
    return {
      card: this.detail(userId, id),
      crisis: false,
      offerMine: input.action === "answer" && text.length >= 10 && !card.mine,
    };
  }
  async update(
    userId: string,
    id: string,
    version: number,
    input: {
      title?: string;
      summary?: string | null;
      slots?: unknown[];
      open?: unknown[];
      next?: unknown;
      type?: CardType;
      // the seven kinds, what follows saving, and the scene.
      kind?: CardKind;
      follow?: CardFollow;
      scene?: CardScene;
      pointId?: string | null;
      resume?: "on" | "off" | "manual";
      remindOn?: string | null;
      remindEvery?: RemindEvery | null;
    },
  ) {
    const row = this.own(userId, id);
    this.version(row, version);
    // An old client's type change is a kind change to that type. Old clients
    //  send their type with every edit, so the same type keeps
    // the stored kind and follow-up.
    const kind =
      input.kind ??
      (input.type !== undefined && input.type !== row.type
        ? input.type
        : undefined);
    if (kind !== undefined && !is(CARD_KINDS, kind))
      throw invalid("填的内容不太对，再看一下");
    const type = kind === undefined ? undefined : KIND_TYPE[kind];
    const before = effectiveKind(row.kind, row.type as CardType);
    if (input.follow !== undefined && !is(CARD_FOLLOWS, input.follow))
      throw invalid("填的内容不太对，再看一下");
    if (input.scene !== undefined) {
      if (!is(CARD_SCENES, input.scene))
        throw invalid("填的内容不太对，再看一下");
      this.requireMood(userId, input.scene);
    }
    if (input.remindOn) {
      const today = chinaDate(this.clock().getTime());
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(input.remindOn) ||
        addDays(input.remindOn, 0) !== input.remindOn ||
        input.remindOn < today ||
        input.remindOn > addDays(today, 365)
      )
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "挑今天到一年内的日子",
        );
    }
    if (input.pointId && !POINT_IDS.has(input.pointId))
      throw invalid("没找到这个知识点");
    if (input.slots !== undefined) {
      // Clients edit the plain text; a slot sent back unchanged keeps its
      // colour marks, an edited one is stored as typed.
      const stored = new Map(
        (JSON.parse(String(row.slots)) as Slot[]).map((slot) => [
          slot.key,
          String(slot.text ?? ""),
        ]),
      );
      input.slots = input.slots.map((raw) => {
        const item = slotSchema.parse(raw);
        // slots kept from an earlier kind stay editable.
        if (
          !SLOT_KEYS[type ?? (row.type as CardType)].includes(item.key) &&
          !stored.has(item.key)
        )
          throw invalid("填的内容不太对，再看一下");
        const before = stored.get(item.key);
        const text =
          before !== undefined && before !== item.text && unmark(before) === item.text
            ? before
            : item.text;
        return { ...item, text, by: "user" };
      });
    }
    // a type change keeps only the new type's slots. The other
    // slots' words go to 补充, so nothing is lost and old clients and v4.1
    // (which check slot keys) still save it. Each keeps who wrote it: a slot
    // without "user" is the AI's, and one sent back unchanged stays so.
    const moved: { text: string; by: "user" | "ai" }[] = [];
    if (type !== undefined && type !== row.type) {
      const stored = JSON.parse(String(row.slots)) as Slot[];
      const given = input.slots as Slot[] | undefined;
      const fits = (slot: Slot) => SLOT_KEYS[type].includes(slot.key);
      const plain = (slot: Slot) => unmark(String(slot.text ?? "")).trim();
      const author = (slot: Slot) => {
        const was = stored.find((s) => s.key === slot.key);
        const source = was && plain(was) === plain(slot) ? was : slot;
        return source.by === "user" ? "user" : "ai";
      };
      for (const slot of [
        ...(given ?? stored),
        // Old clients send only the new type's slots; the rest stay stored.
        ...(given
          ? stored.filter((s) => !given.some((g) => g.key === s.key))
          : []),
      ]) {
        const text = plain(slot);
        if (!fits(slot) && text)
          moved.push({
            text: `${SLOT_LABELS[slot.key] ?? "整理"}：${text}`,
            by: author(slot),
          });
      }
      if (given || moved.length) input.slots = (given ?? stored).filter(fits);
    }
    if (input.open !== undefined)
      input.open = input.open.map((raw) => ({
        ...openSchema.parse(raw),
        by: "user",
      }));
    if (input.next !== undefined && input.next !== null)
      input.next = { ...nextSchema.parse(input.next), by: "user" };
    const editable = [
      "title",
      "summary",
      "slots",
      "open",
      "next",
      "type",
      "kind",
      "follow",
      "scene",
      "pointId",
      "resume",
      "remindOn",
      "remindEvery",
    ].some((k) => k in input);
    if (!editable) throw invalid("没有要改的地方");
    const content = JSON.stringify({
      title: input.title,
      summary: input.summary,
      slots: input.slots,
      open: input.open,
      next: input.next,
    });
    if (
      content &&
      (await this.safety.check(content, {
        scene: row.scene as CardScene,
        source: "card",
      }))
    )
      return { card: this.view(row), crisis: true };
    const now = this.now();
    this.store.transaction(() => {
      this.version(this.own(userId, id), version);
      const sets: string[] = ["updated_at=?", "version=version+1"],
        args: (string | number | null)[] = [now];
      if (input.title !== undefined) {
        sets.push("title=?", "title_by='user'");
        args.push(input.title.trim());
      }
      if (input.summary !== undefined) {
        sets.push("summary=?", "summary_by='user'");
        args.push(input.summary);
      }
      if (input.slots !== undefined) {
        sets.push("slots=?", "organized_at=COALESCE(organized_at,?)");
        args.push(JSON.stringify(input.slots), now);
      }
      if (input.open !== undefined) {
        sets.push("open=?", "organized_at=COALESCE(organized_at,?)");
        args.push(JSON.stringify(input.open), now);
      }
      if (input.next !== undefined) {
        sets.push("next=?", "organized_at=COALESCE(organized_at,?)");
        args.push(input.next === null ? null : JSON.stringify(input.next), now);
      }
      if (kind !== undefined) {
        // the organized slots stay; only the kind changes.
        sets.push("type=?", "kind=?", "organized_at=COALESCE(organized_at,?)");
        args.push(type!, kind, now);
        // A follow-up chosen for the old kind gives way to the new kind's.
        if (kind !== before && input.follow === undefined)
          sets.push("follow=NULL");
        logEvent(this.store, userId, "card_type_change", { type: type!, kind });
      }
      if (input.follow !== undefined) {
        sets.push("follow=?");
        args.push(input.follow);
      }
      if (input.scene !== undefined) {
        sets.push("scene=?");
        args.push(input.scene);
      }
      if (input.pointId !== undefined) {
        sets.push("point_id=?");
        args.push(input.pointId);
      }
      // 提醒频率 : setting one starts tomorrow or a week on unless a
      // date is picked with it; turning it off, or 不提醒 (remindOn null),
      // ends it. A date alone moves the next reminder and keeps the frequency.
      let remindOn = input.remindOn;
      if (input.remindEvery) {
        this.setRemindEvery(userId, id, input.remindEvery);
        remindOn ||= addDays(
          chinaDate(this.clock().getTime()),
          REMIND_DAYS[input.remindEvery],
        );
      } else if (input.remindEvery === null || input.remindOn === null) {
        this.setRemindEvery(userId, id, null);
        if (remindOn === undefined) remindOn = null;
      }
      // A picked reminder date needs the card's reminders on.
      const resume =
        remindOn && (input.resume ?? row.resume) === "off"
          ? "manual"
          : input.resume;
      if (resume !== undefined) {
        sets.push("resume=?");
        args.push(resume);
      }
      if (remindOn !== undefined) {
        sets.push("remind_on=?");
        args.push(remindOn);
      }
      args.push(id, userId, version);
      this.store.db
        .prepare(
          `UPDATE cards SET ${sets.join(",")} WHERE id=? AND user_id=? AND version=?`,
        )
        .run(...args);
      for (const { text, by } of moved)
        this.addVersion(userId, id, "supplement", by, { text, from: "type" });
      this.addVersion(
        userId,
        id,
        kind
          ? "type"
          : input.slots !== undefined ||
              input.open !== undefined ||
              input.next !== undefined
            ? "slots"
            : "edit",
        "user",
        kind ? { ...input, type, kind, previousKind: before } : input,
      );
    });
    return { card: this.detail(userId, id), crisis: false };
  }
  // 补充一句: the user's own later words, kept as versions of the card.
  async supplement(
    userId: string,
    id: string,
    version: number,
    input: { text: string; clientId?: string },
  ) {
    const replay = () =>
      input.clientId &&
      this.store.db
        .prepare(
          "SELECT 1 FROM card_versions WHERE card_id=? AND user_id=? AND kind='supplement' AND json_extract(data,'$.clientId')=?",
        )
        .get(id, userId, input.clientId);
    const row = this.own(userId, id);
    if (replay()) return { card: this.detail(userId, id), crisis: false };
    this.version(row, version);
    const text = input.text.trim();
    if (!text || text.length > 500) throw invalid("写一句，最多 500 个字");
    if (
      await this.safety.check(text, {
        scene: row.scene as CardScene,
        source: "card",
      })
    )
      return { card: this.detail(userId, id), crisis: true };
    const now = this.now();
    this.store.transaction(() => {
      if (replay()) return;
      this.version(this.own(userId, id), version);
      this.store.db
        .prepare(
          "UPDATE cards SET updated_at=?,version=version+1 WHERE id=? AND user_id=? AND version=?",
        )
        .run(now, id, userId, version);
      this.addVersion(userId, id, "supplement", "user", {
        text,
        ...(input.clientId ? { clientId: input.clientId } : {}),
      });
    });
    return { card: this.detail(userId, id), crisis: false };
  }
  async mine(
    userId: string,
    id: string,
    version: number,
    input: { text?: string; quote?: string },
  ) {
    const row = this.own(userId, id);
    this.version(row, version);
    const text = (input.quote ?? input.text ?? "").trim();
    if ((text && text.length < 2) || text.length > 300)
      throw invalid("我的话写一句就好，最多 300 个字");
    const sources = [String(row.quote ?? "")];
    if (row.origin === "chat" && row.src_id)
      sources.push(
        ...this.store.db
          .prepare(
            "SELECT content FROM messages WHERE user_id=? AND thread_id=? AND role='user' AND COALESCE(json_extract(data,'$.crisis'),0)=0 AND COALESCE(json_extract(data,'$.guideChoice'),0)=0",
          )
          .all(userId, String(row.src_id))
          .map((r) => String(r.content)),
      );
    sources.push(
      ...this.store.db
        .prepare(
          "SELECT json_extract(data,'$.text') AS text FROM card_versions WHERE user_id=? AND card_id=? AND kind='supplement' AND by='user'",
        )
        .all(userId, id)
        .map((r) => String(r.text ?? "")),
    );
    if (input.quote && !isQuote(input.quote, sources))
      throw invalid("这句要是你自己说过的");
    if (
      await this.safety.check(text, {
        scene: row.scene as CardScene,
        source: "card",
      })
    )
      return { card: this.view(row), crisis: true };
    const now = this.now();
    this.store.transaction(() => {
      this.version(this.own(userId, id), version);
      this.store.db
        .prepare(
          "UPDATE cards SET mine=?,mine_at=?,updated_at=?,version=version+1 WHERE id=? AND user_id=? AND version=?",
        )
        .run(text || null, text ? now : null, now, id, userId, version);
      this.addVersion(userId, id, "mine", "user", { text });
      logEvent(this.store, userId, "card_mine", {});
    });
    return { card: this.detail(userId, id), crisis: false };
  }
  async close(userId: string, id: string, version: number, text?: string) {
    const row = this.own(userId, id);
    this.version(row, version);
    if (row.scene === "mood") throw invalid("心情卡不用收好");
    if (
      row.scene === "study" &&
      (row.point_id || row.mistake_id) &&
      (row.type === "question" || row.type === "method")
    )
      throw invalid("再自己做对一次相关的题，这张就能收好了");
    const result = text?.trim() ?? "";
    // a 待办 closes on 做了 alone; the others keep the user's words.
    const todo = effectiveKind(row.kind, row.type as CardType) === "todo";
    if ((!todo && result.length < 2) || result.length > 300)
      throw invalid("写一句你想明白了什么，最多 300 个字");
    if (
      result &&
      await this.safety.check(result, {
        scene: row.scene as CardScene,
        source: "card",
      })
    )
      return { card: this.view(row), crisis: true };
    const now = this.now();
    this.store.transaction(() => {
      this.version(this.own(userId, id), version);
      this.store.db
        .prepare(
          "UPDATE cards SET mine=COALESCE(mine,?),mine_at=COALESCE(mine_at,?),closed_at=?,updated_at=?,version=version+1 WHERE id=? AND user_id=?",
        )
        .run(result || null, result ? now : null, now, now, id, userId);
      if (!row.mine && result)
        this.addVersion(userId, id, "mine", "user", { text: result });
      this.addVersion(userId, id, "close", "user", { text: result });
      logEvent(this.store, userId, "card_close", {});
    });
    return { card: this.detail(userId, id), crisis: false };
  }
  private learningProof(userId: string, proofId: number) {
    const row = this.store.db
      .prepare(
        "SELECT data FROM events WHERE id=? AND user_id=? AND name='learning_pass'",
      )
      .get(proofId, userId);
    if (!row) throw new AppError(404, "NOT_FOUND", "没找到这次做题的记录");
    return JSON.parse(String(row.data)) as {
      kind: "point" | "mistake";
      id: string;
      source: string;
      cardIds: string[];
    };
  }
  learningCards(userId: string, proofId: number) {
    const proof = this.learningProof(userId, proofId);
    const cards = proof.cardIds.flatMap((id) => {
      try {
        const c = this.detail(userId, id);
        return c.scene === "study" &&
          !c.crisis &&
          ["question", "method"].includes(c.type) &&
          (proof.kind === "point" ? c.pointId : c.mistakeId) === proof.id
          ? [c]
          : [];
      } catch {
        return [];
      }
    });
    return { proofId, cards };
  }
  async learningClose(
    userId: string,
    id: string,
    version: number,
    input: { proofId: number; used?: boolean; text?: string },
  ) {
    const check = () => {
      const row = this.own(userId, id),
        proof = this.learningProof(userId, input.proofId);
      this.version(row, version);
      if (
        !proof.cardIds.includes(id) ||
        row.scene !== "study" ||
        row.crisis ||
        !["question", "method"].includes(String(row.type)) ||
        row[proof.kind === "point" ? "point_id" : "mistake_id"] !== proof.id ||
        row.closed_at
      )
        throw invalid("这次做的题和这张卡对不上");
      if (row.type === "method" && input.used !== true)
        throw invalid("先确认一下用到了这张卡");
      return row;
    };
    const row = check(),
      text = input.text?.trim() || "";
    if (
      (text && (text.length < 2 || text.length > 300)) ||
      (!row.mine && text.length < 2)
    )
      throw invalid("写下关键的一步，最多 300 个字");
    if (
      text &&
      (await this.safety.check(text, { scene: "study", source: "card" }))
    )
      return { card: this.view(row), crisis: true };
    const at = this.now();
    this.store.transaction(() => {
      const latest = check();
      this.store.db
        .prepare(
          "UPDATE cards SET mine=COALESCE(mine,?),mine_at=COALESCE(mine_at,?),closed_at=?,updated_at=?,version=version+1 WHERE id=? AND user_id=?",
        )
        .run(text || null, at, at, at, id, userId);
      if (!latest.mine) this.addVersion(userId, id, "mine", "user", { text });
      this.addVersion(userId, id, "close", "user", {
        proofId: input.proofId,
        used: input.used === true,
      });
      logEvent(this.store, userId, "card_close", { source: "learning" });
    });
    return { card: this.detail(userId, id), crisis: false };
  }
  tagsReplace(userId: string, id: string, version: number, tagIds: string[]) {
    const row = this.own(userId, id);
    this.version(row, version);
    if (new Set(tagIds).size !== tagIds.length || tagIds.length > 3)
      throw invalid("最多选 3 个标签");
    const valid =
      tagIds.length === 0
        ? 0
        : Number(
            (
              this.store.db
                .prepare(
                  `SELECT count(*) AS n FROM tags WHERE user_id=? AND id IN (${tagIds.map(() => "?").join(",")})`,
                )
                .get(userId, ...tagIds) as { n: number }
            ).n,
          );
    if (valid !== tagIds.length) throw invalid("这个标签找不到了");
    const now = this.now();
    this.store.transaction(() => {
      this.version(this.own(userId, id), version);
      this.store.db
        .prepare("DELETE FROM card_tags WHERE card_id=? AND user_id=?")
        .run(id, userId);
      const insert = this.store.db.prepare(
        "INSERT INTO card_tags(card_id,tag_id,user_id) VALUES(?,?,?)",
      );
      for (const tagId of tagIds) insert.run(id, tagId, userId);
      this.store.db
        .prepare(
          "UPDATE cards SET organized_at=COALESCE(organized_at,?),updated_at=?,version=version+1 WHERE id=? AND user_id=? AND version=?",
        )
        .run(now, now, id, userId, version);
      this.addVersion(userId, id, "tags", "user", { tagIds });
    });
    return this.detail(userId, id);
  }
  tagList(userId: string) {
    return this.store.db
      .prepare(
        "SELECT t.id,t.name,t.color,t.by,t.created_at,count(ct.card_id) AS count FROM tags t LEFT JOIN card_tags ct ON ct.tag_id=t.id AND ct.user_id=t.user_id WHERE t.user_id=? GROUP BY t.id ORDER BY t.name",
      )
      .all(userId)
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        color: Number(r.color),
        by: r.by,
        count: Number(r.count),
        createdAt: String(r.created_at),
      }));
  }
  tagCreate(userId: string, name: string, color: number) {
    if (
      !name.trim() ||
      Array.from(name.trim()).length > 6 ||
      color < 0 ||
      color > 7
    )
      throw invalid("标签名不太对，再看一下");
    try {
      return this.store.transaction(() => {
        const n = Number(
          (
            this.store.db
              .prepare("SELECT count(*) AS n FROM tags WHERE user_id=?")
              .get(userId) as { n: number }
          ).n,
        );
        if (n >= 50) throw invalid("标签最多 50 个");
        const id = uid("tag");
        this.store.db
          .prepare(
            "INSERT INTO tags(id,user_id,name,color,by,created_at) VALUES(?,?,?,?,'user',?)",
          )
          .run(id, userId, name.trim(), color, this.now());
        return { id, name: name.trim(), color, by: "user" as const };
      });
    } catch (e) {
      if (String(e).includes("UNIQUE"))
        throw new AppError(409, "TAG_EXISTS", "已有这个标签");
      throw e;
    }
  }
  tagUpdate(
    userId: string,
    id: string,
    input: { name?: string; color?: number },
  ) {
    if (
      input.name !== undefined &&
      (!input.name.trim() || Array.from(input.name.trim()).length > 6)
    )
      throw invalid("标签名不太对，再看一下");
    if (input.color !== undefined && (input.color < 0 || input.color > 7))
      throw invalid("选一个颜色");
    try {
      const result = this.store.db
        .prepare(
          "UPDATE tags SET name=COALESCE(?,name),color=COALESCE(?,color),by='user' WHERE id=? AND user_id=?",
        )
        .run(input.name?.trim() ?? null, input.color ?? null, id, userId);
      if (!result.changes) throw new AppError(404, "NOT_FOUND", "这个标签找不到了");
      return this.tagList(userId).find((t) => t.id === id)!;
    } catch (e) {
      if (String(e).includes("UNIQUE"))
        throw new AppError(409, "TAG_EXISTS", "已有这个标签");
      throw e;
    }
  }
  tagDelete(userId: string, id: string) {
    const result = this.store.db
      .prepare("DELETE FROM tags WHERE id=? AND user_id=?")
      .run(id, userId);
    if (!result.changes) throw new AppError(404, "NOT_FOUND", "这个标签找不到了");
  }
  link(userId: string, id: string, version: number, otherId: string) {
    const row = this.own(userId, id);
    this.version(row, version);
    this.own(userId, otherId);
    if (id === otherId) throw invalid("不能连上自己，换一张");
    const [a, b] = [id, otherId].sort() as [string, string];
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "INSERT INTO card_links(a,b,user_id,by,created_at) VALUES(?,?,?,'user',?) ON CONFLICT(a,b) DO UPDATE SET by='user',user_id=excluded.user_id,brainstorm_id=NULL",
        )
        .run(a, b, userId, this.now());
      this.store.db
        .prepare(
          "UPDATE cards SET updated_at=?,version=version+1 WHERE id=? AND user_id=? AND version=?",
        )
        .run(this.now(), id, userId, version);
      // linking is not finishing; a spark is no longer closed here.
    });
    return this.detail(userId, id);
  }
  unlink(userId: string, id: string, version: number, otherId: string) {
    const row = this.own(userId, id);
    this.version(row, version);
    const [a, b] = [id, otherId].sort() as [string, string];
    this.store.transaction(() => {
      this.store.db
        .prepare("DELETE FROM card_links WHERE a=? AND b=? AND user_id=?")
        .run(a, b, userId);
      this.store.db
        .prepare(
          "UPDATE cards SET updated_at=?,version=version+1 WHERE id=? AND user_id=? AND version=?",
        )
        .run(this.now(), id, userId, version);
    });
    return this.detail(userId, id);
  }
  remove(userId: string, id: string) {
    const row = this.own(userId, id);
    // the originals hidden behind a merged card (and theirs, when a
    // merged card was merged again) go with it, as a v4.1 merge left them.
    const hidden = (cardId: string): Row[] =>
      (
        this.store.db
          .prepare("SELECT * FROM cards WHERE merged_into=? AND user_id=?")
          .all(cardId, userId) as Row[]
      ).flatMap((r) => [r, ...hidden(String(r.id))]);
    this.store.transaction(() => {
      for (const original of hidden(id)) this.removeRow(userId, original);
      this.removeRow(userId, row);
    });
  }
  // Deletes a card with its reminders and pending jobs; the caller holds the
  // transaction.
  private removeRow(userId: string, row: Row) {
    const id = String(row.id);
    this.store.db
      .prepare(
        "DELETE FROM resume_items WHERE user_id=? AND src='card' AND src_id=?",
      )
      .run(userId, id);
    this.store.db
      .prepare(
        "UPDATE jobs SET params='{\"deleted\":true}',params_hash='deleted:'||id,result=NULL,status=CASE WHEN status IN ('queued','running') THEN 'failed' ELSE status END,error_code=CASE WHEN status IN ('queued','running') THEN 'CARD_DELETED' ELSE error_code END,finished_at=COALESCE(finished_at,?) WHERE user_id=? AND json_extract(params,'$.cardId')=?",
      )
      .run(this.now(), userId, id);
    this.store.db
      .prepare("DELETE FROM cards WHERE id=? AND user_id=?")
      .run(id, userId);
    if (row.origin === "note" && row.src_id) {
      const noteId = String(row.src_id);
      this.store.db
        .prepare(
          "UPDATE jobs SET params='{\"deleted\":true}',params_hash='deleted:'||id,result=NULL,status=CASE WHEN status IN ('queued','running') THEN 'failed' ELSE status END,error_code=CASE WHEN status IN ('queued','running') THEN 'NOTE_DELETED' ELSE error_code END,finished_at=COALESCE(finished_at,?) WHERE user_id=? AND json_extract(params,'$.noteId')=?",
        )
        .run(this.now(), userId, noteId);
      this.store.db
        .prepare("DELETE FROM notes WHERE id=? AND user_id=?")
        .run(noteId, userId);
    }
  }
  // 合并: one new card from several, written in one go. The originals must be
  // unchanged since the merge started; their outside links move to the new card.
  // the originals stay, hidden behind the new card (merged_into), and
  // the new card carries all of their words, open items, tags and 补充.
  merge(
    userId: string,
    sources: { id: string; version: number }[],
    data: {
      type: CardType;
      kind?: CardKind;
      scene: CardScene;
      title: string;
      summary: string;
      slots: { key: string; text: string }[];
    },
  ) {
    const write = () => {
      const rows = sources.map(({ id, version }) => {
        const row = this.store.db
          .prepare("SELECT * FROM cards WHERE id=? AND user_id=?")
          .get(id, userId) as Row | undefined;
        if (
          !row ||
          Number(row.version) !== version ||
          row.crisis ||
          row.merged_into != null
        )
          throw new AppError(
            409,
            "CARD_CHANGED",
            "有卡在合并时改过了，再试一次",
          );
        return row;
      });
      const id = uid("card"),
        now = this.now();
      // Every original's own text, nothing cut: its words, else its gist.
      const quote = rows
        .map((r) => String(r.quote || r.summary || r.title).trim())
        .filter(Boolean)
        .join("\n—\n");
      // the merged card stays within what every client and v4.1
      // can save back (我的话 ≤ 300, ≤ 3 open items, ≤ 3 tags). Whole 我的话
      // that do not fit and the open items past three go to 补充, so no word
      // is lost; the tags past three stay on the hidden originals.
      const overflow: { text: string; by: "user" | "ai" }[] = [];
      const mine = rows
        .map((r) => String(r.mine ?? "").trim())
        .filter(Boolean)
        .reduce((kept, text) => {
          const joined = kept ? `${kept}\n${text}` : text;
          if (joined.length <= MINE_MAX) return joined;
          overflow.push({ text: `我的话：${text}`, by: "user" });
          return kept;
        }, "");
      const items = rows.flatMap((r, i) =>
        (
          JSON.parse(String(r.open)) as {
            key: string;
            text: string;
            answer?: string;
            done?: boolean;
            by?: string;
          }[]
        ).map((item) => ({
          ...item,
          key: `${i + 1}-${item.key}`.slice(0, 40),
        })),
      );
      // Unresolved items first, in their order; the rest go to 补充.
      const ordered = [
        ...items.filter((item) => !item.done),
        ...items.filter((item) => item.done),
      ];
      const open = ordered.slice(0, OPEN_MAX);
      // An item without "user" is the AI's, as the card page shows it.
      for (const item of ordered.slice(OPEN_MAX))
        overflow.push({
          text: `还没想明白的：${item.text}${item.answer ? `\n想到的：${item.answer}` : ""}`,
          by: item.by === "user" ? "user" : "ai",
        });
      const next = rows.find((r) => r.next != null)?.next ?? null;
      const every = rows
        .map((r) => this.remindEvery(String(r.id)))
        .find(Boolean);
      const first = (key: string) =>
        (rows.find((r) => r[key] != null)?.[key] as string | undefined) ?? null;
      const remind = rows
        .map((r) => r.remind_on as string | null)
        .filter((d): d is string => Boolean(d))
        .sort()[0];
      const kind =
        data.kind && KIND_TYPE[data.kind] === data.type ? data.kind : data.type;
      this.store.db
        .prepare(
          "INSERT INTO cards(id,user_id,type,kind,scene,title,title_by,summary,summary_by,mine,mine_at,quote,quote_on,slots,open,next,organized_at,closed_at,origin,mistake_id,point_id,favorite,remind_on,use_count,created_at,updated_at) VALUES(?,?,?,?,?,?,'ai',?,'ai',?,?,?,?,?,?,?,?,?,'jot',?,?,?,?,?,?,?)",
        )
        .run(
          id,
          userId,
          data.type,
          kind,
          data.scene,
          data.title,
          data.summary,
          mine || null,
          mine ? now : null,
          quote || null,
          quote ? chinaDate(this.clock().getTime()) : null,
          JSON.stringify(data.slots.map((slot) => ({ ...slot, by: "ai" }))),
          JSON.stringify(open),
          next == null ? null : String(next),
          now,
          // All of them done: the merged card is done too.
          rows.every((r) => r.closed_at) ? now : null,
          first("mistake_id"),
          first("point_id"),
          rows.some((r) => Number(r.favorite)) ? 1 : 0,
          remind ?? null,
          rows.reduce((n, r) => n + Number(r.use_count ?? 0), 0),
          now,
          now,
        );
      if (every) this.setRemindEvery(userId, id, every);
      const ids = new Set(sources.map((s) => s.id));
      const tagIds = [
        ...new Set(
          this.store.db
            .prepare(
              `SELECT card_id,tag_id FROM card_tags WHERE user_id=? AND card_id IN (${sources.map(() => "?").join(",")})`,
            )
            .all(userId, ...ids)
            .sort(
              (a, b) =>
                sources.findIndex((s) => s.id === a.card_id) -
                sources.findIndex((s) => s.id === b.card_id),
            )
            .map((r) => String(r.tag_id)),
        ),
      ];
      for (const tagId of tagIds.slice(0, TAGS_MAX))
        this.store.db
          .prepare(
            "INSERT INTO card_tags(card_id,tag_id,user_id) VALUES(?,?,?)",
          )
          .run(id, tagId, userId);
      const links = this.store.db
        .prepare(
          `SELECT * FROM card_links WHERE user_id=? AND (a IN (${sources.map(() => "?").join(",")}) OR b IN (${sources.map(() => "?").join(",")})) ORDER BY created_at`,
        )
        .all(userId, ...ids, ...ids);
      for (const link of links) {
        const other = ids.has(String(link.a)) ? String(link.b) : String(link.a);
        if (ids.has(other)) continue;
        const [a, b] = [id, other].sort() as [string, string];
        this.store.db
          .prepare(
            "INSERT OR IGNORE INTO card_links(a,b,user_id,by,brainstorm_id,created_at) VALUES(?,?,?,?,?,?)",
          )
          .run(
            a,
            b,
            userId,
            String(link.by),
            (link.brainstorm_id as string | null) ?? null,
            now,
          );
      }
      this.addVersion(userId, id, "create", "user", {
        from: "merge",
        cardIds: sources.map((s) => s.id),
      });
      if (mine) this.addVersion(userId, id, "mine", "user", { text: mine });
      // The originals' 补充 come along (AI-moved ones too), dated as they
      // were written.
      this.store.db
        .prepare(
          `INSERT INTO card_versions(card_id,user_id,kind,by,data,created_at) SELECT ?,user_id,kind,by,data,created_at FROM card_versions WHERE user_id=? AND kind='supplement' AND by IN ('user','ai') AND card_id IN (${sources.map(() => "?").join(",")}) ORDER BY created_at,id`,
        )
        .run(id, userId, ...ids);
      for (const { text, by } of overflow)
        this.addVersion(userId, id, "supplement", by, { text, from: "merge" });
      for (const row of rows) {
        this.store.db
          .prepare(
            "UPDATE cards SET merged_into=?,updated_at=? WHERE id=? AND user_id=?",
          )
          .run(id, now, String(row.id), userId);
        this.store.db
          .prepare(
            "DELETE FROM resume_items WHERE user_id=? AND src='card' AND src_id=?",
          )
          .run(userId, String(row.id));
      }
      logEvent(this.store, userId, "card_merge", { count: rows.length });
      return id;
    };
    return this.store.db.isTransaction
      ? write()
      : this.store.transaction(write);
  }
  // V4.2 拆开: undoes a merge while the merged card is as it was made; the
  // originals come back and the merged card goes.
  unmerge(userId: string, id: string, version: number) {
    const row = this.own(userId, id);
    this.version(row, version);
    return this.store.transaction(() => {
      const latest = this.own(userId, id);
      this.version(latest, version);
      const originals = this.store.db
        .prepare("SELECT id FROM cards WHERE merged_into=? AND user_id=?")
        .all(id, userId);
      if (!originals.length) throw invalid("这张卡不是合并来的");
      if (Number(latest.version) !== 1)
        throw new AppError(
          409,
          "CARD_CHANGED",
          "合并后又改过这张卡，拆开会丢掉改动",
        );
      this.store.db
        .prepare(
          "UPDATE cards SET merged_into=NULL,updated_at=? WHERE merged_into=? AND user_id=?",
        )
        .run(this.now(), id, userId);
      this.removeRow(userId, latest);
      logEvent(this.store, userId, "card_unmerge", {
        count: originals.length,
      });
      return { cardIds: originals.map((r) => String(r.id)) };
    });
  }
  // 收藏 is a mark, not an edit: no version or updated_at change.
  setFavorite(userId: string, id: string, favorite: boolean) {
    this.own(userId, id);
    this.store.db
      .prepare("UPDATE cards SET favorite=? WHERE id=? AND user_id=?")
      .run(favorite ? 1 : 0, id, userId);
    return { card: this.view(this.own(userId, id)) };
  }
  // scenes limits the counts the way the same scene filter limits the
  // list (new clients hiding 心情卡 send study,life); without it, as before.
  stats(userId: string, scenes?: CardScene[]) {
    const only = scenes?.length
      ? ` AND scene IN (${scenes.map(() => "?").join(",")})`
      : "";
    const sc = scenes ?? [];
    const r = this.store.db
      .prepare(
        `SELECT count(*) AS total,sum(${closedSql("cards")}) AS closed,sum(mine IS NOT NULL) AS clear FROM cards WHERE user_id=? AND merged_into IS NULL${only}`,
      )
      .get(userId, ...sc) as {
      total: number;
      closed: number | null;
      clear: number | null;
    };
    const retests = this.store.db
      .prepare(
        `SELECT count(*) AS count,sum(r.predicted='yes') AS predicted,
         sum(r.predicted='yes' AND r.result='right') AS actual
         FROM retests r JOIN events e ON e.id=(SELECT max(id) FROM events
           WHERE user_id=r.user_id AND name='retest_scheduled' AND json_extract(data,'$.retestId')=r.id)
         WHERE r.user_id=? AND r.done_at IS NOT NULL AND r.predicted IS NOT NULL
           AND r.result IN ('right','wrong','hinted')
           AND (r.round=1 OR json_extract(e.data,'$.repeated')=0)`,
      )
      .get(userId) as {
      count: number;
      predicted: number | null;
      actual: number | null;
    };
    return {
      total: Number(r.total),
      closed: Number(r.closed ?? 0),
      clear: Number(r.clear ?? 0),
      closedByType: Object.fromEntries(
        CARD_TYPES.map((type) => [
          type,
          Number(
            this.store.db
              .prepare(
                `SELECT count(*) AS n FROM cards WHERE user_id=? AND type=? AND ${closedSql("cards")} AND scene<>'mood' AND merged_into IS NULL`,
              )
              .get(userId, type)?.n ?? 0,
          ),
        ]),
      ),
      // v4 卡片 tab: how many cards of each type, the counts on its type row.
      byType: Object.fromEntries(
        CARD_TYPES.map((type) => [
          type,
          Number(
            this.store.db
              .prepare(
                `SELECT count(*) AS n FROM cards WHERE user_id=? AND type=? AND merged_into IS NULL${only}`,
              )
              .get(userId, type, ...sc)?.n ?? 0,
          ),
        ]),
      ),
      // the same per kind, for the kinds row (only kinds with cards).
      byKind: Object.fromEntries(
        CARD_KINDS.map((kind) => [
          kind,
          Number(
            this.store.db
              .prepare(
                `SELECT count(*) AS n FROM cards c WHERE c.user_id=? AND ${kindSql()}=? AND c.merged_into IS NULL${only}`,
              )
              .get(userId, kind, ...sc)?.n ?? 0,
          ),
        ]),
      ),
      favorites: Number(
        this.store.db
          .prepare(
            `SELECT count(*) AS n FROM cards WHERE user_id=? AND favorite=1 AND merged_into IS NULL${only}`,
          )
          .get(userId, ...sc)?.n ?? 0,
      ),
      tagCount: Number(
        this.store.db
          .prepare("SELECT count(*) AS n FROM tags WHERE user_id=?")
          .get(userId)?.n ?? 0,
      ),
      predicted: Number(retests.predicted ?? 0),
      retestCount: Number(retests.count),
      actual: Number(retests.actual ?? 0),
    };
  }
  applyAIData(userId: string, id: string, version: number, data: ApplyAIData) {
    const row = this.own(userId, id);
    this.version(row, version);
    if (row.crisis) throw invalid("这张卡不能再理");
    const now = this.now();
    const write = () => {
      this.version(this.own(userId, id), version);
      const sets: string[] = ["updated_at=?", "version=version+1"],
        args: (string | number | null)[] = [now];
      if (data.title !== undefined && row.title_by !== "user") {
        sets.push("title=?", "title_by='ai'");
        args.push(data.title.slice(0, 16));
      }
      if (data.summary !== undefined && row.summary_by !== "user") {
        sets.push("summary=?", "summary_by='ai'");
        args.push(data.summary.slice(0, 60));
      }
      if (data.slots !== undefined) {
        sets.push("slots=?");
        const previous = JSON.parse(String(row.slots)) as {
          key: string;
          by?: string;
        }[];
        const incoming = data.slots
          .map((raw) => ({ ...slotSchema.parse(raw), by: "ai" }))
          .filter((item) => SLOT_KEYS[row.type as CardType].includes(item.key));
        args.push(
          JSON.stringify([
            ...previous.filter((item) => item.by === "user"),
            ...incoming.filter(
              (item) =>
                !previous.some(
                  (old) => old.key === item.key && old.by === "user",
                ),
            ),
          ]),
        );
      }
      if (
        data.open !== undefined &&
        !this.store.db
          .prepare(
            "SELECT 1 FROM card_versions WHERE card_id=? AND user_id=? AND by='user' AND json_type(data,'$.open') IS NOT NULL LIMIT 1",
          )
          .get(id, userId)
      ) {
        sets.push("open=?");
        args.push(
          JSON.stringify(
            data.open.map((raw) => ({ ...openSchema.parse(raw), by: "ai" })),
          ),
        );
      }
      if (
        data.next !== undefined &&
        !(row.next && JSON.parse(String(row.next)).by === "user")
      ) {
        sets.push("next=?");
        args.push(
          data.next === null
            ? null
            : JSON.stringify({ ...nextSchema.parse(data.next), by: "ai" }),
        );
      }
      if (
        data.tags &&
        !this.store.db
          .prepare(
            "SELECT 1 FROM card_versions WHERE card_id=? AND user_id=? AND kind='tags' AND by='user' LIMIT 1",
          )
          .get(id, userId)
      ) {
        this.store.db
          .prepare("DELETE FROM card_tags WHERE card_id=? AND user_id=?")
          .run(id, userId);
        let count = Number(
          this.store.db
            .prepare("SELECT count(*) AS n FROM tags WHERE user_id=?")
            .get(userId)!.n,
        );
        for (const name of [
          ...new Set(
            data.tags.map((t) => t.trim().slice(0, 6)).filter(Boolean),
          ),
        ].slice(0, 3)) {
          let tag = this.store.db
            .prepare("SELECT id FROM tags WHERE user_id=? AND name=?")
            .get(userId, name);
          if (!tag && count < 50) {
            const tagId = uid("tag");
            this.store.db
              .prepare(
                "INSERT INTO tags(id,user_id,name,color,by,created_at) VALUES(?,?,?,?,'ai',?)",
              )
              .run(tagId, userId, name, count % 8, now);
            count++;
            tag = { id: tagId };
          }
          if (tag)
            this.store.db
              .prepare(
                "INSERT OR IGNORE INTO card_tags(card_id,tag_id,user_id) VALUES(?,?,?)",
              )
              .run(id, String(tag.id), userId);
        }
      }
      // The mode tidy chose, unless the learner chose one; mood stays quiet.
      // An earlier AI choice gives way to a later tidy's.
      if (
        data.follow &&
        row.scene !== "mood" &&
        (row.follow == null || !this.followChosen(userId, id))
      ) {
        sets.push("follow=?");
        args.push(data.follow);
      }
      args.push(id, userId, version);
      this.store.db
        .prepare(
          `UPDATE cards SET ${sets.join(",")} WHERE id=? AND user_id=? AND version=?`,
        )
        .run(...args);
      this.addVersion(userId, id, "slots", "ai", {
        followup: data.followup ?? null,
        tags: data.tags ?? [],
        ...(data.follow ? { follow: data.follow, ask: data.ask ?? null } : {}),
      });
    };
    if (this.store.db.isTransaction) write();
    else this.store.transaction(write);
    return this.detail(userId, id);
  }

  // Brainstorm output can mix untouched model text with user edits. Keep the
  // per-field author instead of flattening everything through applyAIData.
  applyBrainstormData(
    userId: string,
    id: string,
    version: number,
    data: BrainstormCardData,
  ) {
    const row = this.own(userId, id);
    this.version(row, version);
    if (row.crisis) throw invalid("这张卡不能放进头脑风暴");
    const title = data.title
      ? {
          text: data.title.text.trim().slice(0, 16),
          by: data.title.by,
        }
      : undefined;
    if (title && !title.text) throw invalid("标题空着，写几个字吧");
    const summary =
      data.summary === undefined || data.summary === null
        ? data.summary
        : {
            text: data.summary.text.trim().slice(0, 60),
            by: data.summary.by,
          };
    const slots = data.slots?.map((raw) => {
      const parsed = slotSchema.parse(raw);
      if (!SLOT_KEYS[row.type as CardType].includes(parsed.key))
        throw invalid("填的内容不太对，再看一下");
      return { ...parsed, by: raw.by };
    });
    const open = data.open?.map((raw) => ({
      ...openSchema.parse(raw),
      by: raw.by,
    }));
    const next =
      data.next === undefined || data.next === null
        ? data.next
        : { ...nextSchema.parse(data.next), by: data.next.by };
    const write = () => {
      this.version(this.own(userId, id), version);
      const sets = ["updated_at=?", "version=version+1"],
        args: (string | number | null)[] = [this.now()];
      if (title) {
        sets.push("title=?", "title_by=?");
        args.push(title.text, title.by);
      }
      if (summary !== undefined) {
        sets.push("summary=?", "summary_by=?");
        args.push(summary?.text ?? null, summary?.by ?? null);
      }
      if (slots !== undefined) {
        sets.push("slots=?");
        args.push(JSON.stringify(slots));
      }
      if (open !== undefined) {
        sets.push("open=?");
        args.push(JSON.stringify(open));
      }
      if (next !== undefined) {
        sets.push("next=?");
        args.push(next === null ? null : JSON.stringify(next));
      }
      args.push(id, userId, version);
      const updated = this.store.db
        .prepare(
          `UPDATE cards SET ${sets.join(",")} WHERE id=? AND user_id=? AND version=?`,
        )
        .run(...args).changes;
      if (!updated) throw changed();
      this.addVersion(userId, id, "edit", "system", {
        brainstorm: true,
        fields: Object.keys(data),
      });
    };
    if (this.store.db.isTransaction) write();
    else this.store.transaction(write);
    return this.detail(userId, id);
  }
}

/*
 * 卡片回顾与接续：决定本次访问展示哪些待回顾内容，并处理回应、跳过、提醒与撤销。
 * routes.ts 接收页面动作，templates.ts 与 reflections.ts 提供展示所需的模板和反思内容。
 * 回顾项引用原卡片，动作会改变回顾状态；按访问标识和日期控制重复展示，不等同于系统推送。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/domain.js";
import type { SqliteStore } from "../../shared/store.js";
import {
  addDays,
  chinaDate,
  chinaDayStart,
  now as businessNow,
} from "../../shared/time.js";
import { REMIND_DAYS, type CardService } from "../cards/service.js";
import {
  CARD_FOLLOWS,
  defaultFollow,
  effectiveKind,
  type CardFollow,
  type CardType,
} from "../cards/types.js";
import { isQuote } from "../cards/schema.js";
import type { CrisisSafetyService } from "../safety/service.js";
import {
  FOLLOW_ACTS,
  actFor,
  optionsFor,
  questionFor,
} from "./templates.js";
import { CALC_MAP } from "../learn/calc-map.js";
import { RetestService, type RetestRow } from "../learn/retests.js";
import { lookbacks, greeting, type Reflection } from "./reflections.js";

export const resumeSettingsSchema = z
  .object({
    mode: z.enum(["open", "time", "off"]),
    at: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    types: z
      .object({ study: z.boolean(), cards: z.boolean(), mood: z.boolean() })
      .strict(),
    greet: z.boolean(),
  })
  .strict();
const DEFAULTS = {
  mode: "open",
  at: "21:00",
  days: [0, 1, 2, 3, 4, 5, 6],
  types: { study: true, cards: true, mood: true },
  greet: true,
} as const;
type Row = Record<string, any>;
type Item = {
  id: string;
  user_id: string;
  src: string;
  src_id: string;
  item_key: string;
  kind: string;
  quote: string | null;
  quote_on: string | null;
  quote_by: string | null;
  due_on: string;
  state: string;
  shown_on: string | null;
  no_resp: number;
  remind_at: string | null;
  created_at: string;
  updated_at: string;
};
const uid = () => `resume_${randomUUID().replaceAll("-", "")}`;
const slice = (s: string, n = 30) => Array.from(s).slice(0, n).join("");
// "还在进行" and "已完成" are the v4 回顾卡 answers (这件事完成了吗？); the
// question and options sent to older clients stay as they were.
const NO_RESPONSE = new Set(["还在想", "先放着", "还在进行", "还没"]);
// V4.2 回顾: days to the next "还记得吗" after each 记住了; done after the last.
const RECALL_DAYS = [2, 4, 7, 15, 30];
// the resume item kind for each follow-up mode.
const FOLLOW_KIND: Record<Exclude<CardFollow, "none">, string> = {
  review: "recall",
  done: "todo",
  chat: "chat",
};
// A card's follow-up mode: chosen on the card, else by kind and scene.
const followOf = (card: Row): CardFollow =>
  (CARD_FOLLOWS as readonly string[]).includes(String(card.follow))
    ? (card.follow as CardFollow)
    : defaultFollow(
        effectiveKind(card.kind, card.type as CardType),
        String(card.scene),
      );
const CLOSE = new Set(["定了", "做了", "解决了", "已完成"]);
const parse = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};
export class ResumeService {
  private readonly undo = new Map<
    string,
    {
      userId: string;
      expires: number;
      item: Item;
      card: Row | null;
      version: number | null;
      historyIds: number[];
      marker: string;
      retest?: RetestRow | null;
      restoredRetest?: number | null;
      // The card's 提醒频率 before the act.
      every?: "day" | "week" | null;
    }
  >();
  constructor(
    private readonly store: SqliteStore,
    private readonly cards: CardService,
    private readonly safety: CrisisSafetyService,
    private readonly clock: () => Date = businessNow,
  ) {}
  private now() {
    return this.clock().toISOString();
  }
  private day() {
    return chinaDate(this.clock().getTime());
  }
  private own(userId: string, id: string): Item {
    const row = this.store.db
      .prepare("SELECT * FROM resume_items WHERE user_id=? AND id=?")
      .get(userId, id);
    if (!row)
      throw new AppError(404, "NOT_FOUND", "这件事已经不在了，下拉刷新一下");
    return row as Item;
  }
  private event(userId: string, name: string, data: Record<string, unknown>) {
    this.store.db
      .prepare(
        "INSERT INTO events(user_id,name,data,created_at) VALUES(?,?,?,?)",
      )
      .run(userId, name, JSON.stringify(data), this.now());
  }
  settings(userId: string) {
    const row = this.store.db
      .prepare("SELECT data FROM users WHERE id=?")
      .get(userId);
    if (!row)
      throw new AppError(404, "NOT_FOUND", "没找到你的账号，重新打开晓念试试");
    const data = parse<Row>(row.data, {});
    return resumeSettingsSchema.parse({
      ...DEFAULTS,
      ...data.resume,
      types: { ...DEFAULTS.types, ...data.resume?.types },
    });
  }
  setSettings(userId: string, input: unknown) {
    const data = resumeSettingsSchema.parse(input);
    data.days = [...new Set(data.days)];
    this.settings(userId);
    this.store.db
      .prepare(
        "UPDATE users SET data=json_set(data,'$.resume',json(?)) WHERE id=?",
      )
      .run(JSON.stringify(data), userId);
    return data;
  }
  private userCards(userId: string) {
    return this.store.db
      .prepare(
        "SELECT c.* FROM cards c WHERE c.user_id=? AND c.crisis=0 AND c.merged_into IS NULL AND (c.origin<>'note' OR EXISTS(SELECT 1 FROM card_versions v WHERE v.card_id=c.id AND v.by='system' AND v.kind='type')) ORDER BY c.created_at,c.id",
      )
      .all(userId) as Row[];
  }
  private upsert(
    userId: string,
    source: {
      src: string;
      srcId: string;
      key: string;
      kind: string;
      quote?: string;
      date?: string;
      by?: string;
      due: string;
      activity?: string;
    },
  ) {
    const old = this.store.db
      .prepare(
        "SELECT * FROM resume_items WHERE user_id=? AND src=? AND src_id=? AND item_key=?",
      )
      .get(userId, source.src, source.srcId, source.key) as Item | undefined;
    if (!old) {
      this.store.db
        .prepare(
          "INSERT INTO resume_items(id,user_id,src,src_id,item_key,kind,quote,quote_on,quote_by,due_on,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          uid(),
          userId,
          source.src,
          source.srcId,
          source.key,
          source.kind,
          source.quote ?? null,
          source.date ?? null,
          source.by ?? null,
          source.due,
          this.now(),
          this.now(),
        );
    } else {
      const awaken =
        old.state === "dormant" &&
        source.activity &&
        source.activity > old.updated_at;
      this.store.db
        .prepare(
          "UPDATE resume_items SET kind=?,quote=?,quote_on=?,quote_by=?,state=?,no_resp=?,due_on=? WHERE id=? AND user_id=?",
        )
        .run(
          source.kind,
          source.quote ?? null,
          source.date ?? null,
          source.by ?? null,
          awaken ? "waiting" : old.state,
          awaken ? 0 : old.no_resp,
          awaken
            ? source.due
            : old.due_on > source.due
              ? old.due_on
              : source.due,
          old.id,
          userId,
        );
    }
  }
  sync(userId: string) {
    const user = this.store.getUser(userId)!;
    if (!user)
      throw new AppError(404, "NOT_FOUND", "没找到你的账号，重新打开晓念试试");
    const fresh =
      this.day() <= addDays(chinaDate(Date.parse(user.createdAt)), 6);
    const cards = this.userCards(userId);
    const first = cards.find(
      (c) =>
        ["jot", "chat"].includes(c.origin) &&
        c.scene !== "mood" &&
        c.resume !== "off" &&
        followOf(c) !== "none",
    );
    for (const card of cards) {
      const kind = effectiveKind(card.kind, card.type as CardType);
      if (card.closed_at && (card.mine || kind === "todo")) continue;
      // 不提醒 (resume off) stops everything; a follow-up mode of none
      // leaves only the dates the learner picked.
      if (card.resume === "off") continue;
      const follow = followOf(card);
      const auto = follow !== "none";
      const activity = String(
        this.store.db
          .prepare(
            "SELECT max(created_at) AS at FROM card_versions WHERE card_id=? AND user_id=? AND by='user' AND (kind<>'resume_answer' OR json_extract(data,'$.action')='answer') AND (kind<>'followup' OR COALESCE(json_extract(data,'$.action'),'')<>'thinking')",
          )
          .get(card.id, userId)?.at ?? card.created_at,
      );
      const activityDay = chinaDate(Date.parse(activity));
      const firstDue =
        first?.id === card.id
          ? addDays(chinaDate(Date.parse(card.created_at)), 2)
          : null;
      const delay =
        card.scene === "mood"
          ? 7
          : fresh
            ? 2
            : card.type === "idea"
              ? 3
              : card.type === "question"
                ? 2
                : 7;
      const common = {
        src: "card",
        srcId: String(card.id),
        activity,
        date: String(card.quote_on ?? chinaDate(Date.parse(card.created_at))),
        quote: slice(String(card.quote || card.summary || card.title)),
        by: card.quote ? "user" : "ai",
      };
      const baseDue = firstDue ?? addDays(activityDay, delay);
      const opened = parse<
        {
          key: string;
          text: string;
          quote?: string;
          cat: string;
          done?: boolean;
          by?: string;
        }[]
      >(card.open, []).filter((o) => !o.done);
      const next = parse<{
        if: string;
        then: string;
        on?: string;
        by?: string;
      } | null>(card.next, null);
      const keys: string[] = [];
      // a date or period the learner picked says only when; the
      // card's follow-up says how (回顾 / 做了吗 / 接着聊, else a light look
      // back, on a mood card at the feeling). It takes the place of the
      // automatic item that would ask the same way.
      const remindKind =
        follow === "none"
          ? card.scene === "mood"
            ? "mood"
            : "look"
          : FOLLOW_KIND[follow];
      const byDate = (kind: string) =>
        Boolean(card.remind_on) && remindKind === kind;
      // A date the learner picked on the card itself.
      if (card.remind_on) {
        const key = `remind:${String(card.remind_on)}`;
        keys.push(key);
        this.upsert(userId, {
          ...common,
          key,
          kind: remindKind,
          due: String(card.remind_on),
        });
      }
      if (card.scene === "mood") {
        if (auto && !byDate("mood")) {
          keys.push("type");
          this.upsert(userId, {
            ...common,
            key: "type",
            kind: "mood",
            due: addDays(activityDay, 7),
          });
        }
      } else if (!auto) {
        // Only a day the learner set on the next step.
        if (next?.on && next.by === "user") {
          keys.push("next");
          this.upsert(userId, {
            ...common,
            key: "next",
            kind: "promise",
            quote: slice(`如果${next.if}，就${next.then}`),
            by: "user",
            due: next.on,
          });
        }
      } else {
        for (const item of opened) {
          keys.push(item.key);
          const valid =
            item.quote && isQuote(item.quote, [String(card.quote ?? "")]);
          this.upsert(userId, {
            ...common,
            key: item.key,
            kind: "open",
            quote: slice(valid ? item.quote! : item.text),
            by: valid ? "user" : (item.by ?? "ai"),
            due: baseDue,
          });
        }
        if (next) {
          keys.push("next");
          this.upsert(userId, {
            ...common,
            key: "next",
            kind: next.on ? "promise" : "next",
            quote: slice(`如果${next.if}，就${next.then}`),
            by: next.by ?? "ai",
            due: next.on ?? (fresh ? baseDue : addDays(activityDay, 7)),
          });
        }
        // A picked date that asks this card's way stands in for these.
        const asked = byDate(FOLLOW_KIND[follow as "review" | "done" | "chat"]);
        if (!opened.length && !next && !asked && follow === "review") {
          // Spaced: the next 还记得吗 comes further out after each 记住了.
          const recalled = this.store.db
            .prepare(
              "SELECT count(*) AS n,max(created_at) AS at FROM card_versions WHERE card_id=? AND user_id=? AND kind='resume_answer' AND json_extract(data,'$.act')='remember'",
            )
            .get(card.id, userId) as { n: number; at: string | null };
          const step = Number(recalled.n);
          if (step < RECALL_DAYS.length) {
            const key = `recall:${step}`;
            keys.push(key);
            this.upsert(userId, {
              ...common,
              key,
              kind: FOLLOW_KIND.review,
              due: recalled.at
                ? addDays(chinaDate(Date.parse(recalled.at)), RECALL_DAYS[step]!)
                : (firstDue ?? addDays(activityDay, RECALL_DAYS[0]!)),
            });
          }
        } else if (!opened.length && !next && !asked) {
          keys.push("type");
          this.upsert(userId, {
            ...common,
            key: "type",
            kind: FOLLOW_KIND[follow as "done" | "chat"],
            due:
              firstDue ??
              addDays(activityDay, fresh || follow === "done" ? 2 : 3),
          });
        }
      }
      const rows = this.store.db
        .prepare(
          "SELECT id,item_key,state FROM resume_items WHERE user_id=? AND src='card' AND src_id=? AND kind<>'lookback'",
        )
        .all(userId, card.id);
      for (const row of rows)
        if (
          !keys.includes(String(row.item_key)) &&
          ["waiting", "shown", "snoozed", "dormant"].includes(String(row.state))
        )
          this.store.db
            .prepare(
              "UPDATE resume_items SET state='done',updated_at=? WHERE id=?",
            )
            .run(this.now(), String(row.id));
      if (activityDay <= addDays(this.day(), -30))
        this.store.db
          .prepare(
            "UPDATE resume_items SET state='dormant',updated_at=? WHERE user_id=? AND src='card' AND src_id=? AND state IN ('waiting','snoozed') AND remind_at IS NULL",
          )
          .run(this.now(), userId, card.id);
    }
    this.store.db
      .prepare(
        "DELETE FROM resume_items WHERE user_id=? AND src='card' AND src_id NOT IN (SELECT id FROM cards WHERE user_id=? AND merged_into IS NULL)",
      )
      .run(userId, userId);
    this.syncLearning(userId);
    this.syncTasks(userId);
  }
  private batchCards(userId: string, srcId: string, key: string) {
    const settings = this.settings(userId);
    const cards = this.userCards(userId).filter(
      (card) =>
        card.resume === "on" &&
        (card.scene !== "mood" ||
          (settings.types.mood && this.store.getUser(userId)?.moodConsentAt)),
    );
    if (key === "import") {
      if (
        !this.store.db
          .prepare(
            "SELECT 1 FROM imports WHERE id=? AND user_id=? AND status='saved'",
          )
          .get(srcId, userId)
      )
        return [];
      return cards.filter(
        (card) => card.origin === "import" && card.src_id === srcId,
      );
    }
    const chapter = CALC_MAP.chapters.find((c) => c.id === srcId);
    if (
      !chapter ||
      this.store.db
        .prepare("SELECT 1 FROM map_chapters WHERE user_id=? AND chapter_id=?")
        .get(userId, srcId)
    )
      return [];
    const points = new Set(chapter.points.map((p) => p.id));
    return cards.filter(
      (card) =>
        points.has(String(card.point_id)) &&
        !(
          card.closed_at &&
          (card.mine ||
            effectiveKind(card.kind, card.type as CardType) === "todo")
        ),
    );
  }
  private task(item: Item) {
    if (item.src === "import")
      return this.store.db
        .prepare("SELECT * FROM imports WHERE id=? AND user_id=?")
        .get(item.src_id, item.user_id);
    if (item.src === "brainstorm")
      return this.store.db
        .prepare("SELECT * FROM brainstorms WHERE id=? AND user_id=?")
        .get(item.src_id, item.user_id);
    return null;
  }
  private moodItem(item: Item) {
    if (
      this.cardFor(item)?.scene === "mood" ||
      this.task(item)?.scene === "mood"
    )
      return true;
    return (
      item.src === "batch" &&
      this.batchCards(item.user_id, item.src_id, item.item_key).some(
        (c) => c.scene === "mood",
      )
    );
  }
  private enabled(item: Item) {
    const settings = this.settings(item.user_id);
    if (this.moodItem(item)) return settings.types.mood;
    return ["point", "mistake"].includes(item.src)
      ? settings.types.study
      : settings.types.cards;
  }
  private syncTasks(userId: string) {
    for (const row of this.store.db
      .prepare(
        "SELECT id,updated_at FROM imports WHERE user_id=? AND status='picking'",
      )
      .all(userId))
      this.upsert(userId, {
        src: "import",
        srcId: String(row.id),
        key: "ready",
        kind: "import",
        date: chinaDate(Date.parse(String(row.updated_at))),
        due: chinaDate(Date.parse(String(row.updated_at))),
      });
    for (const row of this.store.db
      .prepare(
        "SELECT id,updated_at FROM brainstorms WHERE user_id=? AND status IN ('ready','paused') AND result IS NOT NULL",
      )
      .all(userId))
      this.upsert(userId, {
        src: "brainstorm",
        srcId: String(row.id),
        key: "ready",
        kind: "brainstorm",
        date: chinaDate(Date.parse(String(row.updated_at))),
        due: chinaDate(Date.parse(String(row.updated_at))),
      });
    const batches = [
      ...CALC_MAP.chapters.map((c) => ({ id: c.id, key: "chapter" })),
      ...this.store.db
        .prepare("SELECT id FROM imports WHERE user_id=? AND status='saved'")
        .all(userId)
        .map((row) => ({ id: String(row.id), key: "import" })),
    ];
    for (const batch of batches) {
      if (this.batchCards(userId, batch.id, batch.key).length < 3) continue;
      this.upsert(userId, {
        src: "batch",
        srcId: batch.id,
        key: batch.key,
        kind: "batch",
        due: this.day(),
      });
      this.store.db
        .prepare(
          "UPDATE resume_items SET state='waiting',due_on=?,updated_at=? WHERE user_id=? AND src='batch' AND src_id=? AND item_key=? AND state='done' AND shown_on<=?",
        )
        .run(
          this.day(),
          this.now(),
          userId,
          batch.id,
          batch.key,
          addDays(this.day(), -14),
        );
    }
    for (const item of this.store.db
      .prepare(
        "SELECT * FROM resume_items WHERE user_id=? AND src IN ('import','brainstorm') AND state IN ('waiting','shown','snoozed','dormant')",
      )
      .all(userId) as Item[])
      if (!this.available(item))
        this.store.db
          .prepare(
            "UPDATE resume_items SET state='done',updated_at=? WHERE id=? AND user_id=?",
          )
          .run(this.now(), item.id, userId);
  }
  private point(id: string) {
    for (const chapter of CALC_MAP.chapters) {
      const point = chapter.points.find((p) => p.id === id);
      if (point) return { point, chapter };
    }
    return null;
  }
  private syncLearning(userId: string) {
    const hidden = new Set(
      this.store.db
        .prepare("SELECT chapter_id FROM map_chapters WHERE user_id=?")
        .all(userId)
        .map((r) => String(r.chapter_id)),
    );
    for (const raw of this.store.db
      .prepare("SELECT * FROM retests WHERE user_id=? AND done_at IS NULL")
      .all(userId)) {
      const row = raw as unknown as RetestRow,
        found = this.point(row.point_id);
      if (!found || hidden.has(found.chapter.id)) continue;
      this.upsert(userId, {
        src: "point",
        srcId: row.point_id,
        key: `retest:${row.id}`,
        kind: "retest",
        due: row.due_on,
        date: chinaDate(Date.parse(row.created_at)),
      });
    }
    for (const row of this.store.db
      .prepare(
        "SELECT * FROM map_points WHERE user_id=? AND correct_at IS NOT NULL AND due_on IS NOT NULL",
      )
      .all(userId)) {
      const found = this.point(String(row.point_id));
      if (!found || hidden.has(found.chapter.id)) continue;
      this.upsert(userId, {
        src: "point",
        srcId: String(row.point_id),
        key: `review:${row.due_on}`,
        kind: "review",
        due: String(row.due_on),
      });
    }
    for (const row of this.store.db
      .prepare(
        "SELECT m.*,a.title FROM mistakes m JOIN materials a ON a.id=m.material_id AND a.user_id=m.user_id WHERE m.user_id=? AND m.status='open'",
      )
      .all(userId))
      this.upsert(userId, {
        src: "mistake",
        srcId: String(row.id),
        key: `mistake:${row.due_on}`,
        kind: "mistake",
        due: String(row.due_on),
      });
    const rows = this.store.db
      .prepare(
        "SELECT * FROM resume_items WHERE user_id=? AND src IN ('point','mistake') AND state IN ('waiting','shown','snoozed','dormant')",
      )
      .all(userId) as Item[];
    for (const item of rows)
      if (!this.available(item))
        this.store.db
          .prepare(
            "UPDATE resume_items SET state='done',updated_at=? WHERE id=? AND user_id=?",
          )
          .run(this.now(), item.id, userId);
  }
  private cardFor(item: Item): ReturnType<CardService["detail"]> | null {
    if (item.src !== "card") return null;
    try {
      return this.cards.detail(item.user_id, item.src_id);
    } catch {
      return null;
    }
  }
  private available(item: Item) {
    if (item.src === "batch")
      return (
        this.batchCards(item.user_id, item.src_id, item.item_key).length >= 3
      );
    if (item.src === "import") return this.task(item)?.status === "picking";
    if (item.src === "brainstorm") {
      const task = this.task(item);
      return Boolean(
        task &&
          ["ready", "paused"].includes(String(task.status)) &&
          task.result &&
          (task.scene !== "mood" ||
            this.store.getUser(item.user_id)?.moodConsentAt),
      );
    }
    if (item.src === "point") {
      const found = this.point(item.src_id);
      if (
        !found ||
        this.store.db
          .prepare(
            "SELECT 1 FROM map_chapters WHERE user_id=? AND chapter_id=?",
          )
          .get(item.user_id, found.chapter.id)
      )
        return false;
      if (item.kind === "retest")
        return Boolean(
          this.store.db
            .prepare(
              "SELECT 1 FROM retests WHERE user_id=? AND point_id=? AND id=? AND done_at IS NULL",
            )
            .get(
              item.user_id,
              item.src_id,
              Number(item.item_key.split(":")[1]),
            ),
        );
      const row = this.store.db
        .prepare(
          "SELECT due_on FROM map_points WHERE user_id=? AND point_id=? AND correct_at IS NOT NULL",
        )
        .get(item.user_id, item.src_id);
      return Boolean(row?.due_on && item.item_key === `review:${row.due_on}`);
    }
    if (item.src === "mistake")
      return Boolean(
        this.store.db
          .prepare(
            "SELECT 1 FROM mistakes WHERE id=? AND user_id=? AND status='open' AND ?='mistake:'||due_on",
          )
          .get(item.src_id, item.user_id, item.item_key),
      );
    if (item.src !== "card") return false;
    const card = this.cardFor(item);
    return Boolean(
      card &&
        !card.crisis &&
        card.stage !== "closed" &&
        card.resume !== "off" &&
        (card.resume !== "manual" ||
          item.remind_at ||
          item.kind === "promise" ||
          item.item_key.startsWith("remind:")),
    );
  }
  get(userId: string, id: string) {
    const item = this.own(userId, id),
      card = this.cardFor(item);
    if (!card || card.crisis)
      throw new AppError(409, "RESUME_CHANGED", "这条刚变过，下拉刷新一下");
    return { ...this.view(item), card };
  }
  view(item: Item) {
    const card = this.cardFor(item);
    const open = (
      card?.open as { key: string; cat: string }[] | undefined
    )?.find((o) => o.key === item.item_key);
    const kind = item.kind === "open" ? (open?.cat ?? "verify") : item.kind;
    const learning =
      item.src === "point" ||
      item.src === "mistake" ||
      Boolean(
        card?.scene === "study" &&
          card.pointId &&
          ["question", "method"].includes(card.type),
      );
    // a reminder never closes a 知识点 or 思路 (做了 is not
    // remembering).
    const canClose = Boolean(
      card &&
        card.scene !== "mood" &&
        !learning &&
        !(
          item.item_key.startsWith("remind:") &&
          ["knowledge", "method"].includes(card.kind)
        ),
    );
    const task = this.task(item);
    // a follow-up mode asks tidy's question for this card when it was
    // written for the same mode, else the mode's own words.
    const mode =
      !learning && ["recall", "todo", "chat", "look"].includes(item.kind)
        ? item.kind
        : null;
    const ask =
      mode &&
      card?.followAsk &&
      card.followAsk.follow !== "none" &&
      FOLLOW_KIND[card.followAsk.follow] === mode
        ? card.followAsk
        : null;
    const options = ask
      ? [ask.yes, ask.no, "不用提醒"]
      : learning && !card
        ? ["做一题", "先放着"]
        : optionsFor(kind, canClose, learning);
    return {
      id: item.id,
      src: item.src,
      srcId: item.src_id,
      kind: item.kind,
      state: item.state,
      dueOn: item.due_on,
      remindAt: item.remind_at,
      quote: item.quote,
      quoteOn: item.quote_on,
      quoteBy: item.quote_by,
      card,
      title:
        card?.title ||
        (item.src === "point"
          ? this.point(item.src_id)?.point.name
          : item.src === "mistake"
            ? "错题再试一次"
            : item.quote) ||
        (item.src === "import"
          ? String(task?.file_name || "这次导入")
          : item.src === "brainstorm"
            ? "这次头脑风暴"
            : item.src === "batch"
              ? "这几张卡"
              : "这件事"),
      url:
        item.src === "mistake"
          ? `/pages/mistakes/index`
          : item.src === "point"
            ? `/pages/point/index?id=${encodeURIComponent(item.src_id)}&mode=${item.kind === "review" ? "review" : "retest"}`
            : item.src === "import"
              ? `/pages/import/split/index?id=${encodeURIComponent(item.src_id)}`
              : item.src === "brainstorm"
                ? `/pages/brainstorm/process/index?id=${encodeURIComponent(item.src_id)}`
                : item.src === "batch"
                  ? `/pages/brainstorm/pick/index?batch=${item.item_key}&sourceId=${encodeURIComponent(item.src_id)}`
                  : null,
      question:
        ask?.q ??
        questionFor(
          kind,
          Number(item.id.slice(-3).replace(/[^0-9]/g, "")) || 0,
          learning,
        ),
      options,
      // what each option does (remember / forgot / close / later /
      // chat / never / write / practice / open / answer).
      acts: mode ? FOLLOW_ACTS[mode]! : options.map(actFor),
      canClose,
      learning,
    };
  }
  private count(
    userId: string,
    name: string,
    since: string,
    where = "",
    params: string[] = [],
  ) {
    return Number(
      this.store.db
        .prepare(
          `SELECT count(*) AS n FROM events WHERE user_id=? AND name=? AND created_at>=? ${where}`,
        )
        .get(userId, name, since, ...params)!.n,
    );
  }
  open(userId: string, visitId: string) {
    return this.store.transaction(() => {
      if (this.settings(userId).mode === "off")
        return { kind: "none", item: null };
      const old = this.store.db
        .prepare(
          "SELECT data,created_at FROM events WHERE user_id=? AND name='resume_visit' AND json_extract(data,'$.visitId')=? ORDER BY id DESC LIMIT 1",
        )
        .get(userId, visitId);
      const timeLocal = new Date(this.clock().getTime() + 8 * 3600_000);
      const asked = this.settings(userId);
      // 到点再问: a visit that opened before the time is asked again once the
      // time has come instead of keeping its "21:00 再问你".
      const timeCame =
        asked.mode === "time" &&
        timeLocal.toISOString().slice(11, 16) >= asked.at &&
        asked.days.includes(timeLocal.getUTCDay());
      if (old && !(parse<Row>(old.data, {}).kind === "time" && timeCame)) {
        const saved = parse<Row>(old.data, {});
        if (saved.ref) {
          const settings = this.settings(userId);
          const reflection =
            saved.kind === "lookback"
              ? lookbacks(this.store, userId, settings.types).find(
                  (r) => r.key === saved.ref,
                )
              : settings.greet
                ? greeting(
                    this.store,
                    userId,
                    String(old.created_at),
                    settings.types.cards,
                    saved.ref,
                  )
                : null;
          return reflection
            ? {
                kind: saved.kind,
                item: null,
                text: reflection.text,
                url: reflection.url,
              }
            : { kind: "none", item: null };
        }
        if (saved.itemId) {
          try {
            const item = this.own(userId, saved.itemId);
            return {
              kind: "item",
              item:
                this.available(item) && this.enabled(item)
                  ? this.view(item)
                  : null,
            };
          } catch {
            return { kind: "none", item: null };
          }
        }
        return {
          kind: saved.kind,
          item: null,
          text:
            saved.kind === "time"
              ? `${this.settings(userId).at} 再问你`
              : undefined,
          ...(saved.kind === "none" ? this.unfinished(userId) : {}),
        };
      }
      const settings = this.settings(userId),
        today = this.day(),
        now = this.now();
      const local = new Date(this.clock().getTime() + 8 * 3600_000);
      const before =
        local.toISOString().slice(11, 16) < settings.at ||
        !settings.days.includes(local.getUTCDay());
      const finish = (
        kind: string,
        item?: Item,
        text?: string,
        reflection?: Reflection,
      ) => {
        this.event(userId, "resume_visit", {
          visitId,
          kind,
          itemId: item?.id ?? null,
          ...(reflection ? { ref: reflection.key } : {}),
        });
        return {
          kind,
          item: item ? this.view(item) : null,
          ...(text ? { text } : {}),
          ...(reflection ? { text: reflection.text, url: reflection.url } : {}),
          ...(kind === "none" ? this.unfinished(userId) : {}),
        };
      };
      if (settings.mode === "off") return finish("none");
      if (settings.mode === "time" && before)
        return finish("time", undefined, `${settings.at} 再问你`);
      // A new visit settles the previous unanswered display once; repeated
      // delivery of one visit never increments the only skip counter.
      const unanswered = this.store.db
        .prepare("SELECT * FROM resume_items WHERE user_id=? AND state='shown'")
        .all(userId) as Item[];
      for (const item of unanswered) this.defer(item);
      this.sync(userId);
      const dayStart = chinaDayStart(this.clock().getTime());
      const full = this.count(userId, "resume_show", dayStart) >= 3;
      if (this.count(userId, "resume_return", dayStart)) return finish("none");
      const lastVisit = this.store.db
        .prepare(
          "SELECT created_at FROM events WHERE user_id=? AND name='resume_visit' ORDER BY id DESC LIMIT 1",
        )
        .get(userId);
      const returning =
        lastVisit &&
        Date.parse(now) - Date.parse(String(lastVisit.created_at)) >=
          14 * 86400_000;
      const week = addDays(today, -((local.getUTCDay() + 6) % 7));
      const weekStart = `${week}T00:00:00+08:00`;
      const moodSeen =
        this.count(
          userId,
          "resume_show",
          new Date(weekStart).toISOString(),
          "AND json_extract(data,'$.mood')=1",
        ) > 0;
      const candidates = (
        this.store.db
          .prepare(
            "SELECT * FROM resume_items WHERE user_id=? AND state IN ('waiting','snoozed') AND due_on<=? AND (remind_at IS NULL OR remind_at<=?) AND (shown_on IS NULL OR shown_on<>?)",
          )
          .all(userId, today, now, today) as Item[]
      ).filter((item) => {
        if (!this.available(item)) return false;
        const card = this.cardFor(item);
        if (this.moodItem(item)) {
          if (!settings.types.mood || moodSeen) return false;
          if (
            card &&
            this.count(
              userId,
              "resume_show",
              new Date(this.clock().getTime() - 14 * 86400_000).toISOString(),
              "AND json_extract(data,'$.srcId')=?",
              [card.id],
            )
          )
            return false;
        } else if (card && !settings.types.cards) return false;
        if (
          ["import", "brainstorm", "batch"].includes(item.src) &&
          !this.moodItem(item) &&
          !settings.types.cards
        )
          return false;
        if (
          item.src === "batch" &&
          item.shown_on &&
          item.shown_on > addDays(today, -14)
        )
          return false;
        if (
          !card &&
          ["point", "mistake"].includes(item.src) &&
          !settings.types.study
        )
          return false;
        return !this.count(
          userId,
          "resume_show",
          dayStart,
          "AND json_extract(data,'$.src')=? AND json_extract(data,'$.srcId')=?",
          [item.src, item.src_id],
        );
      });
      const priority = (item: Item) => {
        const card = this.cardFor(item);
        if (this.moodItem(item)) return 20;
        if (
          item.remind_at ||
          item.kind === "promise" ||
          (item.src === "card" && item.item_key.startsWith("remind:"))
        )
          return 0;
        if (item.kind === "open")
          return (card?.open as { key: string; cat: string }[])?.find(
            (o) => o.key === item.item_key,
          )?.cat === "decide"
            ? 1
            : 5;
        return (
          (
            {
              next: 2,
              todo: 2,
              question: 3,
              idea: 4,
              chat: 4,
              recall: 9,
              brainstorm: 6,
              import: 6,
              batch: 7,
              spark: 8,
              method: 9,
              retest: 10,
              mistake: 11,
              review: 12,
            } as Record<string, number>
          )[item.kind] ?? 15
        );
      };
      candidates.sort(
        (a, b) =>
          priority(a) - priority(b) ||
          a.due_on.localeCompare(b.due_on) ||
          a.created_at.localeCompare(b.created_at) ||
          a.id.localeCompare(b.id),
      );
      const chosen = full ? undefined : candidates[0];
      if (chosen) {
        this.store.db
          .prepare(
            "UPDATE resume_items SET state='shown',shown_on=?,updated_at=? WHERE id=? AND user_id=?",
          )
          .run(today, now, chosen.id, userId);
        this.event(userId, "resume_show", {
          src: chosen.src,
          srcId: chosen.src_id,
          kind: chosen.kind,
          mood: this.moodItem(chosen) ? 1 : 0,
          pointId:
            this.cardFor(chosen)?.pointId ||
            (chosen.src === "point" ? chosen.src_id : null),
        });
        if (returning) this.event(userId, "resume_return", { day: today });
        return finish("item", this.own(userId, chosen.id));
      }
      if (this.count(userId, "resume_lookback", dayStart) < 2) {
        const reflection = lookbacks(this.store, userId, settings.types).find(
          (r) =>
            !this.store.db
              .prepare(
                "SELECT 1 FROM events WHERE user_id=? AND name='resume_lookback' AND json_extract(data,'$.ref')=?",
              )
              .get(userId, r.key),
        );
        if (reflection) {
          this.event(userId, "resume_lookback", { ref: reflection.key });
          if (returning) this.event(userId, "resume_return", { day: today });
          return finish("lookback", undefined, undefined, reflection);
        }
      }
      if (settings.greet && !this.count(userId, "resume_visit", dayStart)) {
        const reflection = greeting(
          this.store,
          userId,
          now,
          settings.types.cards,
        )!;
        if (returning) this.event(userId, "resume_return", { day: today });
        return finish("greet", undefined, undefined, reflection);
      }
      return finish("none");
    });
  }
  // The latest chat worth picking up again: recent, not mood, never crisis.
  lastChat(userId: string) {
    const since = new Date(
      this.clock().getTime() - 14 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const row = this.store.db
      .prepare(
        `SELECT t.id,t.title,t.updated_at,
          (SELECT content FROM messages m WHERE m.thread_id=t.id AND m.role='user' ORDER BY m.created_at,m.rowid LIMIT 1) AS first,
          (SELECT content FROM messages m WHERE m.thread_id=t.id AND m.role='user' ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) AS last
        FROM threads t
        WHERE t.user_id=? AND t.scene<>'mood' AND t.updated_at>=?
          AND json_extract(t.data,'$.homeworkOf') IS NULL
          AND EXISTS(SELECT 1 FROM messages m WHERE m.thread_id=t.id AND m.role='user')
          AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.thread_id=t.id AND json_extract(m.data,'$.crisis') IS NOT NULL AND json_extract(m.data,'$.crisis')<>0)
        ORDER BY t.updated_at DESC,t.rowid DESC LIMIT 1`,
      )
      .get(userId, since) as
      | { id: string; title: string; updated_at: string; first: string; last: string }
      | undefined;
    if (!row) return null;
    const cut = (value: string, n: number) => {
      const chars = Array.from(value.replace(/\s+/g, " ").trim());
      return chars.length > n ? `${chars.slice(0, n).join("")}…` : chars.join("");
    };
    return {
      threadId: row.id,
      // Card and brainstorm chats keep the placeholder title; say what was asked.
      title: cut(
        row.title && row.title !== "新的对话" ? row.title : row.first,
        16,
      ),
      quote: cut(row.last, 30),
      at: row.updated_at,
    };
  }
  // A first visit: no chat yet and no cards.
  isFirst(userId: string) {
    const used = this.store.db
      .prepare(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE user_id=? AND role='user') OR EXISTS(SELECT 1 FROM cards WHERE user_id=?) AS used",
      )
      .get(userId, userId) as { used: number };
    return used.used === 0;
  }
  private unfinished(userId: string) {
    const waiting = (
      this.store.db
        .prepare(
          "SELECT * FROM resume_items WHERE user_id=? AND state IN ('waiting','shown','snoozed','dormant')",
        )
        .all(userId) as Item[]
    ).some((item) => this.available(item));
    return waiting
      ? { text: "回顾和提醒 ›", url: "/pages/resume-list/index" }
      : {};
  }
  private defer(item: Item) {
    const count = item.no_resp + 1;
    this.store.db
      .prepare(
        "UPDATE resume_items SET no_resp=?,state=?,due_on=?,updated_at=? WHERE id=? AND user_id=?",
      )
      .run(
        count,
        count >= 2 ? "dormant" : "snoozed",
        addDays(this.day(), 3),
        this.now(),
        item.id,
        item.user_id,
      );
  }
  list(userId: string, state = "waiting") {
    this.sync(userId);
    return (
      this.store.db
        .prepare(
          "SELECT * FROM resume_items WHERE user_id=? ORDER BY due_on,id",
        )
        .all(userId) as Item[]
    )
      .filter((i) =>
        state === "never"
          ? i.state === "never" || this.cardFor(i)?.resume === "off"
          : ["waiting", "snoozed", "dormant", "shown"].includes(i.state) &&
            this.available(i),
      )
      .map((i) => this.view(i));
  }
  async act(
    userId: string,
    id: string,
    input: {
      action: "answer" | "skip" | "never" | "remind" | "restore";
      text?: string;
      remindAt?: string;
    },
  ) {
    const item = this.own(userId, id),
      card = this.cardFor(item);
    if (input.action !== "restore" && !this.available(item))
      throw new AppError(409, "RESUME_CHANGED", "这条刚变过，下拉刷新一下");
    const text = input.text?.trim() ?? "";
    if (input.action === "answer" && (!text || text.length > 300))
      throw new AppError(400, "VALIDATION_ERROR", "写一句再存，300 字以内");
    if (
      text &&
      (await this.safety.check(text, {
        scene: card?.scene ?? "study",
        source: "card",
      }))
    ) {
      if (card)
        this.store.db
          .prepare(
            "UPDATE cards SET crisis=1,resume='off',version=version+1 WHERE id=? AND user_id=?",
          )
          .run(card.id, userId);
      return { crisis: true, item: null };
    }
    const unchanged = this.own(userId, id);
    if (
      unchanged.updated_at !== item.updated_at ||
      (card && this.cards.detail(userId, card.id).version !== card.version)
    )
      throw new AppError(409, "RESUME_CHANGED", "这条刚变过，下拉刷新一下");
    // an answer does what its option means (old clients send the
    // option's words). 还没 / 先放着 / 还在想 are answers too: they snooze
    // without counting as ignored, unlike a display left unanswered.
    const shown = this.view(item);
    const picked =
      input.action === "answer"
        ? shown.acts[shown.options.indexOf(text)]
        : undefined;
    const action =
      picked === "never"
        ? "never"
        : input.action === "answer" &&
            (picked === "later" || NO_RESPONSE.has(text))
          ? "skip"
          : input.action;
    const kind = card ? card.kind : null;
    if (
      action === "answer" &&
      !["shown", "waiting", "snoozed", "dormant"].includes(item.state)
    )
      return { crisis: false, item: this.view(item), reused: true };
    const now = this.now();
    const token = uid();
    const oldCard = card
      ? (this.store.db
          .prepare("SELECT * FROM cards WHERE id=? AND user_id=?")
          .get(card.id, userId) as Row)
      : null;
    // 提醒频率  of the card, if its reminder repeats.
    const oldEvery = card ? (card.remindEvery ?? null) : null;
    const repeat = Boolean(oldEvery && item.item_key.startsWith("remind:"));
    const historyIds: number[] = [];
    const retests = new RetestService(this.store, this.clock);
    const oldRetest =
      item.src === "point" && action === "never"
        ? retests.current(userId, item.src_id)
        : null;
    let restoredRetest: number | null = null;
    let closed = false;
    this.store.transaction(() => {
      if (action === "skip" && repeat)
        this.store.db
          .prepare(
            "UPDATE resume_items SET state='done',no_resp=0,updated_at=? WHERE id=? AND user_id=?",
          )
          .run(now, id, userId);
      else if (action === "skip" && input.action === "skip") this.defer(item);
      else if (action === "skip")
        this.store.db
          .prepare(
            "UPDATE resume_items SET state='snoozed',due_on=?,updated_at=? WHERE id=? AND user_id=?",
          )
          .run(
            addDays(this.day(), item.kind === "todo" ? 2 : 3),
            now,
            id,
            userId,
          );
      else if (action === "answer" && picked === "forgot")
        // 有点忘: the card opens now; the same step asks again tomorrow.
        this.store.db
          .prepare(
            "UPDATE resume_items SET state='snoozed',due_on=?,updated_at=? WHERE id=? AND user_id=?",
          )
          .run(addDays(this.day(), 1), now, id, userId);
      else if (action === "never") {
        if (oldRetest)
          retests.finishInTransaction(userId, oldRetest, "dropped");
        if (card)
          this.store.db
            .prepare(
              "UPDATE cards SET resume='off',version=version+1 WHERE id=? AND user_id=?",
            )
            .run(card.id, userId);
        else
          this.store.db
            .prepare(
              "UPDATE resume_items SET state='never',updated_at=? WHERE id=? AND user_id=?",
            )
            .run(now, id, userId);
      } else if (action === "remind") {
        if (
          !input.remindAt ||
          !Number.isFinite(Date.parse(input.remindAt)) ||
          Date.parse(input.remindAt) <= this.clock().getTime()
        )
          throw new AppError(400, "VALIDATION_ERROR", "挑一个还没到的时间");
        const remind = new Date(input.remindAt).toISOString();
        this.store.db
          .prepare(
            "UPDATE resume_items SET state='waiting',remind_at=?,due_on=?,updated_at=? WHERE id=? AND user_id=?",
          )
          .run(remind, chinaDate(Date.parse(remind)), now, id, userId);
      } else if (action === "restore") {
        if (card)
          this.store.db
            .prepare(
              "UPDATE cards SET resume='on',version=version+1 WHERE id=? AND user_id=?",
            )
            .run(card.id, userId);
        this.store.db
          .prepare(
            "UPDATE resume_items SET state='waiting',no_resp=0,due_on=?,updated_at=? WHERE id=? AND user_id=?",
          )
          .run(this.day(), now, id, userId);
        if (
          item.src === "point" &&
          item.kind === "retest" &&
          item.state === "never"
        ) {
          const previous = this.store.db
            .prepare(
              "SELECT * FROM retests WHERE id=? AND user_id=? AND result='dropped'",
            )
            .get(Number(item.item_key.split(":")[1]), userId) as
            | RetestRow
            | undefined;
          if (previous && !retests.current(userId, item.src_id)) {
            const fresh = retests.scheduleInTransaction(
              userId,
              item.src_id,
              previous.cause,
              previous.problem_index,
            );
            restoredRetest = fresh?.id ?? null;
          }
          this.store.db
            .prepare(
              "UPDATE resume_items SET state='done' WHERE id=? AND user_id=?",
            )
            .run(id, userId);
        }
      } else {
        this.store.db
          .prepare(
            "UPDATE resume_items SET state='done',no_resp=0,updated_at=? WHERE id=? AND user_id=?",
          )
          .run(now, id, userId);
        if (card) {
          // A 待办 is done on 做了; the other kinds also need the user's words.
          const canClose =
            shown.canClose &&
            (picked === "close" || CLOSE.has(text)) &&
            (card.mine || kind === "todo");
          closed = !!canClose;
          this.store.db
            .prepare(
              "UPDATE cards SET organized_at=COALESCE(organized_at,?),closed_at=CASE WHEN ? THEN ? ELSE closed_at END,version=version+1,updated_at=? WHERE id=? AND user_id=?",
            )
            .run(now, canClose ? 1 : 0, now, now, card.id, userId);
        }
      }
      if (
        card &&
        item.item_key.startsWith("remind:") &&
        (action === "answer" || action === "never")
      ) {
        // 提醒频率 : an answered reminder moves on a day or a week from
        // today; 不再提起 or a closed card ends it. A one-off date is cleared.
        const day = item.item_key.slice("remind:".length);
        if (action === "answer" && picked === "forgot")
          // 有点忘: the same reminder asks again tomorrow.
          this.store.db
            .prepare(
              "UPDATE cards SET remind_on=? WHERE id=? AND user_id=? AND remind_on=?",
            )
            .run(addDays(this.day(), 1), card.id, userId, day);
        else if (repeat && action === "answer" && !closed)
          this.store.db
            .prepare(
              "UPDATE cards SET remind_on=? WHERE id=? AND user_id=? AND remind_on=?",
            )
            .run(
              addDays(this.day(), REMIND_DAYS[oldEvery!]),
              card.id,
              userId,
              day,
            );
        else
          this.store.db
            .prepare(
              "UPDATE cards SET remind_on=NULL WHERE id=? AND user_id=? AND remind_on=?",
            )
            .run(card.id, userId, day);
      }
      if (card && repeat && action === "skip") {
        // 稍后 / 还在进行 on a repeating reminder: this one is over, the next
        // comes on schedule instead of the 3-day snooze.
        this.store.db
          .prepare(
            "UPDATE cards SET remind_on=? WHERE id=? AND user_id=? AND remind_on=?",
          )
          .run(
            addDays(this.day(), REMIND_DAYS[oldEvery!]),
            card.id,
            userId,
            item.item_key.slice("remind:".length),
          );
      }
      if (card && oldEvery && (action === "never" || closed)) {
        this.store.db
          .prepare("DELETE FROM card_reminders WHERE card_id=? AND user_id=?")
          .run(card.id, userId);
        this.store.db
          .prepare("UPDATE cards SET remind_on=NULL WHERE id=? AND user_id=?")
          .run(card.id, userId);
      }
      if (card) {
        historyIds.push(
          Number(
            this.store.db
              .prepare(
                "INSERT INTO card_versions(card_id,user_id,kind,by,data,created_at) VALUES(?,?,'resume_answer','user',?,?)",
              )
              .run(
                card.id,
                userId,
                JSON.stringify({
                  action,
                  text,
                  itemKey: item.item_key,
                  remindAt: input.remindAt ?? null,
                  ...(picked ? { act: picked } : {}),
                }),
                now,
              ).lastInsertRowid,
          ),
        );
        if (closed)
          historyIds.push(
            Number(
              this.store.db
                .prepare(
                  "INSERT INTO card_versions(card_id,user_id,kind,by,data,created_at) VALUES(?,?,'close','user',?,?)",
                )
                .run(
                  card.id,
                  userId,
                  JSON.stringify({ source: "resume", itemId: id }),
                  now,
                ).lastInsertRowid,
            ),
          );
      }
      this.event(userId, "resume_act", {
        src: item.src,
        kind: item.kind,
        action,
      });
    });
    const current = this.own(userId, id),
      updated = card ? this.cards.detail(userId, card.id) : null;
    const local = new Date(this.clock().getTime() + 8 * 3600_000);
    const week = addDays(this.day(), -((local.getUTCDay() + 6) % 7));
    const feedback =
      action === "answer" &&
      !this.count(
        userId,
        "resume_feedback_offer",
        new Date(`${week}T00:00:00+08:00`).toISOString(),
      );
    if (feedback)
      this.event(userId, "resume_feedback_offer", { itemId: id, week });
    for (const [key, saved] of this.undo)
      if (saved.userId === userId && saved.item.id === item.id)
        this.undo.delete(key);
    this.undo.set(token, {
      userId,
      expires: this.clock().getTime() + 5000,
      item,
      card: oldCard,
      version: updated?.version ?? null,
      historyIds,
      marker: current.updated_at,
      retest: oldRetest,
      restoredRetest,
      every: oldEvery,
    });
    for (const [key, undo] of this.undo)
      if (undo.expires < this.clock().getTime()) this.undo.delete(key);
    return {
      crisis: false,
      item: this.view(current),
      undoToken: token,
      undoUntil: new Date(this.clock().getTime() + 5000).toISOString(),
      feedback,
      offerMine:
        action === "answer" &&
        !!card &&
        !CLOSE.has(text) &&
        text.length >= 10 &&
        !card?.mine,
      offerClose:
        action === "answer" &&
        CLOSE.has(text) &&
        !closed &&
        !card?.mine &&
        shown.canClose,
      askWhen:
        action === "answer" &&
        CLOSE.has(text) &&
        shown.canClose &&
        // 做了 on a 待办 needs no "什么时候做".
        !(closed && kind === "todo"),
    };
  }
  feedback(
    userId: string,
    id: string,
    value: "useful" | "ok" | "bother" | "dismiss",
  ) {
    this.own(userId, id);
    const offer = this.store.db
      .prepare(
        "SELECT id FROM events WHERE user_id=? AND name='resume_feedback_offer' AND json_extract(data,'$.itemId')=? ORDER BY id DESC LIMIT 1",
      )
      .get(userId, id);
    if (!offer)
      throw new AppError(409, "RESUME_CHANGED", "这条刚变过，下拉刷新一下");
    if (
      !this.store.db
        .prepare(
          "SELECT 1 FROM events WHERE user_id=? AND name='resume_feedback' AND json_extract(data,'$.offerId')=?",
        )
        .get(userId, Number(offer.id))
    )
      this.event(userId, "resume_feedback", { offerId: offer.id, value });
    return { saved: true };
  }
  async when(
    userId: string,
    id: string,
    when: "week" | "next_week",
    version: number,
  ) {
    const item = this.own(userId, id),
      card = this.cardFor(item);
    if (!card || item.state !== "done" || !this.view(item).canClose)
      throw new AppError(409, "RESUME_CHANGED", "这条刚变过，下拉刷新一下");
    const local = new Date(this.clock().getTime() + 8 * 3600_000);
    const end = addDays(
      this.day(),
      6 - ((local.getUTCDay() + 6) % 7) + (when === "next_week" ? 7 : 0),
    );
    return this.cards.update(userId, card.id, version, {
      next: {
        if: when === "week" ? "这周" : "下周",
        then: card.title,
        on: end,
        by: "user",
      },
    });
  }
  undoAct(userId: string, token: string) {
    const saved = this.undo.get(token);
    if (
      !saved ||
      saved.userId !== userId ||
      saved.expires < this.clock().getTime()
    )
      throw new AppError(409, "UNDO_EXPIRED", "过了能撤销的时间了");
    const current = this.own(userId, saved.item.id);
    const retests = new RetestService(this.store, this.clock);
    if (saved.retest) {
      const dropped = this.store.db
        .prepare("SELECT result,done_at FROM retests WHERE id=? AND user_id=?")
        .get(saved.retest.id, userId);
      if (
        dropped?.result !== "dropped" ||
        dropped.done_at !== saved.marker ||
        retests.current(userId, saved.retest.point_id)
      )
        throw new AppError(
          409,
          "RESUME_CHANGED",
          "这条刚变过，撤销不了了，下拉刷新一下",
        );
    }
    const restored = saved.restoredRetest
      ? retests.current(userId, saved.item.src_id)
      : null;
    if (
      saved.restoredRetest &&
      (!restored ||
        restored.id !== saved.restoredRetest ||
        restored.predicted !== null)
    )
      throw new AppError(
        409,
        "RESUME_CHANGED",
        "这条刚变过，撤销不了了，下拉刷新一下",
      );
    if (
      current.updated_at !== saved.marker ||
      (saved.card &&
        this.cards.detail(userId, String(saved.card.id)).version !==
          saved.version)
    )
      throw new AppError(
        409,
        "RESUME_CHANGED",
        "这条刚变过，撤销不了了，下拉刷新一下",
      );
    if (
      saved.historyIds.length &&
      Number(
        this.store.db
          .prepare(
            "SELECT max(id) AS id FROM card_versions WHERE card_id=? AND user_id=?",
          )
          .get(saved.card!.id, userId)?.id,
      ) !== saved.historyIds.at(-1)
    )
      throw new AppError(
        409,
        "RESUME_CHANGED",
        "这条刚变过，撤销不了了，下拉刷新一下",
      );
    this.store.transaction(() => {
      const old = saved.item;
      if (restored) retests.finishInTransaction(userId, restored, "dropped");
      if (saved.retest)
        this.store.db
          .prepare(
            "UPDATE retests SET result=?,predicted=?,done_at=? WHERE id=? AND user_id=?",
          )
          .run(
            saved.retest.result,
            saved.retest.predicted,
            saved.retest.done_at,
            saved.retest.id,
            userId,
          );
      this.store.db
        .prepare(
          "UPDATE resume_items SET state=?,due_on=?,no_resp=?,remind_at=?,updated_at=? WHERE id=? AND user_id=?",
        )
        .run(
          old.state,
          old.due_on,
          old.no_resp,
          old.remind_at,
          this.now(),
          old.id,
          userId,
        );
      if (saved.card)
        this.store.db
          .prepare(
            "UPDATE cards SET organized_at=?,closed_at=?,resume=?,remind_on=?,version=version+1,updated_at=? WHERE id=? AND user_id=?",
          )
          .run(
            saved.card.organized_at,
            saved.card.closed_at,
            saved.card.resume,
            saved.card.remind_on ?? null,
            this.now(),
            saved.card.id,
            userId,
          );
      if (saved.card && saved.every)
        this.store.db
          .prepare(
            "INSERT INTO card_reminders(card_id,user_id,every,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(card_id) DO UPDATE SET every=excluded.every,updated_at=excluded.updated_at",
          )
          .run(
            String(saved.card.id),
            userId,
            saved.every,
            this.now(),
            this.now(),
          );
      for (const historyId of saved.historyIds)
        this.store.db
          .prepare("DELETE FROM card_versions WHERE id=? AND user_id=?")
          .run(historyId, userId);
      this.event(userId, "resume_act", { action: "undo", kind: old.kind });
    });
    this.undo.delete(token);
    return this.view(this.own(userId, saved.item.id));
  }
}

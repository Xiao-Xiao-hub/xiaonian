/*
 * 头脑风暴：接收用户选择的卡片，保留输入快照，生成分组、差异和结论草稿。
 * routes.ts 接收请求，JobRunner 执行生成任务，结果经 schema.ts 校验后保存；用户确认才转为卡片。
 */
import { createHash, randomUUID } from "node:crypto";
import type { LlmClient } from "../../providers/llm.js";
import { AppError } from "../../shared/domain.js";
import type { SqliteStore } from "../../shared/store.js";
import type { CardService } from "../cards/service.js";
import { SLOT_KEYS } from "../cards/schema.js";
import {
  CARD_KINDS,
  effectiveKind,
  kindType,
  type CardKind,
  type CardScene,
  type CardType,
  type CardView,
} from "../cards/types.js";
import { CALC_MAP } from "../learn/calc-map.js";
import {
  JobError,
  publicJob,
  toJob,
  type Job,
  type JobHandler,
  type JobRunner,
} from "../jobs/runner.js";
import { BANNED_PHRASES } from "../safety/banned-phrases.js";
import { IDENTITY_RULE } from "../../shared/identity.js";
import type { CrisisSafetyService } from "../safety/service.js";
import {
  GROUP_SLOTS,
  REPORT_SECTIONS,
  TENSION_KINDS,
  brainstormOutputSchema,
  brainstormReportSchema,
  type BrainstormOutput,
  type BrainstormReportOutput,
  type StoredReport,
  type BrainstormPicks,
  type BrainstormResult,
} from "./schema.js";

// V4.2 : groups, differences and conclusion drafts carry what they mean
// (slot / kind), so saving puts them where they fit; at most 3 of each list,
// which is what the pages show.
export const BRAINSTORM_SYSTEM = `[BRAINSTORM] 只使用输入卡片，不添加输入里没有的事实、数字或期限；每条都用1开始的卡号标依据。标★是用户自己的话，优先采信。不要说“你应该”。学习场景不讲题、不给答案，只把卡点写成问题。“如果”只写条件。按内容分组，不为凑数分组：小型最多2组，标准型最多4组，大型最多5组。groups.slot写这组共同点在说什么：why理由、when适用条件、steps做法步骤、example例子、pitfall易错或顾虑、known已知事实、stuck卡在哪、cause原因、expand可以展开的方向，都不像就写""。tensions是两张卡说法不同，kind写verify（谁对可以查证）、choose（要自己选一个）或differ（只是角度或条件不同，不用选）。drafts.kind写这句结论最像哪类卡：spark灵感、idea想法、question问题、method思路、todo待办、knowledge知识点、note随手记。tensions、more、ifs、directions、drafts各最多3条。不得使用这些说法：${BANNED_PHRASES.join("、")}。只返回JSON，所有字段必填，无内容的数组用[]，ask可用null；格式：{"title":"不超过16字","groups":[{"name":"不超过8字","common":"不超过30字","cards":[1],"slot":"why"}],"tensions":[{"a":1,"b":2,"note":"不超过30字","kind":"choose"}],"more":[{"type":"question或spark","title":"不超过16字","from":[1]}],"ifs":[{"if":"不超过20字","from":[1]}],"directions":[{"title":"不超过16字","why":"不超过40字","from":[1]}],"drafts":[{"text":"不超过40字","from":[1],"kind":"idea"}],"ask":{"q":"不超过40字","options":["不超过12字"]}}。${IDENTITY_RULE}`;
// V4.2 : gentle, nothing written just to fill a section; at most 3 a section.
export const REPORT_SYSTEM = `[BRAINSTORM_REPORT] 看用户挑的这几张卡和已经整理出的分组，像一起想事情的同伴那样，温和地写几句简短的回顾。先接住用户最在意的事，再给一个可以马上试的小下一步。分四部分：links 卡和卡怎么连在一起，improve 哪里还可以想得更清楚，expand 还能往哪边想，advice 下一步可以试试什么。没有可写的就留空，不为凑数写；每部分最多3条，合起来至少一条。只使用输入里的内容，不添加没有的事实、数字或期限；每条不超过60字，用1开始的卡号在 from 里标依据（最多5个），text 里不写“卡1”“卡2”这样的卡号，要提到某张卡就写它的标题。不要说“你应该”。不得使用这些说法：${BANNED_PHRASES.join("、")}。只返回JSON，四个部分都要有：{"sections":{"links":[{"text":"","from":[1]}],"improve":[],"expand":[],"advice":[]}}。${IDENTITY_RULE}`;
type Row = Record<string, unknown>;
type Snapshot = {
  id: string;
  version: number;
  type: CardType;
  // V4.2 : the card's kind; absent in snapshots taken before.
  kind?: CardKind;
  scene: CardScene;
  title: string;
  titleBy: "user" | "ai";
  text: string;
  mine: boolean;
  pointId: string | null;
  mistakeId: string | null;
  sawAnswer: boolean;
};
type Facts = {
  commonPrereqs: Array<{ id: string; name: string; count: number }>;
  mistakeCauses: Array<{ cause: string; count: number }>;
  sawAnswer: number;
};
type StoredPicks = BrainstormPicks & {
  _saved?: Record<string, string>;
  _saveClientId?: string;
  // V4.2 : the conclusion's kind, kept beside it (see packPicks).
  conclusionKind?: CardKind;
};
// V4.2 : what groups, differences and drafts mean (slot / kind), stored
// beside the lists by id instead of inside their items. Old clients send the
// items back as they got them, and the v4.1 server takes picks only with its
// own keys, so stored items keep the old shape. Responses carry the fields
// on the items again (add-only).
type Meanings = {
  slots?: Record<string, string>;
  tensions?: Record<string, string>;
  drafts?: Record<string, string>;
};
type StoredResult = BrainstormResult & { meanings?: Meanings };
type SaveOutput = { brainstorm: unknown; cards: CardView[] };

const parse = <T>(value: unknown, fallback: T): T => {
  try {
    return value === null || value === undefined
      ? fallback
      : (JSON.parse(String(value)) as T);
  } catch {
    return fallback;
  }
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
// Items without their meaning fields, and the meanings by id.
function strip<T extends { id: string }>(
  items: T[] | undefined,
  key: "slot" | "kind",
  into: Record<string, string>,
) {
  return (items || []).map((item) => {
    const { [key]: value, ...rest } = item as T & Record<string, unknown>;
    if (typeof value === "string" && value) into[item.id] = value;
    return rest as T;
  });
}
function lay<T extends { id: string }>(
  items: T[] | undefined,
  key: "slot" | "kind",
  from: Record<string, string> | undefined,
): T[] | undefined {
  return items?.map((item) =>
    from?.[item.id] ? { ...item, [key]: from[item.id] } : item,
  );
}
function packResult(result: BrainstormResult): StoredResult {
  const slots = {},
    tensions = {},
    drafts = {};
  const out = {
    ...result,
    groups: strip(result.groups, "slot", slots),
    tensions: strip(result.tensions, "kind", tensions),
    drafts: strip(result.drafts, "kind", drafts),
  };
  const meanings = Object.fromEntries(
    Object.entries({ slots, tensions, drafts }).filter(
      ([, map]) => Object.keys(map).length,
    ),
  );
  return Object.keys(meanings).length ? { ...out, meanings } : out;
}
function readResult(value: unknown): BrainstormResult | null {
  const stored = parse<StoredResult | null>(value, null);
  if (!stored) return null;
  const { meanings, ...result } = stored;
  return {
    ...result,
    groups: lay(result.groups, "slot", meanings?.slots) ?? [],
    tensions: lay(result.tensions, "kind", meanings?.tensions) ?? [],
    drafts: lay(result.drafts, "kind", meanings?.drafts) ?? [],
  } as BrainstormResult;
}
function packPicks(picks: StoredPicks): StoredPicks {
  const ignore = {};
  const out: StoredPicks = { ...picks };
  if (picks.groups) out.groups = strip(picks.groups, "slot", ignore);
  if (picks.tensions) out.tensions = strip(picks.tensions, "kind", ignore);
  if (picks.drafts) out.drafts = strip(picks.drafts, "kind", ignore);
  delete out.conclusionKind;
  if (picks.conclusion) {
    const { kind, ...conclusion } = picks.conclusion;
    out.conclusion = conclusion;
    if (kind) out.conclusionKind = kind;
  }
  return out;
}
// Picks with the result's meanings laid on by id. The conclusion's kind only
// counts while its type still matches (a v4.1 server may have kept an old
// one beside a conclusion an old client changed).
function readPicks(value: unknown, result: BrainstormResult | null): StoredPicks {
  const { conclusionKind, ...picks } = parse<StoredPicks>(value, {});
  const by = (items: Array<{ id: string; slot?: string; kind?: string }> | undefined, key: "slot" | "kind") =>
    Object.fromEntries(
      (items || []).flatMap((item) => (item[key] ? [[item.id, String(item[key])]] : [])),
    );
  const out = { ...picks } as StoredPicks;
  if (picks.groups) out.groups = lay(picks.groups, "slot", by(result?.groups, "slot")) as StoredPicks["groups"];
  if (picks.tensions) out.tensions = lay(picks.tensions, "kind", by(result?.tensions, "kind")) as StoredPicks["tensions"];
  if (picks.drafts) out.drafts = lay(picks.drafts, "kind", by(result?.drafts, "kind")) as StoredPicks["drafts"];
  if (
    picks.conclusion &&
    conclusionKind &&
    !picks.conclusion.kind &&
    (!picks.conclusion.type || kindType(conclusionKind) === picks.conclusion.type)
  )
    out.conclusion = { ...picks.conclusion, kind: conclusionKind };
  return out;
}
const compact = (value: string) => value.replace(/\s/g, "").trim();
const charCount = (value: string) => Array.from(compact(value)).length;
// By code point, so an emoji is never cut in half.
const cut = (value: string, max: number) =>
  Array.from(value).slice(0, max).join("");
// For card titles: the card service counts 16 UTF-16 units, so stop before
// a character that would not fit instead of splitting it.
const cutUnits = (value: string, max: number) => {
  let out = "";
  for (const char of value) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out;
};
const KIND_NAMES: Record<CardKind, string> = {
  spark: "灵感",
  idea: "想法",
  question: "问题",
  method: "思路",
  todo: "待办",
  knowledge: "知识点",
  note: "随手记",
};
const SIZE_NAMES = { small: "小型", medium: "标准型", large: "大型" } as const;
// V4.2 : about 4800 characters of card text in all; each card keeps up
// to 200 (all of it for 24 cards or fewer), at least 80.
const textBudget = (count: number) =>
  Math.max(80, Math.min(200, Math.floor(4800 / Math.max(1, count))));
// One line a card instead of a JSON object (line breaks become spaces); the
// title only when it is not just the start of the text.
const cardLines = (cards: Snapshot[], max: number, star: boolean) =>
  cards
    .map((card, index) => {
      const text = cut(card.text.replace(/\s+/g, " "), max),
        title = text.startsWith(card.title) ? "" : `${card.title}｜`;
      return `${index + 1} [${KIND_NAMES[card.kind ?? card.type]}] ${title}${text}${star && card.mine ? " ★" : ""}`;
    })
    .join("\n");
const jsonEqual = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const pointById = new Map(
  CALC_MAP.chapters.flatMap((chapter) =>
    chapter.points.map((point) => [point.id, point] as const),
  ),
);
const chapterByPoint = new Map(
  CALC_MAP.chapters.flatMap((chapter) =>
    chapter.points.map((point) => [point.id, chapter] as const),
  ),
);

function editDistance(a: string, b: string) {
  const left = Array.from(compact(a)),
    right = Array.from(compact(b));
  let previous = right.map((_, index) => index + 1);
  previous.unshift(0);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++)
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[right.length]!;
}

function numericTokens(text: string): string[] {
  return [...(text.match(/\d+(?:\.\d+)?/g) ?? [])];
}

export class BrainstormService {
  private readonly saving = new Map<string, Promise<SaveOutput>>();
  constructor(
    private readonly store: SqliteStore,
    private readonly cards: CardService,
    private readonly model: LlmClient,
    private readonly safety: CrisisSafetyService,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  private now() {
    return this.clock().toISOString();
  }
  private own(userId: string, id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM brainstorms WHERE id=? AND user_id=?")
      .get(id, userId) as Row | undefined;
    if (!row) throw new AppError(404, "NOT_FOUND", "这次头脑风暴找不到了，可能已经删掉");
    return row;
  }
  private requireMood(userId: string, scene: CardScene) {
    if (scene === "mood" && !this.store.getUser(userId)?.moodConsentAt)
      throw new AppError(
        403,
        "MOOD_CONSENT_REQUIRED",
        "心情相关的内容，要先同意心情记录说明",
      );
  }
  private snapshot(userId: string, ids: string[]): Snapshot[] {
    if (ids.length < 3 || ids.length > 50)
      throw new AppError(400, "INVALID_CARD_COUNT", "挑 3 到 50 张卡就能开始");
    if (new Set(ids).size !== ids.length)
      throw new AppError(400, "DUPLICATE_CARD", "同一张卡选了两次，再挑一次");
    const rows = this.store.db
      .prepare(
        `SELECT * FROM cards WHERE user_id=? AND merged_into IS NULL AND id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(userId, ...ids) as Row[];
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    if (rows.length !== ids.length)
      throw new AppError(400, "CARD_NOT_AVAILABLE", "有几张卡找不到了，再挑一次");
    return [...ids].sort().map((id) => {
      const row = byId.get(id)!;
      if (row.crisis)
        throw new AppError(400, "CRISIS_CONTENT", "有一张卡先不放进来，换几张试试");
      const text = cut(String(row.mine ?? row.summary ?? row.quote ?? "").trim(), 200);
      if (!text)
        throw new AppError(400, "CARD_NOT_AVAILABLE", "这几张卡还是空的，换几张试试");
      return {
        id,
        version: Number(row.version),
        type: row.type as CardType,
        kind: effectiveKind(row.kind, row.type as CardType),
        scene: row.scene as CardScene,
        title: String(row.title || cut(text, 16)),
        titleBy: row.title_by as "user" | "ai",
        text,
        mine: Boolean(row.mine),
        pointId: row.point_id ? String(row.point_id) : null,
        mistakeId: row.mistake_id ? String(row.mistake_id) : null,
        sawAnswer: Boolean(row.saw_answer),
      };
    });
  }
  private scene(cards: Snapshot[]): CardScene {
    return cards.some((card) => card.scene === "mood")
      ? "mood"
      : cards.every((card) => card.scene === "study")
        ? "study"
        : "life";
  }
  private size(count: number) {
    return count <= 5 ? "small" : count <= 20 ? "medium" : "large";
  }
  private facts(userId: string, cards: Snapshot[]): Facts {
    const points = cards
      .map((card) => card.pointId)
      .filter(Boolean) as string[];
    const ancestors = (id: string) => {
      const found = new Set<string>();
      const walk = (next: string) => {
        for (const prereq of pointById.get(next)?.prereqs ?? [])
          if (!found.has(prereq)) {
            found.add(prereq);
            walk(prereq);
          }
      };
      walk(id);
      return found;
    };
    const common = points.length
      ? [...ancestors(points[0]!)].filter((id) =>
          points.every((point) => ancestors(point).has(id)),
        )
      : [];
    const mistakeIds = cards
      .map((card) => card.mistakeId)
      .filter(Boolean) as string[];
    const mistakeCauses = mistakeIds.length
      ? (
          this.store.db
            .prepare(
              `SELECT cause,COUNT(*) AS count FROM mistakes WHERE user_id=? AND id IN (${mistakeIds.map(() => "?").join(",")}) AND cause IS NOT NULL GROUP BY cause HAVING COUNT(*)>=2 ORDER BY count DESC,cause`,
            )
            .all(userId, ...mistakeIds) as Array<{
            cause: string;
            count: number;
          }>
        ).map((row) => ({ cause: String(row.cause), count: Number(row.count) }))
      : [];
    return {
      commonPrereqs: common
        .sort(
          (a, b) =>
            (pointById.get(b)?.prereqs.length ?? 0) -
            (pointById.get(a)?.prereqs.length ?? 0),
        )
        .slice(0, 3)
        .map((id) => ({
          id,
          name: pointById.get(id)?.name ?? id,
          count: points.length,
        })),
      mistakeCauses,
      sawAnswer: cards.filter((card) => card.sawAnswer).length,
    };
  }
  private revalidate(
    userId: string,
    expected: Array<Pick<Snapshot, "id" | "version">>,
  ) {
    const current = this.snapshot(
      userId,
      expected.map((card) => card.id),
    );
    if (
      current.some((card, index) => card.version !== expected[index]!.version)
    )
      throw new JobError("BRAINSTORM_CHANGED", "卡有改动，回去重新挑一次");
    return current;
  }
  async create(
    userId: string,
    input: { clientId: string; cardIds: string[] },
    runner: JobRunner,
  ) {
    let cards = this.snapshot(userId, input.cardIds);
    const scene = this.scene(cards);
    this.requireMood(userId, scene);
    if (
      scene === "mood" &&
      (await this.safety.check(
        cards.map((card) => `${card.title}\n${card.text}`).join("\n"),
        { scene, source: "brainstorm" },
      ))
    )
      throw new AppError(400, "CRISIS_CONTENT", "有一张卡先不放进来，换几张试试");
    cards = this.revalidate(userId, cards);
    this.requireMood(userId, scene);
    const encoded = JSON.stringify(cards);
    const recent = this.store.db
      .prepare(
        "SELECT * FROM brainstorms WHERE user_id=? AND cards=? ORDER BY created_at DESC,rowid DESC LIMIT 8",
      )
      .all(userId, encoded) as Row[];
    const cutoff = this.clock().getTime() - 10 * 60_000;
    const existing = recent.find((row) => {
      if (this.restartable(row, runner)) return true;
      if (row.job_id) {
        const job = runner.get(String(row.job_id));
        if (job && ["queued", "running"].includes(job.status)) return true;
      }
      return (
        ["ready", "paused", "saved"].includes(String(row.status)) &&
        Date.parse(String(row.updated_at)) >= cutoff
      );
    });
    let row = existing;
    if (!row) {
      const id = `brain_${digest(`${userId}:${input.clientId}:${encoded}`).slice(0, 32)}`;
      row = this.store.db
        .prepare("SELECT * FROM brainstorms WHERE id=? AND user_id=?")
        .get(id, userId) as Row | undefined;
    }
    if (!row) {
      const id = `brain_${digest(`${userId}:${input.clientId}:${encoded}`).slice(0, 32)}`;
      const at = this.now();
      this.store.db
        .prepare(
          `INSERT INTO brainstorms(id,user_id,scene,size,cards,facts,status,created_at,updated_at)
           VALUES(?,?,?,?,?,?,'picked',?,?)`,
        )
        .run(
          id,
          userId,
          scene,
          this.size(cards.length),
          encoded,
          JSON.stringify(this.facts(userId, cards)),
          at,
          at,
        );
      row = this.own(userId, id);
    }
    if (this.restartable(row, runner)) {
      const queued = runner.enqueue({
        userId,
        kind: "brainstorm",
        // The service already applied the ten-minute product dedupe window.
        // Older successful jobs must run and charge again.
        refresh: true,
        params: {
          cards: cards.map(({ id, version }) => ({ id, version })),
        },
      });
      this.store.db
        .prepare(
          "UPDATE brainstorms SET job_id=?,status='running',updated_at=? WHERE id=? AND user_id=? AND COALESCE(job_id,'')=?",
        )
        .run(
          queued.job.id,
          this.now(),
          String(row.id),
          userId,
          String(row.job_id ?? ""),
        );
      row = this.own(userId, String(row.id));
    }
    return row;
  }
  // Not started yet, or its job ended without a result (V4.2: the failed
  // job stays linked so pages can show why; the same request starts anew).
  private restartable(row: Row, runner: JobRunner) {
    if (row.result || !["picked", "running"].includes(String(row.status)))
      return false;
    if (!row.job_id) return row.status === "picked";
    const job = runner.get(String(row.job_id));
    return !job || ["failed", "unknown"].includes(job.status);
  }
  private outputHasNumbers(text: string, refs: number[], cards: Snapshot[]) {
    const allowed = refs
      .map((ref) => cards[ref - 1])
      .filter(Boolean)
      .map((card) => `${card!.title}\n${card!.text}`)
      .join("\n");
    return numericTokens(text).every((token) =>
      numericTokens(allowed).includes(token),
    );
  }
  private validateOutput(
    output: BrainstormOutput,
    cards: Snapshot[],
    size: "small" | "medium" | "large",
  ): BrainstormResult {
    const refs = (values: number[]) => [
      ...new Set(values.filter((value) => value >= 1 && value <= cards.length)),
    ];
    const rawRefs = [
      ...output.groups.flatMap((item) => item.cards),
      ...output.tensions.flatMap((item) => [item.a, item.b]),
      ...output.more.flatMap((item) => item.from),
      ...output.ifs.flatMap((item) => item.from),
      ...output.directions.flatMap((item) => item.from),
      ...output.drafts.flatMap((item) => item.from),
    ];
    if (!rawRefs.some((ref) => ref >= 1 && ref <= cards.length))
      throw new JobError("AI_BAD_OUTPUT", "这次没理好，再试一次");
    // Unknown meanings are dropped; the field is optional.
    const pick = <T extends string>(allowed: readonly T[], value?: string) =>
      allowed.includes(value as T) ? { value: value as T } : null;
    const groupMax = size === "small" ? 2 : size === "medium" ? 4 : 5;
    const generalMax = size === "small" ? 2 : 3;
    const used = new Set<number>();
    let groups = output.groups
      .map(({ slot, ...group }) => {
        const known = pick(GROUP_SLOTS, slot);
        return {
          ...group,
          cards: refs(group.cards),
          ...(known ? { slot: known.value } : {}),
        };
      })
      .filter(
        (group) =>
          group.cards.length &&
          this.outputHasNumbers(group.common, group.cards, cards),
      )
      .slice(0, groupMax)
      .map((group) => ({
        ...group,
        cards: group.cards.filter((ref) => {
          if (used.has(ref)) return false;
          used.add(ref);
          return true;
        }),
      }))
      .filter((group) => group.cards.length);
    if (size !== "small") {
      const missing = cards
        .map((_, index) => index + 1)
        .filter((ref) => !used.has(ref));
      if (missing.length) {
        if (groups.length >= groupMax) groups = groups.slice(0, groupMax - 1);
        const regrouped = new Set(groups.flatMap((group) => group.cards));
        groups.push({
          name: "没归组",
          common: "还没有明确共同点",
          cards: cards
            .map((_, index) => index + 1)
            .filter((ref) => !regrouped.has(ref)),
        });
      }
    }
    const tensions = output.tensions
      .map(({ kind, ...item }) => {
        const known = pick(TENSION_KINDS, kind);
        return {
          ...item,
          a: refs([item.a])[0],
          b: refs([item.b])[0],
          ...(known ? { kind: known.value } : {}),
        };
      })
      .filter((item): item is Omit<BrainstormResult["tensions"][number], "id"> =>
        Boolean(
          item.a &&
            item.b &&
            item.a !== item.b &&
            this.outputHasNumbers(item.note, [item.a, item.b], cards),
        ),
      )
      .slice(0, generalMax);
    const refItems = <T extends { from: number[] }>(
      items: T[],
      text: (item: T) => string,
      max = generalMax,
    ) =>
      items
        .map((item) => ({ ...item, from: refs(item.from) }))
        .filter(
          (item) =>
            item.from.length &&
            this.outputHasNumbers(text(item), item.from, cards),
        )
        .slice(0, max);
    const more = refItems(output.more, (item) => item.title);
    const ifs = refItems(output.ifs, (item) => item.if);
    const directions = refItems(
      output.directions,
      (item) => `${item.title}\n${item.why}`,
      3,
    );
    const drafts = refItems(output.drafts, (item) => item.text, 3).map(
      ({ kind, ...item }) => {
        const known = pick(CARD_KINDS, kind);
        return known ? { ...item, kind: known.value } : item;
      },
    );
    if (
      !groups.length &&
      !tensions.length &&
      !more.length &&
      !ifs.length &&
      !directions.length &&
      !drafts.length
    )
      throw new JobError("AI_BAD_OUTPUT", "这次没理好，再试一次");
    return {
      title: output.title,
      groups: groups.map((item, index) => ({ id: `g${index + 1}`, ...item })),
      tensions: tensions.map((item, index) => ({
        id: `t${index + 1}`,
        ...item,
      })),
      more: more.map((item, index) => ({ id: `m${index + 1}`, ...item })),
      ifs: ifs.map((item, index) => ({ id: `i${index + 1}`, ...item })),
      directions: directions.map((item, index) => ({
        id: `r${index + 1}`,
        ...item,
      })),
      drafts: drafts.map((item, index) => ({ id: `d${index + 1}`, ...item })),
      ask: output.ask,
    };
  }
  private reportJob(userId: string, id: string) {
    const row = this.store.db
      .prepare(
        "SELECT * FROM jobs WHERE user_id=? AND kind='brainstorm_report' AND json_extract(params,'$.brainstormId')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(userId, id);
    return row ? toJob(row) : null;
  }
  // What a report is written from : the groups, differences and
  // directions as they are now. Its digest (basis) marks a report written
  // before the user changed them as stale; the title, the stances and the
  // conclusion do not count.
  private reportFacts(row: Row) {
    const result = parse<BrainstormResult | null>(row.result, null);
    const picks = parse<StoredPicks>(row.picks, {});
    if (!result) return null;
    const facts = {
      groups: (picks.groups ?? result.groups).map((g) => ({
        name: g.name,
        common: g.common,
        cards: g.cards,
      })),
      tensions: (picks.tensions ?? result.tensions).map((t) => ({
        a: t.a,
        b: t.b,
        note: t.note,
      })),
      directions: (picks.directions ?? result.directions).map((d) => ({
        title: d.title,
        why: d.why,
        from: d.from,
      })),
    };
    return {
      facts,
      basis: digest(JSON.stringify(facts)).slice(0, 32),
      title: picks.title ?? result.title,
      conclusion: picks.conclusion?.text || null,
    };
  }
  // The stored report with card numbers turned into the cards still there.
  private reportView(row: Row) {
    const report = parse<StoredReport | null>(row.report, null);
    if (!report) return null;
    const snapshot = parse<Snapshot[]>(row.cards, []);
    const titles = new Map(
      (
        this.store.db
          .prepare(
            `SELECT id,title FROM cards WHERE user_id=? AND id IN (${snapshot.map(() => "?").join(",") || "''"})`,
          )
          .all(String(row.user_id), ...snapshot.map((c) => c.id)) as Row[]
      ).map((c) => [String(c.id), String(c.title)]),
    );
    const sections = Object.fromEntries(
      REPORT_SECTIONS.map((key) => [
        key,
        report.sections[key].map((item) => ({
          // The model sometimes writes "卡2"; nobody sees those numbers, so name the card.
          text: item.text.replace(/卡\s?(\d{1,2})(?!\d)/g, (match, n) => {
            const card = snapshot[Number(n) - 1];
            return card ? `「${titles.get(card.id) || card.title}」` : match;
          }),
          cards: item.from
            .map((n) => snapshot[n - 1])
            .filter((c): c is Snapshot => Boolean(c && titles.has(c.id)))
            .map((c) => ({ id: c.id, title: titles.get(c.id) || c.title })),
        })),
      ]),
    ) as Record<
      (typeof REPORT_SECTIONS)[number],
      { text: string; cards: { id: string; title: string }[] }[]
    >;
    return {
      sections,
      createdAt: report.createdAt,
      // V4.2 : written before the groups or differences changed.
      stale: Boolean(
        report.basis && report.basis !== this.reportFacts(row)?.basis,
      ),
    };
  }
  // 报告 for a brainstorm that has a result: made once, then kept. With
  // refresh  a stale report is written again; the old one stays
  // until the new one is in.
  report(
    userId: string,
    id: string,
    clientId: string,
    runner: JobRunner,
    refresh = false,
  ) {
    const row = this.own(userId, id);
    this.requireMood(userId, row.scene as CardScene);
    if (!row.result)
      throw new AppError(409, "BRAINSTORM_NOT_READY", "还没想完，等一下再看");
    const stored = this.reportView(row);
    // A report on its way is returned; after a failure the same request
    // starts a new one, and failures are not charged.
    const previous = this.reportJob(userId, id);
    if (stored && !(refresh && stored.stale))
      return { job: null, report: stored };
    if (previous && ["queued", "running"].includes(previous.status))
      return { job: publicJob(previous), report: stored };
    // Writing a stale report again spends the budget like any new action
    // ; the first report never stops half a brainstorm.
    if (stored) runner.checkBudget(userId);
    // Writing a stale report again never reuses the finished job that wrote
    // it, even when the page sends that job's clientId again.
    const { job } = runner.enqueue({
      userId,
      kind: "brainstorm_report",
      params: { brainstormId: id, clientId,
        ...(!stored && !previous && row.job_id ? { continuationJobId: row.job_id } : {}) },
      ...(stored ? { refresh: true } : {}),
    });
    // One brainstorm, one charge : the report belongs to a
    // brainstorm whose own job was charged when it ran (a report needs its
    // result), so the report job's receipt (written by the jobs trigger) is
    // void from the start. The handler has no quota bucket, so the daily
    // limit never blocks the second half of a brainstorm.
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO quota_voids(source,source_id,user_id,job_id,created_at) SELECT source,source_id,user_id,?,? FROM quota_receipts WHERE source='job' AND source_id=?",
      )
      .run(job.id, this.now(), job.id);
    return { job: publicJob(job), report: stored };
  }
  private validateReport(output: BrainstormReportOutput, count: number) {
    const items = REPORT_SECTIONS.flatMap((key) => output.sections[key]);
    if (!items.length)
      throw new JobError("AI_BAD_OUTPUT", "这次没看好，再试一次");
    if (items.some((item) => item.from.some((n) => n < 1 || n > count)))
      throw new JobError("AI_BAD_OUTPUT", "这次没看好，再试一次");
    if (BANNED_PHRASES.some((phrase) => JSON.stringify(output).includes(phrase)))
      throw new JobError("AI_BAD_OUTPUT", "这次没看好，再试一次");
    return {
      sections: Object.fromEntries(
        REPORT_SECTIONS.map((key) => [
          key,
          output.sections[key].map((item) => ({
            text: item.text,
            from: [...new Set(item.from)],
          })),
        ]),
      ) as BrainstormReportOutput["sections"],
    };
  }
  handlers(): Record<string, JobHandler> {
    return {
      brainstorm_report: {
        // No quota bucket : see report.
        activityId: (job) => {
          if (job.params._securityAttempt !== 1 || typeof job.params.continuationJobId !== "string") return undefined;
          // Only the initial report of this server-owned successful parent
          // continues its attempt. Refreshes and failed retries are new work.
          const parent = this.store.db.prepare(`SELECT j.id,json_extract(j.params,'$._securityAttempt') AS attempt
            FROM brainstorms b JOIN jobs j ON j.id=b.job_id
            WHERE b.id=? AND b.user_id=? AND j.id=? AND j.user_id=? AND j.kind='brainstorm' AND j.status='succeeded'`)
            .get(String(job.params.brainstormId), job.userId, job.params.continuationJobId, job.userId);
          return parent && Number.isSafeInteger(parent.attempt) && Number(parent.attempt) > 0
            ? `${parent.id}:${parent.attempt}` : undefined;
        },
        timeoutMs: () => 120_000,
        run: async (job, signal, report) => {
          report({ stage: "write" });
          const row = this.own(job.userId, String(job.params.brainstormId));
          const input = this.reportFacts(row);
          if (!input)
            throw new JobError("BRAINSTORM_NOT_READY", "还没想完，等一下再看");
          const cards = parse<Snapshot[]>(row.cards, []);
          // V4.2 : the groups already sum the cards up, so each card
          // goes in as one short line (title and up to 60 characters).
          const messages = [
            { role: "system" as const, content: REPORT_SYSTEM },
            {
              role: "user" as const,
              content: `场景：${row.scene}\n卡片：\n${cardLines(cards, 60, false)}\n整理结果：${JSON.stringify(
                { title: input.title, ...input.facts },
              )}${input.conclusion ? `\n用户的结论：${input.conclusion}` : ""}`,
            },
          ];
          const options = {
            scenario: "brainstorm" as const,
            maxTokens: 2048,
            truncateAsError: true,
          };
          // Streamed when the model can, so the page sees it being written.
          const generated = this.model.streamJson
            ? await this.model.streamJson(messages, brainstormReportSchema, {
                ...options,
                signal,
                expect: 400,
                onProgress: (progress) =>
                  report({ ...progress, stage: "write" }),
              })
            : await this.model.json(
                messages,
                brainstormReportSchema,
                signal,
                options,
              );
          try {
            report({ stage: "check" });
            const output = this.validateReport(generated.data, cards.length);
            if (
              await this.safety.check(
                REPORT_SECTIONS.flatMap((key) =>
                  output.sections[key].map((item) => item.text),
                ).join("\n"),
                { scene: row.scene as CardScene, source: "brainstorm" },
                signal,
              )
            )
              throw new JobError("CRISIS_CONTENT", "这次的内容先不显示了");
            return {
              output: { ...output, basis: input.basis },
              usage: generated.usage,
            };
          } catch (error) {
            if (error instanceof Error)
              Object.assign(error, { usage: generated.usage });
            throw error;
          }
        },
        commit: (job, output) => {
          const id = String(job.params.brainstormId);
          const updated = this.store.db
            .prepare(
              "UPDATE brainstorms SET report=? WHERE id=? AND user_id=? AND result IS NOT NULL",
            )
            .run(
              JSON.stringify({
                ...(output as StoredReport),
                createdAt: this.now(),
              }),
              id,
              job.userId,
            ).changes;
          if (!updated)
            throw new JobError("BRAINSTORM_CHANGED", "这次头脑风暴有变化，退出这页再进来");
          return { brainstormId: id };
        },
      },
      brainstorm: {
        quota: "brainstorm",
        timeoutMs: () => 300_000,
        run: async (job, signal, report) => {
          report({ stage: "cards" });
          const expected = (
            job.params.cards as Array<{ id: string; version: number }>
          ).map((card) => ({
            id: String(card.id),
            version: Number(card.version),
          }));
          const cards = this.revalidate(job.userId, expected);
          const scene = this.scene(cards),
            size = this.size(cards.length);
          this.requireMood(job.userId, scene);
          if (
            scene === "mood" &&
            (await this.safety.check(
              cards.map((card) => `${card.title}\n${card.text}`).join("\n"),
              { scene, source: "brainstorm" },
              signal,
            ))
          )
            throw new JobError("CRISIS_CONTENT", "有一张卡先不放进来，换几张试试");
          const current = this.revalidate(job.userId, cards);
          this.requireMood(job.userId, scene);
          // V4.2 : one line a card, text within a total budget.
          const messages = [
            { role: "system" as const, content: BRAINSTORM_SYSTEM },
            {
              role: "user" as const,
              content: `场景：${scene}；${SIZE_NAMES[size]}，${current.length}张\n${cardLines(current, textBudget(current.length), true)}`,
            },
          ];
          // The answer itself (thinking comes on top): the lists are capped
          // at 3 to 5 short items, about 1.6k characters at most.
          const maxTokens = size === "small" ? 4096 : 6144;
          report({ stage: "think" });
          const generated = this.model.streamJson
            ? await this.model.streamJson(messages, brainstormOutputSchema, {
                signal,
                scenario: "brainstorm",
                maxTokens,
                jsonRetries: 1,
                truncateAsError: true,
                expect: size === "small" ? 800 : 1600,
                onProgress: (progress) =>
                  report({ ...progress, stage: "think" }),
              })
            : await this.model.json(messages, brainstormOutputSchema, signal, {
                scenario: "brainstorm",
                maxTokens,
                jsonRetries: 1,
                truncateAsError: true,
              });
          report({ stage: "tidy" });
          if (
            BANNED_PHRASES.some((phrase) =>
              JSON.stringify(generated.data).includes(phrase),
            )
          )
            throw new JobError(
              "AI_BAD_OUTPUT",
              "这次没理好，换几张卡再试试",
            );
          return {
            output: this.validateOutput(generated.data, cards, size),
            usage: generated.usage,
          };
        },
        commit: (job, output) => {
          const row = this.store.db
            .prepare("SELECT * FROM brainstorms WHERE user_id=? AND job_id=?")
            .get(job.userId, job.id) as Row | undefined;
          if (!row || row.status !== "running")
            throw new JobError("BRAINSTORM_CHANGED", "这次头脑风暴有变化，退出这页再进来");
          this.store.db
            .prepare(
              "UPDATE brainstorms SET result=?,status='ready',updated_at=? WHERE id=? AND user_id=? AND job_id=?",
            )
            .run(
              JSON.stringify(packResult(output as BrainstormResult)),
              this.now(),
              String(row.id),
              job.userId,
              job.id,
            );
          return { brainstormId: row.id };
        },
        // Back to 'picked' (the job stays linked for its error), so the same
        // start request runs it again.
        onFail: (job) => {
          this.store.db
            .prepare(
              "UPDATE brainstorms SET status=CASE WHEN result IS NULL THEN 'picked' ELSE 'ready' END,updated_at=? WHERE user_id=? AND job_id=? AND status='running'",
            )
            .run(this.now(), job.userId, job.id);
        },
      },
    };
  }
  private validatePicks(
    result: BrainstormResult,
    picks: BrainstormPicks,
    count: number,
  ) {
    const source = {
      groups: new Set(result.groups.map((item) => item.id)),
      tensions: new Set(result.tensions.map((item) => item.id)),
      more: new Set(result.more.map((item) => item.id)),
      ifs: new Set(result.ifs.map((item) => item.id)),
      directions: new Set(result.directions.map((item) => item.id)),
      drafts: new Set(result.drafts.map((item) => item.id)),
    };
    const validRefs = (refs: number[]) =>
      refs.length > 0 && refs.every((ref) => ref >= 1 && ref <= count);
    for (const key of Object.keys(source) as Array<keyof typeof source>)
      for (const item of picks[key] ?? []) {
        if (!source[key].has(item.id))
          throw new AppError(400, "INVALID_PICK", "改的内容对不上，退出这页再进来");
        if (key === "groups" && !validRefs((item as { cards: number[] }).cards))
          throw new AppError(400, "INVALID_PICK", "分组对不上，退出这页再进来");
        if (
          ["more", "ifs", "directions", "drafts"].includes(key) &&
          !validRefs((item as { from: number[] }).from)
        )
          throw new AppError(400, "INVALID_PICK", "卡对不上，退出这页再进来");
        if (key === "tensions") {
          const tension = item as { a: number; b: number };
          if (tension.a === tension.b || !validRefs([tension.a, tension.b]))
            throw new AppError(400, "INVALID_PICK", "卡对不上，退出这页再进来");
        }
      }
    if (
      picks.conclusion?.draftId &&
      !source.drafts.has(picks.conclusion.draftId)
    )
      throw new AppError(400, "INVALID_PICK", "这句找不到了，换一句试试");
  }
  update(userId: string, id: string, input: BrainstormPicks) {
    if (this.saving.has(`${userId}:${id}`))
      throw new AppError(409, "SAVE_IN_PROGRESS", "正在存，过一会儿再改");
    const row = this.own(userId, id);
    if (!["ready", "paused"].includes(String(row.status)))
      throw new AppError(409, "NOT_READY", "这次头脑风暴现在改不了，退出这页再进来");
    const result = readResult(row.result);
    if (!result) throw new AppError(409, "NOT_READY", "还没出结果，退出这页再进来看看");
    this.validatePicks(result, input, parse<Snapshot[]>(row.cards, []).length);
    const previous = readPicks(row.picks, result),
      next = { ...previous, ...input };
    delete next.pause;
    this.store.db
      .prepare(
        "UPDATE brainstorms SET picks=?,status=?,updated_at=? WHERE id=? AND user_id=?",
      )
      .run(
        JSON.stringify(packPicks(next)),
        input.pause ? "paused" : "ready",
        this.now(),
        id,
        userId,
      );
    return this.own(userId, id);
  }
  private commonTags(userId: string, sources: Snapshot[]) {
    return (
      this.store.db
        .prepare(
          `SELECT t.name,COUNT(DISTINCT ct.card_id) AS n FROM card_tags ct JOIN tags t ON t.id=ct.tag_id AND t.user_id=ct.user_id
           WHERE ct.user_id=? AND ct.card_id IN (${sources.map(() => "?").join(",")})
           GROUP BY t.id,t.name HAVING COUNT(DISTINCT ct.card_id)>=2 ORDER BY n DESC,t.name LIMIT 3`,
        )
        .all(userId, ...sources.map((card) => card.id)) as Array<{
        name: string;
      }>
    ).map((row) => String(row.name));
  }
  private async createOutputCard(
    userId: string,
    brainstormId: string,
    scene: CardScene,
    tags: string[],
    input: {
      summaryBy?: "ai" | "user";
      type: CardType;
      kind?: CardKind;
      title: { text: string; by: "user" | "ai" };
      mine?: string;
      summary?: string;
      slots?: Array<{ key: string; text: string; by: "user" | "ai" }>;
      open?: Array<{
        key: string;
        cat: "decide" | "verify";
        text: string;
        by: "user" | "ai";
        answer?: string;
      }>;
      next?: { if: string; then: string; by: "user" | "ai" } | null;
    },
  ) {
    let card = (
      await this.cards.create(
        userId,
        {
          type: input.type,
          ...(input.kind ? { kind: input.kind } : {}),
          scene,
          title: input.title.by === "user" ? input.title.text : undefined,
          mine: input.mine,
          origin: "brainstorm",
          srcId: brainstormId,
        },
        { skipTidy: true, seedSummary: input.summary },
      )
    ).card;
    if (tags.length)
      card = this.cards.applyAIData(userId, card.id, card.version, { tags });
    card = this.cards.applyBrainstormData(userId, card.id, card.version, {
      title: input.title,
      ...(input.summary !== undefined
        ? { summary: { text: input.summary, by: input.summaryBy ?? "ai" } }
        : {}),
      slots: input.slots,
      open: input.open,
      next: input.next,
    });
    return card;
  }
  // A group fills the slot of the conclusion's type that its shared point is
  // about (V4.2 G1b: groups.slot); groups about anything else fill none.
  // Results from before carry no slot: they keep the old order-based fill.
  private slotData(
    type: CardType,
    groups: Array<BrainstormResult["groups"][number]>,
    original: BrainstormResult,
  ) {
    const by = (group: BrainstormResult["groups"][number]) =>
      (jsonEqual(
        group,
        original.groups.find((item) => item.id === group.id),
      )
        ? "ai"
        : "user") as "ai" | "user";
    const text = (group: BrainstormResult["groups"][number]) =>
      cutUnits(`${group.name ? `${group.name}：` : ""}${group.common}`, 60);
    const keys = SLOT_KEYS[type];
    if (!original.groups.some((group) => group.slot))
      return groups.slice(0, keys.length).map((group, index) => ({
        key: keys[index]!,
        text: text(group),
        by: by(group),
      }));
    return keys.flatMap((key) => {
      const group = groups.find((item) => item.slot === key);
      return group ? [{ key, text: text(group), by: by(group) }] : [];
    });
  }
  // A difference on the conclusion card : 要核实 when it can be
  // checked, 要决定 when the user picks one (and for results from before);
  // a mere difference of angle is not an open question.
  private openData(
    tensions: Array<
      BrainstormResult["tensions"][number] & {
        choice?: "depends" | "a" | "b" | "unsure";
      }
    >,
    result: BrainstormResult,
    sources: Snapshot[],
  ) {
    const name = (ref: number) => `「${sources[ref - 1]?.title ?? ""}」`;
    return tensions
      .filter((item) => item.kind !== "differ")
      .map((item) => {
        const old = result.tensions.find((entry) => entry.id === item.id);
        // The stance in words, as the page showed it.
        const answer =
          item.choice === "a" || item.choice === "b"
            ? item.kind === "verify"
              ? `${name(item[item.choice])}对`
              : item.kind === "choose"
                ? `选${name(item[item.choice])}`
                : `${name(item[item.choice])}更对`
            : item.choice === "depends"
              ? "看情况"
              : undefined;
        return {
          key: `brainstorm-${item.id}`,
          cat: (item.kind === "verify" ? "verify" : "decide") as
            | "verify"
            | "decide",
          text: item.note,
          by: (old &&
          jsonEqual(
            { a: item.a, b: item.b, note: item.note },
            { a: old.a, b: old.b, note: old.note },
          )
            ? "ai"
            : "user") as "ai" | "user",
          ...(answer ? { answer: cutUnits(answer, 300) } : {}),
        };
      });
  }
  async save(
    userId: string,
    id: string,
    clientId: string,
  ): Promise<SaveOutput> {
    const key = `${userId}:${id}`;
    const pending = this.saving.get(key);
    if (pending) return pending;
    const run = this.saveInner(userId, id, clientId).finally(() =>
      this.saving.delete(key),
    );
    this.saving.set(key, run);
    return run;
  }
  private async saveInner(userId: string, id: string, clientId: string) {
    let row = this.own(userId, id);
    if (row.status === "saved") {
      const ids = parse<string[]>(row.out_cards, []);
      return {
        brainstorm: this.detail(userId, id),
        cards: ids.map((cardId) => this.cards.detail(userId, cardId)),
      };
    }
    if (!["ready", "paused"].includes(String(row.status)))
      throw new AppError(409, "NOT_READY", "这次头脑风暴现在存不了，退出这页再进来");
    const sources = parse<Snapshot[]>(row.cards, []),
      result = readResult(row.result),
      picks = readPicks(row.picks, result);
    if (!result) throw new AppError(409, "NOT_READY", "还没出结果，退出这页再进来看看");
    this.requireMood(userId, row.scene as CardScene);
    const groups = picks.groups ?? result.groups,
      tensions: Array<
        BrainstormResult["tensions"][number] & {
          choice?: "depends" | "a" | "b" | "unsure";
        }
      > = picks.tensions ?? result.tensions,
      more =
        picks.more ?? result.more.map((item) => ({ ...item, selected: false })),
      ifs: Array<
        BrainstormResult["ifs"][number] & { selected: boolean; then?: string }
      > = picks.ifs ?? result.ifs.map((item) => ({ ...item, selected: false })),
      conclusion = picks.conclusion;
    const safetyText = [
      conclusion?.text,
      conclusion?.title,
      ...ifs.filter((item) => item.selected).map((item) => item.then ?? ""),
      ...more.filter((item) => item.selected).map((item) => item.title),
    ]
      .filter(Boolean)
      .join("\n");
    if (
      safetyText &&
      (await this.safety.check(safetyText, {
        scene: row.scene as CardScene,
        source: "brainstorm",
      }))
    )
      throw new AppError(400, "CRISIS_CONTENT", "这几句先不存，改一改再试");
    row = this.own(userId, id);
    if (!["ready", "paused"].includes(String(row.status)))
      return {
        brainstorm: this.detail(userId, id),
        cards: parse<string[]>(row.out_cards, []).map((cardId) =>
          this.cards.detail(userId, cardId),
        ),
      };
    this.requireMood(userId, row.scene as CardScene);
    const saved = picks._saved ?? {},
      output: CardView[] = [],
      tags = this.commonTags(userId, sources),
      scene = row.scene as CardScene;
    let conclusionCard: CardView | undefined;
    if (conclusion?.text.trim()) {
      const draft = conclusion.draftId
        ? result.drafts.find((item) => item.id === conclusion.draftId)
        : undefined;
      // V4.2 : a clear short sentence is enough. Typed text is the
      // user's own words; an AI draft is, once a third of it (at most 10
      // characters) was rewritten.
      if (charCount(conclusion.text) < 2)
        throw new AppError(400, "CONCLUSION_TOO_SHORT", "再多写几个字");
      const userWords = draft
        ? editDistance(draft.text, conclusion.text) >=
          Math.min(10, Math.ceil(charCount(draft.text) / 3))
        : true;
      if (saved.conclusion)
        conclusionCard = this.cards.detail(userId, saved.conclusion);
      else {
        // The kind chosen, else the one the AI gave the draft used (or the
        // first draft), else by scene as before.
        const kind: CardKind =
          conclusion.kind ??
          conclusion.type ??
          draft?.kind ??
          result.drafts.find((item) => item.kind)?.kind ??
          (scene === "study" ? "method" : "idea");
        const type = kindType(kind);
        const originalIf = result.ifs;
        const selectedIf = ifs.find(
          (item) => item.selected && item.then?.trim(),
        );
        const next = selectedIf
          ? {
              if: selectedIf.if,
              then: selectedIf.then!.trim(),
              by: (selectedIf.if ===
              originalIf.find((item) => item.id === selectedIf.id)?.if
                ? "ai"
                : "user") as "ai" | "user",
            }
          : null;
        conclusionCard = await this.createOutputCard(userId, id, scene, tags, {
          type,
          kind,
          title: {
            text: cutUnits(conclusion.title ?? conclusion.text, 16),
            by: conclusion.title || userWords ? "user" : "ai",
          },
          ...(userWords
            ? { mine: conclusion.text }
            : { summary: conclusion.text }),
          slots: this.slotData(type, groups, result),
          open: this.openData(tensions, result, sources),
          next,
        });
        saved.conclusion = conclusionCard.id;
        this.checkpointSaved(userId, id, saved, conclusionCard.id, clientId);
      }
      output.push(conclusionCard);
    }
    for (const item of more.filter((candidate) => candidate.selected)) {
      const saveKey = `more:${item.id}`;
      let card: CardView;
      if (saved[saveKey]) card = this.cards.detail(userId, saved[saveKey]!);
      else {
        const original = result.more.find((old) => old.id === item.id)!;
        const edited = item.title !== original.title;
        card = await this.createOutputCard(userId, id, scene, tags, {
          type: item.type,
          title: { text: item.title, by: edited ? "user" : "ai" },
          summary: item.title,
          summaryBy: edited ? "user" : "ai",
        });
        saved[saveKey] = card.id;
        this.checkpointSaved(userId, id, saved, card.id, clientId);
      }
      output.push(card);
    }
    this.store.transaction(() => {
      for (const source of sources) {
        const exists = this.store.db
          .prepare("SELECT 1 FROM cards WHERE id=? AND user_id=?")
          .get(source.id, userId);
        if (!exists) continue;
        const inserted = this.store.db
          .prepare(
            "INSERT OR IGNORE INTO card_uses(card_id,user_id,kind,ref_id,created_at) VALUES(?,?,'brainstorm',?,?)",
          )
          .run(source.id, userId, id, this.now()).changes;
        if (inserted)
          this.store.db
            .prepare(
              "UPDATE cards SET use_count=use_count+1 WHERE id=? AND user_id=?",
            )
            .run(source.id, userId);
        if (conclusionCard) {
          const ordered = [source.id, conclusionCard.id].sort(),
            a = ordered[0]!,
            b = ordered[1]!;
          this.store.db
            .prepare(
              "INSERT OR IGNORE INTO card_links(a,b,user_id,by,brainstorm_id,created_at) VALUES(?,?,?,'brainstorm',?,?)",
            )
            .run(a, b, userId, id, this.now());
        }
      }
      const allIds = Object.values(saved);
      this.store.db
        .prepare(
          "UPDATE brainstorms SET picks=?,out_cards=?,status='saved',updated_at=? WHERE id=? AND user_id=? AND status IN ('ready','paused')",
        )
        .run(
          JSON.stringify(
            packPicks({ ...picks, _saved: saved, _saveClientId: clientId }),
          ),
          JSON.stringify(allIds),
          this.now(),
          id,
          userId,
        );
    });
    return { brainstorm: this.detail(userId, id), cards: output };
  }
  private checkpointSaved(
    userId: string,
    id: string,
    saved: Record<string, string>,
    cardId: string,
    clientId: string,
  ) {
    const row = this.own(userId, id),
      picks = parse<StoredPicks>(row.picks, {}),
      ids = [...new Set([...parse<string[]>(row.out_cards, []), cardId])];
    this.store.db
      .prepare(
        "UPDATE brainstorms SET picks=?,out_cards=?,updated_at=? WHERE id=? AND user_id=?",
      )
      .run(
        JSON.stringify({ ...picks, _saved: saved, _saveClientId: clientId }),
        JSON.stringify(ids),
        this.now(),
        id,
        userId,
      );
  }
  list(userId: string, runner: JobRunner) {
    return (
      this.store.db
        .prepare(
          "SELECT * FROM brainstorms WHERE user_id=? ORDER BY updated_at DESC,rowid DESC",
        )
        .all(userId) as Row[]
    ).map((row) => this.view(row, runner));
  }
  // 随心记's 进行中 strip : not saved, touched in the last 7 days.
  open(userId: string, runner: JobRunner) {
    const since = new Date(this.clock().getTime() - 7 * 86400_000).toISOString();
    return (
      this.store.db
        .prepare(
          "SELECT * FROM brainstorms WHERE user_id=? AND (status IN ('running','ready','paused') OR (status='picked' AND job_id IS NOT NULL)) AND updated_at>=? ORDER BY updated_at DESC,rowid DESC LIMIT 10",
        )
        .all(userId, since) as Row[]
    ).map((row) => {
      const cards = parse<Snapshot[]>(row.cards, []);
      const result = parse<BrainstormResult | null>(row.result, null);
      const picks = parse<StoredPicks>(row.picks, {});
      const job = row.job_id ? runner.get(String(row.job_id)) : undefined;
      return {
        id: String(row.id),
        status: row.status,
        // By code point, so an emoji is never cut in half.
        title: Array.from(
          picks.title ||
            result?.title ||
            `${cards[0]?.title ?? "几张卡"}等 ${cards.length} 张`,
        )
          .slice(0, 16)
          .join(""),
        count: cards.length,
        job: job ? publicJob(job) : null,
        updatedAt: String(row.updated_at),
      };
    });
  }
  detail(userId: string, id: string, runner?: JobRunner) {
    const row = this.own(userId, id);
    const reportJob = this.reportJob(userId, id);
    return {
      ...this.view(row, runner),
      report: this.reportView(row),
      reportJob: reportJob ? publicJob(reportJob) : null,
    };
  }
  private view(row: Row, runner?: JobRunner) {
    const cards = parse<Snapshot[]>(row.cards, []),
      job = row.job_id && runner ? runner.get(String(row.job_id)) : undefined;
    return {
      id: String(row.id),
      scene: row.scene as CardScene,
      size: row.size,
      status: row.status,
      cards: cards.map(
        ({
          pointId: _pointId,
          mistakeId: _mistakeId,
          sawAnswer: _sawAnswer,
          ...card
        }) => card,
      ),
      facts: parse<Facts>(row.facts, {
        commonPrereqs: [],
        mistakeCauses: [],
        sawAnswer: 0,
      }),
      result: readResult(row.result),
      picks: (() => {
        const {
          _saved: _saved,
          _saveClientId: _saveClientId,
          ...publicPicks
        } = readPicks(row.picks, readResult(row.result));
        return publicPicks;
      })(),
      outCardIds: parse<string[]>(row.out_cards, []),
      jobId: row.job_id ? String(row.job_id) : null,
      job: job ? publicJob(job) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
  suggest(
    userId: string,
    query: { kind?: "chapter" | "import"; sourceId?: string } = {},
  ) {
    const rows = this.store.db
      .prepare(
        "SELECT id,point_id,origin,src_id,scene FROM cards WHERE user_id=? AND crisis=0 AND merged_into IS NULL AND (closed_at IS NULL OR mine IS NULL) ORDER BY updated_at DESC",
      )
      .all(userId) as Row[];
    const buckets = new Map<
      string,
      { kind: "chapter" | "import"; title: string; cardIds: string[] }
    >();
    for (const row of rows) {
      if (row.scene === "mood" && !this.store.getUser(userId)?.moodConsentAt)
        continue;
      if (row.point_id) {
        const chapter = chapterByPoint.get(String(row.point_id));
        if (chapter) {
          const key = `chapter:${chapter.id}`;
          const bucket = buckets.get(key) ?? {
            kind: "chapter" as const,
            title: chapter.label,
            cardIds: [],
          };
          bucket.cardIds.push(String(row.id));
          buckets.set(key, bucket);
        }
      }
      if (row.origin === "import" && row.src_id) {
        const key = `import:${row.src_id}`;
        const bucket = buckets.get(key) ?? {
          kind: "import" as const,
          title: "这次导入的卡",
          cardIds: [],
        };
        bucket.cardIds.push(String(row.id));
        buckets.set(key, bucket);
      }
    }
    return [...buckets]
      .filter(([, bucket]) => bucket.cardIds.length >= 3)
      .filter(([key, bucket]) => {
        const sourceId = key.slice(key.indexOf(":") + 1);
        if (
          query.kind &&
          (bucket.kind !== query.kind || sourceId !== query.sourceId)
        )
          return false;
        return !this.store.db
          .prepare(
            "SELECT 1 FROM resume_items WHERE user_id=? AND src='batch' AND src_id=? AND item_key=? AND state='never'",
          )
          .get(userId, sourceId, bucket.kind);
      })
      .map(([key, bucket]) => ({
        key,
        sourceId: key.slice(key.indexOf(":") + 1),
        ...bucket,
        cardIds: bucket.cardIds,
        count: bucket.cardIds.length,
      }));
  }
  dismiss(userId: string, kind: "chapter" | "import", sourceId: string) {
    const at = this.now();
    this.store.db
      .prepare(
        `INSERT INTO resume_items(id,user_id,src,src_id,item_key,kind,due_on,state,created_at,updated_at)
         VALUES(?,?, 'batch',?,?, 'brainstorm',date(?,'+8 hours'),'never',?,?)
         ON CONFLICT(user_id,src,src_id,item_key) DO UPDATE SET state='never',updated_at=excluded.updated_at`,
      )
      .run(
        `resume_${digest(`${userId}:${kind}:${sourceId}`).slice(0, 32)}`,
        userId,
        sourceId,
        kind,
        at,
        at,
        at,
      );
  }
  remove(userId: string, id: string, runner: JobRunner) {
    const row = this.own(userId, id),
      jobId = row.job_id ? String(row.job_id) : null;
    if (jobId) runner.cancel([jobId]);
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "DELETE FROM resume_items WHERE user_id=? AND src='brainstorm' AND src_id=?",
        )
        .run(userId, id);
      if (jobId)
        this.store.db
          .prepare(
            `UPDATE jobs SET params='{"deleted":true}',params_hash='deleted:'||id,result=NULL,
             status=CASE WHEN status IN ('queued','running') THEN 'failed' ELSE status END,
             error_code=CASE WHEN status IN ('queued','running') THEN 'BRAINSTORM_DELETED' ELSE error_code END,
             error_message=CASE WHEN status IN ('queued','running') THEN '头脑风暴已删除' ELSE error_message END,
             finished_at=COALESCE(finished_at,?) WHERE id=? AND user_id=?`,
          )
          .run(this.now(), jobId, userId);
      this.store.db
        .prepare("DELETE FROM brainstorms WHERE id=? AND user_id=?")
        .run(id, userId);
    });
  }
}

import type { SqliteStore } from "../../shared/store.js";
import { hasCrisisWords } from "../safety/crisis-words.js";
import { ruleType } from "./types.js";

export type CardType = "spark" | "idea" | "question" | "method";

type BackfillDeps = {
  checkCrisis: (
    text: string,
    scene: "study" | "life" | "mood",
    signal: AbortSignal,
  ) => Promise<boolean>;
  classify: (
    text: string,
    signal: AbortSignal,
  ) => Promise<{ type: CardType; confidence: number }>;
  schedule?: <T>(run: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
};

type CardRow = {
  id: string;
  user_id: string;
  quote: string | null;
  scene: "study" | "life" | "mood";
  version: number;
  src_id: string | null;
};

type LegacyItem = {
  id: string;
  group: "clear" | "decide" | "verify";
  text: string;
  sourceIds: string[];
};
type LegacyResult = { items: LegacyItem[] };

const typeKeys: Record<CardType, string> = {
  spark: "seed",
  idea: "claim",
  question: "known",
  method: "steps",
};

const legacyResult = (value: string | null): LegacyResult | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return null;
    const items = parsed.items.filter(
      (item): item is LegacyItem =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { id?: unknown }).id === "string" &&
        typeof (item as { text?: unknown }).text === "string" &&
        Array.isArray((item as { sourceIds?: unknown }).sourceIds) &&
        (item as { sourceIds: unknown[] }).sourceIds.every(
          (id) => typeof id === "string",
        ) &&
        ((item as { group?: unknown }).group === "clear" ||
          (item as { group?: unknown }).group === "decide" ||
          (item as { group?: unknown }).group === "verify"),
    );
    return {
      items: items.map((item) => ({
        ...item,
        sourceIds: item.sourceIds,
      })),
    };
  } catch {
    return null;
  }
};

export class CardBackfill {
  constructor(
    private readonly store: SqliteStore,
    private readonly deps: BackfillDeps,
  ) {}

  private copyMissingNotes() {
    this.store.transaction(() => {
      this.store.db.exec(`
        INSERT OR IGNORE INTO cards(id,user_id,type,scene,title,title_by,quote,quote_on,origin,src_id,point_id,created_at,updated_at)
        SELECT 'card_'||id, user_id, 'idea',
               CASE WHEN point_id IS NULL THEN 'life' ELSE 'study' END,
               title, CASE WHEN status='organized' AND title_edited=0 THEN 'ai' ELSE 'user' END,
               text, date(created_at,'+8 hours'), 'note', id, point_id, created_at, updated_at
        FROM notes;
        INSERT INTO card_versions(card_id,user_id,kind,by,data,created_at)
        SELECT 'card_'||n.id, n.user_id, 'create', 'system', '{"from":"note"}', n.created_at
        FROM notes n
        WHERE NOT EXISTS (
          SELECT 1 FROM card_versions v
          WHERE v.card_id='card_'||n.id AND v.kind='create' AND v.by='system'
        );
        INSERT INTO card_versions(card_id,user_id,kind,by,data,created_at)
        SELECT 'card_'||s.note_id, n.user_id, 'supplement', 'user', json_object('text',s.text), s.created_at
        FROM note_supplements s JOIN notes n ON n.id=s.note_id
        WHERE NOT EXISTS (
          SELECT 1 FROM card_versions v
          WHERE v.card_id='card_'||s.note_id AND v.kind='supplement'
            AND v.by='user' AND v.data=json_object('text',s.text) AND v.created_at=s.created_at
        );
      `);
    });
  }

  private pending(): CardRow[] {
    return this.store.db
      .prepare(
        `SELECT c.id,c.user_id,c.quote,c.scene,c.version,c.src_id
         FROM cards c
         WHERE c.origin='note' AND NOT EXISTS (
           SELECT 1 FROM card_versions v
           WHERE v.card_id=c.id AND v.kind='type' AND v.by='system'
         )
         ORDER BY c.created_at,c.id`,
      )
      .all()
      .map((row) => ({
        id: String(row.id),
        user_id: String(row.user_id),
        quote: row.quote === null ? null : String(row.quote),
        scene: row.scene as CardRow["scene"],
        version: Number(row.version),
        src_id: row.src_id === null ? null : String(row.src_id),
      }));
  }

  private async within<T>(
    call: (signal: AbortSignal) => Promise<T>,
    root?: AbortSignal,
  ): Promise<T> {
    root?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(root?.reason);
    if (root?.aborted) abort();
    else root?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      return await Promise.race([
        call(controller.signal),
        new Promise<T>((_resolve, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("backfill timeout")),
            { once: true },
          ),
        ),
      ]);
    } finally {
      clearTimeout(timer);
      root?.removeEventListener("abort", abort);
    }
  }

  private write(
    card: CardRow,
    crisis: boolean,
    type: CardType,
    root?: AbortSignal,
  ) {
    if (root?.aborted) return;
    const result = card.src_id
      ? (this.store.db
          .prepare("SELECT text,result FROM notes WHERE id=? AND user_id=?")
          .get(card.src_id, card.user_id) as
          | { text: string; result: string | null }
          | undefined)
      : undefined;
    const items = legacyResult(result?.result ?? null)?.items ?? [];
    const sources = new Map<string, string>();
    if (result) {
      sources.set("original", result.text);
      if (card.src_id)
        for (const row of this.store.db
          .prepare("SELECT id,text FROM note_supplements WHERE note_id=?")
          .all(card.src_id) as { id: string; text: string }[])
          sources.set(row.id, row.text);
    }
    const clear = items.filter((item) => item.group === "clear");
    const open = items
      .filter((item) => item.group !== "clear")
      .map((item) => ({
        key: item.id,
        cat: item.group,
        text: item.text,
        ...(item.sourceIds.length && sources.get(item.sourceIds[0]!)
          ? {
              quote: Array.from(sources.get(item.sourceIds[0]!)!)
                .slice(0, 30)
                .join(""),
            }
          : {}),
        by: "ai",
      }));
    const summary = clear.map((item) => item.text).join("\n");
    const slots = summary
      ? [{ key: typeKeys[type], text: summary, by: "ai" }]
      : [];
    this.store.transaction(() => {
      if (root?.aborted) return;
      const current = this.store.db
        .prepare("SELECT version FROM cards WHERE id=? AND user_id=?")
        .get(card.id, card.user_id) as { version: number } | undefined;
      if (!current || Number(current.version) !== card.version) return;
      this.store.db
        .prepare(
          `UPDATE cards
           SET type=?,crisis=?,summary=?,summary_by=?,slots=?,open=?,version=version+1
           WHERE id=? AND user_id=? AND version=? AND NOT EXISTS (
             SELECT 1 FROM card_versions v
             WHERE v.card_id=cards.id AND v.kind='type' AND v.by='system'
           )`,
        )
        .run(
          type,
          crisis ? 1 : 0,
          summary || null,
          summary ? "ai" : null,
          JSON.stringify(slots),
          JSON.stringify(open),
          card.id,
          card.user_id,
          card.version,
        );
      const { n } = this.store.db.prepare("SELECT changes() AS n").get() as {
        n: number;
      };
      if (n)
        this.store.db
          .prepare(
            "INSERT INTO card_versions(card_id,user_id,kind,by,data,created_at) VALUES(?,?, 'type','system','{}',?)",
          )
          .run(card.id, card.user_id, this.store.now());
    });
  }

  async run(root?: AbortSignal) {
    if (root?.aborted) return;
    this.copyMissingNotes();
    for (const card of this.pending()) {
      if (root?.aborted) return;
      const text = card.quote ?? "";
      let crisis = false;
      try {
        crisis = await (this.deps.schedule ?? ((run) => run()))(
          () =>
            this.within(
              (signal) => this.deps.checkCrisis(text, card.scene, signal),
              root,
            ),
          root,
        );
      } catch {
        if (root?.aborted) return;
        // Screening errors still use the keyword result, then ordinary type rules.
        crisis = hasCrisisWords(text);
      }
      if (crisis) {
        this.write(card, true, "idea", root);
        continue;
      }
      const ruled = ruleType(text);
      if (ruled) {
        this.write(card, false, ruled, root);
        continue;
      }
      try {
        const result = await (this.deps.schedule ?? ((run) => run()))(
          () => this.within((signal) => this.deps.classify(text, signal), root),
          root,
        );
        this.write(
          card,
          false,
          result.confidence >= 0.6 ? result.type : "idea",
          root,
        );
      } catch {
        if (root?.aborted) return;
        this.write(card, false, "idea", root);
      }
    }
  }
}

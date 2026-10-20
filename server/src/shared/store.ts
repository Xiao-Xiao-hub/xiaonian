/*
 * SQLite 持久层：打开连接、执行增量迁移，并提供事务和审计等通用能力。
 * 迁移历史属于已有数据的升级路径；追加迁移而不是改写旧迁移，业务查询仍由各领域服务负责。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { User } from "./domain.js";
import { now as businessNow, type Clock } from "./time.js";
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
type Audit = {
  id: string;
  actor: string;
  action: string;
  resourceId: string;
  details: Record<string, unknown>;
  createdAt: string;
};
// Append-only: a released entry is never edited; new tables come in a new entry.
export const MIGRATIONS = [
  `
        CREATE TABLE items(id TEXT PRIMARY KEY,data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE TABLE users(id TEXT PRIMARY KEY,openid TEXT NOT NULL UNIQUE,data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE TABLE sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
        CREATE INDEX sessions_expiry ON sessions(expires_at);
        CREATE TABLE orders(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),item_id TEXT NOT NULL REFERENCES items(id),data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX orders_owner ON orders(user_id);
        CREATE TABLE refunds(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX refunds_order ON refunds(order_id);
        CREATE TABLE idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,payload_hash TEXT NOT NULL,resource_id TEXT NOT NULL,PRIMARY KEY(scope,key));
        CREATE TABLE payment_events(event_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,order_id TEXT NOT NULL REFERENCES orders(id),created_at TEXT NOT NULL);
        CREATE TABLE transactions(transaction_id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE REFERENCES orders(id));
        CREATE TABLE audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,resource_id TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE INDEX audit_time ON audit(created_at);
      `,
  `
        CREATE TABLE materials(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('note','problem')),title TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','confirmed')),current_version INTEGER NOT NULL DEFAULT 0,image_path TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE INDEX materials_owner ON materials(user_id,updated_at);
        CREATE TABLE material_versions(material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,version INTEGER NOT NULL,origin TEXT NOT NULL CHECK(origin IN ('typed','ocr','edit')),text TEXT NOT NULL,paragraphs TEXT NOT NULL CHECK(json_valid(paragraphs)),answer TEXT,ocr TEXT CHECK(ocr IS NULL OR json_valid(ocr)),created_at TEXT NOT NULL,PRIMARY KEY(material_id,version));
        CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,material_id TEXT REFERENCES materials(id) ON DELETE CASCADE,kind TEXT NOT NULL,version INTEGER,params TEXT NOT NULL CHECK(json_valid(params)),params_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','unknown')),result TEXT CHECK(result IS NULL OR json_valid(result)),error_code TEXT,error_message TEXT,usage TEXT CHECK(usage IS NULL OR json_valid(usage)),created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT);
        CREATE INDEX jobs_dedupe ON jobs(user_id,kind,params_hash);
        CREATE INDEX jobs_queue ON jobs(status,created_at);
        CREATE INDEX jobs_material ON jobs(material_id);
        CREATE TABLE artifacts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,version INTEGER NOT NULL,kind TEXT NOT NULL,job_id TEXT,data TEXT NOT NULL CHECK(json_valid(data)),state TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(state)),created_at TEXT NOT NULL);
        CREATE INDEX artifacts_material ON artifacts(material_id,kind,created_at);
        CREATE TABLE attempts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,artifact_id TEXT REFERENCES artifacts(id) ON DELETE CASCADE,item INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL,answer TEXT NOT NULL,job_id TEXT,result TEXT CHECK(result IS NULL OR json_valid(result)),created_at TEXT NOT NULL);
        CREATE INDEX attempts_material ON attempts(material_id,created_at);
        CREATE TABLE reviews(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,material_id TEXT NOT NULL UNIQUE REFERENCES materials(id) ON DELETE CASCADE,box INTEGER NOT NULL CHECK(box BETWEEN 1 AND 5),due_on TEXT NOT NULL,last_reviewed_at TEXT,created_at TEXT NOT NULL);
        CREATE INDEX reviews_due ON reviews(user_id,due_on);
        CREATE TABLE review_logs(id TEXT PRIMARY KEY,review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,outcome TEXT NOT NULL CHECK(outcome IN ('remembered','forgot')),box_before INTEGER NOT NULL,box_after INTEGER NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE reports(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,reason TEXT NOT NULL,note TEXT,created_at TEXT NOT NULL);
      `,
  // The commerce prototype's tables; they never held learning data.
  `
        DROP TABLE transactions;
        DROP TABLE payment_events;
        DROP TABLE refunds;
        DROP TABLE orders;
        DROP TABLE idempotency;
        DROP TABLE items;
      `,
  // Free chat with the tutor, photos read for it, and product analytics events.
  `
        CREATE TABLE threads(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,material_id TEXT REFERENCES materials(id) ON DELETE SET NULL,data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE INDEX threads_owner ON threads(user_id,updated_at);
        CREATE TABLE messages(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('user','assistant')),kind TEXT NOT NULL,content TEXT NOT NULL DEFAULT '',data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)),status TEXT NOT NULL CHECK(status IN ('streaming','done','failed')),client_id TEXT,usage TEXT CHECK(usage IS NULL OR json_valid(usage)),charged INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
        CREATE INDEX messages_thread ON messages(thread_id,created_at);
        CREATE INDEX messages_charged ON messages(user_id,charged,created_at);
        CREATE UNIQUE INDEX messages_client ON messages(user_id,client_id) WHERE client_id IS NOT NULL;
        CREATE TABLE chat_images(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,path TEXT NOT NULL,scan TEXT CHECK(scan IS NULL OR json_valid(scan)),usage TEXT CHECK(usage IS NULL OR json_valid(usage)),charged INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
        CREATE INDEX chat_images_owner ON chat_images(user_id,created_at);
        CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)),created_at TEXT NOT NULL);
        CREATE INDEX events_time ON events(created_at);
        CREATE INDEX events_user ON events(user_id,created_at);
      `,
  // 错题本 : one entry per problem the learner got wrong.
  `
        CREATE TABLE mistakes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,source TEXT NOT NULL CHECK(source IN ('judge','grade')),answer TEXT NOT NULL DEFAULT '',cause TEXT,chapter TEXT,wrong INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL CHECK(status IN ('open','mastered')),due_on TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,mastered_at TEXT,UNIQUE(user_id,material_id));
        CREATE INDEX mistakes_owner ON mistakes(user_id,status,due_on);
      `,
  // 学习地图 : one row per learner and map point, chapters set to 不学,
  // and 这题有问题 reports. *_at are ISO times, *_on Beijing dates (YYYY-MM-DD).
  `
        CREATE TABLE map_points(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,point_id TEXT NOT NULL,correct_at TEXT,self_at TEXT,seen_at TEXT,practice_on TEXT,reviewed_on TEXT,due_on TEXT,interval INTEGER,red INTEGER NOT NULL DEFAULT 0 CHECK(red IN (0,1)),updated_at TEXT NOT NULL,PRIMARY KEY(user_id,point_id));
        CREATE TABLE map_chapters(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,chapter_id TEXT NOT NULL,hidden_at TEXT NOT NULL,PRIMARY KEY(user_id,chapter_id));
        CREATE TABLE map_reports(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,point_id TEXT NOT NULL,reason TEXT NOT NULL,note TEXT,answer TEXT,understood TEXT,verdict TEXT CHECK(verdict IS NULL OR verdict IN ('correct','incorrect','unsure')),created_at TEXT NOT NULL);
        CREATE INDEX map_reports_point ON map_reports(point_id,created_at);
        CREATE INDEX map_reports_owner ON map_reports(user_id,created_at);
      `,
  // Personal notes : keep the user's words verbatim, without AI processing.
  `
        CREATE TABLE notes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,text TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'raw' CHECK(status='raw'),result TEXT CHECK(result IS NULL OR json_valid(result)),point_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE INDEX notes_owner_created ON notes(user_id,created_at DESC,id DESC);
      `,
  // retain the displayed variant and structured feedback without guessing
  // historical indexes. Old scalar strings stay in their original columns.
  `
        ALTER TABLE map_reports ADD COLUMN problem_index INTEGER CHECK(problem_index IS NULL OR problem_index IN (0,1));
        ALTER TABLE map_reports ADD COLUMN problem_kind TEXT CHECK(problem_kind IS NULL OR problem_kind IN ('number','expr','antiderivative','multi','choice'));
        ALTER TABLE map_reports ADD COLUMN answer_json TEXT CHECK(answer_json IS NULL OR json_valid(answer_json));
        ALTER TABLE map_reports ADD COLUMN understood_json TEXT CHECK(understood_json IS NULL OR json_valid(understood_json));
      `,
  // preserve original notes, separate supplements, guard asynchronous edits.
  `
        CREATE TABLE notes_next(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,text TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'raw' CHECK(status IN ('raw','organized')),result TEXT CHECK(result IS NULL OR json_valid(result)),point_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),source_version INTEGER NOT NULL DEFAULT 1 CHECK(source_version>=1),result_version INTEGER NOT NULL DEFAULT 0 CHECK(result_version>=0),title_edited INTEGER NOT NULL DEFAULT 1 CHECK(title_edited IN(0,1)));
        INSERT INTO notes_next(id,user_id,text,title,status,result,point_id,created_at,updated_at) SELECT id,user_id,text,title,status,result,point_id,created_at,updated_at FROM notes;
        DROP TABLE notes;
        ALTER TABLE notes_next RENAME TO notes;
        CREATE INDEX notes_owner_created ON notes(user_id,created_at DESC,id DESC);
        CREATE TABLE note_supplements(id TEXT PRIMARY KEY,note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,client_id TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(note_id,client_id));
        CREATE INDEX note_supplements_note ON note_supplements(note_id,created_at);
      `,
  // confirmed tool links; old mistakes are intentionally left unlinked.
  `
        ALTER TABLE mistakes ADD COLUMN map_point_id TEXT;
        ALTER TABLE mistakes ADD COLUMN map_version INTEGER CHECK(map_version IS NULL OR map_version>=1);
        ALTER TABLE map_points ADD COLUMN tool_epoch INTEGER NOT NULL DEFAULT 0 CHECK(tool_epoch>=0);
      `,
  // Anonymous provider attempts survive deletion of personal learning records.
  // No backfill: historic records cannot reconstruct missing/deleted usage.
  `
        CREATE TABLE usage_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed','unknown')),prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR prompt_tokens>=0),completion_tokens INTEGER CHECK(completion_tokens IS NULL OR completion_tokens>=0),duration_ms INTEGER,created_at TEXT NOT NULL,finished_at TEXT);
        CREATE INDEX usage_ledger_time ON usage_ledger(created_at);
      `,
  // Content deletion must not refund a daily allowance. These content-free
  // receipts belong to the account, not to the removable learning records.
  // Preserve the existing contract: every job, but only charged chat/photos.
  `
        CREATE TABLE quota_receipts(source TEXT NOT NULL CHECK(source IN ('job','chat','photo')),source_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(source,source_id));
        CREATE INDEX quota_receipts_owner ON quota_receipts(user_id,source,created_at);
        CREATE INDEX quota_receipts_time ON quota_receipts(source,created_at);
        INSERT INTO quota_receipts SELECT 'job',id,user_id,kind,created_at FROM jobs;
        INSERT INTO quota_receipts SELECT 'chat',id,user_id,kind,created_at FROM messages WHERE charged=1;
        INSERT INTO quota_receipts SELECT 'photo',id,user_id,'photo',created_at FROM chat_images WHERE charged=1;
        CREATE TRIGGER quota_job_insert AFTER INSERT ON jobs BEGIN
          INSERT OR IGNORE INTO quota_receipts VALUES('job',NEW.id,NEW.user_id,NEW.kind,NEW.created_at);
        END;
        CREATE TRIGGER quota_chat_insert AFTER INSERT ON messages WHEN NEW.charged=1 BEGIN
          INSERT OR IGNORE INTO quota_receipts VALUES('chat',NEW.id,NEW.user_id,NEW.kind,NEW.created_at);
        END;
        CREATE TRIGGER quota_chat_charge AFTER UPDATE OF charged ON messages WHEN NEW.charged=1 BEGIN
          INSERT OR IGNORE INTO quota_receipts VALUES('chat',NEW.id,NEW.user_id,NEW.kind,NEW.created_at);
        END;
        CREATE TRIGGER quota_photo_insert AFTER INSERT ON chat_images WHEN NEW.charged=1 BEGIN
          INSERT OR IGNORE INTO quota_receipts VALUES('photo',NEW.id,NEW.user_id,'photo',NEW.created_at);
        END;
        CREATE TRIGGER quota_photo_charge AFTER UPDATE OF charged ON chat_images WHEN NEW.charged=1 BEGIN
          INSERT OR IGNORE INTO quota_receipts VALUES('photo',NEW.id,NEW.user_id,'photo',NEW.created_at);
        END;
      `,
  // red_due: today's due date came from a red dot, so a correct review
  // keeps the interval. notes.client_id makes a retried create idempotent.
  `
        ALTER TABLE map_points ADD COLUMN red_due INTEGER NOT NULL DEFAULT 0 CHECK(red_due IN (0,1));
        ALTER TABLE notes ADD COLUMN client_id TEXT;
        CREATE UNIQUE INDEX notes_client ON notes(user_id,client_id) WHERE client_id IS NOT NULL;
      `,
  // AI endpoints tried in position order with failover; settings holds
  // admin-editable JSON values such as the per-scenario thinking levels.
  `
        CREATE TABLE ai_endpoints(id TEXT PRIMARY KEY,alias TEXT NOT NULL UNIQUE,base_url TEXT NOT NULL,api_key TEXT NOT NULL,model TEXT NOT NULL,vision INTEGER NOT NULL DEFAULT 0 CHECK(vision IN (0,1)),thinking_format TEXT NOT NULL DEFAULT 'none' CHECK(thinking_format IN ('none','reasoning_effort','thinking_type','enable_thinking')),extra_body TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(extra_body)),timeout_ms INTEGER NOT NULL DEFAULT 90000,position INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL CHECK(json_valid(value)),updated_at TEXT NOT NULL);
        ALTER TABLE usage_ledger ADD COLUMN endpoint TEXT;
      `,
  // Admin workbench : a banned account keeps only export, erase and
  // logout; quota holds per-account daily limits over the global ones; a
  // learner report is marked handled once the maintainer has looked at it;
  // audit_actor finds an account's last login for the user list.
  `
        ALTER TABLE users ADD COLUMN banned_at TEXT;
        ALTER TABLE users ADD COLUMN ban_reason TEXT;
        ALTER TABLE users ADD COLUMN quota TEXT CHECK(quota IS NULL OR json_valid(quota));
        ALTER TABLE map_reports ADD COLUMN handled_at TEXT;
        ALTER TABLE map_reports ADD COLUMN handled_note TEXT;
        ALTER TABLE reports ADD COLUMN handled_at TEXT;
        ALTER TABLE reports ADD COLUMN handled_note TEXT;
        CREATE INDEX audit_actor ON audit(actor,created_at);
      `,
  // v2 guided AI foundation : cards, continuation, import and retest.
  `
        CREATE TABLE cards(
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK(type IN ('spark','idea','question','method')),
          scene TEXT NOT NULL CHECK(scene IN ('study','life','mood')),
          title TEXT NOT NULL,
          title_by TEXT NOT NULL CHECK(title_by IN ('user','ai')),
          summary TEXT,
          summary_by TEXT CHECK(summary_by IS NULL OR summary_by IN ('user','ai')),
          mine TEXT,
          mine_at TEXT,
          quote TEXT,
          quote_on TEXT,
          slots TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(slots)),
          open TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(open)),
          next TEXT CHECK(next IS NULL OR json_valid(next)),
          organized_at TEXT,
          closed_at TEXT,
          origin TEXT NOT NULL CHECK(origin IN ('jot','chat','import','brainstorm','mistake','map','note')),
          src_id TEXT,
          message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
          mistake_id TEXT REFERENCES mistakes(id) ON DELETE SET NULL,
          point_id TEXT,
          saw_answer INTEGER NOT NULL DEFAULT 0 CHECK(saw_answer IN (0,1)),
          resume TEXT NOT NULL DEFAULT 'on' CHECK(resume IN ('on','off','manual')),
          use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count>=0),
          crisis INTEGER NOT NULL DEFAULT 0 CHECK(crisis IN (0,1)),
          version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX cards_wall ON cards(user_id,updated_at);
        CREATE INDEX cards_point ON cards(user_id,point_id) WHERE point_id IS NOT NULL;

        CREATE TABLE card_versions(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('create','slots','mine','type','tags','followup','resume_answer','supplement','close','edit')),
          by TEXT NOT NULL CHECK(by IN ('user','ai','system')),
          data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)),
          created_at TEXT NOT NULL
        );
        CREATE INDEX card_versions_card ON card_versions(card_id,id);

        CREATE TABLE card_links(
          a TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          b TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          by TEXT NOT NULL CHECK(by IN ('user','brainstorm')),
          brainstorm_id TEXT REFERENCES brainstorms(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(a,b), CHECK(a<b)
        );

        CREATE TABLE card_uses(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('chat','brainstorm')),
          ref_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(card_id,kind,ref_id)
        );

        CREATE TABLE tags(
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 6),
          color INTEGER NOT NULL CHECK(color BETWEEN 0 AND 7),
          by TEXT NOT NULL CHECK(by IN ('user','ai')),
          created_at TEXT NOT NULL,
          UNIQUE(user_id,name)
        );
        CREATE TABLE card_tags(
          card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          PRIMARY KEY(card_id,tag_id)
        );
        CREATE INDEX card_tags_tag ON card_tags(user_id,tag_id);

        CREATE TABLE resume_items(
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          src TEXT NOT NULL CHECK(src IN ('card','point','mistake','brainstorm','import','batch')),
          src_id TEXT NOT NULL,
          item_key TEXT NOT NULL,
          kind TEXT NOT NULL,
          quote TEXT,
          quote_on TEXT,
          quote_by TEXT CHECK(quote_by IS NULL OR quote_by IN ('user','ai')),
          due_on TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'waiting' CHECK(state IN ('waiting','shown','done','let_go','snoozed','dormant','never')),
          shown_on TEXT,
          no_resp INTEGER NOT NULL DEFAULT 0 CHECK(no_resp>=0),
          remind_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(user_id,src,src_id,item_key)
        );
        CREATE INDEX resume_items_due ON resume_items(user_id,state,due_on);

        CREATE TABLE brainstorms(
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          scene TEXT NOT NULL CHECK(scene IN ('study','life','mood')),
          size TEXT NOT NULL CHECK(size IN ('small','medium','large')),
          cards TEXT NOT NULL CHECK(json_valid(cards)),
          facts TEXT CHECK(facts IS NULL OR json_valid(facts)),
          result TEXT CHECK(result IS NULL OR json_valid(result)),
          picks TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(picks)),
          out_cards TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(out_cards)),
          status TEXT NOT NULL CHECK(status IN ('picked','running','ready','paused','saved')),
          job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE imports(
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          source TEXT NOT NULL CHECK(source IN ('paste','photo','screenshot','txt','md','docx','pdf')),
          file_name TEXT,
          own INTEGER NOT NULL DEFAULT 0 CHECK(own IN (0,1)),
          segments TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(segments)),
          pages TEXT CHECK(pages IS NULL OR json_valid(pages)),
          candidates TEXT CHECK(candidates IS NULL OR json_valid(candidates)),
          status TEXT NOT NULL CHECK(status IN ('reading','read','splitting','picking','saved','abandoned')),
          job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE retests(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          point_id TEXT NOT NULL,
          cause TEXT NOT NULL CHECK(cause IN ('explanation','hint','ask','stuck','wrong')),
          problem_index INTEGER NOT NULL CHECK(problem_index>=0),
          round INTEGER NOT NULL CHECK(round IN (1,2)),
          due_on TEXT NOT NULL,
          predicted TEXT CHECK(predicted IS NULL OR predicted IN ('yes','unsure','no')),
          result TEXT CHECK(result IS NULL OR result IN ('right','wrong','hinted','early','dropped')),
          created_at TEXT NOT NULL,
          done_at TEXT
        );
        CREATE UNIQUE INDEX retests_open ON retests(user_id,point_id) WHERE done_at IS NULL;
        CREATE INDEX retests_due ON retests(user_id,due_on) WHERE done_at IS NULL;

        ALTER TABLE threads ADD COLUMN scene TEXT NOT NULL DEFAULT 'study' CHECK(scene IN ('study','life','mood'));
        ALTER TABLE threads ADD COLUMN mode TEXT NOT NULL DEFAULT 'guide' CHECK(mode IN ('guide','teach'));
        ALTER TABLE threads ADD COLUMN mood_cards INTEGER NOT NULL DEFAULT 0 CHECK(mood_cards IN (0,1));
        ALTER TABLE map_points ADD COLUMN stuck_at TEXT;
        ALTER TABLE usage_ledger ADD COLUMN scene TEXT;
        ALTER TABLE usage_ledger ADD COLUMN cached_tokens INTEGER CHECK(cached_tokens IS NULL OR cached_tokens>=0);

        INSERT INTO cards(id,user_id,type,scene,title,title_by,quote,quote_on,origin,src_id,point_id,created_at,updated_at)
        SELECT 'card_'||id, user_id, 'idea',
               CASE WHEN point_id IS NULL THEN 'life' ELSE 'study' END,
               title, CASE WHEN status='organized' AND title_edited=0 THEN 'ai' ELSE 'user' END,
               text, date(created_at,'+8 hours'), 'note', id, point_id, created_at, updated_at
        FROM notes;
        INSERT INTO card_versions(card_id,user_id,kind,by,data,created_at)
        SELECT 'card_'||id, user_id, 'create', 'system', '{"from":"note"}', created_at FROM notes;
        INSERT INTO card_versions(card_id,user_id,kind,by,data,created_at)
        SELECT 'card_'||s.note_id, n.user_id, 'supplement', 'user', json_object('text',s.text), s.created_at
        FROM note_supplements s JOIN notes n ON n.id=s.note_id;
      `,
];
export class SqliteStore {
  readonly db: DatabaseSync;
  constructor(
    path: string,
    private clock: Clock = businessNow,
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
    );
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
    );
    const version = Number(
      (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations",
          )
          .get() as { v: number }
      ).v,
    );
    if (version > MIGRATIONS.length)
      throw new Error(
        `Database schema v${version} is newer than this server (v${MIGRATIONS.length})`,
      );
    for (let next = version + 1; next <= MIGRATIONS.length; next++)
      this.transaction(() => {
        this.db.exec(MIGRATIONS[next - 1]!);
        this.db
          .prepare("INSERT INTO schema_migrations VALUES(?,?)")
          .run(next, this.now());
      });
    this.addColumns();
  }
  // v3 columns added idempotently so an older server can still open the file
  // (schema version stays 16).
  private addColumns() {
    const has = (table: string, column: string) =>
      (
        this.db.prepare(`PRAGMA table_info(${table})`).all() as {
          name: string;
        }[]
      ).some((row) => row.name === column);
    this.transaction(() => {
      if (!has("cards", "favorite"))
        this.db.exec(
          "ALTER TABLE cards ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1))",
        );
      if (!has("cards", "remind_on"))
        this.db.exec("ALTER TABLE cards ADD COLUMN remind_on TEXT");
      // 0.6.0 题库 : a point's bank runs past the two problems that
      // problem_index's CHECK allows, so reports keep the served position
      // here and leave problem_index empty past 1.
      if (!has("map_reports", "bank_index"))
        this.db.exec(
          "ALTER TABLE map_reports ADD COLUMN bank_index INTEGER CHECK(bank_index IS NULL OR bank_index>=0)",
        );
      // 0.6.0 题库 : 'bank' when the report came from the 0.6.0 page,
      // which shows the problem as the bank serves it (four options, merged
      // questions); empty for the point page form of 0.5.0 and older.
      if (!has("map_reports", "form"))
        this.db.exec(
          "ALTER TABLE map_reports ADD COLUMN form TEXT CHECK(form IS NULL OR form IN ('bank'))",
        );
      // 0.6.0 题库 : map_points.attempts, the bank problems a learner
      // has answered or seen as the worked example (learn/service.ts
      // Attempts); exported and erased with map_points.
      if (!has("map_points", "attempts"))
        this.db.exec(
          "ALTER TABLE map_points ADD COLUMN attempts TEXT CHECK(attempts IS NULL OR json_valid(attempts))",
        );
      if (!has("brainstorms", "report"))
        this.db.exec(
          "ALTER TABLE brainstorms ADD COLUMN report TEXT CHECK(report IS NULL OR json_valid(report))",
        );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS cards_favorite ON cards(user_id,favorite)",
      );
      // v4 学习时长: seconds per Beijing day. Deleted with the account.
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS study_days(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,day TEXT NOT NULL,seconds INTEGER NOT NULL CHECK(seconds BETWEEN 0 AND 86400),updated_at TEXT NOT NULL,PRIMARY KEY(user_id,day))",
      );
      // v4 提醒频率 : one row per card that repeats its reminder;
      // cards.remind_on stays the next date. Gone with the card or the account.
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS card_reminders(card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,every TEXT NOT NULL CHECK(every IN ('day','week')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL)",
      );
      // 0.6.0 聊天附件 : a photo (its file and allowance stay in
      // chat_images) or a document's name, size, type and the text read from
      // it (the file itself is never kept). thread_id and message_id are empty
      // until it is sent; every reference cascades, so an older server that
      // deletes the conversation, the photo or the account takes these along.
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS chat_attachments(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('image','file')),image_id TEXT REFERENCES chat_images(id) ON DELETE CASCADE,name TEXT NOT NULL,size INTEGER NOT NULL CHECK(size>=0),type TEXT NOT NULL,text TEXT,chars INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL)",
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS chat_attachments_owner ON chat_attachments(user_id,created_at)",
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS chat_attachments_message ON chat_attachments(message_id)",
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS chat_attachments_thread ON chat_attachments(thread_id)",
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS chat_attachments_image ON chat_attachments(image_id)",
      );
      // V4.2 failures are free (W0): a quota receipt with a row here is not
      // counted. A column on quota_receipts is impossible: its insert triggers
      // list no columns. Older servers ignore the table and count as before.
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS quota_voids(source TEXT NOT NULL,source_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,job_id TEXT,created_at TEXT NOT NULL,PRIMARY KEY(source,source_id))",
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS quota_voids_job ON quota_voids(job_id)",
      );
      // V4.2 卡片类别 : kind is one of the seven kinds (cards.type keeps
      // the four-way value old clients read); follow is what happens after
      // saving (review/done/chat/none); merged_into hides a merged original
      // behind the merged card. NULL means the v4.1 behaviour.
      if (!has("cards", "kind"))
        this.db.exec("ALTER TABLE cards ADD COLUMN kind TEXT");
      if (!has("cards", "follow"))
        this.db.exec("ALTER TABLE cards ADD COLUMN follow TEXT");
      if (!has("cards", "merged_into"))
        this.db.exec("ALTER TABLE cards ADD COLUMN merged_into TEXT");
      // V4.2 错题本: how an entry became 弄懂了, 'self' (我会了) or 'redo'
      // (redone right once due); NULL before V4.2 or from an older server,
      // and cleared when it reopens.
      if (!has("mistakes", "mastered_by"))
        this.db.exec(
          "ALTER TABLE mistakes ADD COLUMN mastered_by TEXT CHECK(mastered_by IS NULL OR mastered_by IN ('self','redo'))",
        );
      // V4.2 卡点 help (learn/service.ts StuckHelp): the question, the reply
      // and whether it was charged, to read again after leaving the page.
      // An older server leaves it alone; the new one shows it only while the
      // point is stuck since it was asked.
      if (!has("map_points", "stuck_help"))
        this.db.exec(
          "ALTER TABLE map_points ADD COLUMN stuck_help TEXT CHECK(stuck_help IS NULL OR json_valid(stuck_help))",
        );
      // V4.2 旧练习: the key a client sends with an answer, so sending it
      // again (a retry after a dropped reply) returns the same attempt instead
      // of judging it twice. NULL from older clients and servers.
      if (!has("attempts", "client_key"))
        this.db.exec("ALTER TABLE attempts ADD COLUMN client_key TEXT");
      // V4.2 聊一聊 : where in the document a file attachment's kept text
      // starts (接着读后面); NULL is the start, as before.
      if (!has("chat_attachments", "text_from"))
        this.db.exec("ALTER TABLE chat_attachments ADD COLUMN text_from INTEGER");
      // V4.2 导入 : JSON {rest, mathImages, images}: the text left past
      // the 20000-character limit, to import next, and the pictures a
      // document had that were not read. NULL means none (v4.1 behaviour).
      if (!has("imports", "extra"))
        this.db.exec(
          "ALTER TABLE imports ADD COLUMN extra TEXT CHECK(extra IS NULL OR json_valid(extra))",
        );
      // V4.2 额度按消耗 : the token usage of each succeeded AI action,
      // priced at read time (shared/budget.ts). Owned by the account like
      // quota_receipts, so deleting content refunds nothing; a column there
      // is impossible (its triggers list no columns). Older servers ignore it.
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS quota_spend(source TEXT NOT NULL,source_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,usage TEXT NOT NULL CHECK(json_valid(usage)),created_at TEXT NOT NULL,PRIMARY KEY(source,source_id))",
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS quota_spend_owner ON quota_spend(user_id,created_at)",
      );
    });
  }
  useClock(clock: Clock) {
    this.clock = clock;
  }
  now() {
    return this.clock().toISOString();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  getUser(id: string): User | undefined {
    const row = this.db.prepare("SELECT data FROM users WHERE id=?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as User) : undefined;
  }
  upsertUser(
    openid: string,
    nickname: string,
    authMode: User["authMode"],
  ): User {
    const old = this.db
      .prepare("SELECT data FROM users WHERE openid=?")
      .get(openid) as { data: string } | undefined;
    if (old) return JSON.parse(old.data) as User;
    const user: User = {
      id: `usr_${randomUUID().replaceAll("-", "")}`,
      nickname,
      openid,
      authMode,
      role: "user",
      createdAt: this.now(),
    };
    this.db
      .prepare("INSERT INTO users(id,openid,data) VALUES(?,?,?)")
      .run(user.id, openid, JSON.stringify(user));
    return user;
  }
  // Admin-owned account state, kept out of the user JSON the client sees.
  control(id: string) {
    const row = this.db
      .prepare("SELECT banned_at,ban_reason,quota FROM users WHERE id=?")
      .get(id) as
      | {
          banned_at: string | null;
          ban_reason: string | null;
          quota: string | null;
        }
      | undefined;
    return {
      bannedAt: row?.banned_at ?? null,
      banReason: row?.ban_reason ?? null,
      quota: (row?.quota ? JSON.parse(row.quota) : {}) as Record<
        string,
        number
      >,
    };
  }
  setting<T>(key: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  saveSetting(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      )
      .run(key, JSON.stringify(value), this.now());
  }
  audit(
    actor: string,
    action: string,
    resourceId: string,
    details: Record<string, unknown> = {},
  ) {
    this.db
      .prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)")
      .run(
        randomUUID(),
        actor,
        action,
        resourceId,
        JSON.stringify(details),
        this.now(),
      );
  }
  // Newest 500 matching entries. action matches a prefix ("user." finds every
  // account action), actor matches exactly, from/to are ISO instants.
  audits(
    filter: {
      action?: string;
      actor?: string;
      from?: string;
      to?: string;
    } = {},
  ): Audit[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.action) {
      where.push("substr(action,1,?)=?");
      args.push(filter.action.length, filter.action);
    }
    if (filter.actor) {
      where.push("actor=?");
      args.push(filter.actor);
    }
    if (filter.from) {
      where.push("created_at>=?");
      args.push(filter.from);
    }
    if (filter.to) {
      where.push("created_at<?");
      args.push(filter.to);
    }
    return (
      this.db
        .prepare(
          `SELECT id,actor,action,resource_id,details,created_at FROM audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid DESC LIMIT 500`,
        )
        .all(...args) as Record<string, string>[]
    ).map((r) => ({
      id: r.id!,
      actor: r.actor!,
      action: r.action!,
      resourceId: r.resource_id!,
      details: JSON.parse(r.details!),
      createdAt: r.created_at!,
    }));
  }
  health() {
    this.db.prepare("SELECT 1").get();
    return true;
  }
  close() {
    this.db.close();
  }
}

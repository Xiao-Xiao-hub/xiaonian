import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ChatService } from "../server/src/modules/chat/service.js";
import { ProviderError } from "../server/src/providers/llm.js";
import { SqliteStore } from "../server/src/shared/store.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);
const scan = {
  type: "problems",
  problems: [{ text: "1+1=?", unclear: "" }],
  solution: null,
  homework: [],
  notes: "",
};
function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "zhiye-lifecycle-"));
  const store = new SqliteStore(":memory:");
  const user = store.upsertUser("dev:lifecycle", "test", "dev");
  let now = new Date("2026-10-19T12:00:00Z");
  const vision = {
    configured: true,
    json: async (): Promise<unknown> => ({
      data: scan,
      usage: { calls: 1, model: "mock", promptTokens: 5, completionTokens: 10 },
    }),
  };
  const llm = {
    json: async (): Promise<unknown> => ({
      data: {
        steps: [{ status: "ok", note: "" }],
        first: null,
        summary: "正确",
      },
      usage: {},
    }),
  };
  const chat = new ChatService({
    store,
    uploadDir: root,
    limits: { answers: 20, photos: 20 },
    vision,
    llm,
    markdown: { render: async () => [] },
    now: () => now,
  } as unknown as ConstructorParameters<typeof ChatService>[0]);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const thread = (id: string, data: object) => {
    store.db
      .prepare(
        "INSERT INTO threads(id,user_id,title,data,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        user.id,
        id,
        JSON.stringify(data),
        now.toISOString(),
        now.toISOString(),
      );
  };
  const message = (id: string, data: object) => {
    store.db
      .prepare(
        "INSERT INTO messages(id,thread_id,user_id,role,kind,data,status,created_at) VALUES(?,?,?,'user','problem',?,'done',?)",
      )
      .run(`msg_${id}`, id, user.id, JSON.stringify(data), now.toISOString());
  };
  const path = (id: string) => {
    const row = store.db
      .prepare("SELECT path FROM chat_images WHERE id=?")
      .get(id);
    return row ? join(root, String(row.path)) : null;
  };
  return {
    store,
    user,
    chat,
    llm,
    vision,
    thread,
    message,
    root,
    path,
    advance: () => {
      now = new Date("2026-10-23T12:00:00Z");
    },
  };
}

for (const ref of [
  "thread",
  "message",
  "messageAttachment",
  "homework",
  "attachment",
] as const) {
  test(`deleting one question preserves a photo used by another ${ref}, and deleting the last reference removes it`, async (t) => {
    const f = setup(t);
    const { imageId } = await f.chat.scan(f.user.id, PNG, "sky");
    const path = f.path(imageId)!;
    f.thread("one", { imageId });
    f.thread(
      "two",
      ref === "thread"
        ? { imageId }
        : ref === "homework"
          ? { homework: { imageId, items: [] } }
          : {},
    );
    if (ref === "message") f.message("two", { images: [imageId] });
    if (ref === "messageAttachment")
      f.message("two", { attachments: [{ imageId }] });
    if (ref === "attachment")
      f.store.db
        .prepare(
          "INSERT INTO chat_attachments(id,user_id,thread_id,kind,image_id,name,size,type,created_at) VALUES('att',?,'two','image',?,'photo',1,'png',?)",
        )
        .run(f.user.id, imageId, new Date().toISOString());
    f.chat.remove(f.user.id, "one");
    assert.ok(f.path(imageId));
    assert.deepEqual(f.chat.image(f.user.id, imageId).data, PNG);
    assert.ok(existsSync(path));
    f.chat.remove(f.user.id, "two");
    assert.equal(f.path(imageId), null);
    assert.equal(existsSync(path), false);
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) n FROM quota_receipts WHERE source='photo'")
        .get()!.n,
      1,
      "deleting content does not refund a successful scan",
    );
  });
}

test("a real homework record keeps its original image until the homework is removed", async (t) => {
  const f = setup(t);
  f.vision.json = async () => ({
    data: {
      ...scan,
      type: "homework",
      homework: [
        { no: "1", text: "1+1=?", steps: [], unclear: "看不清" },
        { no: "2", text: "2+2=?", steps: [], unclear: "看不清" },
      ],
    },
    usage: {},
  });
  const { imageId } = await f.chat.scan(f.user.id, PNG, "sky");
  const path = f.path(imageId)!;
  const page = await f.chat.homework(f.user.id, imageId, "sky");
  f.chat.remove(f.user.id, page.id);
  assert.equal(f.path(imageId), null);
  assert.equal(existsSync(path), false);
});

test("images referenced only by a homework child disappear with its parent", async (t) => {
  const f = setup(t);
  const { imageId } = await f.chat.scan(f.user.id, PNG, "sky");
  const path = f.path(imageId)!;
  f.thread("parent", {});
  f.thread("child", { homeworkOf: "parent", imageId });
  f.chat.remove(f.user.id, "parent");
  assert.equal(f.path(imageId), null);
  assert.equal(existsSync(path), false);
});

for (const operation of ["detach", "sweep"] as const) {
  test(`${operation} removes an unsent attachment but preserves its photo used by a question`, async (t) => {
    const f = setup(t);
    const a = await f.chat.attach(f.user.id, { data: PNG, name: "photo.png" });
    const imageId = a.imageId!;
    const path = f.path(imageId)!;
    f.thread("question", { imageId });
    if (operation === "detach") f.chat.detach(f.user.id, a.id);
    else {
      f.advance();
      assert.equal(f.chat.sweepStale(), 1);
    }
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) n FROM chat_attachments").get()!.n,
      0,
    );
    assert.ok(f.path(imageId));
    assert.ok(existsSync(path));
    f.chat.remove(f.user.id, "question");
    assert.equal(existsSync(path), false);
  });
}

test("a rolled back conversation deletion never unlinks the photo", async (t) => {
  const f = setup(t);
  const { imageId } = await f.chat.scan(f.user.id, PNG, "sky");
  const path = f.path(imageId)!;
  f.thread("one", { imageId });
  assert.throws(
    () =>
      f.store.transaction(() => {
        f.chat.removeRecords(f.user.id, "one");
        throw new Error("synthetic rollback");
      }),
    /synthetic rollback/,
  );
  assert.ok(f.path(imageId));
  assert.ok(existsSync(path));
  assert.ok(f.store.db.prepare("SELECT id FROM threads WHERE id='one'").get());
});

test("failed recognition immediately removes bytes and the row, charges nothing, and releases the scan slot", async (t) => {
  const f = setup(t);
  f.vision.json = async () => {
    throw new ProviderError("AI_TIMEOUT", "synthetic timeout");
  };
  await assert.rejects(f.chat.scan(f.user.id, PNG, "sky"), {
    code: "SCAN_FAILED",
  });
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM chat_images").get()!.n,
    0,
  );
  assert.deepEqual(readdirSync(join(f.root, f.user.id, "chat")), []);
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM quota_receipts").get()!.n,
    0,
  );
  f.vision.json = async () => ({ data: scan, usage: {} });
  assert.ok((await f.chat.scan(f.user.id, PNG, "sky")).imageId);
});

test("an image-row insertion failure removes bytes already written and does not call vision", async (t) => {
  const f = setup(t);
  let calls = 0;
  f.vision.json = async () => {
    calls++;
    return { data: scan, usage: {} };
  };
  f.store.db.exec(
    "CREATE TRIGGER fail_test_scan BEFORE INSERT ON chat_images BEGIN SELECT RAISE(ABORT,'synthetic insert failure'); END",
  );
  await assert.rejects(
    f.chat.scan(f.user.id, PNG, "sky"),
    /synthetic insert failure/,
  );
  assert.deepEqual(readdirSync(join(f.root, f.user.id, "chat")), []);
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM chat_images").get()!.n,
    0,
  );
  assert.equal(calls, 0);
});

test("saving a recognition failure rolls back its quota receipt before removing the photo", async (t) => {
  const f = setup(t);
  f.store.db.exec(
    "CREATE TRIGGER fail_test_result BEFORE UPDATE OF scan ON chat_images BEGIN SELECT RAISE(ABORT,'synthetic result failure'); END",
  );
  await assert.rejects(
    f.chat.scan(f.user.id, PNG, "sky"),
    /synthetic result failure/,
  );
  assert.deepEqual(readdirSync(join(f.root, f.user.id, "chat")), []);
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM quota_receipts").get()!.n,
    0,
  );
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM chat_images").get()!.n,
    0,
  );
});

test("a scan failure arriving after account deletion does not recreate image records", async (t) => {
  const f = setup(t);
  let reject!: (error: Error) => void;
  f.vision.json = () =>
    new Promise((_, fail) => {
      reject = fail;
    });
  const pending = f.chat.scan(f.user.id, PNG, "sky");
  f.store.db.prepare("DELETE FROM users WHERE id=?").run(f.user.id);
  reject(new ProviderError("AI_TIMEOUT", "synthetic timeout"));
  await assert.rejects(pending, { code: "SCAN_FAILED" });
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM chat_images").get()!.n,
    0,
  );
  assert.deepEqual(readdirSync(join(f.root, f.user.id, "chat")), []);
});

test("a draft result arriving after the last photo reference was deleted creates no dangling conversation or charge", async (t) => {
  const f = setup(t);
  const { imageId } = await f.chat.scan(f.user.id, PNG, "sky");
  f.thread("old-question", { imageId });
  let complete!: () => void;
  let started!: () => void;
  const gradingStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.llm.json = () =>
    new Promise((resolve) => {
      complete = () =>
        resolve({
          data: {
            steps: [{ status: "ok", note: "" }],
            first: null,
            summary: "正确",
          },
          usage: {},
        });
      started();
    });
  const pending = f.chat.gradeDraft(
    f.user.id,
    { problem: "1+1=?", steps: ["1+1=2"], imageId },
    "sky",
  );
  await gradingStarted;
  f.chat.remove(f.user.id, "old-question");
  complete();
  await assert.rejects(pending, { code: "NOT_FOUND" });
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM threads").get()!.n,
    0,
  );
  assert.equal(
    f.store.db
      .prepare("SELECT COUNT(*) n FROM quota_receipts WHERE source='chat'")
      .get()!.n,
    0,
  );
});

test("a successful scan arriving after account deletion is rejected before charge or delivery", async (t) => {
  const f = setup(t);
  let complete!: () => void;
  f.vision.json = () =>
    new Promise((resolve) => {
      complete = () =>
        resolve({
          data: scan,
          usage: {
            calls: 1,
            model: "mock",
            promptTokens: 5,
            completionTokens: 10,
          },
        });
    });
  const pending = f.chat.scan(f.user.id, PNG, "sky");
  f.store.db.prepare("DELETE FROM users WHERE id=?").run(f.user.id);
  complete();
  await assert.rejects(pending, { code: "NOT_FOUND" });
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM chat_images").get()!.n,
    0,
  );
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM quota_receipts").get()!.n,
    0,
  );
  assert.deepEqual(readdirSync(join(f.root, f.user.id, "chat")), []);
});

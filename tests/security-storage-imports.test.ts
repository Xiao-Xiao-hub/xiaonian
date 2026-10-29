import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs, { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reserveUploadBytes, hasDiskSpace } from "../server/src/shared/upload-budget.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { ResourceLimitError } from "../server/src/shared/isolated-worker.js";
import { ImportService } from "../server/src/modules/imports/service.js";
import { defaultImportFileTools, type ImportFileTools } from "../server/src/modules/imports/parser.js";
import { ChatService } from "../server/src/modules/chat/service.js";
import type { Job } from "../server/src/modules/jobs/runner.js";

const require = createRequire(new URL("../server/package.json", import.meta.url));
const JSZip = require("jszip");
const folder = () => mkdtempSync(join(tmpdir(), "security-storage-"));
const MIB = 1024 * 1024;
const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
async function docx(body: string, media = false) {
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document ${ns}><w:body>${body}</w:body></w:document>`);
  if (media) zip.file("word/media/photo.jpg", Buffer.alloc(5 * MIB, 0x61));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) as Promise<Buffer>;
}
function fixture(t: TestContext, tools = defaultImportFileTools) {
  const store = new SqliteStore(":memory:"), root = folder();
  const user = store.upsertUser("dev:storage", "owner", "dev");
  const other = store.upsertUser("dev:other-storage", "other", "dev");
  let calls = 0;
  const provider = { json: async () => { calls++; throw new Error("unexpected paid call"); }, recognize: async () => { calls++; throw new Error("unexpected OCR"); } };
  const service = new ImportService(store, { tagList: () => [] } as never, provider as never,
    provider as never, provider as never, {} as never, {} as never, root, tools);
  t.after(() => store.close());
  return { store, root, user, other, service, calls: () => calls };
}
function lowDisk(t: TestContext) {
  const mock = t.mock.method(fs, "statfsSync", () => ({ bsize: 4096, blocks: 10 * 1024 * 1024, bavail: 256 * 1024 }));
  syncBuiltinESMExports();
  return () => { mock.mock.restore(); syncBuiltinESMExports(); };
}

test("R01: 100 users with 10 historical photos do not prevent the next user uploading", () => {
  const root = folder();
  for (let user = 0; user < 100; user++) {
    const directory = join(root, `user-${user}`);
    mkdirSync(directory);
    for (let file = 0; file < 10; file++) writeFileSync(join(directory, `${file}.jpg`), "photo");
  }
  assert.doesNotThrow(() => reserveUploadBytes(root, "user-101", 5 * MIB));
});

test("R01: a user's 2300 small files are reconciled in batches without a count rejection", () => {
  const root = folder(), directory = join(root, "owner");
  mkdirSync(directory);
  for (let file = 0; file < 2300; file++) writeFileSync(join(directory, `${file}.txt`), "note");
  for (let call = 0; call < 4; call++) assert.doesNotThrow(() => reserveUploadBytes(root, "owner", 1024));
});

test("R01/R02: low disk prevents new writes and recovers without deleting historical records", (t) => {
  const f = fixture(t);
  const restore = lowDisk(t);
  try {
    assert.equal(hasDiskSpace(f.root, 1), false);
    assert.throws(() => reserveUploadBytes(f.root, f.user.id, 1), { statusCode: 503, code: "UPLOAD_STORAGE_LIMIT" });
    assert.throws(() => f.service.createPaste(f.user.id, { text: "普通笔记" }), { statusCode: 503, code: "IMPORT_STORAGE_LIMIT" });
  } finally { restore(); }
  assert.doesNotThrow(() => f.service.createPaste(f.user.id, { text: "恢复后可以继续导入" }));
});

test("R02: 1000 historical imports above the old site byte cap do not block a new user or a year of imports", (t) => {
  const f = fixture(t), at = f.store.now();
  const insert = f.store.db.prepare("INSERT INTO imports(id,user_id,source,segments,status,created_at,updated_at) VALUES(?,?,'paste',?,'saved',?,?)");
  const segments = JSON.stringify([{ n: 1, text: "a".repeat(70_000) }]);
  f.store.transaction(() => {
    for (let n = 0; n < 1095; n++) insert.run(`history-${n}`, f.user.id, segments, at, at);
  });
  assert.doesNotThrow(() => f.service.createPaste(f.other.id, { text: "新用户正常导入" }));
  assert.doesNotThrow(() => f.service.createPaste(f.user.id, { text: "每天三份，持续一年后仍能导入" }));
});

for (const reason of ["queue_full", "timeout"]) {
  test(`R06: ${reason} is retryable for PDF/DOCX imports and chat attachments`, async (t) => {
    const fail = async () => { throw new ResourceLimitError(reason); };
    const tools = { readPdf: fail, readDocx: fail, rasterizePdfPage: fail } as ImportFileTools;
    const f = fixture(t, tools);
    const chat = new ChatService({ store: f.store, uploadDir: f.root, files: tools, runner: { checkQuota: () => {} } } as ConstructorParameters<typeof ChatService>[0]);
    for (const [fileName, data] of [["notes.pdf", Buffer.from("%PDF-")], ["notes.docx", Buffer.from("PK")]] as const) {
      const check = (error: unknown) => {
        assert.equal((error as { statusCode: number }).statusCode, 503);
        assert.match((error as Error).message, /稍后再试/);
        assert.doesNotMatch((error as Error).message, /坏了|打不开/);
        return true;
      };
      await assert.rejects(f.service.createFile(f.user.id, { fileName, data, start: 1 }, {} as never), check);
      await assert.rejects(chat.attach(f.user.id, { data, name: fileName }), check);
    }
  });
}

for (const reason of ["worker_failed", "memory_limit"]) {
  test(`document ${reason} asks users to shrink the file instead of retrying unchanged`, async t => {
    const fail = async () => { throw new ResourceLimitError(reason); };
    const tools = { readPdf: fail, readDocx: fail, rasterizePdfPage: fail } as ImportFileTools;
    const f = fixture(t, tools);
    const chat = new ChatService({ store: f.store, uploadDir: f.root, files: tools,
      runner: { checkQuota: () => {} } } as ConstructorParameters<typeof ChatService>[0]);
    for (const [fileName, data] of [["notes.pdf", Buffer.from("%PDF-")], ["notes.docx", Buffer.from("PK")]] as const) {
      const check = (error: unknown) => {
        assert.equal((error as { statusCode: number }).statusCode, 400);
        assert.match((error as Error).message, /缩小文件或拆分/);
        assert.doesNotMatch((error as Error).message, /稍后再试|繁忙/);
        return true;
      };
      await assert.rejects(f.service.createFile(f.user.id, { fileName, data, start: 1 }, {} as never), check);
      await assert.rejects(chat.attach(f.user.id, { data, name: fileName }), check);
    }
  });
}

test("R12: a DOCX with a 5 MiB photograph imports its text without inflating its image", async () => {
  const data = await docx("<w:p><w:r><w:t>手机照片旁的笔记</w:t></w:r><w:r><w:drawing/></w:r></w:p>", true);
  const parsed = await defaultImportFileTools.readDocxFull!(data);
  assert.equal(parsed.text, "手机照片旁的笔记");
  assert.equal(parsed.images, 1);
});

test("R12: strict OOXML fallback also accepts an unused 5 MiB image", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", '<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:body><w:p><w:r><w:t>严格格式正文</w:t></w:r></w:p></w:body></w:document>');
  zip.file("word/media/photo.jpg", Buffer.alloc(5 * MIB));
  assert.equal(await defaultImportFileTools.readDocx(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })), "严格格式正文");
});

test("R13: a 500000-character document with more than 450000 tags parses within the worker budget", async () => {
  const paragraph = `<w:p>${"<w:r><w:t>学习笔记</w:t></w:r>".repeat(249)}</w:p>`;
  const body = paragraph.repeat(500) + `<w:p><w:r><w:t>${"终".repeat(1000)}</w:t></w:r></w:p>`;
  const text = await defaultImportFileTools.readDocx(await docx(body));
  assert.equal(text.length, 500000);
  assert.ok(text.startsWith("学习笔记"));
  assert.ok(text.endsWith("终".repeat(1000)));
});

test("R12/R13: expanded text bombs, deep XML and excessive entry collections remain rejected", async () => {
  await assert.rejects(defaultImportFileTools.readDocx(await docx(`<w:p><w:r><w:t>${"x".repeat(5 * MIB)}</w:t></w:r></w:p>`)), ResourceLimitError);
  await assert.rejects(defaultImportFileTools.readDocx(await docx("<w:sdt>".repeat(80) + "</w:sdt>".repeat(80))), ResourceLimitError);
  const zip = new JSZip();
  for (let n = 0; n < 257; n++) zip.file(`word/media/${n}.jpg`, "x");
  await assert.rejects(defaultImportFileTools.readDocx(await zip.generateAsync({ type: "nodebuffer" })), ResourceLimitError);
});

test("storage is checked before paid split-model, OCR and vision calls", async (t) => {
  const f = fixture(t);
  const row = f.service.createPaste(f.user.id, { text: "整理学习笔记" });
  const revision = createHash("sha256").update(String(row.segments)).digest("hex");
  const base = { id: "test-job", userId: f.user.id, params: { importId: row.id, revision } } as Job;
  const restore = lowDisk(t);
  try {
    await assert.rejects(f.service.handlers().import_cards!.run(base, new AbortController().signal, () => {}), { code: "IMPORT_STORAGE_LIMIT" });
    for (const [kind, source] of [["import_read", "photo"], ["import_read", "screenshot"], ["import_scan_pdf", "pdf"]]) {
      await assert.rejects(f.service.handlers()[kind!]!.run({ ...base, params: { importId: row.id, files: ["photo.png"], pages: [1], source } }, new AbortController().signal, () => {}), { code: "IMPORT_STORAGE_LIMIT" });
    }
    assert.equal(f.calls(), 0);
  } finally { restore(); }
});

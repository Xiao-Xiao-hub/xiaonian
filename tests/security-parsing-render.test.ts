import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, writeFileSync, statSync, truncateSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultImportFileTools, readPlainText } from "../server/src/modules/imports/parser.js";
import { FormulaRenderer } from "../server/src/modules/render/formula.js";
import { MarkdownRenderer } from "../server/src/modules/render/markdown.js";
import { ResourceLimitError, runIsolated } from "../server/src/shared/isolated-worker.js";
import { reserveUploadBytes } from "../server/src/shared/upload-budget.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { fakeServices, makeApp } from "./fixtures.js";

const require = createRequire(new URL("../server/package.json", import.meta.url));
const JSZip = require("jszip");
const folder = () => mkdtempSync(join(tmpdir(), "xn-security-parsing-"));
async function docx(text: string, extra = 0) {
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  for (let n = 0; n < extra; n++) zip.file(`metadata/${n}.xml`, "x");
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) as Promise<Buffer>;
}

test("DOCX rejects expanded bytes and entry count before DOM/mammoth and recovers", async () => {
  // A bounded synthetic fixture, 4 MiB expanded (far below machine memory).
  const large = await docx("a".repeat(4 * 1024 * 1024));
  assert.ok(large.length < 10 * 1024 * 1024);
  await assert.rejects(defaultImportFileTools.readDocx(large), ResourceLimitError);
  await assert.rejects(defaultImportFileTools.readDocx(await docx("hello", 257)), ResourceLimitError);
  assert.equal(await defaultImportFileTools.readDocx(await docx("普通文档")), "普通文档");
});

test("XML entity declarations cannot fall through to the mammoth parser", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", '<!DOCTYPE document [<!ENTITY value "test">]><document/>');
  await assert.rejects(defaultImportFileTools.readDocx(await zip.generateAsync({ type: "nodebuffer" })), ResourceLimitError);
});

test("plain text limits decoded content before large segmentation and persistence", () => {
  assert.throws(() => readPlainText(Buffer.alloc(500_001, 0x61), false), ResourceLimitError);
  assert.equal(readPlainText(Buffer.from("普通文字"), false), "普通文字");
});

test("document processing retains its own bounded queue", async () => {
  const data = await docx("queue test");
  const jobs = Array.from({ length: 17 }, () => defaultImportFileTools.readDocx(data));
  const results = await Promise.allSettled(jobs);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 16);
  assert.ok(results[16]?.status === "rejected");
  assert.equal(results[16].reason.reason, "queue_full");
});

test("the parent terminates a processing deadline and the next operation still works", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = runIsolated("document", "pdf", { data: Buffer.from("%PDF-"), start: 1, count: 1 });
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof ResourceLimitError && error.reason === "timeout");
  await Promise.resolve();
  t.mock.timers.tick(4_001);
  await rejected;
  t.mock.timers.reset();
  assert.equal(await defaultImportFileTools.readDocx(await docx("recovered")), "recovered");
});

test("maintenance recovers file-count and byte cache caps after changing formula inputs", async () => {
  const dir = folder();
  const renderer = new FormulaRenderer(dir, 2);
  const first = await renderer.render("x+1", false, "#1f2937");
  assert.ok(first);
  assert.ok(await renderer.render("x+2", false, "#1f2937"));
  const expired = new Date(Date.now() - 2 * 86400_000);
  utimesSync(join(dir, `${first.id}.png`), expired, expired);
  assert.ok(await renderer.render("x+3", false, "#1f2937"));
  await renderer.maintain();
  assert.equal(readdirSync(dir).length, 2);
  for (const name of readdirSync(dir)) utimesSync(join(dir, name), expired, expired);
  assert.ok(await renderer.render("x+1", false, "#1f2937"));
  assert.ok(renderer.file(first.id), "evicted known images are regenerated");
  const oversized = join(dir, `${"f".repeat(40)}.png`);
  writeFileSync(oversized, "");
  truncateSync(oversized, 513 * 1024 * 1024);
  for (const name of readdirSync(dir)) utimesSync(join(dir, name), expired, expired);
  assert.ok(await renderer.render("x+4", false, "#1f2937"));
  await renderer.maintain();
  assert.ok(readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0) <= 512 * 1024 * 1024);
});

test("an ordinary explanation with thirty formulas is fully rendered", async () => {
  const md = new MarkdownRenderer(new FormulaRenderer(folder()));
  const blocks = await md.render(Array.from({ length: 30 }, (_, n) => `$x+${n}$`).join(" "), "#1f2937");
  assert.equal(blocks[0]?.t, "p");
  const items = (blocks[0] as { c: { t: string }[] }).c;
  assert.equal(items.filter((item) => item.t === "math").length, 30);
  assert.equal(items.filter((item) => item.t === "tex").length, 0);
});

test("upload byte reservations enforce per-user bytes without a site-wide byte cap", () => {
  const dir = folder();
  reserveUploadBytes(dir, "user-a", 2 * 1024 * 1024 * 1024);
  assert.throws(() => reserveUploadBytes(dir, "user-a", 1), { code: "UPLOAD_STORAGE_LIMIT" });
  for (let n = 0; n < 4; n++) reserveUploadBytes(dir, `user-${n}`, 100 * 1024 * 1024);
  assert.doesNotThrow(() => reserveUploadBytes(dir, "user-b", 13 * 1024 * 1024));
});

test("unsent attachment count and bytes are checked before accepting another upload", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  t.after(() => app.close());
  const login = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "pending-limit" } });
  const { user, token } = login.json().data;
  const insert = store.db.prepare("INSERT INTO chat_attachments(id,user_id,kind,name,size,type,text,chars,created_at) VALUES(?,?,'file','note.txt',?,'txt','text',4,?)");
  for (let n = 0; n < 20; n++) insert.run(`attachment-${n}`, user.id, 1, new Date().toISOString());
  const upload = () => app.inject({
    method: "POST", url: "/v1/chat/attachments?name=note.txt",
    headers: { authorization: `Bearer ${token}`, "content-type": "multipart/form-data; boundary=test" },
    payload: Buffer.from('--test\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\n\r\ntext\r\n--test--\r\n'),
  });
  const countLimit = await upload();
  assert.equal(countLimit.statusCode, 429, countLimit.body);
  assert.equal(countLimit.json().code, "ATTACHMENT_STORAGE_LIMIT");
  store.db.prepare("DELETE FROM chat_attachments WHERE user_id=?").run(user.id);
  insert.run("large-pending", user.id, 20 * 1024 * 1024, new Date().toISOString());
  const byteLimit = await upload();
  assert.equal(byteLimit.statusCode, 429, byteLimit.body);
  assert.equal(byteLimit.json().code, "ATTACHMENT_STORAGE_LIMIT");
});

test("repeated plain imports are bounded in SQLite even without stored files", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  t.after(() => app.close());
  const login = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "import-limit" } });
  const { user, token } = login.json().data;
  const insert = store.db.prepare("INSERT INTO imports(id,user_id,source,own,segments,status,created_at,updated_at,extra) VALUES(?,?,'txt',0,'[]','read',?,?,'{}')");
  const at = new Date().toISOString();
  for (let n = 0; n < 10_000; n++) insert.run(`imp_fixture${n}`, user.id, at, at);
  const response = await app.inject({
    method: "POST", url: "/v1/imports/file?clientId=another-file",
    headers: { authorization: `Bearer ${token}`, "content-type": "multipart/form-data; boundary=test" },
    payload: Buffer.from('--test\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\n\r\nordinary text\r\n--test--\r\n'),
  });
  assert.equal(response.statusCode, 429, response.body);
  assert.equal(response.json().code, "IMPORT_STORAGE_LIMIT");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM imports WHERE user_id=?").get(user.id)!.count, 10_000);
});

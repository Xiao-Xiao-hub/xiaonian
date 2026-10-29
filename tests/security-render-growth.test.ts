import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FormulaRenderer } from "../server/src/modules/render/formula.js";
import { MarkdownRenderer, type Block } from "../server/src/modules/render/markdown.js";
import { FORMULA_CACHE_GRACE_MS } from "../server/src/modules/render/cache-limits.js";
import { runIsolated } from "../server/src/shared/isolated-worker.js";
import { defaultImportFileTools } from "../server/src/modules/imports/parser.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { fakeServices, makeApp } from "./fixtures.js";

const folder = () => mkdtempSync(join(tmpdir(), "security-render-growth-"));
const ink = "#1f2937";
const textOf = (blocks: Block[]) => blocks.flatMap((block) => "c" in block ? block.c.map((part) => "v" in part ? part.v : part.tex) : "v" in block ? [block.v] : []).join("");
async function documentData() {
  const require = createRequire(new URL("../server/package.json", import.meta.url));
  const zip = new (require("jszip"))();
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>正常文档</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: "nodebuffer" }) as Promise<Buffer>;
}

for (const users of [1, 10])
  test(`${users} users open 200-message mathematical conversations without losing formatting`, async (t) => {
    const store = new SqliteStore(":memory:");
    const app = makeApp(fakeServices(), {}, undefined, store);
    t.after(() => app.close());
    const clients: { token: string; thread: string }[] = [];
    const at = new Date().toISOString();
    const insertThread = store.db.prepare("INSERT INTO threads(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)");
    const insertMessage = store.db.prepare("INSERT INTO messages(id,thread_id,user_id,role,kind,content,status,created_at) VALUES(?,?,?,'assistant','answer',?,'done',?)");
    for (let user = 0; user < users; user++) {
      const response = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: `render-growth-${user}` } });
      const login = response.json().data;
      const thread = `render_thread_${user}`;
      insertThread.run(thread, login.user.id, "长对话", at, at);
      for (let message = 0; message < 200; message++)
        insertMessage.run(`render_message_${user}_${message}`, thread, login.user.id,
          `## 第 ${message} 步\n\n${"逐步解释计算过程。".repeat(60)}\n\n**结论**：$x_{${message % 20}}+1$`, at);
      clients.push({ token: login.token, thread });
    }
    const responses = await Promise.all(clients.map((client) => app.inject({
      method: "GET", url: `/v1/chat/threads/${client.thread}`,
      headers: { authorization: `Bearer ${client.token}` },
    })));
    for (const response of responses) {
      assert.equal(response.statusCode, 200, response.body.slice(0, 300));
      const messages = response.json().data.messages;
      assert.equal(messages.length, 200);
      for (const message of messages) {
        assert.equal(message.blocks[0].t, "h");
        assert.ok(message.blocks.some((block: Block) => "c" in block && block.c.some((part) => part.t === "math")));
      }
    }
  });

test("a 200-item mistakes page renders every problem", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "render-mistakes" } });
  const { user, token } = response.json().data;
  const at = new Date().toISOString();
  for (let index = 0; index < 200; index++) {
    const id = `render_material_${index}`;
    store.db.prepare("INSERT INTO materials(id,user_id,kind,title,status,current_version,created_at,updated_at) VALUES(?,?,'problem','错题','confirmed',1,?,?)").run(id, user.id, at, at);
    store.db.prepare("INSERT INTO material_versions(material_id,version,origin,text,paragraphs,created_at) VALUES(?,1,'typed',?,'[]',?)").run(id, `## 题目 ${index}\n\n计算 $x_{${index % 20}}+1$`, at);
    store.db.prepare("INSERT INTO mistakes(id,user_id,material_id,source,status,due_on,created_at,updated_at) VALUES(?,?,?,'judge','open',?,?,?)").run(`render_mistake_${index}`, user.id, id, at.slice(0, 10), at, at);
  }
  const page = await app.inject({ method: "GET", url: "/v1/mistakes?limit=200", headers: { authorization: `Bearer ${token}` } });
  assert.equal(page.statusCode, 200, page.body.slice(0, 300));
  assert.equal(page.json().data.items.length, 200);
  for (const item of page.json().data.items) {
    assert.equal(item.blocks[0].t, "h");
    assert.ok(item.blocks.some((block: Block) => "c" in block && block.c.some((part) => part.t === "math")));
  }
});

test("a full document queue does not consume rendering slots", async () => {
  const data = await documentData();
  const documents = Array.from({ length: 16 }, () => defaultImportFileTools.readDocx(data));
  const rendering = runIsolated<{ type: string }[]>("formula", "markdown", "## 正常标题");
  const [tokens] = await Promise.all([rendering, Promise.all(documents)]);
  assert.equal(tokens[0]?.type, "heading");
});

test("a full rendering queue leaves document parsing available", async () => {
  const data = await documentData();
  const rendering = Array.from({ length: 64 }, () => runIsolated("formula", "markdown", "**正常文字**"));
  const document = defaultImportFileTools.readDocx(data);
  const [text] = await Promise.all([document, Promise.all(rendering)]);
  assert.equal(text, "正常文档");
});

test("upgrading with 3780 cached formulas preserves every published id", async () => {
  const dir = folder();
  const old = new Date(Date.now() - 7 * 86400_000);
  for (let index = 0; index < 3780; index++) {
    const file = join(dir, `${index.toString(16).padStart(40, "0")}.png`);
    writeFileSync(file, "existing cached image");
    utimesSync(file, old, old);
  }
  const renderer = new FormulaRenderer(dir);
  assert.ok(await renderer.render("x+1", false, ink));
  await renderer.maintain();
  assert.equal(readdirSync(dir).length, 3781);
  for (let index = 0; index < 3780; index++) assert.ok(renderer.file(index.toString(16).padStart(40, "0")));
});

test("cache hits refresh LRU age and capacity evicts the least recently used image", async () => {
  const dir = folder();
  const renderer = new FormulaRenderer(dir, 2);
  const first = await renderer.render("x+1", false, ink);
  const second = await renderer.render("x+2", false, ink);
  assert.ok(first && second);
  const old = new Date(Date.now() - FORMULA_CACHE_GRACE_MS - 60_000);
  for (const image of [first, second]) utimesSync(join(dir, `${image.id}.png`), old, old);
  assert.deepEqual(await renderer.render("x+1", false, ink), first);
  assert.ok(statSync(join(dir, `${first.id}.png`)).mtimeMs > Date.now() - 5000);
  const third = await renderer.render("x+3", false, ink);
  assert.ok(third);
  await renderer.maintain();
  assert.ok(renderer.file(first.id));
  assert.equal(renderer.file(second.id), null, "only the unused old entry is evicted");
  utimesSync(join(dir, `${first.id}.png`), old, old);
  assert.deepEqual(await new FormulaRenderer(dir, 2).render("x+1", false, ink), first);
  assert.ok(statSync(join(dir, `${first.id}.png`)).mtimeMs > Date.now() - 5000, "a disk cache hit also refreshes age");
  const fourth = await renderer.render("x+4", false, ink);
  assert.ok(fourth, "a full, recently used cache still accepts new formulas");
  await renderer.maintain();
  assert.ok(renderer.file(first.id) && renderer.file(fourth.id));
  assert.equal(renderer.file(third.id), null, "capacity eviction has no 24-hour protection window");
  assert.equal(readdirSync(dir).length, 2);
  assert.deepEqual(await renderer.render("x+3", false, ink), third, "evicted images are drawn again");
});

test("200 ordinary formulas in one explanation all become images", async () => {
  const md = new MarkdownRenderer(new FormulaRenderer(folder()));
  const blocks = await md.render(Array.from({ length: 200 }, (_, n) => `$x_{${n}}+1$`).join(" "), ink);
  const paragraph = blocks[0];
  assert.ok(paragraph?.t === "p");
  assert.equal(paragraph.c.filter((part) => part.t === "math").length, 200);
});

test("formula count limits retain the remaining formula and show an explanation", async () => {
  const md = new MarkdownRenderer(new FormulaRenderer(folder()));
  const blocks = await md.render(`${Array.from({ length: 200 }, () => "$x+1$").join(" ")} $z+999$`, ink);
  const paragraph = blocks[0];
  assert.ok(paragraph?.t === "p");
  assert.equal(paragraph.c.filter((part) => part.t === "math").length, 200);
  assert.ok(paragraph.c.some((part) => part.t === "tex" && part.v === "z+999"));
  assert.match(textOf(blocks.slice(1)), /保留公式原文/);
});

test("long explanations keep their suffix and normal formatting beyond 32000 characters", async () => {
  const md = new MarkdownRenderer(new FormulaRenderer(folder()));
  const source = `## 开始\n\n${"正常解释。".repeat(7000)}\n\n**最后结论完整保留**`;
  const blocks = await md.render(source, ink);
  assert.equal(blocks[0]?.t, "h");
  assert.ok(textOf(blocks).endsWith("最后结论完整保留"));
});

test("text beyond the lexer input budget remains complete with a visible notice", async () => {
  const md = new MarkdownRenderer(new FormulaRenderer(folder()));
  const source = `${"长".repeat(200_001)}最后一段`;
  const blocks = await md.render(source, ink);
  assert.match(textOf(blocks.slice(0, 1)), /内容未删减/);
  assert.equal(textOf(blocks.slice(1)), source);
});

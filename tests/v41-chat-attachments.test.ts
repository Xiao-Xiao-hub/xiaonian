import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { loadEnv } from "../server/src/config/env.js";
import { buildApp } from "../server/src/index.js";
import { ChatService, FILE_TEXT_LIMIT } from "../server/src/modules/chat/service.js";
import { SqliteStore } from "../server/src/shared/store.js";

// photos and documents sent in 聊一聊 / chat.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

// A zip with deflated entries, enough for a.docx.
function zip(entries: Record<string, string>) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
const docx = (text: string) =>
  zip({
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  });
// A one-page PDF; with text it has a text layer, without it reads as a scan.
function pdf(text: string) {
  const stream = text ? `BT /F1 12 Tf 20 100 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

type Call = { model: string; body: string };
function fakeFetcher(calls: Call[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      const q = body.questions.q;
      return new Response(
        JSON.stringify({
          answers: {
            q:
              q.type === "noul"
                ? { noul: 0.9 }
                : { choice: "none", confidence: 1, probabilities: { none: 1 } },
          },
        }),
      );
    }
    calls.push({ model: body.model, body: JSON.stringify(body.messages) });
    if (body.stream) {
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "看到了。" } }] })}\n\n`));
            c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`));
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  }) as typeof fetch;
}

async function setup(t: TestContext, env: Record<string, string> = {}) {
  const calls: Call[] = [];
  const store = new SqliteStore(":memory:");
  const uploads = mkdtempSync(join(tmpdir(), "zhiye-attach-"));
  const app = buildApp({
    store,
    fetcher: fakeFetcher(calls),
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: uploads,
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-formula-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "test-llm",
      JEV_API_KEY: "test-jev",
      OCR_VISION_MODEL: "vision-model",
      ...env,
    }),
  });
  t.after(() => app.close());
  const login = async (key: string) => {
    const res = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key } });
    const { token, user } = res.json().data;
    const headers = { authorization: `Bearer ${token}` };
    let n = 0;
    return {
      id: user.id as string,
      headers,
      upload: (data: Buffer, name: string, threadId?: string, from?: number) => {
        const boundary = "----zhiye";
        const payload = Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="tmp_abc"\r\nContent-Type: application/octet-stream\r\n\r\n`,
          ),
          data,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        const query = new URLSearchParams({
          name,
          ...(threadId ? { threadId } : {}),
          ...(from !== undefined ? { from: String(from) } : {}),
        });
        return app.inject({
          method: "POST",
          url: `/v1/chat/attachments?${query}`,
          headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
          payload,
        });
      },
      send: async (payload: Record<string, unknown>) => {
        const res = await app.inject({
          method: "POST",
          url: "/v1/chat/send",
          headers,
          payload: { clientId: `client-${key}-${++n}-abcdef`, ...payload },
        });
        const events = String(res.headers["content-type"]).startsWith("text/event-stream")
          ? res.body
              .split("\n\n")
              .filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
              .map((f) => JSON.parse(f.slice(6)) as Record<string, any>)
          : [];
        return { res, events };
      },
      call: (method: "GET" | "DELETE" | "POST", url: string, payload?: unknown) =>
        app.inject({ method, url, headers, ...(payload ? { payload: payload as object } : {}) }),
    };
  };
  return { app, store, uploads, calls, login };
}

test("a document is read, sent with its name and kept only as text", async (t) => {
  const { store, calls, login } = await setup(t);
  const me = await login("attach-file");
  const up = await me.upload(Buffer.from("第一章 极限\n夹逼定理的条件是什么？"), "笔记.txt");
  assert.equal(up.statusCode, 200, up.body);
  const att = up.json().data;
  assert.equal(att.kind, "file");
  assert.equal(att.name, "笔记.txt");
  assert.equal(att.type, "txt");
  assert.equal(att.truncated, false);
  // The file counts as an 导入 — once it is sent, not when it is picked.
  const receipt = () =>
    store.db
      .prepare("SELECT kind FROM quota_receipts WHERE source='job' AND source_id=?")
      .get(att.id) as { kind: string } | undefined;
  assert.equal(receipt(), undefined);
  // Sent with no text: a new thread named after the file.
  const { events } = await me.send({ attachmentIds: [att.id] });
  assert.ok(receipt()?.kind.startsWith("import"));
  const start = events.find((e) => e.e === "start")!;
  assert.ok(start, JSON.stringify(events));
  assert.equal(start.thread.title, "笔记.txt");
  assert.deepEqual(start.question.attachments, [
    // V4.2  adds from / read / truncated for a file.
    { id: att.id, kind: "file", name: "笔记.txt", size: att.size, type: "txt", imageId: null, from: 0, read: 18, truncated: false },
  ]);
  const streamed = calls.filter((c) => c.body.includes("夹逼定理"));
  assert.ok(streamed.length >= 1);
  assert.match(streamed[0]!.body, /笔记\.txt/);
  assert.notEqual(streamed[0]!.model, "vision-model");
  const row = store.db
    .prepare("SELECT thread_id,message_id,text FROM chat_attachments WHERE id=?")
    .get(att.id) as Record<string, string>;
  assert.equal(row.thread_id, start.thread.id);
  assert.equal(row.message_id, start.question.id);
  // Reopening the thread shows it; the export has the text.
  const view = (await me.call("GET", `/v1/chat/threads/${start.thread.id}`)).json().data;
  const q = view.messages.find((m: any) => m.id === start.question.id);
  assert.equal(q.attachments[0].name, "笔记.txt");
  const exported = (await me.call("GET", "/v1/me/export")).json();
  assert.equal(exported.chatAttachments[0].text, "第一章 极限\n夹逼定理的条件是什么？");
  // Sent once only.
  const again = await me.send({ text: "再看看", threadId: start.thread.id, attachmentIds: [att.id] });
  assert.equal(again.res.statusCode, 404);
  assert.equal(again.res.json().code, "ATTACHMENT_NOT_FOUND");
});

test("docx, md and text-layer PDF are read; a scanned PDF points to 导入", async (t) => {
  const { login } = await setup(t);
  const me = await login("attach-types");
  const word = await me.upload(docx("Word 里的内容"), "a.docx");
  assert.equal(word.statusCode, 200, word.body);
  const md = await me.upload(Buffer.from("# 标题\n正文"), "b.md");
  assert.equal(md.statusCode, 200, md.body);
  const text = await me.upload(
    pdf("The squeeze theorem needs two bounds that share the same limit at the point."),
    "c.pdf",
  );
  assert.equal(text.statusCode, 200, text.body);
  assert.equal(text.json().data.type, "pdf");
  const scan = await me.upload(pdf(""), "scan.pdf");
  assert.equal(scan.statusCode, 422);
  assert.equal(scan.json().message, "扫描版读不出文字，可以用导入");
  const odd = await me.upload(Buffer.from("MZ...."), "a.exe");
  assert.equal(odd.statusCode, 415);
  assert.equal(odd.json().code, "FILE_TYPE");
  const broken = await me.upload(Buffer.from("not a zip"), "x.docx");
  assert.equal(broken.statusCode, 400);
  assert.equal(broken.json().code, "FILE_READ_FAILED");
});

test("a long document is cut and marked; over-limit uploads fail with one line", async (t) => {
  const { store, login } = await setup(t);
  const me = await login("attach-limits");
  const long = await me.upload(Buffer.from("字".repeat(FILE_TEXT_LIMIT + 500)), "long.txt");
  assert.equal(long.statusCode, 200, long.body);
  assert.equal(long.json().data.truncated, true);
  const row = store.db
    .prepare("SELECT text,chars FROM chat_attachments WHERE id=?")
    .get(long.json().data.id) as { text: string; chars: number };
  assert.equal(Array.from(row.text).length, FILE_TEXT_LIMIT);
  assert.equal(row.chars, FILE_TEXT_LIMIT + 500);
  const big = await me.upload(Buffer.alloc(10 * 1024 * 1024 + 10, 0x61), "big.txt");
  assert.equal(big.statusCode, 413);
  assert.equal(big.json().code, "FILE_TOO_LARGE");
  const bigImage = await me.upload(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), "big.png");
  assert.equal(bigImage.statusCode, 413);
  assert.equal(bigImage.json().code, "IMAGE_TOO_LARGE");
  // At most four per message.
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await me.upload(Buffer.from(`第${i}份`), `${i}.txt`)).json().data.id);
  const five = await me.send({ text: "看看", attachmentIds: ids });
  assert.equal(five.res.statusCode, 400);
});

test("a photo goes to the vision route, counts as 拍照 and old clients still see it", async (t) => {
  const { calls, login } = await setup(t);
  const me = await login("attach-photo");
  const up = await me.upload(PNG, "IMG_1.png");
  assert.equal(up.statusCode, 200, up.body);
  const att = up.json().data;
  assert.equal(att.kind, "image");
  assert.ok(att.imageId);
  // Picked is not used yet : it counts once it is sent.
  const used = async () => (await me.call("GET", "/v1/chat/usage")).json().data.photos.used;
  assert.equal(await used(), 0);
  const { events } = await me.send({ text: "这张图里写的什么", attachmentIds: [att.id] });
  assert.equal(await used(), 1);
  const start = events.find((e) => e.e === "start")!;
  assert.deepEqual(start.question.images, [att.imageId]);
  assert.equal(start.question.attachments[0].imageId, att.imageId);
  const stream = calls.find((c) => c.body.includes("image_url"));
  assert.ok(stream);
  assert.equal(stream!.model, "vision-model");
  const image = await me.call("GET", `/v1/chat/images/${att.imageId}`);
  assert.equal(image.statusCode, 200);
});

test("a photo is refused when no vision route is set", async (t) => {
  const { login } = await setup(t, { OCR_VISION_MODEL: "" });
  const me = await login("attach-novision");
  const up = await me.upload(PNG, "a.png");
  assert.equal(up.statusCode, 503);
  assert.equal(up.json().code, "VISION_NOT_CONFIGURED");
});

test("only the owner's unsent attachments, for this thread or a new one", async (t) => {
  const { login } = await setup(t);
  const a = await login("attach-owner-a");
  const b = await login("attach-owner-b");
  const mine = (await a.upload(Buffer.from("A 的文件"), "a.txt")).json().data;
  const stolen = await b.send({ text: "看看", attachmentIds: [mine.id] });
  assert.equal(stolen.res.statusCode, 404);
  const first = await a.send({ text: "你好" });
  const threadId = first.events.find((e) => e.e === "start")!.thread.id;
  const forThread = (await a.upload(Buffer.from("给这段对话的"), "t.txt", threadId)).json().data;
  const elsewhere = await a.send({ text: "新对话", attachmentIds: [forThread.id] });
  assert.equal(elsewhere.res.statusCode, 404);
  const here = await a.send({ text: "这段", threadId, attachmentIds: [forThread.id] });
  assert.ok(here.events.some((e) => e.e === "start"));
  const otherThread = await b.upload(Buffer.from("x"), "x.txt", threadId);
  assert.equal(otherThread.statusCode, 404);
});

test("removing an unsent photo, a thread or the account removes the files", async (t) => {
  const { store, uploads, login } = await setup(t);
  const me = await login("attach-remove");
  const dir = () => {
    const path = join(uploads, me.id, "chat");
    return existsSync(path) ? readdirSync(path) : [];
  };
  const unsent = (await me.upload(PNG, "a.png")).json().data;
  assert.equal(dir().length, 1);
  assert.equal((await me.call("DELETE", `/v1/chat/attachments/${unsent.id}`)).statusCode, 200);
  assert.equal(dir().length, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM chat_attachments").get()!.n, 0);
  const sent = (await me.upload(PNG, "b.png")).json().data;
  const file = (await me.upload(Buffer.from("文字"), "b.txt")).json().data;
  const { events } = await me.send({ attachmentIds: [sent.id, file.id] });
  const threadId = events.find((e) => e.e === "start")!.thread.id;
  const detach = await me.call("DELETE", `/v1/chat/attachments/${sent.id}`);
  assert.equal(detach.statusCode, 409);
  assert.equal(dir().length, 1);
  assert.equal((await me.call("DELETE", `/v1/chat/threads/${threadId}`)).statusCode, 200);
  assert.equal(dir().length, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM chat_attachments").get()!.n, 0);
  await me.upload(PNG, "c.png");
  assert.equal(dir().length, 1);
  const erase = await me.call("DELETE", "/v1/me", { confirm: true });
  assert.equal(erase.statusCode, 200, erase.body);
  assert.equal(existsSync(join(uploads, me.id)), false);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM chat_attachments").get()!.n, 0);
});

// 附件与异步行为回归。
function pdfPages(texts: string[]) {
  const n = texts.length;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${texts.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${n} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  texts.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

test("a PDF past 50 pages is read to the end when its text is short", async (t) => {
  const { store, login } = await setup(t);
  const me = await login("attach-pdf-pages");
  const texts = Array.from({ length: 55 }, (_, i) => `Page number ${i + 1} of the notes`);
  const up = await me.upload(pdfPages(texts), "notes.pdf");
  assert.equal(up.statusCode, 200, up.body);
  assert.equal(up.json().data.truncated, false);
  const row = store.db
    .prepare("SELECT text FROM chat_attachments WHERE id=?")
    .get(up.json().data.id) as { text: string };
  assert.match(row.text, /Page number 55 of the notes/);
});

test("a long file name keeps its extension", async (t) => {
  const { login } = await setup(t);
  const me = await login("attach-long-name");
  const up = await me.upload(Buffer.from("内容"), `${"很长的名字".repeat(30)}.md`);
  assert.equal(up.statusCode, 200, up.body);
  const att = up.json().data;
  assert.equal(att.type, "md");
  assert.ok(att.name.endsWith(".md"));
  assert.ok(att.name.length <= 120);
});

test("four photos in one message: the last two are sent as images", async (t) => {
  const { calls, login } = await setup(t);
  const me = await login("attach-four");
  const photos = [1, 2, 3, 4].map((i) => Buffer.concat([PNG, Buffer.from(`photo-${i}`)]));
  const ids: string[] = [];
  for (const [i, p] of photos.entries()) ids.push((await me.upload(p, `${i}.png`)).json().data.id);
  const { events } = await me.send({ text: "看这四张", attachmentIds: ids });
  assert.ok(events.some((e) => e.e === "start"), JSON.stringify(events));
  const body = calls.find((c) => c.body.includes("image_url"))!.body;
  const sent = photos.map((p) => body.includes(p.toString("base64")));
  assert.deepEqual(sent, [false, false, true, true]);
  // The two left out are new, not older.
  assert.equal(body.split("【图片（太多，这里省略）】").length - 1, 2);
  assert.ok(!body.includes("较早"));
});

test("files past the budget are marked too much in the latest turn and older after it", async (t) => {
  const { calls, login } = await setup(t);
  const me = await login("attach-budget");
  const ids: string[] = [];
  for (const i of [1, 2, 3, 4])
    ids.push(
      (await me.upload(Buffer.from(String(i).repeat(FILE_TEXT_LIMIT)), `${i}.txt`)).json()
        .data.id,
    );
  const first = await me.send({ text: "看这四份", attachmentIds: ids });
  const threadId = first.events.find((e) => e.e === "start")!.thread.id;
  const now = calls.at(-1)!.body;
  assert.ok(now.includes("【附件：1.txt（内容太多，这里省略）】"));
  assert.ok(now.includes("【附件：2.txt（内容太多，这里省略）】"));
  assert.ok(now.includes("4".repeat(FILE_TEXT_LIMIT)));
  assert.ok(!now.includes("较早"));
  await me.send({ text: "接着说", threadId });
  const later = calls.at(-1)!.body;
  assert.ok(later.includes("【附件：1.txt（内容较早，这里省略）】"));
  assert.ok(!later.includes("太多"));
});

test("deleting a chat removes photos uploaded to it but never sent", async (t) => {
  const { uploads, login } = await setup(t);
  const me = await login("attach-thread-unsent");
  const first = await me.send({ text: "你好" });
  const threadId = first.events.find((e) => e.e === "start")!.thread.id;
  const up = await me.upload(PNG, "a.png", threadId);
  assert.equal(up.statusCode, 200, up.body);
  const dir = join(uploads, me.id, "chat");
  assert.equal(readdirSync(dir).length, 1);
  assert.equal((await me.call("DELETE", `/v1/chat/threads/${threadId}`)).statusCode, 200);
  assert.equal(readdirSync(dir).length, 0);
});

test("the daily job drops anyone's uploads left unsent for a day, with their files", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { store, uploads, login } = await setup(t);
  const me = await login("attach-sweep");
  const dir = () => readdirSync(join(uploads, me.id, "chat"));
  const old = (await me.upload(Buffer.concat([PNG, Buffer.from("old")]), "old.png")).json().data;
  const fresh = (await me.upload(PNG, "new.png")).json().data;
  const file = (await me.upload(Buffer.from("文字"), "old.txt")).json().data;
  const sent = (await me.upload(Buffer.concat([PNG, Buffer.from("sent")]), "sent.png")).json().data;
  await me.send({ text: "看", attachmentIds: [sent.id] });
  const age = (id: string, hours: number) =>
    store.db
      .prepare("UPDATE chat_attachments SET created_at=? WHERE id=?")
      .run(new Date(Date.now() - hours * 3_600_000).toISOString(), id);
  age(old.id, 25);
  age(file.id, 25);
  age(fresh.id, 23);
  age(sent.id, 48);
  assert.equal(dir().length, 3);
  // The owner never comes back; the daily job runs.
  t.mock.timers.tick(86_400_000);
  const left = store.db
    .prepare("SELECT id FROM chat_attachments ORDER BY id")
    .all()
    .map((r: any) => r.id)
    .sort();
  assert.deepEqual(left, [fresh.id, sent.id].sort());
  assert.equal(
    store.db.prepare("SELECT COUNT(*) n FROM chat_images WHERE id=?").get(old.imageId)!.n,
    0,
  );
  assert.equal(dir().length, 2);
});

test("an account deleted while its document is read gets 404, not a failed write", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const user = store.upsertUser("openid-attach-gone", "x", "dev");
  let release!: () => void;
  const reading = new Promise<void>((resolve) => (release = resolve));
  const chat = new ChatService({
    store,
    runner: { checkQuota() {}, quotaKinds: () => ["import_cards"] },
    files: {
      readDocx: async () => {
        await reading;
        return "文字";
      },
    },
    uploadDir: mkdtempSync(join(tmpdir(), "zhiye-attach-gone-")),
    limits: { answers: 10, photos: 10 },
  } as unknown as ConstructorParameters<typeof ChatService>[0]);
  const upload = chat.attach(user.id, { data: docx("x"), name: "a.docx" });
  store.db.prepare("DELETE FROM users WHERE id=?").run(user.id);
  release();
  await assert.rejects(upload, { statusCode: 404, code: "NOT_FOUND" });
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM chat_attachments").get()!.n, 0);
});

// V4.2 : the rest of a long document is read from where the last part
// stopped; nothing is charged until the part is sent.
test("a long document goes on from where it stopped", async (t) => {
  const { store, calls, login } = await setup(t);
  const me = await login("attach-more");
  const text = "字".repeat(FILE_TEXT_LIMIT) + "后".repeat(500);
  const first = (await me.upload(Buffer.from(text), "long.txt")).json().data;
  assert.equal(first.truncated, true);
  assert.equal(first.from, 0);
  assert.equal(first.read, FILE_TEXT_LIMIT);
  const rest = await me.upload(Buffer.from(text), "long.txt", undefined, first.from + first.read);
  assert.equal(rest.statusCode, 200, rest.body);
  const more = rest.json().data;
  assert.equal(more.from, FILE_TEXT_LIMIT);
  assert.equal(more.read, 500);
  assert.equal(more.truncated, false);
  const row = store.db.prepare("SELECT text,text_from FROM chat_attachments WHERE id=?").get(more.id) as {
    text: string;
    text_from: number;
  };
  assert.equal(row.text, "后".repeat(500));
  assert.equal(row.text_from, FILE_TEXT_LIMIT);
  const done = await me.upload(Buffer.from(text), "long.txt", undefined, FILE_TEXT_LIMIT + 500);
  assert.equal(done.statusCode, 400);
  assert.equal(done.json().code, "FILE_DONE");
  const receipts = () =>
    (store.db.prepare("SELECT COUNT(*) AS n FROM quota_receipts WHERE source='job'").get() as { n: number }).n;
  assert.equal(receipts(), 0);
  const sent = await me.send({ text: "接着看后面", attachmentIds: [more.id] });
  assert.equal(sent.res.statusCode, 200);
  assert.equal(receipts(), 1);
  assert.ok(calls.some((c) => c.body.includes(`第 ${FILE_TEXT_LIMIT + 1} 字起的一段`)));
});

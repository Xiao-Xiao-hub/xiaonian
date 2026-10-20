// imports and quota from the final acceptance — a long scanned
// import keeps what is past the limit, a picture with no words is free
// , every unfinished import can be found, cleared uploads can be
// picked again for the missing pages only (F10, item 9), solutions stay with
// their problem, each model is priced at its own row  and a spend
// keeps the price it was charged at. Synthetic data only.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";
import {
  Budget,
  DEFAULT_PRICES,
  usageCost,
  type Price,
} from "../server/src/shared/budget.js";
import { mergeParagraphs, segmentText } from "../server/src/modules/imports/segment.js";
import { usageSum } from "../server/src/modules/imports/service.js";
import type { LlmUsage } from "../server/src/providers/llm.js";

const usage = { prompt_tokens: 3, completion_tokens: 2 };
type Read = { chat?: boolean; paragraphs?: string[] };

// Page p of a long synthetic note: three paragraphs of about 3000 characters,
// every sentence marked with its page and number.
const sentence = (p: number, k: number) => `第${p}页第${k}句，这里写一点合成的笔记内容。`;
const longPage = (p: number): Read => ({
  chat: false,
  paragraphs: [0, 1, 2].map((part) =>
    Array.from({ length: 150 }, (_, i) => sentence(p, part * 150 + i + 1)).join(""),
  ),
});
const marks = (text: string) => text.match(/第\d+页第\d+句/g) ?? [];
const empty: Read = { chat: false, paragraphs: [] };

function setup(reads: Read[] = [], pdf: { totalPages: number; pages: { n: number; text: string }[] } = { totalPages: 1, pages: [] }, down = false) {
  const store = new SqliteStore(":memory:");
  const uploadDir = mkdtempSync(join(tmpdir(), "zhiye-fx5a-"));
  const vision: unknown[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/"))
      return new Response(
        JSON.stringify({ answers: { q: { choice: "none", confidence: 0.9, probabilities: { none: 0.9 } } } }),
      );
    vision.push(body);
    // The reading service is down: every call fails.
    if (down) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 503 });
    const content = reads.shift() ?? empty;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage }),
    );
  }) as typeof fetch;
  const app = buildApp({
    store,
    fetcher,
    importTools: {
      readDocx: async () => "",
      readPdf: async () => pdf,
      rasterizePdfPage: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    },
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: uploadDir,
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-fx5a-formula-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "fake",
      JEV_API_KEY: "fake",
      OCR_VISION_MODEL: "fake-vision",
      DAILY_OCR_LIMIT: "20",
      DAILY_IMPORT_LIMIT: "10",
      JOB_CONCURRENCY: "1",
    }),
  });
  return { app, store, uploadDir, vision, reads };
}
type Fixture = ReturnType<typeof setup>;
async function session(f: Fixture) {
  const login = await f.app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "fx5a-owner" } });
  const token = login.json().data.token as string;
  const userId = login.json().data.user.id as string;
  const call = (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    f.app.inject({ method, url, payload: payload as string, headers: { authorization: `Bearer ${token}`, ...headers } });
  return { call, userId };
}
type Call = Awaited<ReturnType<typeof session>>["call"];
function multipart(data: Buffer, filename: string) {
  const boundary = "----zhiye-fx5a-boundary";
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
const jpeg = (n = 1) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, n)]);
async function settle(call: Call, jobId: string) {
  for (let i = 0; i < 2000; i++) {
    const job = (await call("GET", `/v1/jobs/${jobId}`)).json().data;
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("job did not settle");
}
// Screenshots sent one by one; the read starts with the last.
async function screenshots(call: Call, clientId: string, count: number) {
  let item;
  for (let index = 0; index < count; index++) {
    const part = multipart(jpeg(index + 1), `${index}.jpg`);
    const response = await call(
      "POST",
      `/v1/imports/photo?clientId=${clientId}&source=screenshot&index=${index}&count=${count}`,
      part.payload,
      part.headers,
    );
    assert.equal(response.statusCode, 200, response.body);
    item = response.json().data.import;
  }
  return item;
}
const detail = async (call: Call, id: string) => (await call("GET", `/v1/imports/${id}`)).json().data;
const spendOf = (store: SqliteStore, jobId: string) =>
  store.db.prepare("SELECT usage FROM quota_spend WHERE source='job' AND source_id=?").get(jobId) as
    | { usage: string }
    | undefined;

test("F01 + F03: a long scanned import keeps the rest; empty pages are not paid; a re-read page takes its place", async () => {
  // Page 2 reads empty the first time, then 9000 characters when read again.
  const f = setup([longPage(1), empty, longPage(3), longPage(2)]);
  try {
    const { call, userId } = await session(f);
    const first = await screenshots(call, "fx5a-long", 3);
    const job = await settle(call, first.job.id);
    assert.equal(job.status, "succeeded");
    let item = await detail(call, first.id);
    assert.equal(item.status, "read");
    assert.deepEqual(item.pages.map((page: { ok: boolean }) => page.ok), [true, false, true]);
    // only the two pages with words are paid for.
    const paid = JSON.parse(spendOf(f.store, job.id)!.usage);
    assert.equal(paid.calls, 2);
    assert.equal(paid.promptTokens, 6);
    assert.equal(item.retryPages, 1);
    assert.deepEqual(item.missingPages, []);
    // About 18000 characters: all kept.
    assert.equal(item.restChars, 0);

    // Page 2 read again: 27000 characters, in page order, the rest kept.
    const again = (await call("POST", `/v1/imports/${first.id}/read`, { pages: 1 })).json().data.import;
    assert.equal((await settle(call, again.job.id)).status, "succeeded");
    item = await detail(call, first.id);
    assert.equal(item.status, "read");
    const kept = item.segments.reduce((n: number, s: { text: string }) => n + Array.from(s.text).length, 0);
    assert.ok(kept <= 20000, `kept ${kept}`);
    const pagesInOrder = item.segments.map((s: { page: number }) => s.page);
    assert.deepEqual(pagesInOrder, [...pagesInOrder].sort((a: number, b: number) => a - b));
    assert.ok(item.restChars > 0);
    const extra = JSON.parse(
      String((f.store.db.prepare("SELECT extra FROM imports WHERE id=?").get(first.id) as { extra: string }).extra),
    );
    assert.ok(extra.rest.length > 0);
    // Nothing lost: every sentence of the three pages is kept or in the rest.
    const all = [1, 2, 3].flatMap((p) => Array.from({ length: 450 }, (_, k) => `第${p}页第${k + 1}句`));
    const seen = [...item.segments.flatMap((s: { text: string }) => marks(s.text)), ...marks(extra.rest)];
    assert.deepEqual(seen.sort(), [...all].sort());
    assert.ok(marks(extra.rest).every((mark) => mark.startsWith("第3页")));
    // All pages read: the uploads are cleared, the rest is not.
    assert.equal(existsSync(join(f.uploadDir, userId, "imports", first.id)), false);
    const next = (await call("POST", `/v1/imports/${first.id}/rest`, { clientId: "fx5a-rest" })).json().data.import;
    assert.equal(next.status, "read");
    assert.equal(next.source, "paste");
    assert.deepEqual(
      next.segments.flatMap((s: { text: string }) => marks(s.text)),
      marks(extra.rest),
    );
  } finally {
    await f.app.close();
  }
});

test("F03: a read where no page gave words fails, is free and can be retried by the learner", async () => {
  const f = setup([empty, empty]);
  try {
    const { call, userId } = await session(f);
    const before = (await call("GET", "/v1/me/usage")).json().data.budget;
    const first = await screenshots(call, "fx5a-empty", 2);
    const job = await settle(call, first.job.id);
    assert.equal(job.status, "failed");
    assert.equal(job.error.code, "IMPORT_NO_TEXT");
    assert.equal(job.error.message, "这几页没认出字，可以再试一次");
    assert.equal(spendOf(f.store, job.id), undefined);
    const voids = f.store.db.prepare("SELECT COUNT(*) AS n FROM quota_voids WHERE user_id=? AND job_id=?").get(userId, job.id) as { n: number };
    assert.ok(voids.n >= 1, "the receipt is voided");
    assert.deepEqual((await call("GET", "/v1/me/usage")).json().data.budget, before);
    const item = await detail(call, first.id);
    assert.equal(item.status, "reading");
    assert.equal(item.job, null);
    assert.equal(item.failedJob.error.message, "这几页没认出字，可以再试一次");
    assert.equal(item.retryPages, 2);
    // Nothing runs again by itself.
    assert.equal(f.vision.length, 2);
  } finally {
    await f.app.close();
  }
});

test("a read where every call failed says it was not read, not that the pages had no words", async () => {
  const f = setup([], undefined, true);
  try {
    const { call } = await session(f);
    const first = await screenshots(call, "fx5a-down", 2);
    const job = await settle(call, first.job.id);
    assert.equal(job.status, "failed");
    assert.equal(job.error.code, "IMPORT_READ_FAILED");
    assert.equal(job.error.message, "这次没读成，可以再试一次");
    assert.equal(spendOf(f.store, job.id), undefined);
    assert.equal((await detail(call, first.id)).status, "reading");
  } finally {
    await f.app.close();
  }
});

test("F10 + item 9: a read skips pages whose picture is gone; the picture picked again reads only that page", async () => {
  const text = (p: number): Read => ({ chat: false, paragraphs: [`第${p}页认出来的一段正文，足够长不会被并掉。`] });
  const f = setup([text(1), empty, empty, text(3), text(2)]);
  try {
    const { call, userId } = await session(f);
    const first = await screenshots(call, "fx5a-gone", 3);
    assert.equal((await settle(call, first.job.id)).status, "succeeded");
    // Page 2's picture was cleared, page 3's is still there.
    const folder = join(f.uploadDir, userId, "imports", first.id);
    rmSync(join(folder, "1.jpg"));
    let item = await detail(call, first.id);
    assert.deepEqual(item.missingPages, [2]);
    assert.equal(item.retryPages, 1);
    // An old client asks for both failed pages: page 3 is read, no 410.
    const read3 = await call("POST", `/v1/imports/${first.id}/read`, { pages: 2 });
    assert.equal(read3.statusCode, 200, read3.body);
    const job3 = await settle(call, read3.json().data.import.job.id);
    assert.equal(job3.status, "succeeded");
    assert.deepEqual(job3.result.failed, []);
    item = await detail(call, first.id);
    assert.deepEqual(item.pages.map((page: { ok: boolean }) => page.ok), [true, false, true]);
    // Only page 2 is left and its picture is gone: 410 as before.
    const expired = await call("POST", `/v1/imports/${first.id}/read`, { pages: 1 });
    assert.equal(expired.statusCode, 410);
    assert.equal(expired.json().code, "IMPORT_EXPIRED");
    // A page already read is not replaced.
    const readPage = multipart(jpeg(7), "x.jpg");
    const refused = await call("POST", `/v1/imports/${first.id}/page?n=1`, readPage.payload, readPage.headers);
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().code, "IMPORT_PAGE");
    // The picture of page 2 picked again.
    const part = multipart(jpeg(8), "again.jpg");
    const replaced = await call("POST", `/v1/imports/${first.id}/page?n=2`, part.payload, part.headers);
    assert.equal(replaced.statusCode, 200, replaced.body);
    assert.deepEqual(replaced.json().data.import.missingPages, []);
    assert.equal(replaced.json().data.import.retryPages, 1);
    assert.equal(replaced.json().data.import.job.status, "succeeded", "nothing is read yet");
    const calls = f.vision.length;
    const read2 = (await call("POST", `/v1/imports/${first.id}/read`, { pages: 1 })).json().data.import;
    const job2 = await settle(call, read2.job.id);
    assert.equal(job2.status, "succeeded");
    assert.equal(f.vision.length, calls + 1, "only page 2 is read");
    assert.equal(JSON.parse(spendOf(f.store, job2.id)!.usage).calls, 1);
    item = await detail(call, first.id);
    assert.deepEqual(item.pages.map((page: { ok: boolean }) => page.ok), [true, true, true]);
    assert.deepEqual(
      item.segments.map((s: { page: number }) => s.page),
      [1, 2, 3],
    );
    // Not a scanned import: null.
    const paste = (await call("POST", "/v1/imports", { clientId: "fx5a-paste", text: "一段贴进来的笔记，用来看字段。" })).json().data.import;
    assert.equal(paste.missingPages, null);
  } finally {
    await f.app.close();
  }
});

test("F10: a scanned PDF whose file was cleared takes the same file again", async () => {
  const pdf = { totalPages: 2, pages: [{ n: 1, text: "" }, { n: 2, text: "" }] };
  const f = setup([{ paragraphs: [] }, { paragraphs: [] }, { paragraphs: ["第一页认出来的一段正文，足够长不会被并掉。"] }], pdf);
  try {
    const { call, userId } = await session(f);
    const file = Buffer.from("%PDF-1.4 synthetic");
    const part = multipart(file, "notes.pdf");
    const created = await call("POST", "/v1/imports/file?clientId=fx5a-pdf", part.payload, part.headers);
    assert.equal(created.statusCode, 200, created.body);
    const first = created.json().data.import;
    assert.equal((await settle(call, first.job.id)).status, "failed");
    rmSync(join(f.uploadDir, userId, "imports", first.id), { recursive: true });
    let item = await detail(call, first.id);
    assert.deepEqual(item.missingPages, [1, 2]);
    assert.equal(item.retryPages, 0);
    // Another PDF with fewer pages is refused.
    const short = multipart(file, "other.pdf");
    pdf.totalPages = 1;
    const refused = await call("POST", `/v1/imports/${first.id}/page`, short.payload, short.headers);
    assert.equal(refused.statusCode, 409);
    pdf.totalPages = 2;
    const again = multipart(file, "notes.pdf");
    const replaced = await call("POST", `/v1/imports/${first.id}/page`, again.payload, again.headers);
    assert.equal(replaced.statusCode, 200, replaced.body);
    assert.deepEqual(replaced.json().data.import.missingPages, []);
    assert.equal(replaced.json().data.import.retryPages, 2);
    const read = (await call("POST", `/v1/imports/${first.id}/read`, { pages: 2 })).json().data.import;
    assert.equal((await settle(call, read.job.id)).status, "succeeded");
    item = await detail(call, first.id);
    assert.equal(item.status, "read");
    assert.equal(item.segments.length, 1);
  } finally {
    await f.app.close();
  }
});

test("F09: ?open=1&all=1 lists every unfinished import, however old; the strip's list stays recent", async () => {
  const f = setup();
  try {
    const { call, userId } = await session(f);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++)
      ids.push(
        (await call("POST", "/v1/imports", { clientId: `fx5a-open-${i}`, text: `第 ${i} 段贴进来的笔记，用来看列表。` })).json().data.import.id,
      );
    // Two are a month old; one was given up.
    f.store.db
      .prepare("UPDATE imports SET updated_at='2026-09-01T00:00:00.000Z' WHERE id IN (?,?) AND user_id=?")
      .run(ids[0], ids[1], userId);
    await call("POST", `/v1/imports/${ids[2]}/abandon`);
    const recent = (await call("GET", "/v1/imports?open=1")).json().data.items;
    assert.equal(recent.length, 9);
    assert.ok(!recent.some((row: { id: string }) => [ids[0], ids[1], ids[2]].includes(row.id)));
    const all = (await call("GET", "/v1/imports?open=1&all=1")).json().data.items;
    assert.equal(all.length, 11);
    assert.deepEqual(all.slice(-2).map((row: { id: string }) => row.id).sort(), [ids[0], ids[1]].sort());
    assert.ok(!all.some((row: { id: string }) => row.id === ids[2]));
    assert.deepEqual(Object.keys(all[0]).sort(), Object.keys(recent[0]).sort());
  } finally {
    await f.app.close();
  }
});

test("F11: 解 / 答 / 证明 and their lines stay with their problem until the next one", () => {
  const two = [
    "1. 设函数 f(x)=x^3-3x，求 f(x) 的单调区间和极值。",
    "解：先求导数，f'(x)=3x^2-3=3(x-1)(x+1)。令 f'(x)=0，得到 x=1 或 x=-1，这两个点把定义域分成三段。",
    "当 x<-1 时 f'(x)>0，函数单调递增；当 -1<x<1 时 f'(x)<0，函数单调递减；当 x>1 时 f'(x)>0，函数又单调递增。",
    "所以极大值是 f(-1)=2，极小值是 f(1)=-2。",
    "答：增区间是 (-∞,-1) 和 (1,+∞)，减区间是 (-1,1)，极大值 2，极小值 -2，这就是全部结论。",
    "2. 求极限 lim(x→0) (1-cos x)/x^2 的值，并说明用到的等价无穷小。",
    "解：当 x→0 时，1-cos x 和 x^2/2 是等价无穷小，可以直接替换分子，得到的式子化简以后就是常数。",
    "所以原式等于 1/2，这一步不需要用洛必达法则，替换以后马上就能看出来结果。",
  ];
  // Pasted line by line (five segments before FX5a), and as paragraphs read
  // from a picture.
  for (const segments of [segmentText(two.join("\n")), mergeParagraphs(two)]) {
    assert.equal(segments.length, 2);
    assert.equal(segments[0], two.slice(0, 5).join("\n"));
    assert.equal(segments[1], two.slice(5).join("\n"));
  }
  // 证明 and 分析, then a heading ends the solution.
  const proof = segmentText(
    [
      "例 1 证明：当 x>0 时，有 x>ln(1+x)，并说明等号什么时候成立。",
      "分析：构造辅助函数，把不等式变成函数的单调性问题，再看端点处的值。",
      "证明：设 g(x)=x-ln(1+x)，则 g'(x)=x/(1+x)>0，所以 g(x) 在 x>0 时单调递增，g(x)>g(0)=0。",
      "第二节 中值定理",
      "罗尔定理说的是，闭区间上连续、开区间内可导、端点函数值相等，就有导数为零的点。",
    ].join("\n"),
  );
  assert.equal(proof.length, 2);
  assert.match(proof[0]!, /^例 1[\s\S]*分析：[\s\S]*证明：设/);
  assert.match(proof[1]!, /^第二节 中值定理\n罗尔定理/);
  // A short 答 after a stem's numbered items stays with that problem, and
  // the next numbered problem is its own segment.
  const sample = segmentText(
    [
      "1.",
      "已知函数 f(x)=x^2-2x，求：",
      "（1）f(1) 的值；",
      "（2）f(x) 的最小值。",
      "答案：（1）-1",
      "（2）-1",
      "",
      "2. 计算极限 lim(x→0) sin x / x。",
      "答：1",
      "",
      "第3题",
      "求导：y=e^x·cos x",
      "解：",
      "y'=e^x(cos x - sin x)",
    ].join("\n"),
  );
  assert.deepEqual(sample, [
    "1.\n已知函数 f(x)=x^2-2x，求：\n（1）f(1) 的值；\n（2）f(x) 的最小值。\n答案：（1）-1\n（2）-1",
    "2. 计算极限 lim(x→0) sin x / x。\n答：1",
    "第3题\n求导：y=e^x·cos x\n解：\ny'=e^x(cos x - sin x)",
  ]);
});

const GLM = { provider: "open.bigmodel.cn", model: "glm-5.3" };
const FLASH = { provider: "open.bigmodel.cn", model: "glm-5.3-flash" };
const call = (model: typeof GLM, completionTokens: number): LlmUsage => ({
  ...model,
  calls: 1,
  promptTokens: 0,
  completionTokens,
  ms: 10,
});
function budget(at = "2026-10-14T02:00:00.000Z") {
  const clock = { at: new Date(at) };
  const store = new SqliteStore(":memory:", () => clock.at);
  const userId = store.upsertUser("dev:fx5a", "测试", "dev").id;
  const quota = new Budget(store, { day: 10, week: 50, cap: 500 }, () => clock.at);
  return { store, userId, quota };
}

test("F12: calls of several models are summed per model and each priced at its own row", () => {
  // Batch 1 and 3 on glm-5.3, batch 2 fell back to the flash model.
  const sum = usageSum([call(GLM, 50_000), { ...call(FLASH, 100_000), estimated: true }, call(GLM, 50_000)]);
  assert.ok(Array.isArray(sum));
  assert.deepEqual(
    sum.map((item) => [item.model, item.calls, item.completionTokens, item.estimated ?? false]),
    [
      ["glm-5.3", 2, 100_000, false],
      ["glm-5.3-flash", 1, 100_000, true],
    ],
  );
  // ¥2.80 + ¥0.28, not 200,000 tokens at glm-5.3's ¥28 per million (¥5.60).
  assert.ok(Math.abs(usageCost(sum, DEFAULT_PRICES) - 3.08) < 1e-9);
  // One model: one object, as before.
  const one = usageSum([call(GLM, 1), call(GLM, 2)]);
  assert.ok(!Array.isArray(one));
  assert.equal(one!.completionTokens, 3);
  const { store, userId, quota } = budget();
  quota.charge(userId, "job", "mixed", sum);
  assert.ok(Math.abs(quota.status(userId).day.spent - 3.08) < 1e-9);
  assert.equal(JSON.parse(String((store.db.prepare("SELECT usage FROM quota_spend").get() as { usage: string }).usage)).length, 2);
});

test("F13: a spend keeps the cost it was charged at; a later price applies to later calls only", () => {
  const { store, userId, quota } = budget();
  // ¥1.40, ¥0.14 estimated, and an unpriced model at the highest rate (¥180 per million out).
  quota.charge(userId, "job", "a", call(GLM, 50_000));
  quota.charge(userId, "job", "b", [{ ...call(FLASH, 50_000), estimated: true }]);
  quota.charge(userId, "job", "c", call({ provider: "x", model: "mystery" } as typeof GLM, 1000));
  const rows = store.db.prepare("SELECT source_id,usage FROM quota_spend ORDER BY source_id").all() as { source_id: string; usage: string }[];
  const kept = rows.map((row) => JSON.parse(row.usage));
  assert.ok(Math.abs(kept[0].cost - 1.4) < 1e-9);
  assert.equal(kept[0].completionTokens, 50_000, "the tokens stay");
  assert.ok(Array.isArray(kept[1]));
  assert.ok(Math.abs(kept[1][0].cost - 0.14) < 1e-9);
  assert.ok(Math.abs(kept[2].cost - 0.18) < 1e-9);
  const before = quota.status(userId);
  assert.ok(Math.abs(before.day.spent - 1.72) < 1e-9);
  // The admin makes everything ten times dearer.
  store.saveSetting(
    "ai.prices",
    DEFAULT_PRICES.map((row): Price => ({ ...row, input: row.input * 10, output: row.output * 10, cached: row.cached * 10 })),
  );
  assert.deepEqual(quota.status(userId), before);
  assert.ok(Math.abs(quota.spent(userId, "2026-10-01T00:00:00.000Z") - 1.72) < 1e-9);
  // A later call pays the new price.
  quota.charge(userId, "job", "d", call(GLM, 50_000));
  assert.ok(Math.abs(quota.status(userId).day.spent - 15.72) < 1e-9);
  // A row from before FX5a (no cost) is priced at today's table.
  store.db
    .prepare("INSERT INTO quota_spend(source,source_id,user_id,usage,created_at) VALUES('job','old',?,?,?)")
    .run(userId, JSON.stringify(call(GLM, 50_000)), "2026-10-14T01:00:00.000Z");
  assert.ok(Math.abs(quota.status(userId).day.spent - 29.72) < 1e-9);
});

test("2）-numbered problems and mixed numbers split per problem; 1）items of a stem and steps of a solution stay", () => {
  const mixed = [
    "1. 求函数 f(x)=x^2-4x+3 的最小值，并写出取到最小值时 x 的值。",
    "解：配方得 f(x)=(x-2)^2-1，所以当 x=2 时取到最小值 -1，这就是要求的结论。",
    "2）求极限 lim(x→0) sin 3x / x 的值，并说明用到的重要极限。",
    "解：sin 3x / x = 3·(sin 3x)/(3x)，当 x→0 时 (sin 3x)/(3x)→1，所以极限等于 3。",
  ];
  const paren = mixed.map((line, i) => (i === 0 ? line.replace(/^1\. /, "1）") : line));
  for (const lines of [mixed, paren])
    for (const segments of [segmentText(lines.join("\n")), mergeParagraphs(lines)])
      assert.deepEqual(segments, [lines.slice(0, 2).join("\n"), lines.slice(2).join("\n")]);
  const items = [
    "1. 已知函数 f(x)=x^3-3x，求：",
    "1）f(x) 的单调区间，并写出每一段上函数的增减情况；",
    "2）f(x) 在区间 [-2,2] 上的最大值和最小值，并说明理由。",
    "解：",
    "1）f'(x)=3x^2-3，令 f'(x)=0 得 x=±1，所以增区间是 (-∞,-1) 和 (1,+∞)。",
    "2）比较 f(-2)、f(-1)、f(1)、f(2) 的值，最大值 2，最小值 -2。",
    "2. 求 y=ln x 在 x=1 处的切线方程。",
  ];
  assert.deepEqual(segmentText(items.join("\n")), [items.slice(0, 6).join("\n"), items[6]]);
});

test("a solution's own 1）2）steps stay with it; a later paren number after a solution starts the next problem", () => {
  // 分段样例： 解：1）… opens the solution's steps, so 2）is a step.
  const steps = [
    "1. 求函数 f(x)=x^3-3x 的单调区间和极值。",
    "解：1）求导得 f′(x)=3x^2-3，令导数为零得 x=±1。",
    "2）检查导数符号可知，两侧区间递增，中间区间递减。",
  ];
  for (const segments of [segmentText(steps.join("\n")), mergeParagraphs(steps)])
    assert.deepEqual(segments, [steps.join("\n")]);
  // The same with the stem's own 1）2）items on its line.
  const inline = [
    "1. 已知函数 f(x)=x^3-3x，求：1）f(x) 的单调区间；2）f(x) 在 [-2,2] 上的最值。",
    "解：1）f'(x)=3x^2-3，令 f'(x)=0 得 x=±1，所以增区间是 (-∞,-1) 和 (1,+∞)。",
    "2）比较 f(-2)、f(-1)、f(1)、f(2) 的值，最大值 2，最小值 -2，这就是第二问的结论。",
    "2. 求 y=ln x 在 x=1 处的切线方程，并画出示意图说明切线的位置。",
  ];
  for (const segments of [segmentText(inline.join("\n")), mergeParagraphs(inline)])
    assert.deepEqual(segments, [inline.slice(0, 3).join("\n"), inline[3]]);
  // 1. then 3）(a number skipped): two problems, each with its solution.
  const gap = [
    "1. 求函数 f(x)=x^2-4x+3 的最小值，并写出取到最小值时 x 的值。",
    "解：配方得 f(x)=(x-2)^2-1，所以当 x=2 时取到最小值 -1，这就是要求的结论。",
    "3）求极限 lim(x→0) sin 3x / x 的值，并说明用到的重要极限。",
    "解：sin 3x / x = 3·(sin 3x)/(3x)，当 x→0 时 (sin 3x)/(3x)→1，所以极限等于 3。",
  ];
  for (const segments of [segmentText(gap.join("\n")), mergeParagraphs(gap)])
    assert.deepEqual(segments, [gap.slice(0, 2).join("\n"), gap.slice(2).join("\n")]);
  // A problem numbered 1）is not its own first item: 2）after its solution is the next problem.
  const paren = gap.map((line, i) => (i === 0 ? line.replace(/^1\. /, "1）") : i === 2 ? line.replace(/^3）/, "2）") : line));
  for (const segments of [segmentText(paren.join("\n")), mergeParagraphs(paren)])
    assert.deepEqual(segments, [paren.slice(0, 2).join("\n"), paren.slice(2).join("\n")]);
});

import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import type { ImportFileTools } from "../server/src/modules/imports/parser.js";
import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";
import { SqliteStore } from "../server/src/shared/store.js";

const point = CALC_MAP.chapters[0]!.points[0]!;
const usage = { prompt_tokens: 3, completion_tokens: 2 };
type FakeOptions = {
  cards?: unknown[];
  holdSplit?: Promise<void>;
  failVisionAt?: number[];
  holdVisionAt?: { index: number; promise: Promise<void> };
};
function fakeFetcher(options: FakeOptions = {}) {
  const calls: string[] = [];
  let visionCalls = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      const q = body.questions.q;
      const serialized = JSON.stringify(body.state);
      calls.push(`jev:${q.type}`);
      if (q.type === "noul")
        return new Response(
          JSON.stringify({
            answers: { q: { noul: serialized.includes("危机") ? 1 : 0 } },
          }),
        );
      const criteria = q.criteria as Record<string, string>;
      const choice = criteria[point.id]
        ? point.id
        : criteria.mood
          ? "mood"
          : "none";
      return new Response(
        JSON.stringify({
          answers: {
            q: { choice, confidence: 0.9, probabilities: { [choice]: 0.9 } },
          },
        }),
      );
    }
    const system = String(body.messages[0].content);
    if (system.includes("[IMPORT_SPLIT]")) {
      calls.push("split");
      if (options.holdSplit) await options.holdSplit;
      const cards = options.cards ?? [
        {
          type: "idea",
          scene: "study",
          title: "极限定义",
          summary: "整理极限定义",
          src: [1],
          open: { cat: "verify", text: "核对定义" },
          tags: ["极限"],
        },
      ];
      const content = JSON.stringify({ cards });
      return new Response(
        [
          `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}`,
          `data: ${JSON.stringify({ choices: [], usage })}`,
          "data: [DONE]",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (system.includes("[IMPORT_READ]") || system.includes("文字识别引擎")) {
      calls.push("vision");
      visionCalls++;
      if (options.holdVisionAt?.index === visionCalls)
        await options.holdVisionAt.promise;
      if (options.failVisionAt?.includes(visionCalls))
        return new Response("temporary failure", { status: 503 });
      const content = system.includes("聊天截图")
        ? { lines: [{ who: "me", text: "这是我在截图里写下的一句完整原话" }] }
        : { paragraphs: ["扫描页识别出的正文段落"] };
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(content) } }],
          usage,
        }),
      );
    }
    throw new Error(`unexpected fake request: ${system}`);
  }) as typeof fetch;
  return { fetcher, calls };
}

const defaultTools: ImportFileTools = {
  readDocx: async () => "Word 文件里的正文内容",
  readPdf: async (_data, start, count) => ({
    totalPages: 30,
    pages: [
      {
        n: start,
        text: "这一页有足够长的文本层内容，能够直接读取而不需要调用图片识别。这里继续补足字符数量。",
      },
      { n: start + 1, text: "" },
    ].slice(0, count),
  }),
  rasterizePdfPage: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
};
function setup(
  options: {
    fake?: FakeOptions;
    env?: Record<string, string>;
    tools?: ImportFileTools;
  } = {},
) {
  const store = new SqliteStore(":memory:");
  const uploads = mkdtempSync(join(tmpdir(), "zhiye-import-test-"));
  const fake = fakeFetcher(options.fake);
  const app = buildApp({
    store,
    importTools: options.tools ?? defaultTools,
    fetcher: fake.fetcher,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: uploads,
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-formula-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "fake",
      JEV_API_KEY: "fake",
      OCR_VISION_MODEL: "fake-vision",
      DAILY_OCR_LIMIT: "20",
      DAILY_IMPORT_LIMIT: "10",
      ...options.env,
    }),
  });
  return { app, store, uploads, fake };
}
async function session(app: ReturnType<typeof buildApp>, key = "import-owner") {
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: { key },
  });
  const token = login.json().data.token as string;
  return (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      payload: payload as string,
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
}
function multipart(data: Buffer, filename: string) {
  const boundary = "----zhiye-import-boundary";
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
const jpeg = () =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
async function settle(
  call: Awaited<ReturnType<typeof session>>,
  jobId: string,
) {
  for (let i = 0; i < 200; i++) {
    const response = await call("GET", `/v1/jobs/${jobId}`);
    const job = response.json().data;
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("job did not settle");
}

test("paste import is idempotent, split is charged once, and selected cards save once", async () => {
  const { app, store, fake } = setup();
  try {
    const call = await session(app);
    const payload = {
      clientId: "paste-1",
      text: "极限定义需要左右两侧都成立",
      own: false,
    };
    const first = await call("POST", "/v1/imports", payload);
    const repeated = await call("POST", "/v1/imports", payload);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(repeated.json().data.import.id, first.json().data.import.id);
    assert.equal(
      (await call("GET", "/v1/imports")).json().data.items.length,
      1,
    );
    const id = first.json().data.import.id as string;
    const split = await call("POST", `/v1/imports/${id}/cards`, {
      clientId: "split-1",
    });
    const retried = await call("POST", `/v1/imports/${id}/cards`, {
      clientId: "split-1",
    });
    assert.equal(
      retried.json().data.import.job.id,
      split.json().data.import.job.id,
    );
    const settled = await settle(call, split.json().data.import.job.id);
    assert.equal(settled.status, "succeeded", JSON.stringify(settled));
    const ready = (await call("GET", `/v1/imports/${id}`)).json().data;
    assert.equal(ready.status, "picking");
    assert.equal(ready.candidates[0].pointId, point.id);
    assert.equal(ready.candidates[0].pointName, point.name);
    const ownChanged = await call("PATCH", `/v1/imports/${id}`, { own: true });
    assert.equal(ownChanged.statusCode, 200, ownChanged.body);
    assert.equal(ownChanged.json().data.import.own, true);
    assert.equal(
      (await call("PATCH", `/v1/imports/${id}`, { keepSegments: [1] }))
        .statusCode,
      409,
    );
    const saveBody = {
      clientId: "save-1",
      selections: [
        {
          candidateId: "c1",
          mine: "极限定义需要左右两侧都成立",
          tags: ["手动标签"],
          pointId: point.id,
        },
      ],
    };
    const [saved, savedAgain] = await Promise.all([
      call("POST", `/v1/imports/${id}/save`, saveBody),
      call("POST", `/v1/imports/${id}/save`, saveBody),
    ]);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().data.cards[0].titleBy, "ai");
    const reopened = (await call("GET", `/v1/imports/${id}`)).json().data;
    assert.equal(reopened.savedCards[0].id, saved.json().data.cards[0].id);
    assert.equal(
      savedAgain.json().data.cards[0].id,
      saved.json().data.cards[0].id,
    );
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) n FROM cards WHERE origin='import'")
        .get()!.n,
      1,
    );
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) n FROM quota_receipts WHERE kind='import_cards'",
        )
        .get()!.n,
      1,
    );
    assert.equal(fake.calls.filter((call) => call === "split").length, 1);
  } finally {
    await app.close();
  }
});

test("empty split supports an exact manual quote and rejects forged text", async () => {
  const { app } = setup({ fake: { cards: [] } });
  try {
    const call = await session(app, "manual");
    const created = await call("POST", "/v1/imports", {
      clientId: "manual",
      text: "这是可以手动选取的一句原文",
    });
    const id = created.json().data.import.id;
    const split = await call("POST", `/v1/imports/${id}/cards`, {
      clientId: "manual-split",
    });
    await settle(call, split.json().data.import.job.id);
    assert.deepEqual(
      (await call("GET", `/v1/imports/${id}`)).json().data.candidates,
      [],
    );
    const forged = await call("POST", `/v1/imports/${id}/save`, {
      clientId: "bad",
      selections: [
        {
          quote: "这句不是用户导入的文字",
          type: "idea",
          scene: "life",
        },
      ],
    });
    assert.equal(forged.statusCode, 400);
    assert.equal(forged.json().code, "IMPORT_CANDIDATE");
    const saved = await call("POST", `/v1/imports/${id}/save`, {
      clientId: "good",
      selections: [
        {
          quote: "这是可以手动选取的一句原文",
          type: "idea",
          scene: "life",
          title: "手动收卡",
        },
      ],
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(
      saved.json().data.cards[0].quote,
      "这是可以手动选取的一句原文",
    );
  } finally {
    await app.close();
  }
});

test("paste and upload limits are enforced before work or quota is recorded", async () => {
  const { app, store } = setup();
  try {
    const call = await session(app, "limits");
    // one limit (20000) with the page; whole segments are kept and
    // the rest is offered as the next import instead of being dropped.
    const capped = await call("POST", "/v1/imports", {
      clientId: "long",
      text: "字".repeat(21_000),
    });
    assert.equal(capped.statusCode, 200, capped.body);
    const cappedImport = capped.json().data.import;
    assert.ok(cappedImport.chars <= 20_000 && cappedImport.chars > 19_000);
    assert.equal(cappedImport.chars + cappedImport.restChars, 21_000);
    assert.equal(cappedImport.truncated, true);
    const rejected = await call("POST", "/v1/imports", {
      clientId: "too-long",
      text: "字".repeat(60_001),
    });
    assert.equal(rejected.statusCode, 400, rejected.body);
    const largeFile = multipart(
      Buffer.alloc(10 * 1024 * 1024 + 1, 1),
      "large.txt",
    );
    const fileResponse = await call(
      "POST",
      "/v1/imports/file?clientId=large",
      largeFile.payload,
      largeFile.headers,
    );
    assert.equal(fileResponse.statusCode, 413, fileResponse.body);
    const largePhoto = multipart(
      Buffer.concat([jpeg(), Buffer.alloc(5 * 1024 * 1024, 1)]),
      "large.jpg",
    );
    const photoResponse = await call(
      "POST",
      "/v1/imports/photo?clientId=large-photo&source=photo&index=0&count=1",
      largePhoto.payload,
      largePhoto.headers,
    );
    assert.equal(photoResponse.statusCode, 413, photoResponse.body);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) n FROM quota_receipts").get()!.n,
      0,
    );
  } finally {
    await app.close();
  }
});

test("txt, docx and PDF use bounded parsing; a scanned PDF page runs OCR and removes the source", async () => {
  let pdfArgs: [number, number] | undefined;
  const tools: ImportFileTools = {
    ...defaultTools,
    readPdf: async (data, start, count) => {
      assert.equal(data.subarray(0, 5).toString(), "%PDF-");
      pdfArgs = [start, count];
      return defaultTools.readPdf(data, start, count);
    },
  };
  const { app, uploads, store } = setup({ tools });
  try {
    const call = await session(app, "files");
    for (const [clientId, filename, data] of [
      ["txt", "note.txt", Buffer.from("纯文字文件内容")],
      ["docx", "note.docx", Buffer.from([0x50, 0x4b, 1, 2])],
    ] as const) {
      const part = multipart(data, filename);
      const response = await call(
        "POST",
        `/v1/imports/file?clientId=${clientId}`,
        part.payload,
        part.headers,
      );
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().data.import.status, "read");
    }
    const part = multipart(Buffer.from("%PDF-fake"), "scan.pdf");
    const response = await call(
      "POST",
      "/v1/imports/file?clientId=pdf&start=5",
      part.payload,
      part.headers,
    );
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(pdfArgs, [5, 20]);
    const jobId = response.json().data.import.job.id;
    const settled = await settle(call, jobId);
    assert.equal(settled.status, "succeeded", JSON.stringify(settled));
    const detail = (
      await call("GET", `/v1/imports/${response.json().data.import.id}`)
    ).json().data;
    assert.equal(detail.status, "read");
    assert.equal(detail.truncated, true);
    assert.equal(detail.pageRange.from, 5);
    assert.ok(
      detail.segments.some((segment: { text: string }) =>
        segment.text.includes("扫描页"),
      ),
    );
    const userId = String(
      (
        store.db
          .prepare("SELECT user_id FROM imports WHERE id=?")
          .get(detail.id) as { user_id: string }
      ).user_id,
    );
    assert.equal(
      existsSync(join(uploads, userId, "imports", detail.id)),
      false,
    );
  } finally {
    await app.close();
  }
});

test("PDF scan confirmation never exceeds the remaining per-page OCR quota", async () => {
  const tools: ImportFileTools = {
    ...defaultTools,
    readPdf: async (_data, start) => ({
      totalPages: 2,
      pages: [
        { n: start, text: "" },
        { n: start + 1, text: "" },
      ],
    }),
  };
  // the per-page count is the hidden daily cap now; under the
  // budget a scan starts with all its pages or none.
  const { app, store } = setup({ tools, env: { DAILY_SAFETY_CAP: "1" } });
  try {
    const call = await session(app, "pdf-quota");
    const part = multipart(Buffer.from("%PDF-fake"), "scan.pdf");
    const response = await call(
      "POST",
      "/v1/imports/file?clientId=scan-quota",
      part.payload,
      part.headers,
    );
    assert.equal(response.statusCode, 200, response.body);
    const imported = response.json().data.import;
    assert.equal(imported.job, null);
    assert.deepEqual(imported.needsOcr, { pages: 2, available: 0 });
    const refused = await call("POST", `/v1/imports/${imported.id}/read`, {
      pages: 2,
    });
    assert.equal(refused.statusCode, 429, refused.body);
    const accepted = await call("POST", `/v1/imports/${imported.id}/read`, {
      pages: 1,
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    const job = await settle(call, accepted.json().data.import.job.id);
    assert.equal(job.status, "succeeded");
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) n FROM quota_receipts WHERE kind='import_scan_pdf'",
        )
        .get()!.n,
      1,
    );
  } finally {
    await app.close();
  }
});

test("sequential single-photo uploads start once, charge by page, and retain partial page status", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app, store, fake } = setup({
    fake: {
      failVisionAt: [2],
      holdVisionAt: { index: 2, promise: held },
    },
  });
  try {
    const call = await session(app, "photos");
    const firstPart = multipart(jpeg(), "one.jpg");
    const first = await call(
      "POST",
      "/v1/imports/photo?clientId=album&source=photo&index=0&count=2",
      firstPart.payload,
      firstPart.headers,
    );
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().data.import.job, null);
    const replay = await call(
      "POST",
      "/v1/imports/photo?clientId=album&source=photo&index=0&count=2",
      firstPart.payload,
      firstPart.headers,
    );
    assert.equal(replay.statusCode, 200, replay.body);
    const secondPart = multipart(jpeg(), "two.jpg");
    const second = await call(
      "POST",
      "/v1/imports/photo?clientId=album&source=photo&index=1&count=2",
      secondPart.payload,
      secondPart.headers,
    );
    assert.equal(second.statusCode, 200, second.body);
    const id = second.json().data.import.id;
    let checkpointed = false;
    for (let i = 0; i < 100; i++) {
      const row = store.db
        .prepare("SELECT pages,segments FROM imports WHERE id=?")
        .get(id) as { pages: string; segments: string };
      const pages = JSON.parse(row.pages) as { ok: boolean }[];
      if (pages[0]?.ok && JSON.parse(row.segments).length) {
        checkpointed = true;
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(
      checkpointed,
      true,
      "the first page is durable before the second provider call finishes",
    );
    release();
    const job = await settle(call, second.json().data.import.job.id);
    assert.equal(job.status, "succeeded");
    assert.deepEqual(job.result.failed, [2]);
    const detail = (
      await call("GET", `/v1/imports/${second.json().data.import.id}`)
    ).json().data;
    assert.equal(detail.status, "read");
    assert.equal(detail.pages.length, 2);
    assert.equal(detail.partial, true);
    assert.deepEqual(
      detail.pages.map((page: { ok: boolean }) => page.ok),
      [true, false],
    );
    assert.equal(fake.calls.filter((value) => value === "vision").length, 2);
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) n FROM quota_receipts WHERE kind='import_read'",
        )
        .get()!.n,
      2,
    );
  } finally {
    release();
    await app.close();
  }
});

test("deleting an import while split awaits prevents a late commit or resurrection", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app, store } = setup({ fake: { holdSplit: pending } });
  try {
    const call = await session(app, "deleted");
    const created = await call("POST", "/v1/imports", {
      clientId: "gone",
      text: "等待期间删除的原文",
    });
    const id = created.json().data.import.id;
    const split = await call("POST", `/v1/imports/${id}/cards`, {
      clientId: "gone-split",
    });
    const jobId = split.json().data.import.job.id;
    const removed = await call("DELETE", `/v1/imports/${id}`);
    assert.equal(removed.statusCode, 200, removed.body);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await call("GET", `/v1/imports/${id}`)).statusCode, 404);
    assert.equal(
      store.db.prepare("SELECT 1 FROM imports WHERE id=?").get(id),
      undefined,
    );
    const job = store.db
      .prepare("SELECT status,params,result FROM jobs WHERE id=?")
      .get(jobId) as Record<string, unknown>;
    assert.equal(job.params, '{"deleted":true}');
    assert.equal(job.result, null);
    assert.notEqual(job.status, "succeeded");
  } finally {
    release();
    await app.close();
  }
});

test("ownership, OCR quota, crisis candidates and mood consent remain enforced", async () => {
  // two split jobs leave one receipt under the hidden cap of three.
  const { app } = setup({
    env: { DAILY_SAFETY_CAP: "3" },
    fake: {
      cards: [
        {
          type: "idea",
          scene: "life",
          title: "危机内容",
          summary: "危机内容",
          src: [1],
          open: null,
          tags: [],
        },
      ],
    },
  });
  try {
    const owner = await session(app, "bounds-owner");
    const other = await session(app, "bounds-other");
    const created = await owner("POST", "/v1/imports", {
      clientId: "private",
      text: "危机内容",
    });
    const id = created.json().data.import.id;
    assert.equal((await other("GET", `/v1/imports/${id}`)).statusCode, 404);
    const split = await owner("POST", `/v1/imports/${id}/cards`, {
      clientId: "crisis",
    });
    await settle(owner, split.json().data.import.job.id);
    const detail = (await owner("GET", `/v1/imports/${id}`)).json().data;
    assert.equal(detail.candidates[0].crisis, true);
    assert.equal(detail.candidates[0].quote, "");
    assert.equal(detail.candidates[0].selected, false);
    const crisisSaved = await owner("POST", `/v1/imports/${id}/save`, {
      clientId: "crisis-save",
      selections: [{ candidateId: "c1" }],
    });
    assert.equal(crisisSaved.statusCode, 200, crisisSaved.body);
    assert.equal(crisisSaved.json().data.crisis, true);
    assert.equal(crisisSaved.json().data.cards[0].crisis, true);
    const moodSource = await owner("POST", "/v1/imports", {
      clientId: "mood",
      text: "今天有点紧张，想先缓一缓",
    });
    const moodId = moodSource.json().data.import.id;
    const moodSplit = await owner("POST", `/v1/imports/${moodId}/cards`, {
      clientId: "mood-split",
    });
    await settle(owner, moodSplit.json().data.import.job.id);
    const mood = await owner("POST", `/v1/imports/${moodId}/save`, {
      clientId: "mood-save",
      selections: [
        {
          quote: "今天有点紧张，想先缓一缓",
          type: "idea",
          scene: "mood",
        },
      ],
    });
    assert.equal(mood.statusCode, 403, mood.body);
    assert.equal(mood.json().code, "MOOD_CONSENT_REQUIRED");
    const photo = multipart(jpeg(), "one.jpg");
    const tooMany = await owner(
      "POST",
      "/v1/imports/photo?clientId=quota&source=photo&index=1&count=2",
      photo.payload,
      photo.headers,
    );
    assert.equal(tooMany.statusCode, 200, tooMany.body);
    const final = await owner(
      "POST",
      "/v1/imports/photo?clientId=quota&source=photo&index=0&count=2",
      photo.payload,
      photo.headers,
    );
    assert.equal(final.statusCode, 429, final.body);
    assert.equal(final.json().code, "DAILY_LIMIT");
  } finally {
    await app.close();
  }
});

test("import split never exposes generated prohibited wording", async (t) => {
  const f = setup({
    fake: {
      cards: [
        {
          type: "idea",
          scene: "life",
          title: "心理咨询",
          summary: "整理安排",
          src: [1],
          open: null,
          tags: [],
        },
      ],
    },
  });
  t.after(() => f.app.close());
  const call = await session(f.app);
  const created = await call("POST", "/v1/imports", {
    text: "今天先把安排写清楚",
    clientId: "banned",
  });
  const id = created.json().data.import.id;
  const split = await call("POST", `/v1/imports/${id}/cards`, {
    clientId: "banned-split",
  });
  const job = await settle(call, split.json().data.import.job.id);
  assert.equal(job.status, "failed");
  assert.equal(job.error.code, "AI_BAD_OUTPUT");
  const detail = await call("GET", `/v1/imports/${id}`);
  assert.equal(detail.json().data.candidates.length, 0);
});

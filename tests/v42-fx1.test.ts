// an import's detail says which pictures reached the server
// (`received`), so a client that left while sending can send the rest under
// the same clientId. Synthetic data only.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";

const usage = { prompt_tokens: 3, completion_tokens: 2 };
// The vision model reads every page as one paragraph.
const fetcher = (async () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ paragraphs: ["照片里认出来的一段正文"] }) } }],
      usage,
    }),
  )) as typeof fetch;

function setup() {
  const app = buildApp({
    store: new SqliteStore(":memory:"),
    fetcher,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-fx1-")),
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-fx1-formula-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "fake",
      JEV_API_KEY: "fake",
      OCR_VISION_MODEL: "fake-vision",
      DAILY_OCR_LIMIT: "20",
      DAILY_IMPORT_LIMIT: "10",
      JOB_CONCURRENCY: "1",
    }),
  });
  return app;
}
async function session(app: ReturnType<typeof buildApp>) {
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: { key: "fx1-owner" },
  });
  const token = login.json().data.token as string;
  return (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url,
      payload: payload as string,
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
}
function multipart(data: Buffer, filename: string) {
  const boundary = "----zhiye-fx1-boundary";
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
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);

test("received names the pictures on the server; the rest sent later (same clientId) starts the read", async () => {
  const app = setup();
  try {
    const call = await session(app);
    const send = async (index: number) => {
      const part = multipart(jpeg(), `${index}.jpg`);
      const response = await call(
        "POST",
        `/v1/imports/photo?clientId=fx1-left&source=photo&index=${index}&count=3`,
        part.payload,
        part.headers,
      );
      assert.equal(response.statusCode, 200, response.body);
      return response.json().data.import;
    };
    // The page was left after the first picture.
    const first = await send(0);
    const left = (await call("GET", `/v1/imports/${first.id}`)).json().data;
    assert.equal(left.status, "reading");
    assert.equal(left.job, null);
    assert.equal(left.failedJob, null);
    assert.deepEqual(left.received, [1]);
    // Old clients still see what they saw before. Under budgets
    // `available` is the pages that may start now: all three.
    assert.deepEqual(left.needsOcr, { pages: 3, available: 3 });
    assert.equal(left.retryPages, 1);
    // Sending the first again changes nothing (idempotent per clientId and index).
    const again = await send(0);
    assert.equal(again.id, first.id);
    assert.deepEqual(again.received, [1]);
    // The rest arrives: reading starts.
    assert.deepEqual((await send(1)).received, [1, 2]);
    const last = await send(2);
    assert.equal(last.id, first.id);
    assert.ok(last.job, "the read job started");
    assert.deepEqual(last.received, [1, 2, 3]);
    // Not about pictures: null.
    const paste = (
      await call("POST", "/v1/imports", { clientId: "fx1-paste", text: "一段贴进来的笔记，用来看字段。" })
    ).json().data.import;
    assert.equal(paste.received, null);
  } finally {
    await app.close();
  }
});

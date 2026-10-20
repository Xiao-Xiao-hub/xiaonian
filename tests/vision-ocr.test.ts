import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { ChatModel } from "../server/src/providers/llm.js";
import { OcrError } from "../server/src/providers/tencent-ocr.js";
import { VisionOcr } from "../server/src/providers/vision-ocr.js";

type Call = { url: string; body: any };
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), body: JSON.parse(String(init?.body)) };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetcher, calls };
}
const reply = (content: unknown, status = 200) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content:
              typeof content === "string" ? content : JSON.stringify(content),
          },
        },
      ],
      usage: { prompt_tokens: 500, completion_tokens: 40 },
    }),
    { status },
  );
const visionOcr = (fetcher: typeof fetch, apiKey = "k") =>
  new VisionOcr(
    new ChatModel(
      {
        baseUrl: "https://llm.example/v4",
        apiKey,
        model: "vision-test",
        extraBody: {},
        timeoutMs: 5000,
      },
      fetcher,
    ),
  );
const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(60, 1),
]);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
const bmp = Buffer.concat([Buffer.from("BM"), Buffer.alloc(52, 1)]);
const imageUrl = (call: Call) =>
  call.body.messages.at(-1).content[0].image_url.url as string;

async function rejectsWith(
  promise: Promise<unknown>,
  code: string,
  billing = "none",
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof OcrError);
    assert.equal(error.code, code);
    assert.equal(error.billing, billing);
    return true;
  });
}

test("视觉模型把每段转写成一行，图片以 data URL 发出", async () => {
  const { fetcher, calls } = fakeFetch(() =>
    reply({ paragraphs: ["已知 f(x)=x²+1", "求 f(2) 的值。"] }),
  );
  const ocr = visionOcr(fetcher);
  assert.equal(ocr.configured, true);
  const result = await ocr.recognize(png);
  assert.deepEqual(result.lines, [
    { text: "已知 f(x)=x²+1", confidence: null, paragraph: 0 },
    { text: "求 f(2) 的值。", confidence: null, paragraph: 1 },
  ]);
  assert.equal(calls[0].url, "https://llm.example/v4/chat/completions");
  assert.equal(calls[0].body.model, "vision-test");
  assert.match(calls[0].body.messages[0].content, /文字识别引擎/);
  assert.equal(
    imageUrl(calls[0]),
    `data:image/png;base64,${png.toString("base64")}`,
  );
  assert.deepEqual(
    { ...(result.usage as object), ms: 0 },
    {
      provider: "llm.example",
      model: "vision-test",
      calls: 1,
      promptTokens: 500,
      completionTokens: 40,
      ms: 0,
    },
  );
  await ocr.recognize(jpeg);
  assert.match(imageUrl(calls[1]), /^data:image\/jpeg;base64,/);
  // The model rejects BMP, so it is refused before any call.
  await rejectsWith(ocr.recognize(bmp), "OCR_BAD_IMAGE");
  assert.equal(calls.length, 2);
});

test("模型错误映射为识别错误，保留计费状态和用量", async () => {
  await rejectsWith(
    visionOcr(fakeFetch(() => reply("x")).fetcher, "").recognize(jpeg),
    "OCR_NOT_CONFIGURED",
  );
  await rejectsWith(
    visionOcr(fakeFetch(() => reply({}, 401)).fetcher).recognize(jpeg),
    "OCR_AUTH",
  );
  await rejectsWith(
    visionOcr(fakeFetch(() => reply({}, 429)).fetcher).recognize(jpeg),
    "OCR_UNAVAILABLE",
  );
  await rejectsWith(
    visionOcr(fakeFetch(() => reply({}, 500)).fetcher).recognize(jpeg),
    "OCR_UNAVAILABLE",
  );
  // A broken connection after sending may still be billed.
  await rejectsWith(
    visionOcr(
      fakeFetch(() => {
        throw new Error("socket hang up");
      }).fetcher,
    ).recognize(jpeg),
    "OCR_UNAVAILABLE",
    "unknown",
  );
  // Unusable output twice: one corrective retry, then a failure that keeps the usage.
  const bad = fakeFetch(() => reply("不是 JSON"));
  await assert.rejects(visionOcr(bad.fetcher).recognize(jpeg), (error) => {
    assert.ok(error instanceof OcrError);
    assert.equal(error.code, "OCR_FAILED");
    assert.equal((error as { usage?: { calls: number } }).usage?.calls, 2);
    return true;
  });
  assert.equal(bad.calls.length, 2);
});

function makeApp(env: Record<string, string>, fetcher: typeof fetch) {
  return buildApp({
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "test-llm",
      ...env,
    }),
    fetcher,
  });
}
async function uploadProblem(app: ReturnType<typeof makeApp>) {
  const { token } = (
    await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key: "owner" },
    })
  ).json().data;
  const call = (method: "GET" | "POST", url: string, payload?: Buffer) =>
    app.inject({
      method,
      url,
      payload,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
    });
  const boundary = "----zhiye-vision-boundary";
  const { material, job } = (
    await call(
      "POST",
      "/v1/materials/image?kind=problem",
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
        ),
        jpeg,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    )
  ).json().data;
  for (let i = 0; i < 200; i++) {
    const status = (await call("GET", `/v1/jobs/${job.id}`)).json().data.status;
    if (!["queued", "running"].includes(status)) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  return (await call("GET", `/v1/materials/${material.id}`)).json().data;
}

test("没有腾讯云密钥但配了视觉模型时，拍照识别走视觉模型", async () => {
  const { fetcher, calls } = fakeFetch(() =>
    reply({
      paragraphs: ["商品原价 60 元，打八折后再减 5 元，", "现价多少元？"],
    }),
  );
  const app = makeApp({ OCR_VISION_MODEL: "vision-test" }, fetcher);
  try {
    assert.equal(
      (await app.inject({ url: "/v1/config" })).json().data.ocr,
      true,
    );
    const detail = await uploadProblem(app);
    assert.equal(detail.ocr.status, "succeeded");
    assert.equal(detail.current.origin, "ocr");
    assert.deepEqual(detail.current.paragraphs, [
      "商品原价 60 元，打八折后再减 5 元，",
      "现价多少元？",
    ]);
    assert.deepEqual(detail.current.doubts, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.model, "vision-test");
  } finally {
    await app.close();
  }
});

test("腾讯云密钥齐全时仍用腾讯云，不调用视觉模型", async () => {
  const urls: string[] = [];
  const app = makeApp(
    {
      OCR_VISION_MODEL: "vision-test",
      TENCENT_SECRET_ID: "AKIDtest",
      TENCENT_SECRET_KEY: "test-secret",
    },
    (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          Response: {
            RequestId: "req-1",
            TextDetections: [{ DetectedText: "现价多少元？", Confidence: 99 }],
          },
        }),
      );
    }) as typeof fetch,
  );
  try {
    const detail = await uploadProblem(app);
    assert.equal(detail.ocr.status, "succeeded");
    assert.deepEqual(urls, ["https://ocr.tencentcloudapi.com/"]);
  } finally {
    await app.close();
  }
});

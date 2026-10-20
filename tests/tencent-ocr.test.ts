import test from "node:test";
import assert from "node:assert/strict";
import {
  OcrError,
  TencentOcr,
  tc3Sign,
} from "../server/src/providers/tencent-ocr.js";

type Call = { url: string; headers: Record<string, string>; body: string };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: String(init?.body),
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetcher, calls };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const apiError = (Code: string) =>
  json({ Response: { Error: { Code, Message: "x" }, RequestId: "req-err" } });
const keys = {
  secretId: "AKIDtest",
  secretKey: "secret-test",
  timeoutMs: 5000,
};

async function rejectsWith(
  promise: Promise<unknown>,
  code: string,
  billing?: string,
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof OcrError);
    assert.equal(error.code, code);
    if (billing) assert.equal(error.billing, billing);
    return true;
  });
}

// Worked example from https://cloud.tencent.com/document/api/213/30654 (also /document/api/866/33519).
// The doc masks SecretId/SecretKey, so the final Signature (10b1a37a...) cannot be reproduced;
// we assert every intermediate value the doc prints plus the Authorization layout.
test("TC3 签名与官方文档示例的中间值一致", () => {
  const payload =
    '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}';
  const r = tc3Sign({
    secretId: "AKIDexample",
    secretKey: "masked-in-doc",
    service: "cvm",
    host: "cvm.tencentcloudapi.com",
    action: "DescribeInstances",
    timestamp: 1551113065,
    payload,
  });
  assert.equal(
    r.canonicalRequest,
    [
      "POST",
      "/",
      "",
      "content-type:application/json; charset=utf-8",
      "host:cvm.tencentcloudapi.com",
      "x-tc-action:describeinstances",
      "",
      "content-type;host;x-tc-action",
      "35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064",
    ].join("\n"),
  );
  assert.equal(
    r.hashedCanonicalRequest,
    "7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84",
  );
  assert.equal(
    r.stringToSign,
    [
      "TC3-HMAC-SHA256",
      "1551113065",
      "2019-02-25/cvm/tc3_request",
      "7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84",
    ].join("\n"),
  );
  assert.match(
    r.authorization,
    /^TC3-HMAC-SHA256 Credential=AKIDexample\/2019-02-25\/cvm\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/,
  );
  assert.ok(r.authorization.endsWith(r.signature));
});

test("recognize 发送正确的请求头和正文，并解析识别结果", async () => {
  const { fetcher, calls } = fakeFetch(() =>
    json({
      Response: {
        TextDetections: [
          {
            DetectedText: "第一行",
            Confidence: 99,
            AdvancedInfo: '{"Parag":{"ParagNo":1}}',
          },
          { DetectedText: "第二行", AdvancedInfo: "not json" },
          { DetectedText: "第三行", Confidence: 87, AdvancedInfo: "{}" },
        ],
        Language: "zh",
        RequestId: "req-1",
      },
    }),
  );
  const ocr = new TencentOcr(
    { ...keys, region: "ap-shanghai" },
    fetcher,
    () => 1551113065123,
  );
  const image = Buffer.from("fake image bytes");
  const result = await ocr.recognize(image);

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, "https://ocr.tencentcloudapi.com/");
  assert.equal(call.headers["X-TC-Action"], "GeneralBasicOCR");
  assert.equal(call.headers["X-TC-Version"], "2018-11-19");
  assert.equal(call.headers["X-TC-Region"], "ap-shanghai");
  assert.equal(call.headers["X-TC-Timestamp"], "1551113065");
  assert.equal(call.headers["Host"], "ocr.tencentcloudapi.com");
  assert.equal(call.headers["Content-Type"], "application/json; charset=utf-8");
  assert.match(
    call.headers["Authorization"] ?? "",
    /Credential=AKIDtest\/2019-02-25\/ocr\/tc3_request, /,
  );
  assert.deepEqual(JSON.parse(call.body), {
    ImageBase64: image.toString("base64"),
    LanguageType: "zh",
  });

  assert.deepEqual(result, {
    requestId: "req-1",
    lines: [
      { text: "第一行", confidence: 99, paragraph: 1 },
      { text: "第二行", confidence: null, paragraph: null },
      { text: "第三行", confidence: 87, paragraph: null },
    ],
  });
  assert.equal(ocr.configured, true);
});

test("ImageNoText 返回空结果而不是错误", async () => {
  const { fetcher } = fakeFetch(() => apiError("FailedOperation.ImageNoText"));
  assert.deepEqual(
    await new TencentOcr(keys, fetcher).recognize(Buffer.from("x")),
    { lines: [], requestId: "req-err" },
  );
});

test("接口错误码映射到对应的 OcrError", async () => {
  const cases: [string, string][] = [
    ["AuthFailure.SignatureFailure", "OCR_AUTH"],
    ["ResourceUnavailable.InArrears", "OCR_QUOTA"],
    ["RequestLimitExceeded", "OCR_QUOTA"],
    ["LimitExceeded.TooLargeFileError", "OCR_BAD_IMAGE"],
    ["FailedOperation.ImageDecodeFailed", "OCR_BAD_IMAGE"],
    ["FailedOperation.OcrFailed", "OCR_FAILED"],
  ];
  for (const [code, expected] of cases) {
    const { fetcher } = fakeFetch(() => apiError(code));
    await rejectsWith(
      new TencentOcr(keys, fetcher).recognize(Buffer.from("x")),
      expected,
      "none",
    );
  }
});

test("HTTP 500 和网络失败映射为 OCR_UNAVAILABLE", async () => {
  const http500 = fakeFetch(() => new Response("oops", { status: 500 }));
  await rejectsWith(
    new TencentOcr(keys, http500.fetcher).recognize(Buffer.from("x")),
    "OCR_UNAVAILABLE",
  );
  const down = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
  await rejectsWith(
    new TencentOcr(keys, down.fetcher).recognize(Buffer.from("x")),
    "OCR_UNAVAILABLE",
  );
});

function waitForAbort() {
  return (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

test("超时映射为 OCR_TIMEOUT，计费状态未知", async () => {
  const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout's timer is unref'd
  try {
    const ocr = new TencentOcr({ ...keys, timeoutMs: 10 }, waitForAbort());
    await rejectsWith(
      ocr.recognize(Buffer.from("x")),
      "OCR_TIMEOUT",
      "unknown",
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test("调用方主动取消时原样抛出取消，而不是伪装成超时", async () => {
  const controller = new AbortController();
  const ocr = new TencentOcr({ ...keys, timeoutMs: 5000 }, waitForAbort());
  const pending = ocr.recognize(Buffer.from("x"), controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(!(error instanceof OcrError));
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
});

test("缺少密钥时抛出 OCR_NOT_CONFIGURED 且不发请求", async () => {
  const { fetcher, calls } = fakeFetch(() => json({}));
  const ocr = new TencentOcr(
    { secretId: "AKIDtest", timeoutMs: 1000 },
    fetcher,
  );
  assert.equal(ocr.configured, false);
  await rejectsWith(
    ocr.recognize(Buffer.from("x")),
    "OCR_NOT_CONFIGURED",
    "none",
  );
  assert.equal(calls.length, 0);
});

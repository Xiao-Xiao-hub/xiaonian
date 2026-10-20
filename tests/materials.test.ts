import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import {
  ocrText,
  splitParagraphs,
} from "../server/src/modules/materials/service.js";

type App = ReturnType<typeof buildApp>;
const dir = () => mkdtempSync(join(tmpdir(), "zhiye-"));
function makeApp(
  options: {
    path?: string;
    uploads?: string;
    ocr?: boolean;
    fetcher?: typeof fetch;
    env?: Record<string, string>;
  } = {},
) {
  return buildApp({
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: options.path ?? ":memory:",
      UPLOAD_DIR: options.uploads ?? dir(),
      LOG_LEVEL: "silent",
      ...(options.ocr === false
        ? {}
        : { TENCENT_SECRET_ID: "AKIDtest", TENCENT_SECRET_KEY: "test-secret" }),
      ...options.env,
    }),
    fetcher: options.fetcher,
  });
}
async function login(app: App, key = "owner") {
  const { token } = (
    await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key },
    })
  ).json().data;
  return async (
    method: string,
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: method as "GET",
      url,
      payload: payload as string,
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
}
function multipart(data: Buffer, filename = "photo.jpg") {
  const boundary = "----zhiye-test-boundary";
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
const jpeg = (size = 64) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(size - 4, 1),
  ]);
async function settle(call: Awaited<ReturnType<typeof login>>, jobId: string) {
  for (let i = 0; i < 200; i++) {
    const job = (await call("GET", `/v1/jobs/${jobId}`)).json().data;
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job did not finish");
}

test("text is split into numbered paragraphs and OCR lines are joined per paragraph", () => {
  assert.deepEqual(splitParagraphs(" 第一段 \n\n\n第二段\r\n第三段 "), [
    "第一段",
    "第二段",
    "第三段",
  ]);
  assert.equal(
    ocrText([
      { text: "水在不同温度下", confidence: 99, paragraph: 1 },
      { text: "会呈现三种状态。", confidence: 97, paragraph: 1 },
      { text: "Water can", confidence: 90, paragraph: 2 },
      { text: "boil.", confidence: 90, paragraph: 2 },
      { text: "无段落信息", confidence: 90, paragraph: null },
    ]),
    "水在不同温度下会呈现三种状态。\nWater can boil.\n无段落信息",
  );
});

test("a user saves a note and a problem, finds them again and sees them after a restart", async () => {
  const path = join(dir(), "app.sqlite");
  let app = makeApp({ path });
  try {
    const call = await login(app);
    const note = await call("POST", "/v1/materials", {
      kind: "note",
      text: "水的三态变化\n水在 0℃ 以下结成冰。\n\n水在 100℃ 沸腾变成水蒸气。",
    });
    assert.equal(note.statusCode, 200);
    const detail = note.json().data;
    assert.equal(detail.title, "水的三态变化");
    assert.equal(detail.status, "draft");
    assert.equal(detail.version, 1);
    assert.equal(detail.current.origin, "typed");
    assert.deepEqual(detail.current.paragraphs, [
      "水的三态变化",
      "水在 0℃ 以下结成冰。",
      "水在 100℃ 沸腾变成水蒸气。",
    ]);
    assert.equal(detail.current.answer, null);
    const problem = (
      await call("POST", "/v1/materials", {
        kind: "problem",
        title: "打折问题",
        text: "一件商品原价 60 元，打八折后要付多少钱？",
        answer: "48 元",
      })
    ).json().data;
    assert.equal(problem.current.answer, "48 元");
    const list = (await call("GET", "/v1/materials")).json().data;
    assert.deepEqual(
      list.map((m: { id: string }) => m.id),
      [problem.id, detail.id],
    );
    assert.equal(list[1].snippet.startsWith("水的三态变化 水在"), true);
    // A formula with ">" keeps it in the title and the list preview.
    const ineq = (
      await call("POST", "/v1/materials", {
        kind: "problem",
        text: "已知 $x>0$，证明 $e^x>1+x$。",
      })
    ).json().data;
    assert.equal(ineq.title, "已知 x>0，证明 eˣ>1+x。");
    const listed = (await call("GET", "/v1/materials?kind=problem"))
      .json()
      .data.find((m: { id: string }) => m.id === ineq.id);
    assert.equal(listed.snippet, "已知 x>0，证明 eˣ>1+x。");
    await call("DELETE", `/v1/materials/${ineq.id}`);
    assert.deepEqual(
      (await call("GET", "/v1/materials?kind=problem"))
        .json()
        .data.map((m: { id: string }) => m.id),
      [problem.id],
    );
    assert.deepEqual(
      (await call("GET", `/v1/materials?q=${encodeURIComponent("沸腾")}`))
        .json()
        .data.map((m: { id: string }) => m.id),
      [detail.id],
    );
    assert.deepEqual(
      (await call("GET", `/v1/materials?q=${encodeURIComponent("%")}`)).json()
        .data,
      [],
    );
  } finally {
    await app.close();
  }
  app = makeApp({ path });
  try {
    const call = await login(app);
    assert.equal((await call("GET", "/v1/materials")).json().data.length, 2);
  } finally {
    await app.close();
  }
});

test("text limits count non-whitespace characters and reject instead of truncating", async () => {
  const app = makeApp();
  try {
    const call = await login(app);
    const tooLong = await call("POST", "/v1/materials", {
      kind: "note",
      text: "字".repeat(2001),
    });
    assert.equal(tooLong.statusCode, 400);
    assert.equal(tooLong.json().code, "TEXT_TOO_LONG");
    assert.match(tooLong.json().message, /2001/);
    const empty = await call("POST", "/v1/materials", {
      kind: "note",
      text: " \n\t ",
    });
    assert.equal(empty.json().code, "TEXT_EMPTY");
    const spaced = await call("POST", "/v1/materials", {
      kind: "note",
      text: "字 ".repeat(2000),
    });
    assert.equal(spaced.statusCode, 200);
    assert.equal(spaced.json().data.current.chars, 2000);
  } finally {
    await app.close();
  }
});

test("edits create versions, stale edits conflict, and confirmation is explicit", async () => {
  const app = makeApp();
  try {
    const call = await login(app);
    const created = (
      await call("POST", "/v1/materials", {
        kind: "problem",
        text: "60 元打八折是多少？",
      })
    ).json().data;
    const renamed = (
      await call("PUT", `/v1/materials/${created.id}`, {
        expectedVersion: 1,
        title: "折扣",
      })
    ).json().data;
    assert.equal(renamed.title, "折扣");
    assert.equal(renamed.version, 1);
    const edited = (
      await call("PUT", `/v1/materials/${created.id}`, {
        expectedVersion: 1,
        text: "一件商品原价 60 元，打八折后要付多少钱？",
        answer: "48 元",
      })
    ).json().data;
    assert.equal(edited.version, 2);
    assert.equal(edited.current.origin, "edit");
    assert.equal(edited.current.answer, "48 元");
    const stale = await call("PUT", `/v1/materials/${created.id}`, {
      expectedVersion: 1,
      text: "旧页面上的修改",
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().code, "VERSION_CONFLICT");
    const confirmed = (
      await call("PUT", `/v1/materials/${created.id}`, {
        expectedVersion: 2,
        confirm: true,
      })
    ).json().data;
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.version, 2);
    const versions = (
      await call("GET", `/v1/materials/${created.id}/versions`)
    ).json().data;
    assert.deepEqual(
      versions.map((v: { version: number; origin: string }) => [
        v.version,
        v.origin,
      ]),
      [
        [2, "edit"],
        [1, "typed"],
      ],
    );
    const first = (
      await call("GET", `/v1/materials/${created.id}/versions/1`)
    ).json().data;
    assert.equal(first.text, "60 元打八折是多少？");
    assert.equal(first.answer, null);
  } finally {
    await app.close();
  }
});

test("materials are invisible to other users and deletion removes versions, jobs and the image", async () => {
  const uploads = dir();
  const app = makeApp({
    uploads,
    fetcher: (async () =>
      new Response(
        JSON.stringify({ Response: { RequestId: "r", TextDetections: [] } }),
      )) as typeof fetch,
  });
  try {
    const owner = await login(app);
    const other = await login(app, "other");
    const text = (
      await owner("POST", "/v1/materials", { kind: "note", text: "私人笔记" })
    ).json().data;
    for (const [method, url, payload] of [
      ["GET", `/v1/materials/${text.id}`],
      ["GET", `/v1/materials/${text.id}/versions`],
      ["PUT", `/v1/materials/${text.id}`, { expectedVersion: 1, text: "改掉" }],
      ["DELETE", `/v1/materials/${text.id}`],
    ] as const) {
      const response = await other(method, url, payload);
      assert.equal(response.statusCode, 404, `${method} ${url}`);
    }
    assert.deepEqual((await other("GET", "/v1/materials")).json().data, []);
    const upload = multipart(jpeg());
    const image = (
      await owner(
        "POST",
        "/v1/materials/image?kind=note",
        upload.payload,
        upload.headers,
      )
    ).json().data;
    await settle(owner, image.job.id);
    assert.equal(
      (await other("GET", `/v1/materials/${image.material.id}/image`))
        .statusCode,
      404,
    );
    const userDir = readdirSync(uploads)[0]!;
    assert.equal(readdirSync(join(uploads, userDir)).length, 1);
    assert.equal(
      (await owner("DELETE", `/v1/materials/${image.material.id}`)).statusCode,
      200,
    );
    assert.equal(readdirSync(join(uploads, userDir)).length, 0);
    assert.equal(
      (await owner("GET", `/v1/jobs/${image.job.id}`)).statusCode,
      404,
    );
    assert.equal(
      (await owner("DELETE", `/v1/materials/${text.id}`)).statusCode,
      200,
    );
    assert.equal(
      (await owner("GET", `/v1/materials/${text.id}`)).statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});

test("an uploaded photo is recognized into a draft that flags low-confidence lines", async () => {
  let requests = 0;
  const app = makeApp({
    fetcher: (async (url: unknown, init?: RequestInit) => {
      assert.equal(String(url), "https://ocr.tencentcloudapi.com/");
      assert.equal(
        new Headers(init!.headers).get("x-tc-action"),
        "GeneralBasicOCR",
      );
      requests++;
      return new Response(
        JSON.stringify({
          Response: {
            RequestId: "req-1",
            TextDetections: [
              {
                DetectedText: "水的三态",
                Confidence: 99,
                AdvancedInfo: '{"Parag":{"ParagNo":1}}',
              },
              {
                DetectedText: "水在0℃以下会结成冰，",
                Confidence: 97,
                AdvancedInfo: '{"Parag":{"ParagNo":2}}',
              },
              {
                DetectedText: "在1O0℃沸腾。",
                Confidence: 62,
                AdvancedInfo: '{"Parag":{"ParagNo":2}}',
              },
            ],
          },
        }),
      );
    }) as typeof fetch,
  });
  try {
    const call = await login(app);
    const upload = multipart(jpeg(2048));
    const created = await call(
      "POST",
      "/v1/materials/image?kind=note",
      upload.payload,
      upload.headers,
    );
    assert.equal(created.statusCode, 200);
    const { material, job } = created.json().data;
    assert.equal(material.version, 0);
    assert.equal(material.hasImage, true);
    assert.equal((await settle(call, job.id)).status, "succeeded");
    const detail = (await call("GET", `/v1/materials/${material.id}`)).json()
      .data;
    assert.equal(detail.version, 1);
    assert.equal(detail.title, "水的三态");
    assert.equal(detail.current.origin, "ocr");
    assert.deepEqual(detail.current.paragraphs, [
      "水的三态",
      "水在0℃以下会结成冰，在1O0℃沸腾。",
    ]);
    assert.deepEqual(detail.current.doubts, [
      { text: "在1O0℃沸腾。", confidence: 62 },
    ]);
    assert.equal(detail.ocr.status, "succeeded");
    const image = await call("GET", `/v1/materials/${material.id}/image`);
    assert.equal(image.headers["content-type"], "image/jpeg");
    assert.equal(image.rawPayload.length, 2048);
    // Fixing the OCR draft drops the provider doubts: the user's text is authoritative.
    const fixed = (
      await call("PUT", `/v1/materials/${material.id}`, {
        expectedVersion: 1,
        text: "水的三态\n水在0℃以下会结成冰，在100℃沸腾。",
        confirm: true,
      })
    ).json().data;
    assert.equal(fixed.current.doubts, null);
    assert.equal(fixed.status, "confirmed");
    assert.equal(requests, 1);
  } finally {
    await app.close();
  }
});

test("an upload over the daily OCR limit is refused without leaving an empty material", async () => {
  // the budget stops it (OCR itself reports no tokens and is free),
  // here a day budget of ¥0.
  const app = makeApp({
    env: { DAILY_BUDGET_CNY: "0" },
    fetcher: (async () =>
      new Response(
        JSON.stringify({ Response: { RequestId: "r", TextDetections: [{ DetectedText: "水的三态", Confidence: 99, AdvancedInfo: '{"Parag":{"ParagNo":1}}' }] } }),
      )) as unknown as typeof fetch,
  });
  try {
    const call = await login(app);
    const upload = multipart(jpeg());
    const send = () =>
      call(
        "POST",
        "/v1/materials/image?kind=problem",
        upload.payload,
        upload.headers,
      );
    const refused = await send();
    assert.equal(refused.statusCode, 429);
    assert.equal(refused.json().code, "DAILY_LIMIT");
    const list = (await call("GET", "/v1/materials?kind=problem")).json().data;
    assert.equal((Array.isArray(list) ? list : list.items).length, 0);
  } finally {
    await app.close();
  }
});
test("oversized or non-image uploads are refused and missing OCR keys leave a typeable draft", async () => {
  const app = makeApp({ ocr: false });
  try {
    const call = await login(app);
    const big = multipart(jpeg(5 * 1024 * 1024 + 1));
    const tooBig = await call(
      "POST",
      "/v1/materials/image?kind=note",
      big.payload,
      big.headers,
    );
    assert.equal(tooBig.statusCode, 413);
    assert.equal(tooBig.json().code, "IMAGE_TOO_LARGE");
    const text = multipart(Buffer.from("just text, not an image"), "a.txt");
    const notImage = await call(
      "POST",
      "/v1/materials/image?kind=note",
      text.payload,
      text.headers,
    );
    assert.equal(notImage.statusCode, 415);
    const config = (await app.inject({ url: "/v1/config" })).json().data;
    assert.equal(config.ocr, false);
    const upload = multipart(jpeg());
    const { material, job } = (
      await call(
        "POST",
        "/v1/materials/image?kind=problem",
        upload.payload,
        upload.headers,
      )
    ).json().data;
    const failed = await settle(call, job.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "OCR_NOT_CONFIGURED");
    const detail = (await call("GET", `/v1/materials/${material.id}`)).json()
      .data;
    assert.equal(detail.current, null);
    assert.equal(detail.ocr.error.code, "OCR_NOT_CONFIGURED");
    const typed = await call("PUT", `/v1/materials/${material.id}`, {
      expectedVersion: 0,
      text: "看图手动输入的题目",
    });
    assert.equal(typed.json().data.version, 1);
    assert.equal(typed.json().data.title, "看图手动输入的题目");
  } finally {
    await app.close();
  }
});

test("V4.2: 我的资料 pages through every material with limit and offset", async () => {
  const app = makeApp();
  try {
    const call = await login(app, "pager");
    for (let i = 1; i <= 5; i++)
      await call("POST", "/v1/materials", { kind: "note", title: `第 ${i} 份`, text: `资料正文 ${i}` });
    const ids = (url: string) =>
      call("GET", url).then((r) => r.json().data.map((m: { id: string }) => m.id));
    const all = await ids("/v1/materials");
    assert.equal(all.length, 5);
    const paged = [
      ...(await ids("/v1/materials?limit=2&offset=0")),
      ...(await ids("/v1/materials?limit=2&offset=2")),
      ...(await ids("/v1/materials?limit=2&offset=4")),
    ];
    assert.deepEqual(paged, all);
    assert.deepEqual(await ids("/v1/materials?limit=2&offset=6"), []);
    assert.deepEqual(await ids("/v1/materials?kind=note&limit=1&offset=1"), [all[1]]);
    assert.equal((await call("GET", "/v1/materials?offset=-1")).statusCode, 400);
  } finally {
    await app.close();
  }
});

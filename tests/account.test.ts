import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeServices, makeApp, NOTE, type App } from "./fixtures.js";

async function login(app: App, key: string) {
  const { token } = (
    await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key },
    })
  ).json().data;
  return (
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
type Call = Awaited<ReturnType<typeof login>>;
async function settle(call: Call, jobId: string) {
  for (let i = 0; i < 200; i++) {
    const job = (await call("GET", `/v1/jobs/${jobId}`)).json().data;
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job did not finish");
}
function image() {
  const boundary = "----zhiye-account-boundary";
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(60, 1),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
// A learner with one studied note (explained, quizzed, answered, in review) and one image.
async function learner(call: Call) {
  const { id } = (
    await call("POST", "/v1/materials", { kind: "note", text: NOTE })
  ).json().data;
  await call("PUT", `/v1/materials/${id}`, {
    expectedVersion: 1,
    confirm: true,
  });
  await settle(
    call,
    (await call("POST", `/v1/materials/${id}/explain`)).json().data.job.id,
  );
  await settle(
    call,
    (await call("POST", `/v1/materials/${id}/quiz`)).json().data.job.id,
  );
  const quiz = (await call("GET", `/v1/materials/${id}/study`)).json().data
    .quiz;
  await call("POST", `/v1/materials/${id}/attempts`, {
    artifactId: quiz.id,
    item: 0,
    choice: 1,
  });
  await call("POST", `/v1/materials/${id}/review`);
  const upload = image();
  const photo = (
    await call(
      "POST",
      "/v1/materials/image?kind=problem",
      upload.payload,
      upload.headers,
    )
  ).json().data;
  await settle(call, photo.job.id);
  return { id, photo: photo.material.id as string };
}

test("usage returns all seven daily allowance buckets", async () => {
  const app = makeApp(fakeServices(), {
    DAILY_AI_LIMIT: "30",
    DAILY_OCR_LIMIT: "5",
  });
  const call = await login(app, "owner");
  const fresh = (await call("GET", "/v1/me/usage")).json().data;
  // V4.2 G4 adds `budget` beside the seven old buckets.
  assert.deepEqual(Object.keys(fresh).sort(), ["ai", "brainstorm", "budget", "chat", "date", "import", "notes", "ocr", "photos"]);
  assert.deepEqual({ ai: fresh.ai, ocr: fresh.ocr }, { ai: { used: 0, limit: 30 }, ocr: { used: 0, limit: 5 } });
  assert.deepEqual(
    { notes: fresh.notes, chat: fresh.chat, photos: fresh.photos, brainstorm: fresh.brainstorm, import: fresh.import },
    { notes: { used: 0, limit: 30 }, chat: { used: 0, limit: 60 }, photos: { used: 0, limit: 20 }, brainstorm: { used: 0, limit: 10 }, import: { used: 0, limit: 10 } },
  );
  assert.match(fresh.date, /^\d{4}-\d{2}-\d{2}$/);
  await learner(call);
  const used = (await call("GET", "/v1/me/usage")).json().data;
  assert.deepEqual(used.ai, { used: 2, limit: 30 });
  // the test OCR provider is not configured, so the photo job fails and is not charged.
  assert.deepEqual(used.ocr, { used: 0, limit: 5 });
  await app.close();
});

test("export holds the learner's own texts, results, attempts and review log", async () => {
  const app = makeApp(fakeServices());
  const call = await login(app, "owner");
  const { id, photo } = await learner(call);
  const other = await login(app, "stranger");
  await other("POST", "/v1/materials", { kind: "note", text: "别人的笔记" });

  const res = await call("GET", "/v1/me/export");
  assert.equal(res.statusCode, 200);
  const data = res.json();
  const exportDay = data.exportedAt.slice(0, 10);
  assert.equal(
    String(res.headers["content-disposition"]),
    `attachment; filename="export-${exportDay}.json"; filename*=UTF-8''${encodeURIComponent(`晓念数据导出-${exportDay}.json`)}`,
  );
  assert.equal(data.format, "zhiye-export/1");
  assert.equal(data.user.nickname, "开发者");
  assert.deepEqual(
    data.materials.map((m: { id: string }) => m.id),
    [id, photo],
  );
  const note = data.materials[0];
  assert.equal(note.versions[0].text, NOTE);
  assert.deepEqual(
    note.generated.map((g: { kind: string }) => g.kind),
    ["explain", "quiz"],
  );
  assert.equal(note.generated[1].data.questions[0].answer, 1);
  assert.equal(note.attempts[0].result.verdict, "correct");
  assert.equal(note.review.box, 1);
  assert.deepEqual(note.review.log, []);
  assert.equal(data.materials[1].hasImage, true);
  assert.doesNotMatch(res.body, /别人的笔记/);
  await app.close();
});

test("erasing the account removes rows, sessions and images, and nobody else's", async () => {
  const uploads = mkdtempSync(join(tmpdir(), "zhiye-"));
  const app = makeApp(fakeServices(), { UPLOAD_DIR: uploads });
  const call = await login(app, "owner");
  await learner(call);
  const other = await login(app, "stranger");
  const kept = (
    await other("POST", "/v1/materials", { kind: "note", text: "别人的笔记" })
  ).json().data.id;
  const upload = image();
  await other(
    "POST",
    "/v1/materials/image?kind=note",
    upload.payload,
    upload.headers,
  );
  assert.equal(readdirSync(uploads).length, 2);

  assert.equal((await call("DELETE", "/v1/me")).statusCode, 400);
  assert.equal(
    (await call("DELETE", "/v1/me", { confirm: false })).statusCode,
    400,
  );
  const erased = await call("DELETE", "/v1/me", { confirm: true });
  assert.deepEqual(erased.json().data, { deleted: true });
  assert.equal((await call("GET", "/v1/materials")).statusCode, 401);
  assert.equal(readdirSync(uploads).length, 1);

  const other2 = (await other("GET", `/v1/materials/${kept}`)).json().data;
  assert.equal(other2.id, kept);
  // Logging in again with the same key starts an empty account.
  const again = await login(app, "owner");
  assert.deepEqual((await again("GET", "/v1/materials")).json().data, []);
  assert.deepEqual((await again("GET", "/v1/reviews")).json().data.counts, {
    due: 0,
    total: 0,
  });
  assert.ok(existsSync(uploads));
  await app.close();
});

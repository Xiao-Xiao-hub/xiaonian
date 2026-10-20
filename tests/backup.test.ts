import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { fakeServices, makeApp, NOTE, PROBLEM, type App } from "./fixtures.js";

const python =
  process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");

// This drill uses only self-written fixtures and fake model replies. It tests
// persistence, not OCR quality. Retain all temporary data for inspection.
test("stopped backup restores original images and both learning flows into new paths", async () => {
  const parent = process.env.BACKUP_DRILL_DIR || tmpdir();
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(parent, "zhiye-backup-"));
  const original = join(work, "original");
  const saved = join(work, "snapshot");
  const restored = join(work, "restored");
  const script = fileURLToPath(
    new URL("../scripts/backup.py", import.meta.url),
  );
  const now = () => new Date("2026-10-01T01:00:00Z");
  const services = fakeServices();
  const open = (dir: string) =>
    makeApp(
      services,
      {
        DATABASE_PATH: join(dir, "app.sqlite"),
        UPLOAD_DIR: join(dir, "uploads"),
      },
      now,
    );
  let app: App | undefined = open(original);
  let token = "";
  const checks: string[] = [];
  const hash = (bytes: Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
  const started = Date.now();
  const request = async (
    method: string,
    url: string,
    payload?: unknown,
    headers = {},
  ) => {
    const response = await app!.inject({
      method: method as "GET",
      url,
      payload: payload as string,
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
    assert.equal(
      response.statusCode,
      200,
      `${method} ${url}: ${response.statusCode}`,
    );
    return response;
  };
  const call = async (method: string, url: string, payload?: unknown) =>
    (await request(method, url, payload)).json().data;
  const settle = async (id: string, expected = "succeeded") => {
    for (let i = 0; i < 400; i++) {
      const job = await call("GET", `/v1/jobs/${id}`);
      if (!["queued", "running"].includes(job.status)) {
        assert.equal(job.status, expected, job.error?.code);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Fixture job did not finish");
  };
  const run = async (url: string, payload = {}) => {
    const data = await call("POST", url, payload);
    if (data.job) await settle(data.job.id);
    return data;
  };
  const exportData = async () => {
    const { exportedAt: _at, ...data } = (
      await request("GET", "/v1/me/export")
    ).json();
    return data;
  };
  try {
    token = (await call("POST", "/v1/auth/dev-login", { key: "backup-drill" }))
      .token;
    const note = await call("POST", "/v1/materials", {
      kind: "note",
      text: NOTE,
    });
    await call("PUT", `/v1/materials/${note.id}`, {
      expectedVersion: 1,
      confirm: true,
    });
    await run(`/v1/materials/${note.id}/explain`);
    await run(`/v1/materials/${note.id}/quiz`);
    const quiz = (await call("GET", `/v1/materials/${note.id}/study`)).quiz;
    await run(`/v1/materials/${note.id}/attempts`, {
      artifactId: quiz.id,
      item: 0,
      choice: 1,
    });
    await call("PUT", `/v1/materials/${note.id}`, {
      expectedVersion: 1,
      text: `${NOTE}\n这是一条自编的备份校对补充。`,
      confirm: true,
    });
    await call("POST", `/v1/materials/${note.id}/review`);
    checks.push(
      "note versions, stale generated results and choice attempt created",
    );

    // A valid one-pixel PNG: only byte-for-byte image persistence is under test.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/a8AAAAASUVORK5CYII=",
      "base64",
    );
    const boundary = "zhiye-backup-boundary";
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const photo = (
      await request("POST", "/v1/materials/image?kind=problem", multipart, {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      })
    ).json().data;
    // No OCR credentials: exercise the documented manual-input fallback.
    await settle(photo.job.id, "failed");
    const problem = photo.material;
    await call("PUT", `/v1/materials/${problem.id}`, {
      expectedVersion: 0,
      text: PROBLEM,
      confirm: true,
    });
    await run(`/v1/materials/${problem.id}/hints`);
    const hints = (await call("GET", `/v1/materials/${problem.id}/study`))
      .hints;
    await call("POST", `/v1/artifacts/${hints.id}/reveal`, { level: 2 });
    await run(`/v1/materials/${problem.id}/attempts`, { answer: "48" });
    await call("POST", `/v1/artifacts/${hints.id}/report`, {
      reason: "unclear",
      note: "合成演练反馈",
    });
    await call("POST", `/v1/materials/${problem.id}/review`);
    const reviews = await call("GET", "/v1/reviews");
    await call("POST", `/v1/reviews/${reviews.upcoming[0].id}`, {
      outcome: "remembered",
    });
    checks.push(
      "image problem, revealed hints, rule attempt, report and review log created",
    );

    const endpoints = [
      "/v1/auth/me",
      "/v1/materials",
      "/v1/reviews",
      "/v1/me/usage",
      `/v1/materials/${note.id}/study`,
      `/v1/materials/${problem.id}/study`,
      `/v1/materials/${note.id}/versions`,
      `/v1/materials/${note.id}/versions/1`,
      `/v1/materials/${note.id}/versions/2`,
    ];
    const before = await Promise.all(endpoints.map((url) => call("GET", url)));
    const exported = await exportData();
    const originalImage = (
      await request("GET", `/v1/materials/${problem.id}/image`)
    ).rawPayload;
    assert.equal(hash(originalImage), hash(png));
    await app.close();
    app = undefined;
    checks.push("all jobs settled and original application fully closed");
    const originalHash = hash(readFileSync(join(original, "app.sqlite")));
    const backup = JSON.parse(
      execFileSync(
        python,
        [
          script,
          "backup-bundle",
          "--source",
          join(original, "app.sqlite"),
          "--uploads",
          join(original, "uploads"),
          "--target",
          saved,
          "--stopped",
        ],
        { encoding: "utf8" },
      ),
    );
    execFileSync(
      python,
      [script, "restore-bundle", "--source", saved, "--target", restored],
      { encoding: "utf8" },
    );
    checks.push(
      "database and referenced images backed up and restored to new paths",
    );
    app = open(restored);
    for (const [i, url] of endpoints.entries())
      assert.deepEqual(await call("GET", url), before[i], url);
    checks.push(
      "original session reads identical materials, versions, study state, reviews and usage",
    );
    assert.deepEqual(await exportData(), exported);
    checks.push("full personal export including review log preserved");
    const restoredImage = (
      await request("GET", `/v1/materials/${problem.id}/image`)
    ).rawPayload;
    assert.equal(hash(restoredImage), hash(png));
    checks.push("image downloaded through restored API has identical SHA-256");
    await call("POST", "/v1/materials", {
      kind: "note",
      text: "只写入恢复库的自编记录",
    });
    assert.equal((await call("GET", "/v1/materials")).length, 3);
    await app.close();
    app = undefined;
    assert.equal(
      hash(readFileSync(join(original, "app.sqlite"))),
      originalHash,
    );
    const db = new DatabaseSync(join(restored, "app.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        Object.values(db.prepare("PRAGMA integrity_check").get()!)[0],
        "ok",
      );
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
    checks.push(
      "restored application accepts writes without changing original database",
    );
    const report = {
      at: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      work,
      boundary:
        "Local synthetic fixtures and fake AI; not real OCR, production data or device validation",
      checks,
      image: { bytes: png.length, sha256: hash(png) },
      backup,
    };
    if (process.env.BACKUP_DRILL_REPORT)
      writeFileSync(
        process.env.BACKUP_DRILL_REPORT,
        `${JSON.stringify(report, null, 2)}\n`,
        { flag: "wx" },
      );
  } finally {
    await app?.close();
  }
});

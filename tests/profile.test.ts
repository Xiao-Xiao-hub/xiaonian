import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRIVACY_VERSION,
  PREVIOUS_PRIVACY_VERSION,
} from "../server/src/shared/domain.js";
import { SqliteStore } from "../server/src/shared/store.js";
import {
  ProfileService,
  AVATAR_LIMIT,
} from "../server/src/modules/account/profile.js";
import { fakeServices, makeApp, type App } from "./fixtures.js";

// A complete synthetic 1×1 PNG; no user photo or external service is involved.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
// Pillow-generated single color fixture, kept inline so tests need no decoder dependency.
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDlqKKK8c9Q/9k=",
  "base64",
);
function multipart(
  data = PNG,
  nickname?: string,
  mime = "image/png",
  extra = "",
) {
  const boundary = "profile-test-boundary";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../../outside.png"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      data,
      Buffer.from(
        `\r\n${nickname === undefined ? "" : `--${boundary}\r\nContent-Disposition: form-data; name="nickname"\r\n\r\n${nickname}\r\n`}${extra}--${boundary}--\r\n`,
      ),
    ]),
  };
}
async function login(app: App, key = "profile-owner", mode = "dev") {
  const response = await app.inject({
    method: "POST",
    url: `/v1/auth/${mode === "wechat" ? "wechat" : "dev"}-login`,
    payload: mode === "wechat" ? { code: "synthetic-login-code" } : { key },
  });
  assert.equal(response.statusCode, 200);
  const data = response.json().data;
  const call = (method: string, url: string, payload?: unknown, headers = {}) =>
    app.inject({
      method: method as "GET",
      url,
      payload: payload as string,
      headers: { authorization: `Bearer ${data.token}`, ...headers },
    });
  return { user: data.user, call };
}
async function agree(
  call: Awaited<ReturnType<typeof login>>["call"],
  version = PRIVACY_VERSION,
) {
  const response = await call("PUT", "/v1/me/consent", {
    version,
    ageBand: "adult",
  });
  assert.equal(response.statusCode, 200);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "profile-test-"));
  const store = new SqliteStore(":memory:");
  const services = fakeServices();
  const app = makeApp(services, { UPLOAD_DIR: root }, undefined, store);
  return {
    app,
    store,
    root,
    services,
    profiles: new ProfileService(store, root),
  };
}

test("profile writes require current consent; old consent and withdrawal retain basic account access", async (t) => {
  const f = fixture();
  t.after(() => f.app.close());
  const { call } = await login(f.app);
  for (const version of [null, PREVIOUS_PRIVACY_VERSION]) {
    if (version) await agree(call, version);
    const denied = await call("PATCH", "/v1/me/profile", {
      nickname: "新昵称",
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().code, "PROFILE_CONSENT_REQUIRED");
    assert.equal((await call("GET", "/v1/me/usage")).statusCode, 200);
  }
  await agree(call);
  assert.equal(
    (await call("PATCH", "/v1/me/profile", { nickname: " 已保存 " })).json()
      .data.nickname,
    "已保存",
  );
  await call("DELETE", "/v1/me/consent");
  assert.equal(
    (await call("PATCH", "/v1/me/profile", { nickname: "拒绝保存" }))
      .statusCode,
    403,
  );
  assert.equal(
    (await call("DELETE", "/v1/me/profile", { nickname: true })).json().data
      .nickname,
    "开发者",
  );
});

test("a child needs the current basic guardian agreement before optional profile writes", async (t) => {
  const f = fixture();
  t.after(() => f.app.close());
  const { call, user } = await login(f.app);
  const stored = f.store.getUser(user.id)!;
  stored.ageBand = "child";
  stored.consents = [
    { kind: "docs", version: PRIVACY_VERSION, at: f.store.now() },
  ];
  f.store.db
    .prepare("UPDATE users SET data=? WHERE id=?")
    .run(JSON.stringify(stored), user.id);
  const denied = await call("PATCH", "/v1/me/profile", { nickname: "小朋友" });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, "GUARDIAN_REQUIRED");
  assert.equal(
    (
      await call("PUT", "/v1/me/consent", {
        version: PRIVACY_VERSION,
        ageBand: "child",
        guardian: true,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await call("PATCH", "/v1/me/profile", { nickname: "小朋友" })).statusCode,
    200,
  );
});

test("nickname and avatar save together, stay private, and never enter learning or AI jobs", async (t) => {
  const f = fixture();
  t.after(() => f.app.close());
  const a = await login(f.app),
    b = await login(f.app, "profile-other");
  await agree(a.call);
  const upload = multipart(PNG, "本人昵称");
  const response = await a.call(
    "POST",
    "/v1/me/profile",
    upload.payload,
    upload.headers,
  );
  assert.equal(response.statusCode, 200, response.body);
  const user = response.json().data;
  assert.equal(user.nickname, "本人昵称");
  assert.deepEqual(Object.keys(user.avatar), ["version"]);
  assert.doesNotMatch(response.body, /openid|profile\/|\.png|updatedAt/);
  const route = `/v1/me/profile/avatar?v=${user.avatar.version}`;
  const own = await a.call("GET", route);
  assert.equal(own.statusCode, 200);
  assert.deepEqual(own.rawPayload, PNG);
  assert.equal(own.headers["content-type"], "image/png");
  assert.equal(own.headers["cache-control"], "private, no-store");
  assert.equal((await b.call("GET", route)).statusCode, 404);
  assert.equal((await f.app.inject({ url: route })).statusCode, 401);
  assert.equal(
    (await a.call("GET", route + `&userId=${b.user.id}`)).statusCode,
    400,
  );
  assert.equal((await login(f.app)).user.nickname, "本人昵称");
  assert.deepEqual((await login(f.app)).user.avatar, user.avatar);
  for (const table of ["materials", "chat_images", "jobs"])
    assert.equal(
      (
        f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n,
      0,
    );
  assert.equal(f.services.llm.length + f.services.jev.length, 0);
  const audits = JSON.stringify(
    f.store.db
      .prepare("SELECT details FROM audit WHERE action='profile.updated'")
      .all(),
  );
  assert.doesNotMatch(audits, /本人昵称|\.png/);
});

test("WeChat OpenID login preserves customized profile and reset restores the WeChat default", async (t) => {
  const services = fakeServices();
  const original = services.fetcher;
  services.fetcher = (async (url, init) =>
    String(url).startsWith("https://api.weixin.qq.com/")
      ? new Response(JSON.stringify({ openid: "synthetic-openid-profile" }))
      : original(url, init)) as typeof fetch;
  const app = makeApp(services, {
    WECHAT_APP_ID: "test-wechat-app",
    WECHAT_APP_SECRET: "test-wechat-secret",
  });
  t.after(() => app.close());
  const first = await login(app, "", "wechat");
  await agree(first.call);
  await first.call("PATCH", "/v1/me/profile", { nickname: "保留我的名字" });
  const again = await login(app, "", "wechat");
  assert.equal(again.user.id, first.user.id);
  assert.equal(again.user.nickname, "保留我的名字");
  assert.equal(
    (await again.call("DELETE", "/v1/me/profile", { nickname: true })).json()
      .data.nickname,
    "微信用户",
  );
});

test("profile rejects invalid fields, control characters, images, size and MIME before any commit", async (t) => {
  const f = fixture();
  t.after(() => f.app.close());
  const { call, user } = await login(f.app);
  await agree(call);
  for (const nickname of ["", "  ", "a".repeat(25), "名字\n换行", "名字\u0000"])
    assert.equal(
      (await call("PATCH", "/v1/me/profile", { nickname })).statusCode,
      400,
    );
  assert.equal(
    (await call("PATCH", "/v1/me/profile", { nickname: "名字", id: "other" }))
      .statusCode,
    400,
  );
  for (const [data, mime, expected] of [
    [Buffer.from("<svg></svg>"), "image/svg+xml", 400],
    [PNG.subarray(0, 24), "image/png", 400],
    [PNG, "text/html", 400],
    [Buffer.alloc(AVATAR_LIMIT + 1, 1), "image/png", 413],
  ] as const) {
    const body = multipart(data, "不会保存", mime);
    const response = await call(
      "POST",
      "/v1/me/profile",
      body.payload,
      body.headers,
    );
    assert.equal(response.statusCode, expected, response.body);
  }
  const invalidName = multipart(PNG, "x".repeat(25));
  assert.equal(
    (
      await call(
        "POST",
        "/v1/me/profile",
        invalidName.payload,
        invalidName.headers,
      )
    ).statusCode,
    400,
  );
  const duplicate = multipart(
    PNG,
    "重复",
    "image/png",
    '--profile-test-boundary\r\nContent-Disposition: form-data; name="nickname"\r\n\r\n重复\r\n',
  );
  assert.equal(
    (await call("POST", "/v1/me/profile", duplicate.payload, duplicate.headers))
      .statusCode,
    400,
  );
  assert.equal(f.store.getUser(user.id)?.nickname, "开发者");
  assert.equal(f.store.getUser(user.id)?.avatar, undefined);
  assert.equal(existsSync(join(f.root, user.id)), false);
});

test("image containers require pixel data and valid PNG checksums; normal JPEG is supported", async (t) => {
  const f = fixture();
  t.after(() => f.app.close());
  const { call, user } = await login(f.app);
  await agree(call);
  const corruptPng = Buffer.from(PNG);
  corruptPng[45] ^= 1;
  const noPngPixels = Buffer.concat([PNG.subarray(0, 33), PNG.subarray(-12)]);
  const noJpegPixels = Buffer.from("ffd8ffc000080800010001ffd9", "hex");
  for (const image of [
    corruptPng,
    noPngPixels,
    noJpegPixels,
    JPEG.subarray(0, -2),
  ])
    assert.throws(() => f.profiles.update(user.id, { image }), {
      code: "IMAGE_INVALID",
    });
  const saved = f.profiles.update(user.id, { image: JPEG, mime: "image/jpeg" });
  const result = await call(
    "GET",
    `/v1/me/profile/avatar?v=${saved.avatar!.version}`,
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["content-type"], "image/jpeg");
  assert.deepEqual(result.rawPayload, JPEG);
});

test("replacing and clearing avatars invalidates older versions and removes only the owner's files", async (t) => {
  const f = fixture();
  t.after(() => f.app.close());
  const a = await login(f.app),
    b = await login(f.app, "profile-other");
  await agree(a.call);
  await agree(b.call);
  const upload = multipart();
  const first = (
    await a.call("POST", "/v1/me/profile", upload.payload, upload.headers)
  ).json().data;
  const other = (
    await b.call("POST", "/v1/me/profile", upload.payload, upload.headers)
  ).json().data;
  const oldPath = join(f.root, f.store.getUser(a.user.id)!.avatar!.path);
  const second = (
    await a.call("POST", "/v1/me/profile", upload.payload, upload.headers)
  ).json().data;
  assert.notEqual(second.avatar.version, first.avatar.version);
  assert.equal(existsSync(oldPath), false);
  assert.equal(
    (await a.call("GET", `/v1/me/profile/avatar?v=${first.avatar.version}`))
      .statusCode,
    404,
  );
  const newPath = join(f.root, f.store.getUser(a.user.id)!.avatar!.path);
  f.store.db
    .prepare("UPDATE users SET banned_at=? WHERE id=?")
    .run(f.store.now(), a.user.id);
  assert.equal(
    (await a.call("PATCH", "/v1/me/profile", { nickname: "不可写入" }))
      .statusCode,
    403,
  );
  assert.equal(
    (await a.call("GET", `/v1/me/profile/avatar?v=${second.avatar.version}`))
      .statusCode,
    200,
  );
  assert.equal(
    (await a.call("DELETE", "/v1/me/profile", { avatar: true })).json().data
      .avatar,
    null,
  );
  assert.equal(existsSync(newPath), false);
  assert.equal(
    (await b.call("GET", `/v1/me/profile/avatar?v=${other.avatar.version}`))
      .statusCode,
    200,
  );
});

test("account export describes the avatar without exposing its path and erasure removes it", async (t) => {
  const f = fixture();
  t.after(() => f.app.close());
  const { call, user } = await login(f.app);
  await agree(call);
  const upload = multipart(PNG, "导出名字");
  await call("POST", "/v1/me/profile", upload.payload, upload.headers);
  const data = (await call("GET", "/v1/me/export")).json();
  assert.equal(data.user.nickname, "导出名字");
  assert.equal(data.user.avatar.bytes, PNG.length);
  assert.equal(data.user.avatar.type, "png");
  assert.equal("path" in data.user.avatar, false);
  assert.equal("version" in data.user.avatar, false);
  const path = join(f.root, f.store.getUser(user.id)!.avatar!.path);
  assert.equal(existsSync(path), true);
  assert.equal(
    (await call("DELETE", "/v1/me", { confirm: true })).statusCode,
    200,
  );
  assert.equal(existsSync(join(f.root, user.id)), false);
  assert.equal((await call("GET", "/v1/auth/me")).statusCode, 401);
});

test("a failed database commit removes the new avatar and preserves the previous profile", async (t) => {
  const f = fixture();
  t.after(() => f.app.close());
  const { call, user } = await login(f.app);
  await agree(call);
  const old = f.profiles.update(user.id, { image: PNG, nickname: "原昵称" });
  f.store.db.exec(
    "CREATE TRIGGER refuse_profile BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
  );
  assert.throws(() =>
    f.profiles.update(user.id, { image: PNG, nickname: "失败昵称" }),
  );
  assert.equal(f.store.getUser(user.id)?.nickname, "原昵称");
  assert.deepEqual(f.store.getUser(user.id)?.avatar, old.avatar);
  assert.deepEqual(readdirSync(join(f.root, user.id, "profile")), [
    `${old.avatar!.version}.png`,
  ]);
});

test("logout, erasure, ban or consent withdrawal while an upload is read prevents saving", async (t) => {
  for (const change of ["logout", "erase", "ban", "withdraw"] as const) {
    await t.test(change, async (t) => {
      const f = fixture();
      t.after(() => f.app.close());
      let userId = "";
      // Apply the account change at the end of the actual multipart stream,
      // after the route's initial authorization but before its commit.
      f.app.addHook("preHandler", async (req) => {
        if (req.method !== "POST" || req.url !== "/v1/me/profile") return;
        const parts = req.parts.bind(req);
        req.parts = (options) =>
          (async function* () {
            yield* parts(options);
            if (change === "logout" || change === "erase")
              f.store.db
                .prepare("DELETE FROM sessions WHERE user_id=?")
                .run(userId);
            if (change === "erase")
              f.store.db.prepare("DELETE FROM users WHERE id=?").run(userId);
            if (change === "ban")
              f.store.db
                .prepare("UPDATE users SET banned_at=? WHERE id=?")
                .run(f.store.now(), userId);
            if (change === "withdraw") {
              const user = f.store.getUser(userId)!;
              user.consents!.push({
                kind: "withdraw",
                version: PRIVACY_VERSION,
                at: f.store.now(),
              });
              f.store.db
                .prepare("UPDATE users SET data=? WHERE id=?")
                .run(JSON.stringify(user), userId);
            }
          })();
      });
      const { call, user } = await login(f.app);
      userId = user.id;
      await agree(call);
      const upload = multipart(PNG, "不可保存");
      const response = await call(
        "POST",
        "/v1/me/profile",
        upload.payload,
        upload.headers,
      );
      assert.equal(
        response.statusCode,
        change === "logout" || change === "erase" ? 401 : 403,
      );
      assert.equal(f.store.getUser(userId)?.avatar, undefined);
      assert.equal(existsSync(join(f.root, userId)), false);
    });
  }
});

test("orphan sweep preserves referenced and fresh avatars, ignores learning files and recovers erased accounts", async (t) => {
  const f = fixture();
  t.after(() => f.app.close());
  const { call, user } = await login(f.app);
  await agree(call);
  const saved = f.profiles.update(user.id, { image: PNG });
  const dir = join(f.root, user.id, "profile");
  const orphan = join(dir, `${"1".repeat(32)}.png`);
  const fresh = join(dir, `${"2".repeat(32)}.png`);
  const learning = join(f.root, user.id, "material.png");
  for (const path of [orphan, fresh, learning]) writeFileSync(path, PNG);
  const old = new Date(Date.now() - 7200000);
  for (const path of [orphan, learning, join(f.root, saved.avatar!.path)])
    utimesSync(path, old, old);
  assert.equal(f.profiles.sweepOrphans(), 1);
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(learning), true);
  assert.deepEqual(f.profiles.image(user.id, saved.avatar!.version).data, PNG);
  f.store.db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
  f.store.db.prepare("DELETE FROM users WHERE id=?").run(user.id);
  assert.equal(f.profiles.sweepOrphans(), 1);
  assert.equal(existsSync(join(f.root, saved.avatar!.path)), false);
});

test("stopped bundle backup and independent restore preserve the private avatar and nickname", async () => {
  const root = mkdtempSync(join(tmpdir(), "profile-backup-"));
  const original = join(root, "original"),
    snapshot = join(root, "snapshot"),
    restored = join(root, "restored");
  mkdirSync(original);
  const open = (dir: string) =>
    makeApp(fakeServices(), {
      DATABASE_PATH: join(dir, "app.sqlite"),
      UPLOAD_DIR: join(dir, "uploads"),
    });
  let app = open(original);
  try {
    const first = await login(app);
    await agree(first.call);
    const upload = multipart(PNG, "恢复后的名字");
    const saved = (
      await first.call("POST", "/v1/me/profile", upload.payload, upload.headers)
    ).json().data;
    await app.close();
    const script = fileURLToPath(
      new URL("../scripts/backup.py", import.meta.url),
    );
    const python =
      process.env.PYTHON ||
      (process.platform === "win32" ? "python" : "python3");
    execFileSync(python, [
      script,
      "backup-bundle",
      "--source",
      join(original, "app.sqlite"),
      "--uploads",
      join(original, "uploads"),
      "--target",
      snapshot,
      "--stopped",
    ]);
    execFileSync(python, [
      script,
      "restore-bundle",
      "--source",
      snapshot,
      "--target",
      restored,
    ]);
    app = open(restored);
    const second = await login(app);
    assert.equal(second.user.nickname, "恢复后的名字");
    assert.deepEqual(second.user.avatar, saved.avatar);
    const response = await second.call(
      "GET",
      `/v1/me/profile/avatar?v=${saved.avatar.version}`,
    );
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, PNG);
    const path = join(
      restored,
      "uploads",
      second.user.id,
      "profile",
      `${saved.avatar.version}.png`,
    );
    assert.deepEqual(readFileSync(path), PNG);
  } finally {
    await app.close();
  }
});

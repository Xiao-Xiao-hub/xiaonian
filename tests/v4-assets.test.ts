import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ASSET_DIR } from "../server/src/modules/assets/routes.js";
import { fakeServices, makeApp } from "./fixtures.js";

// 验证公开图片的匿名访问、缓存时长与文件类型。
test("public images load without login and are cached for a week", async () => {
  const app = makeApp(fakeServices());
  const webp = await app.inject({ method: "GET", url: "/v1/assets/xiaoli-hi.webp" });
  assert.equal(webp.statusCode, 200);
  assert.equal(webp.headers["content-type"], "image/webp");
  assert.equal(webp.headers["cache-control"], "public, max-age=604800");
  assert.equal(webp.headers["cross-origin-resource-policy"], "cross-origin");
  assert.equal(webp.rawPayload.subarray(8, 12).toString(), "WEBP");
  const icon = await app.inject({ method: "GET", url: "/v1/assets/ic-memo.webp" });
  assert.equal(icon.statusCode, 200);
  await app.close();
});

test("only plain names of webp or png files are served", async () => {
  const app = makeApp(fakeServices());
  for (const url of [
    "/v1/assets/missing.webp",
    "/v1/assets/..%2f..%2fpackage.json",
    "/v1/assets/..%2fsrc%2findex.ts",
    "/v1/assets/%2e%2e%2fDockerfile",
    "/v1/assets/Xiaoli-hi.webp",
    "/v1/assets/xiaoli-hi.WEBP",
    "/v1/assets/xiaoli_hi.webp",
    "/v1/assets/xiaoli-hi.svg",
    "/v1/assets/.webp",
  ]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 404, url);
    assert.equal(res.json().code, "NOT_FOUND", url);
    assert.notEqual(res.headers["content-type"], "image/webp", url);
  }
  await app.close();
});

test("the image folder holds only small webp files with valid names", () => {
  const files = readdirSync(ASSET_DIR);
  assert.ok(files.includes("xiaoli-hi.webp"));
  for (const file of files) {
    assert.match(file, /^[a-z0-9-]+\.(webp|png)$/);
    assert.ok(statSync(join(ASSET_DIR, file)).size < 64 * 1024, file);
  }
});

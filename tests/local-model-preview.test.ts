import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname, join, resolve } from "node:path";
import {
  preparePreviewDirectory,
  previewEnv,
  readModelSettings,
} from "../scripts/dev-model-local.mjs";

function temporary(t: TestContext) {
  const parent = resolve(tmpdir()),
    root = mkdtempSync(join(parent, "zhiye-model-preview-"));
  t.after(() => {
    assert.equal(dirname(resolve(root)), parent);
    assert.ok(basename(root).startsWith("zhiye-model-preview-"));
    rmSync(root, { recursive: true });
  });
  return root;
}

test("local model preview passes provider settings only and fixes all local service paths", () => {
  const data = resolve("synthetic-preview-path");
  const env = previewEnv(
    {
      LLM_API_KEY: "synthetic-key",
      LLM_MODEL: "synthetic-model",
      JEV_API_KEY: "synthetic-jev",
      OCR_VISION_MODEL: "synthetic-vision",
      HOST: "0.0.0.0",
      PORT: "9999",
      DATABASE_PATH: "original.sqlite",
      UPLOAD_DIR: "original-uploads",
      FORMULA_DIR: "original-formulas",
      ADMIN_API_KEY: "synthetic-admin-key-with-32-characters",
      WECHAT_APP_ID: "synthetic-app",
      WECHAT_APP_SECRET: "synthetic-secret",
      DEV_LOGIN_ENABLED: "false",
      NODE_ENV: "production",
      LOG_LEVEL: "trace",
    },
    data,
  );
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.PORT, 8788);
  assert.equal(env.DEV_LOGIN_ENABLED, true);
  assert.equal(env.NODE_ENV, "development");
  assert.equal(env.LOG_LEVEL, "silent");
  assert.equal(env.DATABASE_PATH, join(data, "app.sqlite"));
  assert.equal(env.UPLOAD_DIR, join(data, "uploads"));
  assert.equal(env.FORMULA_DIR, join(data, "formulas"));
  assert.equal(env.ADMIN_API_KEY, undefined);
  assert.equal(env.WECHAT_APP_ID, undefined);
  assert.equal(env.WECHAT_APP_SECRET, undefined);
  assert.equal(env.LLM_MODEL, "synthetic-model");
  assert.equal(env.JEV_API_KEY, "synthetic-jev");
  assert.equal(env.OCR_VISION_MODEL, "synthetic-vision");
  assert.throws(() => previewEnv({}, data), /未配置 LLM_API_KEY/);
  assert.throws(
    () =>
      previewEnv(
        { LLM_API_KEY: "synthetic", LLM_EXTRA_BODY: "not-json" },
        data,
      ),
    /配置格式无效/,
  );
});

test("local model preview reads a synthetic env file without leaking or retaining unrelated settings", (t) => {
  const root = temporary(t),
    envFile = join(root, "synthetic.env");
  writeFileSync(
    envFile,
    "LLM_API_KEY=synthetic-file-key\nLLM_MODEL=synthetic-model\nHOST=0.0.0.0\nPORT=9999\nZHIYE_SYNTHETIC_UNRELATED=not-for-app\n",
  );
  const before = { ...process.env };
  const settings = readModelSettings(envFile);
  assert.deepEqual(settings, {
    LLM_API_KEY: "synthetic-file-key",
    LLM_MODEL: "synthetic-model",
  });
  assert.ok(
    isDeepStrictEqual({ ...process.env }, before),
    "process environment was restored",
  );
  assert.throws(() => readModelSettings(join(root, "missing.env")), /无法读取/);
  assert.ok(
    isDeepStrictEqual({ ...process.env }, before),
    "failed reads also restore the environment",
  );
});

test("local model preview creates an isolated marker and refuses nonempty unmarked or altered directories", (t) => {
  const root = temporary(t),
    preview = join(root, "new-preview");
  assert.equal(preparePreviewDirectory(preview), preview);
  const [marker] = readdirSync(preview);
  assert.equal(marker, ".zhiye-local-model-preview");
  writeFileSync(join(preview, "synthetic.sqlite"), "synthetic data");
  preparePreviewDirectory(preview);
  const original = join(root, "original");
  mkdirSync(original);
  writeFileSync(join(original, "app.sqlite"), "leave unchanged");
  assert.throws(() => preparePreviewDirectory(original), /缺少合成数据标记/);
  assert.deepEqual(readdirSync(original), ["app.sqlite"]);
  assert.equal(
    readFileSync(join(original, "app.sqlite"), "utf8"),
    "leave unchanged",
  );
  writeFileSync(join(preview, marker!), "altered marker");
  assert.throws(() => preparePreviewDirectory(preview), /标记无效/);
});

test("local model preview refuses directory junctions, nested links and shared files", (t) => {
  const root = temporary(t),
    outside = join(root, "outside"),
    via = join(root, "via");
  mkdirSync(outside);
  symlinkSync(outside, via, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => preparePreviewDirectory(join(via, "new")),
    /软链接|目录联接/,
  );
  assert.deepEqual(readdirSync(outside), []);
  const nested = join(root, "nested-preview");
  preparePreviewDirectory(nested);
  symlinkSync(
    outside,
    join(nested, "uploads"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => preparePreviewDirectory(nested), /链接或特殊文件/);
  const hard = join(root, "hard-preview"),
    source = join(outside, "app.sqlite");
  preparePreviewDirectory(hard);
  writeFileSync(source, "leave unchanged");
  linkSync(source, join(hard, "app.sqlite"));
  assert.throws(() => preparePreviewDirectory(hard), /链接或特殊文件/);
  assert.equal(readFileSync(source, "utf8"), "leave unchanged");
});

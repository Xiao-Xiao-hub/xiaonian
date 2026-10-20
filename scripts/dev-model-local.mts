import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv } from "../server/src/config/env.js";
import { buildApp } from "../server/src/index.js";

const serverRoot = fileURLToPath(new URL("../server/", import.meta.url));
const previewRoot = join(serverRoot, "data", "local-model-preview");
const markerName = ".zhiye-local-model-preview";
const markerText =
  "zhiye/local-model-preview/v1\nLocal synthetic preview data only.\n";
export const MODEL_ENV_KEYS = [
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "LLM_EXTRA_BODY",
  "LLM_TIMEOUT_MS",
  "JEV_API_KEY",
  "JEV_TIMEOUT_MS",
  "TENCENT_SECRET_ID",
  "TENCENT_SECRET_KEY",
  "OCR_REGION",
  "OCR_TIMEOUT_MS",
  "OCR_VISION_MODEL",
] as const;

class PreviewError extends Error {}
const selectModelSettings = (input: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    MODEL_ENV_KEYS.flatMap((key) =>
      input[key] === undefined ? [] : [[key, input[key]]],
    ),
  );

// Read the file in this process, return only supported provider settings, and
// restore the environment before creating any application services.
export function readModelSettings(envPath: string): NodeJS.ProcessEnv {
  const previous = { ...process.env };
  try {
    for (const key of MODEL_ENV_KEYS) delete process.env[key];
    process.loadEnvFile(envPath);
    return selectModelSettings(process.env);
  } catch {
    throw new PreviewError(
      "无法读取 server/.env，请先配置模型，再启动本地预览。",
    );
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    for (const [key, value] of Object.entries(previous))
      process.env[key] = value;
  }
}

export function previewEnv(input: NodeJS.ProcessEnv, dataPath: string) {
  if (!input.LLM_API_KEY?.trim())
    throw new PreviewError(
      "server/.env 未配置 LLM_API_KEY，本地真实模型预览未启动。",
    );
  try {
    return loadEnv({
      ...selectModelSettings(input),
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: "8788",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: join(dataPath, "app.sqlite"),
      UPLOAD_DIR: join(dataPath, "uploads"),
      FORMULA_DIR: join(dataPath, "formulas"),
      LOG_LEVEL: "silent",
    });
  } catch {
    // Validation errors can contain values from provider settings.
    throw new PreviewError(
      "模型配置格式无效，请核对 server/.env；未输出配置内容。",
    );
  }
}

export function preparePreviewDirectory(dataPath: string) {
  const target = resolve(dataPath);
  // Check every existing ancestor, including junctions on Windows.
  for (let current = target; ; current = dirname(current)) {
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new PreviewError(
        "预览数据路径必须是普通目录，不能含软链接或目录联接。",
      );
    if (dirname(current) === current) break;
  }
  mkdirSync(target, { recursive: true });
  const marker = join(target, markerName);
  const entries = readdirSync(target);
  if (!entries.includes(markerName)) {
    if (entries.length)
      throw new PreviewError(
        "预览目录非空且缺少合成数据标记，已拒绝使用；未改动现有文件。",
      );
    writeFileSync(marker, markerText, { flag: "wx" });
  }
  // Refuse links anywhere below the directory before SQLite or uploads open.
  const checkTree = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry),
        stat = lstatSync(path);
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1)
      )
        throw new PreviewError("预览数据中存在链接或特殊文件，已拒绝启动。");
      if (stat.isDirectory()) checkTree(path);
    }
  };
  checkTree(target);
  const markerStat = lstatSync(marker);
  if (
    !markerStat.isFile() ||
    markerStat.size !== Buffer.byteLength(markerText) ||
    readFileSync(marker, "utf8") !== markerText
  )
    throw new PreviewError("预览目录的合成数据标记无效，已拒绝启动。");
  return target;
}

async function main() {
  if (process.argv.length > 2)
    throw new PreviewError(
      "本入口固定使用本机 8788 和专用预览目录，不接受额外参数。",
    );
  const env = previewEnv(
    readModelSettings(join(serverRoot, ".env")),
    previewRoot,
  );
  preparePreviewDirectory(previewRoot);
  const app = buildApp({ env });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("正在停止本地预览并关闭数据库……");
    try {
      await app.close();
    } catch {
      console.error("本地预览关闭失败，请确认进程已经停止后再重启。");
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await app.listen({ host: "127.0.0.1", port: 8788 });
    console.log(
      "晓念本地真实模型预览：http://127.0.0.1:8788（开发登录，Ctrl+C 停止）",
    );
    console.log("仅用于本机合成试用；主动使用 AI 或识图会调用已配置服务。");
  } catch {
    await shutdown();
    throw new PreviewError(
      "本地预览未能启动，请确认 8788 未被其他服务占用。未自动停止其他进程。",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof PreviewError
        ? error.message
        : "本地预览启动失败；未输出配置或凭据。",
    );
    process.exitCode = 1;
  });
}

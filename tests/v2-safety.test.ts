import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BANNED_PHRASES } from "../server/src/modules/safety/banned-phrases.js";
import { CrisisSafetyService, type NoulJudge } from "../server/src/modules/safety/service.js";

function judge(score: number, calls: { value: number }): NoulJudge {
  return {
    async noul() {
      calls.value += 1;
      return score;
    },
  };
}

test("crisis keywords apply to every scene and do not match a standalone ordinary death character", async () => {
  const calls = { value: 0 };
  const safety = new CrisisSafetyService(judge(0, calls));

  assert.equal(await safety.check("我不想活了", { scene: "study", source: "chat" }), true);
  assert.equal(await safety.check("这道题想死", { scene: "study", source: "chat" }), true);
  assert.equal(await safety.check("死亡率怎么算", { scene: "mood", source: "chat" }), false);
  assert.equal(calls.value, 1);
});

test("Jev screening is limited to the designated contexts and uses the inclusive threshold", async () => {
  const studyCalls = { value: 0 };
  const study = new CrisisSafetyService(judge(1, studyCalls));
  assert.equal(await study.check("我学不懂", { scene: "study", source: "chat" }), false);
  assert.equal(await study.check("旧学习笔记", { scene: "study", source: "backfill" }), false);
  assert.equal(studyCalls.value, 0);

  for (const context of [
    { scene: "life", source: "chat" },
    { scene: "mood", source: "chat" },
    { scene: "study", source: "note" },
    { scene: "study", source: "import" },
    { scene: "life", source: "backfill" },
  ] as const) {
    const calls = { value: 0 };
    assert.equal(await new CrisisSafetyService(judge(0.3, calls)).check("需要判断", context), true);
    assert.equal(calls.value, 1);
  }

  const belowThresholdCalls = { value: 0 };
  assert.equal(
    await new CrisisSafetyService(judge(0.299, belowThresholdCalls)).check("需要判断", {
      scene: "life",
      source: "chat",
    }),
    false,
  );
});

test("Jev errors and an abort-ignoring judge fall back to keyword-only screening", async () => {
  const errorSafety = new CrisisSafetyService({
    async noul() {
      throw new Error("offline");
    },
  });
  assert.equal(await errorSafety.check("普通文字", { scene: "mood", source: "chat" }), false);

  const neverSettles: NoulJudge = { noul: () => new Promise<number>(() => {}) };
  const timeoutSafety = new CrisisSafetyService(neverSettles, 10);
  assert.equal(await timeoutSafety.check("普通文字", { scene: "life", source: "chat" }), false);
  const calls = { value: 0 };
  const stopped = new CrisisSafetyService(judge(1, calls));
  assert.equal(await stopped.check("普通文字", { scene: "life", source: "chat" }, AbortSignal.abort()), false);
  assert.equal(calls.value, 0);
});

const projectRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const allowedMoodConsent = join(projectRoot, "miniprogram", "pages", "mood-consent", "index.wxml");
const scannedExtensions = new Set([".ts", ".js", ".wxml", ".json"]);

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return scannedExtensions.has(extname(entry.name)) ? [path] : [];
  });
}

test("product prompts and fixed copy do not contain banned phrases", () => {
  const safetyDefinition = join(projectRoot, "server", "src", "modules", "safety", "banned-phrases.ts");
  const files = [
    ...sourceFiles(join(projectRoot, "miniprogram")),
    ...sourceFiles(join(projectRoot, "server", "src")),
  ].filter((path) => path !== safetyDefinition);

  const violations: string[] = [];
  for (const path of files) {
    let text = readFileSync(path, "utf8");
    if (path === allowedMoodConsent) text = text.replaceAll("不是心理咨询", "");
    for (const phrase of BANNED_PHRASES) {
      if (text.includes(phrase)) violations.push(`${path}: ${phrase}`);
    }
  }
  assert.deepEqual(violations, []);
});

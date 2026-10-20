import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LEGAL_DIR, LEGAL_DOCS, split } from "../server/src/modules/legal/service.js";
import { PRIVACY_VERSION } from "../server/src/shared/domain.js";
import { fakeServices, makeApp } from "./fixtures.js";

type LegalMode = "operator" | "template";
const templateLabel = "开发运行示例";
const exampleContact = "contact@example.com";
const documents = LEGAL_DOCS.map((doc) => readFileSync(`${LEGAL_DIR}${doc}.md`, "utf8"));

function legalMode(contents: string[]): LegalMode {
  const marked = contents.map((text) => text.split("\n").slice(0, 8).join("\n").includes(templateLabel));
  assert.equal(marked.some(Boolean), marked.every(Boolean),
    "Every legal document must use the same operator or example-template mode.");
  return marked.every(Boolean) ? "template" : "operator";
}

function contacts(text: string): string[] {
  return [...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi))];
}

function assertTemplate(text: string): void {
  assert.ok(text.split("\n").slice(0, 8).join("\n").includes(templateLabel),
    "The example notice must appear before the legal summary.");
  assert.match(text, /不可直接上线/);
  assert.ok(text.includes("【运营主体待配置】"));
  assert.ok(text.includes("【服务商及处理地域待配置】"));
  assert.deepEqual(contacts(text), [exampleContact]);
}

const mode = legalMode(documents);

test("server/legal is self-contained and matches the current privacy version", () => {
  for (const doc of LEGAL_DOCS) {
    const served = readFileSync(`${LEGAL_DIR}${doc}.md`, "utf8");
    assert.ok(served.includes(`版本：${PRIVACY_VERSION}`), doc);
    assert.match(served, /版本：2026-10-20\.2　更新日期：2026-10-20　生效日期：2026-10-20/);
  }
});

test("mixed operator and example documents are rejected", () => {
  assert.equal(legalMode(["operator", "operator", "operator"]), "operator");
  assert.equal(legalMode(Array(3).fill(`title\n\n${templateLabel}`)), "template");
  assert.throws(() => legalMode(["operator", templateLabel, templateLabel]), /same operator/);
  assert.throws(() => legalMode([templateLabel, "operator", "operator"]), /same operator/);
});

test("example mode requires a visible notice, configuration fields and example contact", () => {
  const sample = `# Example\n\n${templateLabel}\n不可直接上线\n【运营主体待配置】\n【服务商及处理地域待配置】\n${exampleContact}`;
  assertTemplate(sample);
  for (const required of [templateLabel, "不可直接上线", "【运营主体待配置】", "【服务商及处理地域待配置】", exampleContact]) {
    assert.throws(() => assertTemplate(sample.replace(required, "")), required);
  }
  assert.throws(() => assertTemplate(`${"\n".repeat(8)}${sample}`));
});

test("each document splits into title, summary and chapters", () => {
  for (const doc of LEGAL_DOCS) {
    const parts = split(readFileSync(`${LEGAL_DIR}${doc}.md`, "utf8"));
    assert.ok(parts.title, doc);
    assert.match(parts.version, /^版本：/);
    assert.ok(parts.summaryHead.startsWith("摘要"), doc);
    assert.ok(parts.summary.trim().length > 20, doc);
    assert.ok(parts.sections.length >= 5, doc);
  }
});

test("GET /v1/legal/:doc is public, rendered and cached", async (t) => {
  const app = makeApp(fakeServices());
  t.after(() => app.close());
  for (const doc of LEGAL_DOCS) {
    const response = await app.inject({ method: "GET", url: `/v1/legal/${doc}` });
    assert.equal(response.statusCode, 200, doc);
    assert.match(String(response.headers["cache-control"]), /public/);
    const data = response.json().data;
    assert.equal(data.doc, doc);
    assert.ok(data.title);
    assert.equal(data.version.includes(PRIVACY_VERSION), true);
    assert.ok(data.summary.blocks.length > 0);
    assert.ok(data.sections.length >= 5);
    assert.ok(data.sections.every((s: { title: string; blocks: unknown[] }) => s.title && s.blocks.length));
  }
  const missing = await app.inject({ method: "GET", url: "/v1/legal/terms" });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, "NOT_FOUND");
});

// Public release copy must describe the inspected configuration, without
// turning an implementation limit into a compliance or deletion guarantee.
test("legal release validates the operator or clearly identifies deployment templates", () => {
  for (const doc of LEGAL_DOCS) {
    const text = readFileSync(`${LEGAL_DIR}${doc}.md`, "utf8");
    if (mode === "template") {
      assertTemplate(text);
    } else {
      assert.match(text, /个人开发者（个人主体）/, doc);
      assert.doesNotMatch(text, /【[^】]*】/, doc);
      assert.equal(contacts(text).length, 1, doc);
      assert.doesNotMatch(contacts(text)[0], /@example\.(com|org|net)$/i, doc);
    }
    assert.doesNotMatch(text, /注册地址|联系地址|联系电话|claude-opus|gpt-6|GLM|Jev|Opus|Astra/i, doc);
  }
});

test("retention copy distinguishes rotation counts and cleanup thresholds from deadlines", () => {
  const text = readFileSync(`${LEGAL_DIR}privacy-policy.md`, "utf8");
  assert.match(text, /有效期为 30 天/);
  assert.match(text, /最新 14 份成功快照/);
  assert.match(text, /失败目录[^。\n]*人工处理/);
  assert.match(text, /服务启动时[^。\n]*超过 1 小时/);
  assert.match(text, /审计记录[^\n]*当前没有自动清理期限/);
  assert.match(text, /按天轮换[^\n]*14 份轮换日志/);
  assert.doesNotMatch(text, /保存不少于六个月|备份保存 14 天|我们采取加密等措施存储/);
});

test("AI processing disclosure states operator facts or requires deployment-specific configuration", () => {
  const text = readFileSync(`${LEGAL_DIR}privacy-policy.md`, "utf8");
  if (mode === "template") {
    assertTemplate(text);
    assert.match(text, /服务商及处理地域待配置/);
  } else {
    for (const brand of ["Anthropic", "OpenAI", "智谱", "TypeSafe", "阿里云", "腾讯云"])
      assert.ok(text.includes(brand), brand);
    assert.match(text, /当前[^。\n]*包含境外/);
  }
  assert.match(text, /保存期限、是否将收到的内容用于训练[^。\n]*核实/);
  assert.doesNotMatch(text, /已完成个人信息保护影响评估|已签订委托处理协议/);
  for (const doc of ["privacy-policy", "children-privacy"]) {
    const copy = readFileSync(`${LEGAL_DIR}${doc}.md`, "utf8");
    assert.doesNotMatch(copy, /所有信息都存储在中国境内|我们不会向境外提供|全部在中国境内处理|我们每年[^。\n]*合规审计/);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { CommercialMeter } from "../server/src/shared/commercial-meter.js";
import { runWithCallContext } from "../server/src/shared/call-context.js";

const llm = { kind: "llm" as const, provider: "api.test", model: "chat", source: "chat" };
function setup() {
  const store = new SqliteStore(":memory:");
  store.saveSetting("ai.prices", [{ host: "api.test", model: "chat", input: 1, output: 2, cached: 0.5, note: "" }]);
  const user = store.upsertUser("dev:meter", "用户", "dev");
  const meter = new CommercialMeter(store);
  const rows = () => store.db.prepare("SELECT * FROM commercial_usage ORDER BY rowid").all();
  return { store, user, meter, rows };
}

test("logical-call cost freezes before invocation and never stores prompts or credentials", async (t) => {
  const f = setup(); t.after(() => f.store.close());
  const result = await runWithCallContext({ userId: f.user.id, source: "http" }, () => f.meter.run(llm, async () => {
    assert.equal(f.rows()[0]!.status, "pending");
    f.store.saveSetting("ai.prices", [{ host: "api.test", model: "chat", input: 9, output: 9, cached: 9, note: "" }]);
    return { text: "private-content", secret: "private-secret" };
  }, () => ({ inputTokens: 1000, cachedInputTokens: 200, outputTokens: 500 })));
  assert.equal(result.text, "private-content");
  assert.equal(f.rows()[0]!.user_id, f.user.id);
  assert.equal(f.rows()[0]!.cost_microyuan, 1900);
  assert.doesNotMatch(JSON.stringify(f.rows()), /private-content|private-secret/);
});

test("invalid logical output is failed; unconfigured OCR price remains unknown, explicit zero is real zero", async (t) => {
  const f = setup(); t.after(() => f.store.close());
  await assert.rejects(f.meter.run(llm, async () => { throw Error("bad-schema"); }, () => ({})), /bad-schema/);
  const ocr = { kind: "ocr" as const, provider: "ocr.test", model: "GeneralBasicOCR", source: "ocr" };
  await f.meter.run(ocr, async () => 1, () => ({ requests: 1 }));
  f.store.saveSetting("commercial.prices", { ocr: { microyuanPerRequest: 0 } });
  await f.meter.run(ocr, async () => 1, () => ({ requests: 1 }));
  assert.deepEqual(f.rows().map(r => [r.status, r.cost_microyuan]), [["failed", null], ["succeeded", null], ["succeeded", 0]]);
});

test("failed provider calls retain reported usage and exact cost without treating null as zero", async (t) => {
  const f = setup(); t.after(() => f.store.close());
  const billed = Object.assign(Error("bad-output"), {
    billing: "unknown",
    usage: { promptTokens: 1, cachedTokens: 0, completionTokens: 2, calls: 1 },
  });
  await assert.rejects(f.meter.run(llm, async () => { throw billed; }, () => ({})), /bad-output/);
  const unknown = Object.assign(Error("timeout"), { billing: "unknown", usage: null });
  await assert.rejects(f.meter.run(llm, async () => { throw unknown; }, () => ({})), /timeout/);
  const rows = f.rows();
  assert.deepEqual(JSON.parse(rows[0]!.usage), {
    inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, requests: 1,
  });
  assert.deepEqual(
    [rows[0]!.status, rows[0]!.cost_microyuan, rows[0]!.exact_numerator, rows[0]!.exact_denominator],
    ["failed", 5, "5000000", "1000000"],
  );
  assert.deepEqual(
    [rows[1]!.status, rows[1]!.usage, rows[1]!.cost_microyuan, rows[1]!.exact_numerator],
    ["unknown", null, null, null],
  );
});

test("missing/invalid metering never retries a completed call and surfaces an accounting failure", async (t) => {
  const f = setup(); t.after(() => f.store.close());
  let calls = 0;
  assert.equal(await f.meter.run(llm, async () => ++calls, () => ({ inputTokens: -1 })), 1);
  assert.equal(calls, 1);
  assert.equal(f.rows()[0]!.status, "unknown");
  assert.equal(f.meter.accountingWriteFailures, 1);
  f.store.db.exec("CREATE TRIGGER fail_meter BEFORE UPDATE ON commercial_usage BEGIN SELECT RAISE(FAIL,'disk unavailable'); END");
  assert.equal(await f.meter.run(llm, async () => ++calls, () => ({ inputTokens: 1 })), 2);
  assert.equal(calls, 2);
  assert.equal(f.rows()[1]!.status, "pending");
  assert.equal(f.meter.accountingWriteFailures, 2);
});

test("deleted account late completions do not recreate data; startup marks incomplete calls unknown", async (t) => {
  const f = setup(); t.after(() => f.store.close());
  await runWithCallContext({ userId: f.user.id, source: "job" }, () => f.meter.run(llm, async () => {
    f.store.db.prepare("DELETE FROM users WHERE id=?").run(f.user.id);
    return true;
  }, () => ({ outputTokens: 1 })));
  assert.equal(f.rows().length, 0);
  await assert.rejects(runWithCallContext({ userId: f.user.id, source: "http" }, () => f.meter.run(llm, async () => true, () => ({}))));
  await f.meter.run(llm, async () => true, () => ({}));
  f.store.db.prepare("UPDATE commercial_usage SET status='pending'").run();
  new CommercialMeter(f.store);
  assert.equal(f.rows()[0]!.status, "unknown");
  assert.equal(f.rows()[0]!.user_id, null);
});

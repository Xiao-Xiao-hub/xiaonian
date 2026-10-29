import assert from "node:assert/strict";
import test from "node:test";
import { z } from "../server/node_modules/zod/index.js";
import { approvedCommercialCatalog } from "../server/src/modules/commercial/policy.js";
import { ModelRouter } from "../server/src/providers/model-router.js";
import { CommercialBilling } from "../server/src/shared/commercial-billing.js";
import { CommercialMeter } from "../server/src/shared/commercial-meter.js";
import {
  bindCallContext,
  runWithCallContext,
} from "../server/src/shared/call-context.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { Budget } from "../server/src/shared/budget.js";
import { JobRunner } from "../server/src/modules/jobs/runner.js";

function fixture(enabled = true) {
  let at = Date.parse("2026-10-24T08:00:00.000Z");
  const clock = () => new Date(at);
  const store = new SqliteStore(":memory:", clock);
  const user = store.upsertUser("billing-user", "计费用户", "wechat");
  if (enabled) {
    store.saveSetting("commercial.enabled", true);
    store.saveSetting("commercial.catalog", approvedCommercialCatalog());
  }
  store.saveSetting("commercial.prices", {
    ocr: { microyuanPerRequest: 1000 },
  });
  const billing = new CommercialBilling(store, clock);
  const meter = new CommercialMeter(store, clock, billing);
  const run = <T>(
    call: () => Promise<T>,
    usage: (value: T) => object,
    info = {
      kind: "ocr" as const,
      provider: "provider.test",
      model: "meter",
      source: "test",
    },
  ) =>
    runWithCallContext({ userId: user.id, source: "http" }, () =>
      billing.action(() => meter.run(info, call, usage)),
    );
  return {
    store,
    user,
    billing,
    meter,
    run,
    set: (iso: string) => (at = Date.parse(iso)),
  };
}

const usage = () => ({ requests: 1 });

test("real job completion atomically settles; a commit failure releases holds without repeating the provider", async () => {
  const f = fixture();
  let sent = 0;
  const budget = new Budget(f.store, { day: 3, week: 12, cap: 100 }, () => new Date("2026-10-24T08:00:00Z"), f.billing);
  const run = async () => {
    const output = await f.meter.run({ kind: "ocr", provider: "test", model: "test", source: "job" }, async () => ++sent, usage);
    return { output };
  };
  const runner = new JobRunner(f.store, {
    succeeds: { run, commit: (job, output) => { f.store.saveSetting("saved-result", output); return output; } },
    fails: { run, commit: () => { f.store.saveSetting("rolled-back-result", true); throw new Error("write failed"); } },
  }, { concurrency: 2, timeoutMs: 5000, limits: {}, budget });
  try {
    const a = runner.enqueue({ userId: f.user.id, kind: "succeeds" });
    const b = runner.enqueue({ userId: f.user.id, kind: "fails" });
    await runner.idle();
    assert.equal(runner.get(a.job.id)?.status, "succeeded");
    assert.equal(runner.get(b.job.id)?.status, "failed");
    assert.equal(sent, 2);
    assert.equal(f.store.setting("rolled-back-result"), undefined);
    assert.equal(f.billing.accounts.available(f.user.id).free, 29);
    assert.equal(f.billing.ledger.freeCostRemaining("2026-10"), 99_998_000);
    assert.deepEqual(calls(f.store).sort(), ["released", "settled"]);
  } finally { await runner.stop(); f.store.close(); }
});
const status = (store: SqliteStore) =>
  store.db
    .prepare(
      "SELECT status,cost_microyuan FROM commercial_usage ORDER BY created_at,id",
    )
    .all()
    .map((row) => ({ ...row }));
const calls = (store: SqliteStore) =>
  store.db
    .prepare("SELECT status FROM commercial_calls ORDER BY created_at,id")
    .all()
    .map((row) => String(row.status));
const paidWallet = (
  f: ReturnType<typeof fixture>,
  id: string,
  credits: number,
) => {
  const at = Date.parse("2026-10-24T00:00:00.000Z");
  f.store.db
    .prepare(
      "INSERT INTO commercial_orders(id,user_id,idempotency_key,good_id,amount_cents,snapshot,catalog_version,env,status,platform,paid_at,created_at) VALUES(?,?,?,?,?,'{}','v1',0,'delivered','android',?,?)",
    )
    .run(id, f.user.id, `key-${id}`, "points_10", 1000, at, at);
  const bucket = `wallet:${id}`;
  f.billing.ledger.ensureBucket({
    id: bucket,
    userId: f.user.id,
    kind: "wallet",
    credits,
    startsAt: at,
    endsAt: null,
  });
  f.store.db
    .prepare(
      "INSERT INTO commercial_order_grants(order_id,bucket_id) VALUES(?,?)",
    )
    .run(id, bucket);
  return bucket;
};

test("commercial enforcement requires the explicit enabled switch and approved catalog", async () => {
  const f = fixture(false);
  try {
    await f.run(async () => "ok", usage);
    assert.equal(f.billing.enabled, false);
    assert.deepEqual(calls(f.store), []);
    f.store.saveSetting("commercial.enabled", true);
    await f.run(async () => "ok", usage);
    assert.deepEqual(calls(f.store), []);
  } finally {
    f.store.close();
  }
});

test("router holds before dispatch, sends max_tokens, snapshots price and settles after success", async () => {
  const f = fixture();
  try {
    f.store.db
      .prepare(
        "INSERT INTO ai_endpoints(id,alias,base_url,api_key,model,vision,thinking_format,extra_body,timeout_ms,position,enabled,created_at,updated_at) VALUES('aep_bill','bill','https://provider.test/v1','key','meter-model',0,'none','{}',5000,0,1,'t','t')",
      )
      .run();
    f.store.saveSetting("ai.prices", [
      {
        host: "provider.test",
        model: "meter-model",
        input: 1,
        output: 1,
        cached: 0,
        note: "test",
      },
    ]);
    let maxTokens: unknown;
    const router = new ModelRouter(f.store, {
      commercialMeter: f.meter,
      fetcher: (async (_url, init) => {
        maxTokens = JSON.parse(String(init?.body)).max_tokens;
        return Response.json({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 2, completion_tokens: 3 },
        });
      }) as typeof fetch,
    });
    const result = await runWithCallContext(
      { userId: f.user.id, source: "http" },
      () =>
        f.billing.action(() =>
          router
            .client("chat.study")
            .json(
              [{ role: "user", content: "hi" }],
              z.object({ ok: z.literal(true) }),
              undefined,
              { maxTokens: 7, jsonRetries: 0 },
            ),
        ),
    );
    assert.deepEqual(result.data, { ok: true });
    assert.equal(typeof maxTokens, "number");
    assert.ok(Number(maxTokens) >= 7);
    assert.deepEqual(calls(f.store), ["settled"]);
    const row = f.store.db
      .prepare("SELECT status,price,cost_microyuan FROM commercial_usage")
      .get() as { status: string; price: string; cost_microyuan: number };
    assert.equal(row.status, "succeeded");
    assert.ok(row.cost_microyuan > 0);
    assert.equal(JSON.parse(row.price).model, "meter-model");
  } finally {
    f.store.close();
  }
});

test("a held credit stops a concurrent dispatch before its provider starts", async () => {
  const f = fixture();
  try {
    f.store.db
      .prepare("UPDATE users SET quota=? WHERE id=?")
      .run('{"budget":{"day":0,"week":0}}', f.user.id);
    f.billing.accounts.consentWallet(f.user.id);
    paidWallet(f, "wallet-only", 1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sent = 0;
    const first = f.run(async () => {
      sent++;
      await held;
      return "one";
    }, usage);
    await Promise.resolve();
    await assert.rejects(
      f.run(async () => {
        sent++;
        return "two";
      }, usage),
      { code: "CREDIT_LIMIT" },
    );
    assert.equal(sent, 1);
    release();
    await first;
  } finally {
    f.store.close();
  }
});

test("business rollback releases the user hold while the successful provider cost remains", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      runWithCallContext({ userId: f.user.id, source: "job" }, () =>
        f.billing.action(async () => {
          await f.meter.run(
            {
              kind: "ocr",
              provider: "provider.test",
              model: "meter",
              source: "job",
            },
            async () => "ok",
            usage,
          );
          throw new Error("business commit failed");
        }),
      ),
      /business commit failed/,
    );
    assert.deepEqual(calls(f.store), ["released"]);
    assert.deepEqual(status(f.store), [
      { status: "succeeded", cost_microyuan: 1000 },
    ]);
  } finally {
    f.store.close();
  }
});

test("error usage and unknown outcomes are recorded once and never provider-retried", async () => {
  const f = fixture();
  try {
    let sent = 0;
    const measured = Object.assign(new Error("failed"), {
      usage: { requests: 1 },
    });
    await assert.rejects(
      f.run(async () => {
        sent++;
        throw measured;
      }, usage),
      /failed/,
    );
    const unknown = Object.assign(new Error("uncertain"), {
      billing: "unknown",
    });
    await assert.rejects(
      f.run(async () => {
        sent++;
        throw unknown;
      }, usage),
      /uncertain/,
    );
    assert.equal(sent, 2);
    assert.deepEqual(
      status(f.store)
        .map((row) => row.status)
        .sort(),
      ["failed", "unknown"],
    );
    assert.deepEqual(calls(f.store), ["released", "released"]);
  } finally {
    f.store.close();
  }
});

test("exhausted global free cost still permits a consented paid wallet", async () => {
  const f = fixture();
  try {
    f.billing.accounts.consentWallet(f.user.id);
    const wallet = paidWallet(f, "wallet-paid", 2);
    f.store.db
      .prepare(
        "INSERT INTO commercial_free_entries(month,call_id,event_key,kind,delta,created_at) VALUES('2026-10',NULL,'cap-grant','grant',100000000,?)",
      )
      .run(new Date().toISOString());
    f.store.db
      .prepare(
        "INSERT INTO commercial_free_entries(month,call_id,event_key,kind,delta,created_at) VALUES('2026-10',NULL,'cap-used','reserve',-100000000,?)",
      )
      .run(new Date().toISOString());
    await f.run(async () => "paid", usage);
    assert.deepEqual(calls(f.store), ["settled"]);
    assert.equal(f.billing.ledger.balance(wallet), 1);
  } finally {
    f.store.close();
  }
});

test("queued contexts get independent holds and recovery releases an interrupted parent hold", async () => {
  const f = fixture();
  try {
    await runWithCallContext(
      { userId: f.user.id, source: "http" },
      async () => {
        await f.meter.run(
          {
            kind: "ocr",
            provider: "provider.test",
            model: "meter",
            source: "parent",
          },
          async () => "parent",
          usage,
        );
        const queued = bindCallContext(() =>
          f.billing.action(() =>
            f.meter.run(
              {
                kind: "ocr",
                provider: "provider.test",
                model: "meter",
                source: "queue",
              },
              async () => "queue",
              usage,
            ),
          ),
        );
        await queued();
      },
    );
    assert.deepEqual(calls(f.store).sort(), ["held", "settled"]);
    assert.equal(f.billing.recover(), 1);
    assert.deepEqual(calls(f.store).sort(), ["released", "settled"]);
  } finally {
    f.store.close();
  }
});

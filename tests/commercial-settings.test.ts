import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "../server/node_modules/fastify/fastify.js";
import { loadEnv } from "../server/src/config/env.js";
import { AuthService } from "../server/src/modules/auth/service.js";
import { registerAdminSessionRoutes } from "../server/src/modules/auth/admin-session.js";
import { registerCommercialSettingsRoutes } from "../server/src/modules/commercial/settings-routes.js";
import { CommercialSettings } from "../server/src/modules/commercial/settings.js";
import { CommercialLedger } from "../server/src/shared/commercial-ledger.js";
import { CommercialAccounts } from "../server/src/shared/commercial-accounts.js";
import { CommercialPricing } from "../server/src/shared/commercial-pricing.js";
import { SqliteStore } from "../server/src/shared/store.js";

const KEY = "commercial-settings-test-key-0123456789";
const ORIGIN = "http://settings.test";
const headers = (cookie?: string) => ({ host: "settings.test", origin: ORIGIN, ...(cookie ? { cookie } : {}) });
const patch = {
  reason: "本机校准",
  allowances: { freeDayCredits: 41, freeWeekCredits: 177, freeMonthCostMicroyuan: 123_456 },
  prices: {
    calibration: { numerator: 3, denominator: 2 },
    microyuanPerCredit: 2_000,
    jev: { microyuanPerRequest: 70 },
    ocr: { microyuanPerRequest: 80 },
  },
};

function setup() {
  let now = Date.parse("2026-10-24T15:00:00.000Z");
  const store = new SqliteStore(":memory:", () => new Date(now));
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => {
    const status = "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : error instanceof Error && error.name === "ZodError" ? 400 : 500;
    reply.code(status).send({ code: "TEST_ERROR" });
  });
  const auth = new AuthService(store, loadEnv({ NODE_ENV: "test", ADMIN_API_KEY: KEY, ADMIN_ORIGIN: ORIGIN }));
  registerAdminSessionRoutes(app, auth);
  registerCommercialSettingsRoutes(app, { auth, store });
  return { app, store, settings: new CommercialSettings(store), advance: (ms: number) => { now += ms; } };
}

async function session(app: ReturnType<typeof setup>["app"]) {
  const login = await app.inject({ method: "POST", url: "/v1/admin/session", headers: headers(), payload: { key: KEY } });
  assert.equal(login.statusCode, 200, login.body);
  return login.headers["set-cookie"]!.split(";")[0]!;
}

test("settings routes require admin auth and same-origin session, reject unknown or incomplete values", async () => {
  const f = setup();
  try {
    assert.equal((await f.app.inject({ url: "/v1/admin/commercial/settings" })).statusCode, 401);
    const cookie = await session(f.app);
    const missingReason = await f.app.inject({ method: "PUT", url: "/v1/admin/commercial/settings", headers: headers(cookie), payload: { allowances: patch.allowances } });
    assert.equal(missingReason.statusCode, 400);
    const unknown = await f.app.inject({ method: "PUT", url: "/v1/admin/commercial/settings", headers: headers(cookie), payload: { ...patch, enabled: true } });
    assert.equal(unknown.statusCode, 400);
    const csrf = await f.app.inject({ method: "PUT", url: "/v1/admin/commercial/settings", headers: { host: "settings.test", cookie, origin: "https://other.test" }, payload: patch });
    assert.equal(csrf.statusCode, 403);
    assert.equal(f.store.setting("commercial.allowances"), undefined);
    assert.equal(f.store.setting("commercial.prices"), undefined);
  } finally { await f.app.close(); f.store.close(); }
});

test("complete update writes both settings atomically and audits before, after and effective time", async () => {
  const f = setup();
  try {
    const cookie = await session(f.app);
    const res = await f.app.inject({ method: "PUT", url: "/v1/admin/commercial/settings", headers: headers(cookie), payload: patch });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().data.allowances, patch.allowances);
    assert.equal(res.json().data.prices.jev.microyuanPerRequest, 70);
    const audit = f.store.audits({ action: "commercial.settings.updated" })[0]!;
    const details = audit.details;
    assert.equal(details.reason, patch.reason);
    assert.equal(details.before.allowances.freeDayCredits, 30);
    assert.equal(details.after.allowances.freeDayCredits, 41);
    assert.equal(typeof details.effectiveAt, "string");
  } finally { await f.app.close(); f.store.close(); }
});

test("allowance changes issue only future free buckets while personal zero override survives", () => {
  const f = setup();
  try {
    const user = f.store.upsertUser("settings-owner", "设置用户", "wechat");
    const ledger = new CommercialLedger(f.store, () => new Date(Date.parse(f.store.now())));
    const accounts = new CommercialAccounts(f.store, ledger, () => new Date(Date.parse(f.store.now())));
    const first = accounts.sources(user.id, 1_000).sources[0]!;
    assert.equal(ledger.balance(first.buckets[0]!), 30);
    f.settings.update("admin:test", { reason: "调整免费额度", allowances: patch.allowances });
    assert.equal(ledger.balance(accounts.sources(user.id, 1_000).sources[0]!.buckets[0]!), 30);
    f.advance(24 * 60 * 60_000);
    assert.equal(ledger.balance(accounts.sources(user.id, 1_000).sources[0]!.buckets[0]!), 41);
    f.store.db.prepare("UPDATE users SET quota=? WHERE id=?").run('{"budget":{"day":0}}', user.id);
    f.advance(24 * 60 * 60_000);
    assert.equal(ledger.balance(accounts.sources(user.id, 1_000).sources[0]!.buckets[0]!), 0);
  } finally { f.store.close(); }
});

test("price update produces a new version without changing an existing price snapshot", () => {
  const f = setup();
  try {
    f.store.saveSetting("commercial.prices", { calibration: { numerator: 1, denominator: 1 }, microyuanPerCredit: 1_000, ocr: { microyuanPerRequest: 9 } });
    const pricing = new CommercialPricing(f.store);
    const old = pricing.snapshot("ocr.test", "General", "ocr");
    f.settings.update("admin:test", { reason: "调整 OCR 价", prices: { calibration: { numerator: 1, denominator: 1 }, microyuanPerCredit: 1_000, ocr: { microyuanPerRequest: 11 } } });
    const next = pricing.snapshot("ocr.test", "General", "ocr");
    assert.equal(old.microyuanPerRequest, 9);
    assert.equal(next.microyuanPerRequest, 11);
    assert.notEqual(old.version, next.version);
  } finally { f.store.close(); }
});

test("settings read normalizes existing partial and decimal prices without inventing a missing price", () => {
  const f = setup();
  try {
    f.store.saveSetting("commercial.prices", { jev: { yuanPerRequest: "0.000009" } });
    const view = f.settings.get();
    assert.equal(view.prices.jev?.microyuanPerRequest, 9);
    assert.equal(view.prices.ocr, null);
    assert.equal(view.prices.microyuanPerCredit, 1000);
    f.settings.update("admin:test", { reason: "只改免费窗口", allowances: patch.allowances });
    assert.equal(f.settings.get().prices.jev?.microyuanPerRequest, 9);
  } finally { f.store.close(); }
});

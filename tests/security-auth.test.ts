import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyRequest } from "fastify";
import { AuthService } from "../server/src/modules/auth/service.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore, digest } from "../server/src/shared/store.js";
import { fakeServices, makeApp } from "./fixtures.js";
import { ProfileService } from "../server/src/modules/account/profile.js";
import { reserveUploadBytes } from "../server/src/shared/upload-budget.js";
import { PRIVACY_VERSION } from "../server/src/shared/domain.js";

const request = (token?: string, ip = "192.0.2.1", url = "/v1/cards") => ({
  headers: token ? { authorization: `Bearer ${token}` } : {},
  ip, url, routeOptions: { url },
}) as FastifyRequest;

test("rate-limit identity joins valid sessions and addresses but never trusts an arbitrary token", () => {
  const store = new SqliteStore(":memory:");
  try {
    const auth = new AuthService(store, loadEnv({ NODE_ENV: "test", DEV_LOGIN_ENABLED: "true" }));
    const first = auth.dev("one", "one"), second = auth.dev("one", "one");
    const other = auth.dev("two", "two");
    assert.equal(auth.rateLimitKey(request(first.token)), `user:${first.user.id}`);
    assert.equal(auth.rateLimitKey(request(second.token, "192.0.2.2")), `user:${first.user.id}`);
    assert.equal(auth.rateLimitKey(request(other.token)), `user:${other.user.id}`);
    assert.equal(auth.rateLimitKey(request("a".repeat(43))), "ip:192.0.2.1");
    assert.equal(auth.rateLimitKey(request("not-a-token")), "ip:192.0.2.1");
    assert.equal(auth.rateLimitKey(request()), "ip:192.0.2.1");
    for (const url of ["/v1/admin/session", "/v1/auth/dev-login", "/v1/auth/wechat-login"])
      assert.equal(auth.rateLimitKey(request(first.token, "192.0.2.1", url)), "ip:192.0.2.1");
  } finally { store.close(); }
});

test("expired, revoked and production-disabled sessions cannot claim a user rate-limit bucket", () => {
  const store = new SqliteStore(":memory:");
  try {
    const auth = new AuthService(store, loadEnv({ NODE_ENV: "test", DEV_LOGIN_ENABLED: "true" }));
    const expired = auth.dev("expiry", "one"), revoked = auth.dev("revoke", "two");
    store.db.prepare("UPDATE sessions SET expires_at=? WHERE hash=?").run(Date.now() - 1, digest(expired.token));
    assert.equal(auth.rateLimitKey(request(expired.token)), "ip:192.0.2.1");
    auth.logout(request(revoked.token));
    assert.equal(auth.rateLimitKey(request(revoked.token)), "ip:192.0.2.1");
    assert.throws(() => auth.require(request(revoked.token)), { code: "SESSION_EXPIRED" });
    const active = auth.dev("prod-disabled", "three");
    const production = new AuthService(store, { ...auth.env, NODE_ENV: "production", DEV_LOGIN_ENABLED: true });
    assert.equal(production.rateLimitKey(request(active.token)), "ip:192.0.2.1");
    assert.throws(() => production.require(request(active.token)), { code: "DEV_LOGIN_DISABLED" });
    assert.throws(() => production.dev("new", "four"), { code: "NOT_FOUND" });
    assert.equal(store.db.prepare("SELECT 1 FROM sessions WHERE hash=?").get(active.token), undefined);
  } finally { store.close(); }
});

test("foreign materials, notes, cards and source references stay unreadable and unchanged", async () => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  try {
    const login = async (key: string) => {
      const response = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key } });
      assert.equal(response.statusCode, 200, response.body);
      return { authorization: `Bearer ${response.json().data.token}` };
    };
    const owner = await login("security-owner"), other = await login("security-other");
    const materialResponse = await app.inject({ method: "POST", url: "/v1/materials", headers: owner, payload: { kind: "note", text: "private material marker" } });
    assert.equal(materialResponse.statusCode, 200, materialResponse.body);
    const material = materialResponse.json().data.id as string;
    const noteResponse = await app.inject({ method: "POST", url: "/v1/notes", headers: owner, payload: { text: "private note marker" } });
    assert.equal(noteResponse.statusCode, 200, noteResponse.body);
    const note = noteResponse.json().data.id as string;
    const cardResponse = await app.inject({ method: "POST", url: "/v1/cards", headers: owner, payload: { text: "private card marker", type: "idea" } });
    assert.equal(cardResponse.statusCode, 200, cardResponse.body);
    const card = cardResponse.json().data.card.id as string;
    const checks = [
      ["GET", `/v1/materials/${material}`],
      ["GET", `/v1/materials/${material}/image`],
      ["GET", `/v1/materials/${material}/versions`],
      ["GET", `/v1/materials/${material}/versions/1`],
      ["GET", `/v1/materials/${material}/study`],
      ["PUT", `/v1/materials/${material}`, { expectedVersion: 1, title: "forged" }],
      ["POST", `/v1/materials/${material}/review`],
      ["DELETE", `/v1/materials/${material}/review`],
      ["DELETE", `/v1/materials/${material}`],
      ["GET", `/v1/notes/${note}`],
      ["PUT", `/v1/notes/${note}`, { title: "forged" }],
      ["DELETE", `/v1/notes/${note}`],
      ["GET", `/v1/cards/${card}`],
      ["PATCH", `/v1/cards/${card}`, { version: 1, title: "forged" }],
      ["PUT", `/v1/cards/${card}/favorite`, { favorite: true }],
      ["PUT", `/v1/cards/${card}/tags`, { version: 1, tagIds: [] }],
      ["DELETE", `/v1/cards/${card}`],
    ] as const;
    for (const [method, url, payload] of checks) {
      const response = await app.inject({ method, url, payload, headers: other });
      assert.equal(response.statusCode, 404, `${method} ${url}: ${response.body}`);
      assert.doesNotMatch(response.body, /private .* marker/);
    }
    for (const url of [`/v1/materials/${material}`, `/v1/notes/${note}`, `/v1/cards/${card}`])
      assert.equal((await app.inject({ url, headers: owner })).statusCode, 200);
    const maliciousSource = await app.inject({ method: "POST", url: "/v1/cards", headers: other,
      payload: { text: "forged", origin: "mistake", mistakeId: card } });
    assert.equal(maliciousSource.statusCode, 400, maliciousSource.body);
    const sqlProbe = await app.inject({ url: "/v1/cards?q=%27%20OR%201%3D1--", headers: other });
    assert.equal(sqlProbe.statusCode, 200, sqlProbe.body);
    assert.equal(sqlProbe.json().data.total, 0);
    for (const url of ["/metrics", "/v1/admin/users", "/v1/admin/commercial/orders", "/v1/admin/support/tickets"]) {
      const response = await app.inject({ url, headers: other });
      assert.ok([401, 503].includes(response.statusCode), `${url}: ${response.body}`);
    }
  } finally { await app.close(); }
});

test("avatar writes share the upload budget and refuse before changing the profile or filesystem", () => {
  const store = new SqliteStore(":memory:"), root = mkdtempSync(join(tmpdir(), "security-avatar-"));
  try {
    const user = store.upsertUser("dev:avatar-budget", "old-name", "dev");
    user.ageBand = "adult";
    user.consents = [{ kind: "docs", version: PRIVACY_VERSION, at: store.now() }];
    store.db.prepare("UPDATE users SET data=? WHERE id=?").run(JSON.stringify(user), user.id);
    reserveUploadBytes(root, user.id, 2 * 1024 * 1024 * 1024);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
    assert.throws(() => new ProfileService(store, root).update(user.id, { nickname: "new-name", image: png }), { code: "UPLOAD_STORAGE_LIMIT" });
    assert.equal(store.getUser(user.id)!.nickname, "old-name");
    assert.equal(store.getUser(user.id)!.avatar, undefined);
    assert.deepEqual(readdirSync(root), []);
  } finally { store.close(); }
});

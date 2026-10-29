import assert from "node:assert/strict";
import test from "node:test";
import { WechatAccessToken } from "../server/src/providers/wechat-access-token.js";

test("stable token coalesces concurrent refreshes and expires before its deadline", async () => {
  let at = 0, calls = 0;
  const client = new WechatAccessToken({ appId: "synthetic-id", appSecret: "synthetic-secret", now: () => at,
    fetcher: (async (url, init) => {
      assert.equal(String(url), "https://api.weixin.qq.com/cgi-bin/stable_token");
      assert.deepEqual(JSON.parse(String(init!.body)), { grant_type: "client_credential", appid: "synthetic-id", secret: "synthetic-secret", force_refresh: false });
      return new Response(JSON.stringify({ access_token: `synthetic-${++calls}`, expires_in: 7200 }));
    }) as typeof fetch,
  });
  assert.deepEqual(await Promise.all([client.get(), client.get()]), ["synthetic-1", "synthetic-1"]);
  at = 7_139_000;
  assert.equal(await client.get(), "synthetic-1");
  at = 7_140_000;
  assert.equal(await client.get(), "synthetic-2");
  assert.equal(calls, 2);
});

test("token failures release refresh lock without exposing platform errors or secrets", async () => {
  let fail = true;
  const client = new WechatAccessToken({ appId: "synthetic-id", appSecret: "synthetic-secret", fetcher: (async () => new Response(JSON.stringify(fail ? { errcode: 40013, errmsg: "synthetic-secret" } : { access_token: "short-lived", expires_in: 45 }))) as typeof fetch });
  await assert.rejects(client.get(), error => { assert.doesNotMatch(String(error), /synthetic-secret/); return true; });
  fail = false;
  assert.equal(await client.get(), "short-lived");
});

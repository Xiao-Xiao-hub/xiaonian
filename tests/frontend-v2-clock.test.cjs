const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const clockPath = path.join(root, "utils/clock.js");
const formatPath = path.join(root, "utils/format.js");
const requestPath = path.join(root, "utils/request.js");

test("response service time drives calendar labels without changing wait timers", async (t) => {
  const fixed = Date.parse("2026-10-10T04:00:00.000Z");
  const realDateNow = Date.now;
  const originalZone = process.env.TZ;
  Date.now = () => fixed;
  global.wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
    getStorageSync: () => null,
    removeStorageSync() {},
    request(options) {
      options.success({
        statusCode: 200,
        data: { data: { ok: true } },
        header: { "X-Service-Time": "2026-10-12T04:00:00.000Z" },
      });
    },
  };
  delete require.cache[clockPath];
  delete require.cache[formatPath];
  delete require.cache[requestPath];
  try {
    const clock = require(clockPath);
    const format = require(formatPath);
    const { request } = require(requestPath);
    assert.equal(clock.synced(), false);
    await request({ url: "/v1/config" });
    assert.equal(clock.synced(), true);
    assert.equal(clock.now(), Date.parse("2026-10-12T04:00:00.000Z"));
    // Due dates use Beijing days; ordinary timestamps use the device calendar.
    // At midnight in New York the prior hour belongs to yesterday, even when
    // the same instant belongs to today in Beijing and UTC.
    for (const [zone, expected] of [
      ["UTC", "今天 03:00"],
      ["Asia/Shanghai", "今天 11:00"],
      ["America/New_York", "昨天 23:00"],
    ]) {
      await t.test(zone, () => {
        process.env.TZ = zone;
        assert.equal(format.dueText("2026-10-12"), "今天");
        assert.equal(format.dueText("2026-10-13"), "明天");
        assert.equal(format.when("2026-10-12T03:00:00.000Z"), expected);
        assert.equal(Date.now(), fixed, "service offset must not change elapsed-time clocks");
      });
    }
  } finally {
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
    Date.now = realDateNow;
    delete global.wx;
    delete require.cache[clockPath];
    delete require.cache[formatPath];
    delete require.cache[requestPath];
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../admin/", import.meta.url);
test("commercial operations is reachable from the existing admin console and uses protected APIs", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("app.js", root), "utf8"),
  ]);
  assert.match(html, /data-page="commercial"/);
  for (const path of [
    "/v1/admin/commercial/settings",
    "/v1/admin/commercial/overview",
    "/v1/admin/commercial/orders?limit=50",
    "/v1/admin/commercial/costs?limit=50",
    "/v1/admin/commercial/pending?limit=50",
    "/v1/admin/commercial/refunds?limit=50",
    "/v1/admin/support/tickets?limit=50",
    "/v1/admin/commercial/anomalies?limit=50",
  ]) assert.match(app, new RegExp(path.replace(/[/?]/g, "\\$&")));
  assert.match(app, /confirmButton\("保存计量配置"/);
  assert.match(app, /placeholder: "修改原因（必填）"/);
  assert.match(app, /留空表示未配置；明确填 0 表示零价。/);
  assert.match(app, /\/v1\/admin\/commercial\/orders\/\$\{encodeURIComponent\(order\.id\)\}\/sync/);
  assert.match(app, /confirmButton\("人工查单"/);
  assert.match(app, /placeholder: "查单原因（必填）"/);
  assert.match(app, /不会直接发放积分/);
  assert.match(app, /goodName \|\| order\.goodId/);
  assert.match(app, /node\("span", order\.goodId, "cell-detail mono"\)/);
  assert.match(app, /confirmButton\("申请退款"/);
  assert.match(app, /order\.planAction === "upgrade"\) value\.append\(" ", badge\("", "升级"\)\)/);
  assert.match(app, /order\.supersededBy\) value\.append\(" ", badge\("unknown", "已被升级取代"\)\)/);
  assert.match(app, /refund\.disabled = true;\n\s*refund\.title = order\.refundBlockReason;/);
  assert.match(app, /row\.upgradeSegments/);
  assert.match(app, /confirmButton\("发送回复"/);
  assert.match(app, /confirmButton\("关闭工单"/);
  assert.match(app, /confirmButton\("查单后恢复额度"/);
  assert.match(app, /confirmButton\("重新提交退款"/);
  assert.match(app, /expectedAttempt: row.attempt/);
  assert.match(app, /row\.status === "pending" && row\.manualReviewAt/);
  assert.match(app, /manualReviewReason === "status7_after_retry"/);
  assert.doesNotMatch(app, /updatedAtMs \+ 24/);
  assert.match(app, /order\.accountErased \? `\$\{commercialStatus\(order\.status\)\}（账号已注销）`/);
  assert.match(app, /ORDER_ACCOUNT_ERASED: "/);
  assert.match(app, /idempotencyKey: crypto.randomUUID\(\)/);
  assert.match(app, /open: "待处理"/);
  assert.match(app, /NOTIFY_PROVIDE_GOODS_FAILED: "已发货，但通知微信发货失败"/);
  assert.match(app, /\[row\.orderId, commercialAnomaly\(row\)/);
  assert.doesNotMatch(app, /\[row\.orderId, row\.code/);
  assert.match(app, /未定价，不会调用/);
  assert.doesNotMatch(app, /smtp|sendPending|sendMail/i);
});

test("commercial page shows today's site-wide call risk and lets the operator set its cap", async () => {
  const app = await readFile(new URL("app.js", root), "utf8");
  assert.match(app, /\["今日调用风险额", `\$\{yuan\(\(overview\.costSafety\?\.riskMicroyuan \|\| 0\) \/ 1_000_000\)\} \/ 上限 \$\{yuan\(\(overview\.costSafety\?\.dailyCapMicroyuan \|\| 0\) \/ 1_000_000\)\}/);
  assert.match(app, /value: settings\.costSafety\?\.dailyCapMicroyuan/);
  assert.match(app, /costSafety: \{ dailyCapMicroyuan: commercialInteger\(dailyCap, "全站每日调用上限"\) \}/);
  // The public readiness note carries no amounts; the console must not parse one out of it.
  assert.doesNotMatch(app, /ready\.note\.match|风险额 \$\{ready/);
});

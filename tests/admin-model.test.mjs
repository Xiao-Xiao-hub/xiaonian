import test from "node:test";
import assert from "node:assert/strict";
import {
  pageSlice,
  dateTime,
  jobTotals,
  percent,
  ratio,
  bytes,
  mapReportTable,
  number,
  duration,
  costLabel,
  usageTrend,
  queuePending,
} from "../admin/model.mjs";

test("待完成任务取全时段队列，缺失统计不伪装成零积压", () => {
  assert.equal(queuePending({ queued: 4, running: 2 }), 6);
  assert.equal(queuePending({ queued: 0, running: 0 }), 0);
  assert.equal(queuePending(undefined), null);
  assert.equal(queuePending({ queued: 0 }), null);
  assert.equal(queuePending({ queued: -1, running: 0 }), null);
  assert.equal(queuePending({ queued: NaN, running: 0 }), null);
});

test("消耗金额：账单未接入与真实零元明确区分", () => {
  assert.equal(
    costLabel({ status: "unavailable", amount: null, currency: null }),
    "尚未接入账单",
  );
  assert.equal(
    costLabel({ status: "unavailable", amount: 0, currency: "CNY" }),
    "尚未接入账单",
  );
  assert.match(
    costLabel({ status: "available", amount: 0, currency: "CNY" }),
    /0\.00/,
  );
  assert.equal(
    costLabel({ status: "available", amount: NaN, currency: "CNY" }),
    "尚未接入账单",
  );
  assert.equal(
    costLabel({ status: "available", amount: -1, currency: "CNY" }),
    "尚未接入账单",
  );
});
test("趋势对全零、缺失 token、未知调用和异常数值保持可读", () => {
  assert.deepEqual(usageTrend([]), []);
  const rows = usageTrend([
    {
      date: "2026-10-03",
      calls: 0,
      promptTokens: null,
      completionTokens: null,
    },
    {
      date: "2026-10-04",
      calls: 4,
      promptTokens: 100,
      completionTokens: 20,
      unknown: 2,
    },
    {
      date: "2026-10-05",
      calls: Infinity,
      promptTokens: -50,
      completionTokens: NaN,
    },
  ]);
  assert.equal(rows[0].height, 0);
  assert.equal(rows[1].height, 1);
  assert.equal(rows[1].tokens, 120);
  assert.equal(rows[1].unknownJobs, 2);
  assert.equal(rows[2].tokens, 0);
  assert.equal(rows[2].height, 0);
  assert.equal(usageTrend([{ calls: 0 }])[0].height, 0);
});
test("统计时长保留秒与日口径，未知数不显示成零", () => {
  assert.equal(number(null), "—");
  assert.equal(number(NaN), "—");
  assert.equal(number(0), "0");
  assert.equal(duration(null), "—");
  assert.equal(duration(-1), "—");
  assert.equal(duration(12.54), "12.5 秒");
  assert.equal(duration(3600), "1 小时 0 分钟");
  assert.equal(duration(90000), "1 天 1 小时");
});

test("分页在删除或过滤后钳制到有效页面", () => {
  const list = Array.from({ length: 21 }, (_, index) => index);
  assert.deepEqual(pageSlice(list, 2).rows, [20]);
  assert.equal(pageSlice(list, 99).page, 2);
  assert.equal(pageSlice([], 9).page, 1);
  assert.equal(pageSlice(list, -2).page, 1);
  assert.equal(pageSlice(list, NaN).page, 1);
});
test("无效日期不渲染 Invalid Date", () => {
  assert.equal(dateTime(undefined), "—");
  assert.equal(dateTime("oops"), "—");
  assert.notEqual(dateTime("2026-01-01T00:00:00Z"), "—");
});
test("任务合计只按已结束的任务算成功率", () => {
  const totals = jobTotals([
    { queued: 1, running: 1, succeeded: 6, failed: 1, unknown: 1 },
    { queued: 0, running: 0, succeeded: 0, failed: 0, unknown: 0 },
  ]);
  assert.deepEqual(totals, {
    total: 10,
    pending: 2,
    failed: 1,
    unknown: 1,
    successRate: 0.75,
  });
  assert.equal(jobTotals([{ queued: 2 }]).successRate, null);
  assert.equal(percent(0.75), "75%");
  assert.equal(percent(null), "—");
});
test("比例在分母为 0 时不显示", () => {
  assert.equal(percent(ratio(1, 4)), "25%");
  assert.equal(ratio(0, 0), null);
  assert.equal(percent(ratio(0, 0)), "—");
});
test("存储大小按 1024 进位", () => {
  assert.equal(bytes(500), "500 B");
  assert.equal(bytes(1536), "1.5 KB");
  assert.equal(bytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(bytes(undefined), "—");
  assert.equal(bytes(null), "—");
});
test("地图题反馈表：每个点一行，四种原因缺的记 0，不含答案", () => {
  const { headers, rows } = mapReportTable([
    {
      pointId: "application-taylor-limit",
      name: "泰勒公式求极限",
      chapter: "中值与应用",
      total: 3,
      users: 2,
      reasons: { judge: 2, problem: 0, unclear: 1, other: 0 },
    },
    {
      pointId: "limit-rules",
      name: "极限四则运算",
      chapter: "极限",
      total: 1,
      users: 1,
      reasons: { other: 1 },
    },
  ]);
  assert.deepEqual(headers, [
    "知识点",
    "章",
    "反馈",
    "人数",
    "判错了",
    "题目或答案有错",
    "看不懂",
    "其他问题",
  ]);
  assert.deepEqual(rows, [
    ["泰勒公式求极限", "中值与应用", 3, 2, 2, 0, 1, 0],
    ["极限四则运算", "极限", 1, 1, 0, 0, 0, 1],
  ]);
  assert.deepEqual(mapReportTable(undefined).rows, []);
});

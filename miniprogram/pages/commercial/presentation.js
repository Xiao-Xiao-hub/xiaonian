const GOODS = Object.freeze({
  plan_entry_30d: "晓念Plus",
  plan_standard_30d: "晓念Pro",
  plan_advanced_30d: "晓念Max",
  points_10: "晓念积分包10元",
  points_30: "晓念积分包30元",
  points_50: "晓念积分包50元",
});

const STATUS = Object.freeze({
  created: "待支付",
  paid: "已支付，待到账",
  delivered: "已到账",
  refunding: "退款处理中",
  refunded: "已退款",
  closed: "已关闭",
});

function beijingDate(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return "";
  const [year, month, day] = new Date(ms + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function snapshotName(snapshot) {
  const good = snapshot && typeof snapshot === "object" ? snapshot.good : null;
  return good && typeof good.name === "string" ? good.name : "";
}

function orderPresentation(order) {
  const paidAtMs = Number(order.paidAtMs);
  const paid = Number.isFinite(paidAtMs) && ["paid", "delivered", "refunding", "refunded"].includes(order.status);
  return {
    ...order,
    name: snapshotName(order.snapshot) || GOODS[order.goodId] || order.goodId,
    statusText: STATUS[order.status] || "状态待确认",
    dateLabel: beijingDate(order.createdAtMs),
    paidLabel: paid ? beijingDate(paidAtMs) : "",
    // Upgrade orders charge a prorated difference such as ¥26.67.
    price: `¥${(Number(order.amountCents || 0) / 100).toFixed(Number(order.amountCents || 0) % 100 ? 2 : 0)}`,
    paid,
  };
}

module.exports = { GOODS, beijingDate, orderPresentation };

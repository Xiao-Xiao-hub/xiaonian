export type SupportKnowledge = Readonly<{
  id: string;
  title: string;
  keywords: readonly string[];
  answer: string;
}>;

// Only owner-confirmed D126/D127 facts live here. This is deliberately small
// enough for the help page and support gate to share without inventing policy.
export const SUPPORT_KNOWLEDGE: readonly SupportKnowledge[] = Object.freeze([
  {
    id: "quota",
    title: "额度怎么算？",
    keywords: ["额度", "积分", "免费"],
    answer:
      "AI 帮你做的事都从同一份额度里扣，按实际用量算。免费额度按北京时间每天 0 点、每周一 0 点恢复；没成功的不扣额度。套餐和积分余额可在“我的 › 充值”查看。",
  },
  {
    id: "plan",
    title: "套餐怎么续费、升级？",
    keywords: ["套餐", "plus", "pro", "max", "有效期"],
    answer:
      "同一时间只有一个套餐，不自动续费，每 7 天有一个额度窗口。同档续费从当前套餐到期时顺延 30 天，额度不叠加；套餐期内可补差价升级到更高档，到期时间不变，苹果手机暂不支持升级；不能换更低档，须等当前套餐到期。积分包随时可买，可以叠加。",
  },
  {
    id: "wallet",
    title: "积分包怎么用？",
    keywords: ["积分包", "钱包", "余额"],
    answer: "积分包随时可买，可以和套餐、其他积分包叠加；余额由服务端订单记录发放，第一次使用积分前会征求同意。",
  },
  {
    id: "refund",
    title: "怎么申请退款？",
    keywords: ["退款", "退费", "退钱", "提现"],
    answer:
      "购买后 7 天内且权益未使用的订单可以申请退款，由管理员核实处理；已使用不退。苹果订单按 Apple 规则申请，开发者不能主动退款。积分不能提现。",
  },
  {
    id: "order",
    title: "付款后没到账怎么办？",
    keywords: ["订单", "支付", "扣款", "扣了两次钱", "购买", "到账"],
    answer: "可在“我的 › 充值 › 订单与退款进度”查看到账情况；支付成功后仍未到账，可先刷新订单状态。",
  },
  {
    id: "complaint",
    title: "想投诉或要补偿？",
    keywords: ["投诉", "补偿"],
    answer: "请说说在晓念里遇到的具体情况，我先帮你查。多次仍没解决时，可以提交工单，运营者会在 3 个自然日（72 小时）内处理，但不承诺补偿或处理结果。",
  },
  {
    id: "account",
    title: "怎么导出资料或注销？",
    keywords: ["登录", "账号", "导出", "注销", "隐私"],
    answer: "你可以在“我的”中导出自己的资料或注销账号；注销后数据会删除。",
  },
  {
    id: "ticket",
    title: "怎么找人工？",
    keywords: ["工单", "人工", "客服"],
    answer:
      "先说说遇到的问题，我先帮你看。多次仍没解决时，这里会出现提交工单的入口；运营者会在 3 个自然日（72 小时）内处理，不承诺退款、补偿或必定解决。",
  },
  {
    id: "map",
    title: "学习地图怎么用？",
    keywords: ["学习地图", "知识地图"],
    answer: "在“学习”里选择知识点做题；需要帮助时先看提示，做过的知识点可以回头复习。",
  },
  {
    id: "fault",
    title: "页面打不开怎么办？",
    keywords: ["白屏", "打不开", "加载失败", "网络连接不上", "闪退", "报错", "卡住"],
    answer: "先确认网络可用，再关闭晓念后重新打开。若试过后问题仍在，请说明是晓念的哪个页面、具体提示，以及已经尝试的操作。",
  },
  {
    id: "cards",
    title: "怎么整理成卡片？",
    keywords: ["卡片", "随心记"],
    answer: "在“随心记”写下内容，可以整理成卡片；卡片里能修改内容、类型和回顾提醒。",
  },
]);

export const knowledgeFor = (text: string) => {
  const lower = text.toLowerCase();
  // Specific phrases win over generic words: 积分包 must not select 额度.
  const matches = SUPPORT_KNOWLEDGE.map(item => ({
    item,
    score: Math.max(0, ...item.keywords.filter(word =>
      /^[a-z]+$/i.test(word)
        ? new RegExp(`\\b${word}\\b`, "i").test(text)
        : lower.includes(word),
    ).map(word => word.length)),
  })).filter(match => match.score > 0);
  if (/退款|退费|退钱|提现/.test(text))
    return matches.find(match => match.item.id === "refund")?.item;
  return matches.sort((a, b) => b.score - a.score)[0]?.item;
};

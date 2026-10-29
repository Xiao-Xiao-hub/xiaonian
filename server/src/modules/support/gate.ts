import { hasCrisisWords } from "../safety/crisis-words.js";
import { knowledgeFor } from "./knowledge.js";

export type SupportJudgment = Readonly<{ related: number; injection: number; category: string }>;
export type SupportJev = { classify(text: string): Promise<SupportJudgment> };
export type SupportGateResult = Readonly<{
  layer: "crisis" | "reject" | "answer" | "clarify" | "generate";
  intent: "crisis" | "unrelated" | "injection" | "support" | "ambiguous";
  kbAnswer: string | null;
  ticketEligible: boolean;
  remoteUsed: boolean;
  message: string;
  knowledgeId?: string;
  resourcePath?: "/pages/crisis/index";
}>;

const reject = (
  intent: "unrelated" | "injection",
  message: string,
  remoteUsed = false,
): SupportGateResult => ({
  layer: "reject",
  intent,
  kbAnswer: null,
  ticketEligible: false,
  remoteUsed,
  message,
});
const clarify = (remoteUsed: boolean): SupportGateResult => ({
  layer: "clarify",
  intent: "ambiguous",
  kbAnswer: null,
  ticketEligible: false,
  remoteUsed,
  message: "请说说这和晓念的哪项功能、订单或账号有关，我再帮你查。",
});
const INJECTION =
  /忽略.{0,8}(指令|规则|设定)|system\s*prompt|提示词|jailbreak|越权|管理员口令|session[ _-]?key|输出.*(密钥|token|session)|(?:ignore|override).{0,20}(?:instruction|rule)|别人的?(账号|订单|余额)/i;
const UNRELATED =
  /(写.{0,12}作文|写代码|写\s*python|写\s*javascript|扮演.{0,8}诗人|股票|彩票|天气|翻译这句|数学作业答案|恋爱建议|附近餐厅|星期几|推荐.*电影|写.*诗|讲.*笑话)/i;
const FAULT = /白屏|打不开|加载失败|网络连接不上|闪退|报错|卡住/;
const RELATED =
  /(晓念|额度|积分|余额|钱包|套餐|\b(?:plus|pro|max)\b|订单|支付|扣款|扣了.{0,4}次钱|到账|退款|退费|投诉|补偿|账号|登录|隐私|工单|客服|导出|注销|学习地图|卡片|拍题|批改)|(?:白屏|打不开|加载失败|网络连接不上|闪退|报错|卡住)/i;
const OTHER_PRODUCT_FAULT = /(?:其他|别的).{0,8}(?:游戏|软件|小程序|应用)|(?:游戏|软件).{0,12}(?:白屏|打不开|加载失败|闪退|报错|卡住)/i;
const OTHER_PRODUCT_COMPLAINT =
  /(?:王者荣耀|原神|和平精英|英雄联盟|(?:其他|别的).{0,8}(?:游戏|软件|小程序|应用)|游戏.{0,8}(?:补偿|投诉))/i;
// A complaint that also names Xiaonian's own money or order in the same
// clause stays support even when it mentions another product. A bare
// "晓念" prefix is not enough.
const OWN_ORDER_CLAUSE =
  /晓念[^，,。；;！!？?]{0,12}(?:扣(?:了|钱|款|费)|订单|退款|退费|到账|充值|套餐|积分|额度)|(?:扣(?:了|钱|款|费)|订单|退款|退费|到账|充值|套餐|积分|额度)[^，,。；;！!？?]{0,6}晓念/;
const GARBLED = /�{2,}|(.)\1{12,}/;
/** The user says the problem is still not solved or asks for a person.
 * Two such signals in one session open the ticket entry. */
export const UNRESOLVED =
  /转人工|人工客服|找人工|要人工|联系人工|真人客服|找真人|没(?:有)?解决|未解决|解决不了|没帮上|(?:还是|依然|仍然|仍旧|仍).{0,4}(?:不行|没用|不管用|没解决|不对|有问题|白屏|打不开|加载失败|闪退|报错|卡住)/;
// A short follow-up in a session that already has a supported question is
// answered with that context instead of a fresh relevance judgment.
const FOLLOW_UP_MAX_CHARS = 30;
const REJECTION = "我只能回答晓念的使用、额度、订单和账号问题。学习上的问题可以去“聊一聊”。";
// A vague complaint about the product is support even when the judgment scores it low.
const COMPLAINT = /奇怪|不对|不准|错了|有问题|不好用|不正常|异常|出错|bug/i;

/** Pure preflight: no DB, mail, account action, or dialogue-model fallback. */
export class SupportGate {
  private readonly thresholds: Readonly<{ rejectBelow: number; injectionAt: number; generateAt: number }>;
  constructor(
    private readonly jev?: SupportJev,
    thresholds: Readonly<{ rejectBelow: number; injectionAt?: number; generateAt: number }> = { rejectBelow: 0.3, injectionAt: 0.3, generateAt: 0.7 },
  ) {
    this.thresholds = { ...thresholds, injectionAt: thresholds.injectionAt ?? 0.3 };
    if (!Number.isFinite(this.thresholds.rejectBelow) || !Number.isFinite(this.thresholds.injectionAt) || !Number.isFinite(this.thresholds.generateAt) ||
      this.thresholds.rejectBelow < 0 || this.thresholds.injectionAt < 0 || this.thresholds.injectionAt > 1 || this.thresholds.generateAt > 1 || this.thresholds.rejectBelow >= this.thresholds.generateAt)
      throw new RangeError("客服门控阈值无效");
  }
  async check(raw: unknown, options: Readonly<{ followUp?: boolean }> = {}): Promise<SupportGateResult> {
    if (
      typeof raw !== "string" ||
      !raw.trim() ||
      raw.trim().length > 200 ||
      GARBLED.test(raw)
    )
      return reject("unrelated", "请用一句简短的话说明你在晓念里遇到的问题。");
    const text = raw.trim();
    if (hasCrisisWords(text))
      return {
        layer: "crisis",
        intent: "crisis",
        kbAnswer: null,
        ticketEligible: false,
        remoteUsed: false,
        message: "你的安全最重要。",
        resourcePath: "/pages/crisis/index",
      };
    if (INJECTION.test(text))
      return reject("injection", REJECTION);
    if (UNRELATED.test(text))
      return reject("unrelated", REJECTION);
    if (OTHER_PRODUCT_FAULT.test(text) && !/晓念/.test(text))
      return reject("unrelated", REJECTION);
    if (OTHER_PRODUCT_COMPLAINT.test(text) && /补偿|投诉/.test(text) && !OWN_ORDER_CLAUSE.test(text))
      return reject("unrelated", REJECTION);
    if (!/[\p{L}\p{N}]/u.test(text)) return reject("unrelated", REJECTION);
    const unresolved = UNRESOLVED.test(text);
    if (unresolved && options.followUp && text.length <= FOLLOW_UP_MAX_CHARS)
      return { layer: "generate", intent: "support", kbAnswer: null, ticketEligible: false, remoteUsed: false, message: "" };
    const item = knowledgeFor(text) ?? (unresolved ? knowledgeFor("工单") : undefined);
    // The gate never opens tickets; the service does after repeated
    // unresolved signals in the same session.
    if (item && (RELATED.test(text) || unresolved || (item.id === "fault" && FAULT.test(text))))
      return {
        layer: "answer",
        intent: "support",
        kbAnswer: item.answer,
        knowledgeId: item.id,
        ticketEligible: false,
        remoteUsed: false,
        message: item.answer,
      };
    if (!RELATED.test(text)) return reject("unrelated", REJECTION);
    if (!this.jev) return clarify(false);
    try {
      const result = await this.jev.classify(text);
      if (![result.related, result.injection].every(value => Number.isFinite(value) && value >= 0 && value <= 1))
        return clarify(true);
      if (result.injection >= this.thresholds.injectionAt) return reject("injection", REJECTION, true);
      if (result.related < this.thresholds.rejectBelow)
        return COMPLAINT.test(text) ? clarify(true) : reject("unrelated", REJECTION, true);
      if (result.related >= this.thresholds.generateAt)
        return { layer: "generate", intent: "support", kbAnswer: null, ticketEligible: false, remoteUsed: true, message: "" };
      return clarify(true);
    } catch {
      return clarify(true);
    }
  }
}

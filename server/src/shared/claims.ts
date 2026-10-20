import type { Jev } from "../providers/jev.js";
import {
  parseCheck,
  runCheck,
  sameFunction,
  type Check,
  type CheckResult,
} from "./verify.js";
// Results the model claims (limits, derivatives, integrals…) and how the program
// checks them. Prompt wording is original to this project.
export const CHECK_FORMAT = `核对项格式（式子用 mathjs 语法：exp(x)、log(x) 表示 ln x、sqrt、abs、asin、atan、pi、e，乘号写 *，幂写 ^。无穷：x→+∞ 写 +inf，x→−∞ 写 -inf，不带符号的 x→∞ 写 inf（两侧都要满足）；极限是无穷时同样区分 +inf、-inf 和不分正负的 inf；极限不存在写 none）。每个核对项是下列之一：
  {"kind":"limit","expr":"(exp(3*x)-1-3*x)/x^2","at":"0","answer":"9/2"}（单侧极限加 "side":"+" 或 "-"）
  {"kind":"derivative","expr":"x^2*sin(x)","answer":"2*x*sin(x)+x^2*cos(x)"}（二阶加 "order":2）
  {"kind":"antiderivative","expr":"x*exp(x)","answer":"(x-1)*exp(x)"}
  {"kind":"definite","expr":"x*sin(x)","from":"0","to":"pi/2","answer":"1"}
  {"kind":"roots","expr":"x^3-3*x+1","roots":["-1.8794","0.3473","1.5321"],"interval":["-2","2"]}
  {"kind":"extremum","expr":"x^3-3*x+1","at":"-1","type":"max","value":"3"}
  {"kind":"monotonic","expr":"x^3-3*x+1","from":"-1","to":"1","direction":"dec"}
  {"kind":"value","expr":"2^10","answer":"1024"}
expr 必须是题目原本的式子（求导、积分、求极限的对象本身），不能换成化简后或中间步骤的式子；变量不是 x 时加 "var"。`;
export type ClaimItem = Pick<
  CheckResult,
  "status" | "computed" | "detail" | "tex"
>;
// pass: every check agreed; partial: some agreed, none disagreed; conflict: the
// program disagreed; unverified: nothing could be confirmed.
export type Claims = {
  state: "pass" | "partial" | "conflict" | "unverified";
  items: ClaimItem[];
  // What the program found, for asking the model to look again.
  findings: string[];
};
const MISMATCH = "核对的式子和题目可能对不上，这一项不算已核对";
// What a problem's formulas are about: each side of each formula, without its
// \lim_{…}, \int and bounds, or dx.
function objects(problem: string): string[] {
  const out: string[] = [];
  for (const m of problem.matchAll(/\$\$?([^$]+)\$\$?/g))
    for (const part of m[1]!.split("=")) {
      const s = part
        .trim()
        .replace(/^\\lim\s*_\s*\{[^{}]*\}/, "")
        .replace(
          /^\\int\s*(?:_\s*(?:\{[^{}]*\}|[^\s{])\s*\^\s*(?:\{(?:[^{}]|\{[^{}]*\})*\}|[^\s{]))?/,
          "",
        )
        .replace(/(?:\\[,;!])?\s*(?:\\mathrm\{d\}|d)\s*[a-z]\s*$/, "")
        .trim();
      if (s) out.push(s);
    }
  return out;
}
// A check of an expression the problem itself writes out needs no second opinion.
const written = (check: Check, shown: string[]) =>
  shown.some(
    (o) =>
      sameFunction(o, check.expr, ("var" in check && check.var) || "x") ===
      true,
  );
// Runs each claim through the program, then asks Jev whether what was checked is
// what the problem asks for, unless every check is of an expression the problem
// writes out. Doubt only ever turns "pass" into "unknown", never
// into "fail"; without a confirmed match nothing counts as checked.
export async function checkClaims(
  raw: unknown[],
  problem: string,
  jev: Jev,
  log?: (error: unknown, context: string) => void,
): Promise<Claims | null> {
  const checks = raw.map((c) => parseCheck(c)).filter((c) => c !== null);
  if (!checks.length) return null;
  const items: ClaimItem[] = checks.map((check) => {
    const r = runCheck(check);
    return {
      status: r.status,
      computed: r.computed,
      detail: r.detail,
      tex: r.tex,
    };
  });
  if (items.some((i) => i.status === "pass")) {
    const shown = objects(problem);
    let matches = checks.every(
      (c, i) => items[i]!.status !== "pass" || written(c, shown),
    );
    if (!matches && jev.configured && problem.trim())
      try {
        matches =
          (await jev.noul(
            {
              problem: problem.slice(0, 1500),
              checked: items.map((i) => i.tex).join("\n"),
            },
            "程序核对的这些式子，是否就是题目要求计算的对象本身（不是中间步骤、化简后的式子或别的题）？",
          )) >= 0.5;
      } catch (error) {
        log?.(error, "correspondence check failed");
      }
    if (!matches)
      for (const item of items)
        if (item.status === "pass") {
          item.status = "unknown";
          item.detail = MISMATCH;
        }
  }
  const fails = items.filter((i) => i.status === "fail");
  const passes = items.filter((i) => i.status === "pass");
  return {
    state: fails.length
      ? "conflict"
      : passes.length === items.length
        ? "pass"
        : passes.length
          ? "partial"
          : "unverified",
    items,
    findings: fails.map(
      (f) => `${f.detail}${f.computed ? `（程序结果：${f.computed}）` : ""}`,
    ),
  };
}
// One line per confirmed item, for showing how an answer was checked.
export const checkedText = (claims: Claims) =>
  claims.items
    .filter((i) => i.status === "pass")
    .map((i) => i.detail)
    .join("；");

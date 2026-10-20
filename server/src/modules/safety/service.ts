/*
 * 危机信号筛查：输入用户文字及场景，返回是否需要进入危机求助流程。
 * 先查本地词表，再按场景调用判断服务；本模块不写业务数据，展示和存储由调用方决定。
 * 返回 false 仅表示本次筛查未命中，不能解释为专业结论或对文字内容的安全保证。
 */
import type { Jev } from "../../providers/jev.js";
import { hasCrisisWords } from "./crisis-words.js";

export type SafetyScene = "study" | "life" | "mood";
export type SafetySource = "chat" | "note" | "import" | "backfill" | (string & {});

export interface SafetyContext {
  scene: SafetyScene;
  source: SafetySource;
}

export type NoulJudge = Pick<Jev, "noul">;

const JEV_TIMEOUT_MS = 2_000;
const JEV_THRESHOLD = 0.3;
const JEV_SOURCES = new Set<SafetySource>(["note", "import"]);
const JEV_INSTRUCTIONS =
  "判断这段文字是否表达了伤害自己或结束生命的想法。只返回 0 到 1 的肯定概率。";

function needsJev(context: SafetyContext): boolean {
  return context.scene === "life" || context.scene === "mood" || JEV_SOURCES.has(context.source);
}

function fallbackOnAbort(signals: AbortSignal[]): { promise: Promise<false>; dispose: () => void } {
  let resolveFallback: (() => void) | undefined;
  const listeners = new Map<AbortSignal, () => void>();
  const promise = new Promise<false>((resolve) => {
    resolveFallback = () => resolve(false);
  });

  for (const signal of signals) {
    if (signal.aborted) {
      resolveFallback?.();
      break;
    }
    const listener = () => resolveFallback?.();
    listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }

  return {
    promise,
    dispose: () => {
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    },
  };
}

/**
 * Public, side-effect-free crisis screening. Callers decide how to present a true result.
 * The injected Jev client keeps this module usable in foreground and background workflows.
 */
export class CrisisSafetyService {
  constructor(
    private readonly jev?: NoulJudge,
    private readonly timeoutMs = JEV_TIMEOUT_MS,
  ) {}

  async check(text: string, context: SafetyContext, signal?: AbortSignal): Promise<boolean> {
    if (hasCrisisWords(text)) return true;
    if (signal?.aborted) return false;
    if (!text.trim() || !this.jev || !needsJev(context)) return false;

    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const fallback = fallbackOnAbort(signal ? [signal, deadline] : [deadline]);
    const judged = this.jev
      .noul({ text }, JEV_INSTRUCTIONS, combined)
      .then((score) => score >= JEV_THRESHOLD, () => false);

    try {
      return await Promise.race([judged, fallback.promise]);
    } finally {
      fallback.dispose();
    }
  }
}

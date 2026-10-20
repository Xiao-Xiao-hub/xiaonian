// Shared by the study API tests and the page tests: an app with fake AI services.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import type { SqliteStore } from "../server/src/shared/store.js";

export type Replies = Record<string, unknown>;
export const REPLIES: Replies = {
  card_tidy: {
    title: "先理清安排", summary: "想先理清安排",
    slots: [{ key: "claim", text: "先列出要做的事" }], open: [],
    followup: { q: "先从哪里开始", options: ["列出任务", "排好时间"] }, tags: ["安排"],
  },
  // Synthetic fixture only; never used as a product fallback.
  note_organize: {
    title: "复习前先理清",
    items: [
      { group: "clear", text: "想复习高数", sourceIds: ["original"] },
      { group: "decide", text: "先决定从哪里开始", sourceIds: ["original"] },
      { group: "verify", text: "考试范围需要再确认", sourceIds: ["original"] },
    ],
    question: {
      prompt: "你想先理清哪一部分？",
      options: ["先列出卡住的内容", "先确认考试范围"],
    },
    nextStep: { text: "先选出最想理清的部分", pointId: null },
  },
  explain: {
    summary: "水循环靠蒸发和降水推动",
    points: [
      {
        title: "蒸发",
        explanation: "太阳加热让水变成水蒸气",
        citations: [1],
        extension: "",
      },
    ],
    limits: "",
    insufficient: false,
  },
  ask: {
    answer: "降水把水送回地面",
    citations: [2],
    extension: "",
    insufficient: false,
  },
  quiz: {
    questions: [
      {
        type: "choice",
        stem: "推动蒸发的主要能量是？",
        options: ["风", "太阳辐射", "月球引力"],
        answer: 1,
        explanation: "第一段说太阳加热水面",
        citations: [1],
      },
      {
        type: "short",
        stem: "降水有什么作用？",
        answer: "把水送回地面",
        explanation: "见第二段",
        citations: [2],
      },
    ],
  },
  hints: {
    complete: true,
    missing: "",
    levels: ["打八折就是乘以 0.8", "列式 60×0.8", "60×0.8=48，所以是 48 元"],
    finalAnswer: "48 元",
    expression: "60*0.8",
    note: "",
  },
  variant: {
    numeric: true,
    template: "一件衣服原价 {a} 元，打 {d} 折后是多少元？",
    vars: {
      a: { min: 20, max: 200, step: 10 },
      d: { min: 5, max: 9, step: 1 },
    },
    answer: "a*d/10",
    constraints: [],
    unit: "元",
    original: { a: 60, d: 8 },
  },
  feedback: { comment: "你可能把八折当成了减 10 元，再看看折扣的意思。" },
};
export const NOTE =
  "太阳加热水面，水蒸发成水蒸气。\n水蒸气遇冷凝结，形成降水回到地面。";
export const PROBLEM = "一件衣服原价 60 元，打八折后是多少元？";

// Routes AI calls by host: the chat model answers by prompt type, Jev by question type.
export function fakeServices(overrides: Replies = {}) {
  const replies = { ...REPLIES, ...overrides };
  const llm: { kind: string; prompt: string }[] = [];
  const jev: { type: string; state: Record<string, string> }[] = [];
  const judge = { noul: 0.9, cause: "calc" };
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      const q = body.questions.q;
      jev.push({ type: q.type, state: body.state });
      const answer =
        q.type === "noul"
          ? { noul: judge.noul }
          : q.criteria?.["application-taylor-limit"]
            ? { choice: "none", confidence: 1, probabilities: { none: 1 } }
            : {
                choice: judge.cause,
                confidence: 0.8,
                probabilities: { [judge.cause]: 0.8 },
              };
      return new Response(JSON.stringify({ answers: { q: answer } }));
    }
    const system: string = body.messages[0].content;
    const kind = system.includes("[CARD_TIDY]") ? "card_tidy" : system.includes("[NOTE_ORGANIZE]")
      ? "note_organize"
      : system.includes("出题老师")
        ? "quiz"
        : system.includes("同类再练")
          ? "variant"
          : system.includes("写一段反馈")
            ? "feedback"
            : system.includes("解题教练")
              ? "hints"
              : system.includes("追问")
                ? "ask"
                : "explain";
    llm.push({ kind, prompt: body.messages.at(-1).content });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(replies[kind]) } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    );
  }) as typeof fetch;
  return { fetcher, llm, jev, judge };
}
export function makeApp(
  services: ReturnType<typeof fakeServices>,
  env: Record<string, string> = {},
  now?: () => Date,
  // A store the test seeds directly; an in-memory one otherwise.
  store?: SqliteStore,
  options: { legacyNotesReadOnly?: boolean } = {},
) {
  return buildApp({
    ...options,
    now,
    store,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-")),
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-formula-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "test-llm",
      JEV_API_KEY: "test-jev",
      ...env,
    }),
    fetcher: services.fetcher,
  });
}
export type App = ReturnType<typeof makeApp>;

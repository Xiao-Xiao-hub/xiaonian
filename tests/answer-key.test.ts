// The answer key and practice problems for calculus: only what the program
// confirmed is labelled as checked.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mathEquivalent,
  missingConstant,
  oppositeSign,
  referenceFor,
} from "../server/src/modules/study/service.js";
import { fakeServices, makeApp, REPLIES, type App } from "./fixtures.js";

const LIMIT = String.raw`求极限 $\lim_{x\to 0}\frac{e^{3x}-1-3x}{x^{2}}$。`;
const hints = (answer: string, checks = true) => ({
  complete: true,
  missing: "",
  levels: ["这是 0/0 型未定式", "把 $e^{3x}$ 展开到二阶", `极限为 ${answer}`],
  finalAnswer: answer,
  // The old way to look checked: an "expression" that is just the answer.
  expression: answer === "1.5" ? "3/2" : "",
  note: "",
  checks: checks
    ? [{ kind: "limit", expr: "(exp(3*x)-1-3*x)/x^2", at: "0", answer }]
    : [],
});
const similar = (answer: string) => ({
  question: String.raw`求极限 $\lim_{x\to 0}\frac{e^{2x}-1-2x}{x^{2}}$。`,
  answer,
  solution: `泰勒展开。\n\n**答案**：${answer}`,
  checks: [{ kind: "limit", expr: "(exp(2*x)-1-2*x)/x^2", at: "0", answer }],
});
// fakeServices answers by prompt type; this queues replies for the hints and
// similar-problem prompts and records what was asked.
function scripted(queue: { hints?: object[]; similar?: object[] }) {
  const services = fakeServices();
  const base = services.fetcher;
  const asked: { kind: string; body: Record<string, unknown> }[] = [];
  services.fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith("https://api.typesafe.ai/")) {
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages[0].content);
      const kind = system.includes("同类题")
        ? "similar"
        : system.includes("解题教练") && !system.includes("写一段反馈")
          ? "hints"
          : "";
      const next = kind ? queue[kind as "hints" | "similar"]?.shift() : undefined;
      if (kind) asked.push({ kind, body });
      if (next)
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(next) } }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
        );
    }
    return base(url, init);
  }) as typeof fetch;
  return { services, asked };
}
async function setup(app: App) {
  const { token } = (
    await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: {} })
  ).json().data;
  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url,
      payload: payload as string,
      headers: { authorization: `Bearer ${token}` },
    });
  const settle = async (jobId: string) => {
    for (let i = 0; i < 400; i++) {
      const job = (await call("GET", `/v1/jobs/${jobId}`)).json().data;
      if (!["queued", "running"].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("job did not finish");
  };
  const { id } = (
    await call("POST", "/v1/materials", { kind: "problem", text: LIMIT })
  ).json().data;
  await call("PUT", `/v1/materials/${id}`, { expectedVersion: 1, confirm: true });
  const run = async (path: string) => {
    const res = await call("POST", `/v1/materials/${id}/${path}`, {});
    assert.equal(res.statusCode, 200, res.body);
    const { job } = res.json().data;
    return job ? settle(job.id) : null;
  };
  const key = async () => {
    const study = (await call("GET", `/v1/materials/${id}/study`)).json().data;
    const opened = await call("POST", `/v1/artifacts/${study.hints.id}/reveal`, { level: 3 });
    return opened.json().data.data.answer;
  };
  const attempt = async (answer: string) => {
    const { attempt, job } = (
      await call("POST", `/v1/materials/${id}/attempts`, { answer })
    ).json().data;
    await settle(job.id);
    return (await call("GET", `/v1/attempts/${attempt.id}`)).json().data.result;
  };
  return { call, run, key, attempt, id };
}

test("an integral without its constant is told apart from a wrong one", () => {
  assert.equal(missingConstant("log(abs(x)) + C", "ln|x|"), true);
  assert.equal(missingConstant("log(abs(x)) + C", "ln|x|+C"), false);
  assert.equal(missingConstant("log(abs(x)) + C", "ln x"), false);
  assert.equal(missingConstant("9/2", "4.5"), false);
});

test("a result right but for its sign is told apart from a wrong one", () => {
  assert.equal(oppositeSign(String.raw`-\dfrac{9}{2}`, "4.5"), true);
  assert.equal(oppositeSign("2*x*sin(x)+x^2*cos(x)", String.raw`-2x\sin x-x^2\cos x`), true);
  assert.equal(oppositeSign("-9/2", "9/4"), false);
  // Zero has no sign; integrals go by their constant instead.
  assert.equal(oppositeSign("0", "0"), false);
  assert.equal(oppositeSign("(x-1)e^x + C", "-(x-1)e^x+C"), false);
});

test("a bare number no longer makes a calculus answer look checked", () => {
  const old = { ...hints("1.5", false) } as Parameters<typeof referenceFor>[0];
  // Before: "3/2" = 1.5 counted as a check, so the wrong 1.5 was labelled checked.
  assert.equal(referenceFor(old, null, null, LIMIT)!.source, "ai");
  // Arithmetic word problems keep their expression check.
  const word = REPLIES.hints as Parameters<typeof referenceFor>[0];
  assert.equal(referenceFor(word, null, null, "一件衣服原价 60 元，打八折后是多少元？")!.source, "rule");
});

test("the program confirms a right key and labels how it checked", async () => {
  const { services } = scripted({ hints: [hints("9/2")] });
  const app = makeApp(services);
  const { run, key, attempt } = await setup(app);
  await run("hints");
  const answer = await key();
  assert.equal(answer.source, "rule");
  assert.match(answer.check, /与答案一致/);
  // Different notations of the same number are judged by the program.
  const result = await attempt(String.raw`\frac{9}{2}`);
  assert.equal(result.verdict, "correct");
  assert.equal(result.judge, "rule");
  await app.close();
});

test("a wrong key gets one reasoning retry and is corrected", async () => {
  const { services, asked } = scripted({ hints: [hints("1.5"), hints("9/2")] });
  const app = makeApp(services);
  const { run, key } = await setup(app);
  await run("hints");
  const answer = await key();
  assert.equal(answer.value, "9/2");
  assert.equal(answer.source, "rule");
  const calls = asked.filter((a) => a.kind === "hints");
  assert.equal(calls.length, 2);
  // v2 generation defaults to low; the independent recheck stays high.
  assert.equal(calls[0]!.body.reasoning_effort, "low");
  assert.equal(calls[1]!.body.reasoning_effort, "high");
  const last = (calls[1]!.body.messages as { content: string }[]).at(-1)!.content;
  assert.match(last, /程序独立计算/);
  await app.close();
});

test("a key the program still disputes never decides right or wrong", async () => {
  const { services } = scripted({ hints: [hints("1.5"), hints("1.5")] });
  const app = makeApp(services);
  const { run, key, attempt } = await setup(app);
  await run("hints");
  const answer = await key();
  assert.equal(answer.source, "ai");
  assert.equal(answer.disputed, true);
  assert.match(answer.note, /不一致/);
  // The learner's right answer is not marked wrong against a disputed key…
  const right = await attempt("9/2");
  assert.equal(right.verdict, "unsure");
  assert.match(right.comment, /没有通过程序核对/);
  // …and a wrong answer matching the disputed key is not marked right.
  const wrong = await attempt("1.5");
  assert.equal(wrong.verdict, "unsure");
  await app.close();
});

// Right checks (9/2) under a wrong answer: the model can write both.
const says = (shown: string) => ({
  ...hints("9/2"),
  finalAnswer: shown,
  levels: ["这是 0/0 型未定式", "把 $e^{3x}$ 展开到二阶", `极限为 ${shown}`],
});

test("an answer that says other than its checks gets the retry, then judges by the checked key", async () => {
  const { services, asked } = scripted({ hints: [says("1.5"), hints("9/2")] });
  const app = makeApp(services);
  const { run, key, attempt } = await setup(app);
  await run("hints");
  assert.equal(asked.filter((a) => a.kind === "hints").length, 2);
  const answer = await key();
  assert.equal(answer.value, "9/2");
  assert.equal(answer.source, "rule");
  assert.equal(answer.key, "9/2");
  const wrong = await attempt("1.5");
  assert.equal(wrong.verdict, "incorrect");
  assert.equal(wrong.judge, "rule");
  const right = await attempt("4.5");
  assert.equal(right.verdict, "correct");
  await app.close();
});

test("an answer that keeps disagreeing with its checks is disputed", async () => {
  const { services } = scripted({ hints: [says("1.5"), says("1.5")] });
  const app = makeApp(services);
  const { run, key, attempt } = await setup(app);
  await run("hints");
  const answer = await key();
  assert.equal(answer.disputed, true);
  assert.equal((await attempt("1.5")).verdict, "unsure");
  await app.close();
});

test("calculus practice problems are handed out only when the program confirms them", async () => {
  const { services, asked } = scripted({
    hints: [hints("9/2")],
    similar: [similar("1"), similar("1"), similar("1"), similar("2")],
  });
  const app = makeApp(services);
  const { call, run, id } = await setup(app);
  await run("hints");
  const refused = await run("variant");
  assert.equal(refused.status, "failed");
  assert.equal(refused.error.code, "VARIANT_UNRELIABLE");
  assert.equal(asked.filter((a) => a.kind === "similar").length, 2);
  const made = await run("variant");
  assert.equal(made.status, "succeeded", JSON.stringify(made));
  const study = (await call("GET", `/v1/materials/${id}/study`)).json().data;
  assert.equal(study.variant.data.answer, undefined, "hidden until asked");
  const opened = (
    await call("POST", `/v1/artifacts/${study.variant.id}/reveal`, { level: 1 })
  ).json().data.data;
  assert.equal(opened.answer, "2");
  assert.equal(opened.source, "rule");
  assert.match(opened.solution, /泰勒/);
  await app.close();
});

test("maths answers are compared by the program where it can", () => {
  assert.equal(mathEquivalent(String.raw`\frac{9}{2}`, "4.5"), true);
  assert.equal(mathEquivalent("e^2", String.raw`e^{2}`), true);
  assert.equal(mathEquivalent("2x*sin(x)+x^2*cos(x)", "x(2sin x + x cos x)"), true);
  // Indefinite integrals: equal up to a constant, and the constant must be written.
  assert.equal(mathEquivalent("ln|x| + C", "ln|x|+C"), true);
  assert.equal(mathEquivalent("(x-1)e^x + C", "xe^x - e^x + C"), true);
  assert.equal(mathEquivalent("ln|x| + C", "ln|x|"), false);
  assert.equal(mathEquivalent("ln|x| + C", "ln x + C"), false);
  // Anything else is left to Jev.
  assert.equal(mathEquivalent("e^2", "7.389"), null);
  assert.equal(mathEquivalent("48 元", "48"), null);
  assert.equal(mathEquivalent("不存在", "极限不存在"), null);
});

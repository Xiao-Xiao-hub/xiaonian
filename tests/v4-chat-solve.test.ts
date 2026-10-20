// 聊一聊 and the 解题 page list their own conversations, and AI-made
// problems are single choice: four options checked by the program, a wrong
// pick shows the short steps.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeServices, makeApp } from "./fixtures.js";

const LIMIT = String.raw`求极限 $\lim_{x\to 0}\frac{e^{2x}-1-2x}{x^{2}}$。`;
const made = (options: string[], correct: number) => ({
  question: LIMIT,
  answer: "2",
  options,
  correct,
  steps: ["把 $e^{2x}$ 展开到二阶", "约去 $x^2$，极限是 2"],
  solution: "泰勒展开。\n\n**答案**：2",
  checks: [{ kind: "limit", expr: "(exp(2*x)-1-2*x)/x^2", at: "0", answer: "2" }],
});
function scripted(queue: object[]) {
  const services = fakeServices();
  const base = services.fetcher;
  const asked: string[] = [];
  services.fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith("https://api.typesafe.ai/")) {
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages[0].content);
      if (system.includes("专项练") || system.includes("同类题")) {
        asked.push(system);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(queue.shift()) } }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
        );
      }
    }
    return base(url, init);
  }) as typeof fetch;
  return { services, asked };
}
async function login(app: ReturnType<typeof makeApp>) {
  const { token } = (
    await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: {} })
  ).json().data;
  return (method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url,
      payload: payload as string,
      headers: { authorization: `Bearer ${token}` },
    });
}

test("threads: kind=chat and kind=solve split the list; without kind it is as before", async () => {
  const { services } = scripted([made(["$2$", "$1$", "$4$", "$-2$"], 0)]);
  const app = makeApp(services);
  const call = await login(app);
  const chat = (await call("POST", "/v1/chat/threads", { text: "随便聊聊", tone: "light" })).json().data.thread;
  const typed = (
    await call("POST", "/v1/chat/threads", { text: "讲一遍", mode: "teach", origin: "solve", tone: "light" })
  ).json().data.thread;
  const practice = (await call("POST", "/v1/chat/practice", { chapter: "limit", tone: "light" })).json().data;
  assert.ok(practice.thread, JSON.stringify(practice));
  const ids = async (query: string) =>
    (await call("GET", `/v1/chat/threads${query}`)).json().data.threads.map((t: { id: string }) => t.id).sort();
  const all = await ids("");
  assert.deepEqual(all, [chat.id, typed.id, practice.thread.id].sort());
  assert.deepEqual(await ids("?kind=chat"), [chat.id]);
  assert.deepEqual(await ids("?kind=solve"), [typed.id, practice.thread.id].sort());
  // An unknown kind is refused; an unknown extra query key is ignored as before.
  assert.equal((await call("GET", "/v1/chat/threads?kind=other")).statusCode, 400);
  assert.deepEqual(await ids("?x=1"), all);
  // Old clients send no origin: the body schema still takes them.
  assert.equal((await call("POST", "/v1/chat/threads", { origin: "elsewhere", tone: "light" })).statusCode, 400);
  await app.close();
});

test("practice is single choice: options always, the right one and the steps only after a pick", async () => {
  const { services, asked } = scripted([made(["$4$", "$1$", "$2$", "$-2$"], 2)]);
  const app = makeApp(services);
  const call = await login(app);
  const out = (await call("POST", "/v1/chat/practice", { chapter: "limit", tone: "light" })).json().data;
  assert.match(asked[0]!, /options 给 4 个选项/);
  const s = out.message.similar;
  assert.deepEqual(s.options.map((o: { id: string }) => o.id), ["A", "B", "C", "D"]);
  assert.ok(s.options.every((o: { blocks: unknown[] }) => o.blocks.length));
  assert.equal(s.correct, null, "which option is right stays on the server");
  assert.equal(s.steps, null);
  assert.equal(s.answer, null);
  const pick = (choice: number, clientId: string) =>
    call("POST", `/v1/chat/messages/${out.message.id}/answer`, { choice, clientId, tone: "light" });
  const wrong = (await pick(0, "pick-wrong-1")).json().data;
  assert.equal(wrong.judge.attempt.result.verdict, "incorrect");
  assert.equal(wrong.judge.attempt.result.judge, "choice");
  assert.equal(wrong.judge.choice, 0);
  assert.equal(wrong.question.kind, "answer");
  assert.match(JSON.stringify(wrong.question.blocks), /4/);
  const steps = JSON.stringify(wrong.judge.steps);
  assert.match(steps, /"n":"2\."/, steps);
  assert.match(steps, /约去/);
  // After the steps the problem counts as seen: the key shows, and so does the right option.
  const after = (await call("GET", `/v1/chat/messages/${out.message.id}?tone=light`)).json().data;
  assert.equal(after.similar.correct, "C");
  assert.ok(after.similar.steps.length);
  const right = (await pick(2, "pick-right-1")).json().data;
  assert.equal(right.judge.attempt.result.verdict, "correct");
  assert.equal(right.judge.steps, null, "a right pick needs no steps");
  // No such option, and a typed answer still works for older clients.
  assert.equal((await pick(5, "pick-bad-1")).statusCode, 400);
  const typed = await call("POST", `/v1/chat/messages/${out.message.id}/answer`, {
    answer: "2",
    clientId: "typed-old-1",
    tone: "light",
  });
  assert.equal(typed.json().data.judge.attempt.result.verdict, "correct");
  assert.equal((await call("POST", `/v1/chat/messages/${out.message.id}/answer`, { clientId: "empty-1", tone: "light" })).statusCode, 400);
  await app.close();
});

test("a problem whose options do not check out is made again", async () => {
  // A second option equal to the answer, then the marked option wrong, then a good one.
  const { services, asked } = scripted([
    made(["$2$", String.raw`$\frac{4}{2}$`, "$4$", "$-2$"], 0),
    made(["$2$", "$1$", "$4$", "$-2$"], 1),
    made(["$1$", "$2$", "$4$", "$-2$"], 1),
  ]);
  const app = makeApp(services);
  const call = await login(app);
  const res = await call("POST", "/v1/chat/practice", { chapter: "limit", tone: "light" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(asked.length, 3);
  const message = res.json().data.message;
  const right = (
    await call("POST", `/v1/chat/messages/${message.id}/answer`, { choice: 1, clientId: "pick-1-ok", tone: "light" })
  ).json().data;
  assert.equal(right.judge.attempt.result.verdict, "correct");
  await app.close();
});

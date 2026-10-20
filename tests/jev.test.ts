import test from "node:test";
import assert from "node:assert/strict";
import {
  Jev,
  JevError,
  type JevErrorCode,
} from "../server/src/providers/jev.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(
  responses: Array<{ status: number; body: unknown } | "hang">,
) {
  const calls: Call[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next === undefined) throw new Error("no fake response");
    if (next === "hang") {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    }
    const text =
      typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status });
  }) as typeof fetch;
  return { fetcher, calls };
}

function fakeSleep() {
  const waits: number[] = [];
  return { sleep: async (ms: number) => void waits.push(ms), waits };
}

const make = (
  fetcher: typeof fetch,
  sleep = fakeSleep().sleep,
  timeoutMs = 1000,
) => new Jev({ apiKey: "test-key", timeoutMs }, fetcher, sleep);

async function rejectsWith(p: Promise<unknown>, code: JevErrorCode) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof JevError);
    assert.equal(err.code, code);
    return true;
  });
}

const noulOk = { answers: { q: { type: "noul", noul: 0.12 } } };
const choiceOk = {
  answers: {
    q: {
      type: "choice",
      choice: "billing",
      confidence: 0.82,
      probabilities: { ops: 0.1, billing: 0.85, none: 0.05 },
    },
  },
};
const criteria = { ops: "servers", billing: "payments", none: "fits nothing" };

test("request pins the model and sends state, questions and bearer auth", async () => {
  const { fetcher, calls } = fakeFetch([{ status: 200, body: noulOk }]);
  await make(fetcher).noul({ student: "12 元" }, "相等吗？");
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(call.init.method, "POST");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    state: { student: "12 元" },
    model: "jev-1.13.0",
    questions: { q: { type: "noul", instructions: "相等吗？" } },
  });
});

test("noul returns the probability", async () => {
  const { fetcher } = fakeFetch([{ status: 200, body: noulOk }]);
  assert.equal(await make(fetcher).noul("x", "?"), 0.12);
});

test("choice returns label, confidence and probabilities", async () => {
  const { fetcher } = fakeFetch([{ status: 200, body: choiceOk }]);
  assert.deepEqual(await make(fetcher).choice("x", "Which team?", criteria), {
    choice: "billing",
    confidence: 0.82,
    probabilities: { ops: 0.1, billing: 0.85, none: 0.05 },
  });
});

test("ask parses score answers and accepts answers without a type field", async () => {
  const { fetcher } = fakeFetch([
    {
      status: 200,
      body: {
        answers: {
          urgent: { noul: 0.9 },
          risk: {
            type: "score",
            score: 1.6,
            confidence: 0.71,
            legend: {},
            probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
          },
        },
      },
    },
  ]);
  const out = await make(fetcher).ask("x", {
    urgent: { type: "noul", instructions: "urgent?" },
    risk: {
      type: "score",
      instructions: "risky?",
      criteria: ["low", "medium", "high"],
    },
  });
  assert.equal(out.urgent.noul, 0.9);
  assert.deepEqual(out.risk, {
    score: 1.6,
    confidence: 0.71,
    probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
  });
});

test("429 then 200 succeeds after one backoff sleep", async () => {
  const { fetcher, calls } = fakeFetch([
    { status: 429, body: "slow down" },
    { status: 200, body: noulOk },
  ]);
  const { sleep, waits } = fakeSleep();
  assert.equal(await make(fetcher, sleep).noul("x", "?"), 0.12);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [500]);
});

test("persistent 429/529 becomes JEV_BUSY after two retries", async () => {
  const { fetcher, calls } = fakeFetch([
    { status: 529, body: "" },
    { status: 429, body: "" },
  ]);
  const { sleep, waits } = fakeSleep();
  await rejectsWith(make(fetcher, sleep).noul("x", "?"), "JEV_BUSY");
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [500, 1500]);
});

test("401 and 403 become JEV_AUTH without retry", async () => {
  for (const status of [401, 403]) {
    const { fetcher, calls } = fakeFetch([{ status, body: "nope" }]);
    await rejectsWith(make(fetcher).noul("x", "?"), "JEV_AUTH");
    assert.equal(calls.length, 1);
  }
});

test("500 and network failures become JEV_UNAVAILABLE", async () => {
  const { fetcher } = fakeFetch([{ status: 503, body: "down" }]);
  await rejectsWith(make(fetcher).noul("x", "?"), "JEV_UNAVAILABLE");
  const broken = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await rejectsWith(make(broken).noul("x", "?"), "JEV_UNAVAILABLE");
});

test("timeout becomes JEV_TIMEOUT with unknown billing", async () => {
  const { fetcher } = fakeFetch(["hang"]);
  await assert.rejects(
    make(fetcher, undefined, 5).noul("x", "?"),
    (err: unknown) => {
      assert.ok(err instanceof JevError);
      assert.equal(err.code, "JEV_TIMEOUT");
      assert.equal(err.billing, "unknown");
      assert.match(err.message, /超时/);
      return true;
    },
  );
});

test("caller abort propagates as an abort, not a timeout", async () => {
  const { fetcher } = fakeFetch(["hang"]);
  const ctrl = new AbortController();
  const p = make(fetcher, undefined, 10_000).noul("x", "?", ctrl.signal);
  ctrl.abort();
  await assert.rejects(p, (err: unknown) => {
    assert.ok(!(err instanceof JevError));
    assert.equal((err as Error).name, "AbortError");
    return true;
  });
});

test("missing or malformed answers become JEV_BAD_OUTPUT", async () => {
  const bodies: unknown[] = [
    "not json",
    {},
    { answers: {} },
    { answers: { q: { noul: "high" } } },
    { answers: { q: { noul: 1.5 } } },
    {
      answers: {
        q: { type: "choice", choice: "ops", confidence: 1, probabilities: {} },
      },
    },
  ];
  for (const body of bodies) {
    const { fetcher } = fakeFetch([{ status: 200, body }]);
    await rejectsWith(make(fetcher).noul("x", "?"), "JEV_BAD_OUTPUT");
  }
});

test("choice outside the given criteria becomes JEV_BAD_OUTPUT", async () => {
  const body = structuredClone(choiceOk);
  body.answers.q.choice = "sales";
  const { fetcher } = fakeFetch([{ status: 200, body }]);
  await rejectsWith(
    make(fetcher).choice("x", "Which team?", criteria),
    "JEV_BAD_OUTPUT",
  );
});

test("no api key fails with JEV_NOT_CONFIGURED without calling fetch", async () => {
  const { fetcher, calls } = fakeFetch([{ status: 200, body: noulOk }]);
  const jev = new Jev({ timeoutMs: 1000 }, fetcher);
  assert.equal(jev.configured, false);
  await rejectsWith(jev.noul("x", "?"), "JEV_NOT_CONFIGURED");
  assert.equal(calls.length, 0);
  assert.equal(make(fetcher).configured, true);
});

test("baseUrl points requests at a relay", async () => {
  const { fetcher, calls } = fakeFetch([{ status: 200, body: noulOk }]);
  const jev = new Jev(
    { apiKey: "test-key", timeoutMs: 1000, baseUrl: "https://relay.example/typesafe/" },
    fetcher,
    fakeSleep().sleep,
  );
  await jev.noul("x", "?");
  assert.equal(calls[0]!.url, "https://relay.example/typesafe/v1/systemone");
});

test("fallback answers when Jev fails and the original error wins if it fails too", async () => {
  const asked: unknown[] = [];
  const ok = new Jev(
    {
      apiKey: "test-key",
      timeoutMs: 1000,
      fallback: async (request) => {
        asked.push(request.questions);
        return noulOk;
      },
    },
    fakeFetch([{ status: 503, body: "down" }]).fetcher,
    fakeSleep().sleep,
  );
  assert.equal(await ok.noul("x", "?"), 0.12);
  assert.equal(asked.length, 1);

  const bad = new Jev(
    {
      apiKey: "test-key",
      timeoutMs: 1000,
      fallback: async () => {
        throw new Error("also down");
      },
    },
    fakeFetch([{ status: 403, body: "nope" }]).fetcher,
    fakeSleep().sleep,
  );
  await rejectsWith(bad.noul("x", "?"), "JEV_AUTH");
});

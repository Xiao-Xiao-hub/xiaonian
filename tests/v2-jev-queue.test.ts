import assert from "node:assert/strict";
import test from "node:test";
import { Jev } from "../server/src/providers/jev.js";

function deferred<T>() {
  let resolve: (value: T) => void;
  let reject: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

function queuingJev(order: string[]) {
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { state: string };
    order.push(body.state);
    return new Response(JSON.stringify({ answers: { q: { noul: 0.5 } } }), { status: 200 });
  }) as typeof fetch;
  return new Jev({ apiKey: "test-key", timeoutMs: 2_000 }, fetcher);
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("foreground waits for the current background call and takes priority over queued work", async () => {
  const order: string[] = [];
  const jev = queuingJev(order);
  const gate = deferred<void>();

  const first = jev.background(async (judge) => {
    await gate.promise;
    return judge.noul("background-first", "?");
  });
  await flush();
  const second = jev.background((judge) => judge.noul("background-second", "?"));
  const foreground = jev.noul("foreground", "?");

  gate.resolve();
  await Promise.all([first, foreground, second]);
  assert.deepEqual(order, ["background-first", "foreground", "background-second"]);
});

test("a foreground request reserves priority when it and background work arrive in the same tick", async () => {
  const order: string[] = [];
  const jev = queuingJev(order);

  const foreground = jev.noul("foreground", "?");
  const background = jev.background((judge) => judge.noul("background", "?"));

  await Promise.all([foreground, background]);
  assert.deepEqual(order, ["foreground", "background"]);
});

test("a synchronously thrown background callback releases the next queued callback", async () => {
  const order: string[] = [];
  const jev = queuingJev(order);
  const failed = jev.background(() => {
    throw new Error("failed classification");
  });
  const next = jev.background((judge) => judge.noul("after-error", "?"));

  await assert.rejects(failed, /failed classification/);
  assert.equal(await next, 0.5);
  assert.deepEqual(order, ["after-error"]);
});

test("an already cancelled foreground request does not block queued background work", async () => {
  const order: string[] = [];
  const jev = queuingJev(order);
  const controller = new AbortController();
  controller.abort();

  const foreground = jev.noul("cancelled", "?", controller.signal);
  const background = jev.background((judge) => judge.noul("background", "?"));

  await assert.rejects(foreground, (err: unknown) => (err as Error).name === "AbortError");
  assert.equal(await background, 0.5);
  assert.deepEqual(order, ["background"]);
});

test("aborting queued background work removes it without blocking the active callback", async () => {
  const order: string[] = [];
  const jev = queuingJev(order);
  const gate = deferred<void>();
  const active = jev.background(async (judge) => {
    await gate.promise;
    return judge.noul("active", "?");
  });
  await flush();

  const controller = new AbortController();
  let ranCancelled = false;
  const cancelled = jev.background(async () => {
    ranCancelled = true;
    return 0;
  }, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, (err: unknown) => (err as Error).name === "AbortError");

  gate.resolve();
  assert.equal(await active, 0.5);
  assert.equal(ranCancelled, false);
  assert.deepEqual(order, ["active"]);
});

test("aborting the outer signal after a callback starts does not settle it before its judge", async () => {
  const order: string[] = [];
  const jev = queuingJev(order);
  const gate = deferred<void>();
  const controller = new AbortController();
  const active = jev.background(async (judge) => {
    await gate.promise;
    return judge.noul("active-after-abort", "?");
  }, controller.signal);
  await flush();

  controller.abort();
  let settled = false;
  void active.finally(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  gate.resolve();
  assert.equal(await active, 0.5);
  assert.deepEqual(order, ["active-after-abort"]);
});

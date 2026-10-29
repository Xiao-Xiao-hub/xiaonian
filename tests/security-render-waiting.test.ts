import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse, IncomingMessage } from "node:http";
import Fastify from "../server/node_modules/fastify/fastify.js";
import type { AuthService } from "../server/src/modules/auth/service.js";
import { FormulaRenderer } from "../server/src/modules/render/formula.js";
import { MarkdownRenderer } from "../server/src/modules/render/markdown.js";
import { registerRenderRoutes, RENDER_WAIT_MS, RENDER_WAITING_PER_USER } from "../server/src/modules/render/routes.js";

// inject() parses request bodies through streams before entering the handler.
const turn = async () => { for (let i = 0; i < 5; i++) await immediate(); };

for (const count of [10, 40]) {
  test(`one page's ${count} simultaneous single-formula requests all return images`, async t => {
    const formulas = new FormulaRenderer(mkdtempSync(join(tmpdir(), "security-render-waiting-")));
    const app = Fastify();
    t.after(() => app.close());
    registerRenderRoutes(app, { auth: { require: () => ({ id: "page-user" }) } as unknown as AuthService,
      formulas, markdown: new MarkdownRenderer(formulas) });
    const responses = await Promise.all(Array.from({ length: count }, (_, i) => app.inject({
      method: "POST", url: "/v1/render", payload: { text: `$x+${i}$` },
    }).then(response => response)));
    for (const response of responses) {
      assert.equal(response.statusCode, 200, response.body);
      const image = response.json().data.blocks[0].c[0];
      assert.equal(image.t, "math", response.body);
      const png = await app.inject(`/v1/formula/${image.id}.png`);
      assert.equal(png.statusCode, 200);
      assert.equal(png.headers["content-type"], "image/png");
      assert.equal(png.rawPayload.subarray(1, 4).toString(), "PNG");
    }
  });
}

// Hold actual route rendering, so admission, disconnects and FIFO are exercised
// deterministically without drawing thousands of images or opening sockets.
function heldPage() {
  const app = Fastify();
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const connections = new Map<string, { req: IncomingMessage; res: ServerResponse }>();
  let active = 0, maximum = 0;
  app.addHook("preHandler", async (req, reply) => {
    connections.set((req.body as { text: string }).text, { req: req.raw, res: reply.raw });
  });
  registerRenderRoutes(app, {
    auth: { require: (req: { headers: Record<string, string> }) => ({ id: req.headers["x-test-user"] ?? "A" }) } as unknown as AuthService,
    formulas: {} as FormulaRenderer,
    markdown: { render: async (text: string) => {
      started.push(text);
      active++; maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => release.set(text, resolve));
      active--;
      return [];
    } } as unknown as MarkdownRenderer,
  });
  const request = (text: string, user = "A") => app.inject({ method: "POST", url: "/v1/render",
    headers: { "x-test-user": user }, payload: { text } }).then(response => response);
  const begin = async () => {
    await app.ready();
    const active = [request("first"), request("second")];
    await turn();
    assert.deepEqual(started, ["first", "second"]);
    return active;
  };
  const drain = async (pending: Promise<unknown>[]) => {
    // Each released slot starts the next waiting route in a microtask.
    for (let i = 0; i <= RENDER_WAITING_PER_USER; i++) {
      for (const resolve of release.values()) resolve();
      await turn();
    }
    await Promise.all(pending);
  };
  return { app, started, release, connections, request, begin, drain, maximum: () => maximum };
}

test("a user's waiters enter FIFO with at most two active and another user bypasses that waiting list", async t => {
  const f = heldPage();
  t.after(() => f.app.close());
  const active = await f.begin();
  const waiting = ["third", "fourth", "fifth"].map(text => f.request(text));
  await turn();
  assert.deepEqual(f.started, ["first", "second"]);
  const other = f.request("other", "B");
  await turn();
  assert.deepEqual(f.started, ["first", "second", "other"]);
  f.release.get("other")!();
  assert.equal((await other).statusCode, 200);
  for (const [done, next] of [["first", "third"], ["second", "fourth"], ["third", "fifth"]]) {
    f.release.get(done!)!();
    await turn();
    assert.equal(f.started.at(-1), next);
  }
  await f.drain([...active, ...waiting]);
  assert.equal(f.maximum(), 3, "two for A plus B's independent active request");
  for (const response of await Promise.all([...active, ...waiting])) assert.equal(response.statusCode, 200);
});

for (const event of ["close", "error", "aborted"] as const) {
  test(`a waiting request's ${event} removes it immediately and never renders it`, async t => {
    const f = heldPage();
    t.after(() => f.app.close());
    const active = await f.begin();
    const pending = f.request("disconnected").catch(error => error as Error);
    const next = f.request("next");
    await turn();
    const connection = f.connections.get("disconnected")!;
    if (event === "aborted") connection.req.emit(event);
    else connection.res.emit(event, ...(event === "error" ? [new Error("synthetic disconnect")] : []));
    const result = await pending;
    if (event === "aborted") assert.equal((result as { statusCode: number }).statusCode, 499);
    else assert.match((result as Error).message, /response destroyed|synthetic disconnect/);
    f.release.get("first")!();
    await turn();
    assert.equal(f.started.at(-1), "next");
    await f.drain([...active, next]);
    assert.ok(!f.started.includes("disconnected"));
    assert.equal(connection.req.listenerCount("aborted"), 0);
  });
}

test("a disconnect before admission listeners are attached cannot enter or leak a waiting slot", async t => {
  const f = heldPage();
  f.app.addHook("preHandler", async (req, reply) => {
    if ((req.body as { text: string }).text === "already-closed") {
      Object.defineProperty(req.raw, "aborted", { value: true, configurable: true });
    }
  });
  t.after(() => f.app.close());
  const active = await f.begin();
  assert.equal((await f.request("already-closed")).statusCode, 499);
  assert.ok(!f.started.includes("already-closed"));
  await f.drain(active);
});

test("64 waiting requests are accepted, only the next is busy, and disconnect frees capacity immediately", async t => {
  const f = heldPage();
  t.after(() => f.app.close());
  const active = await f.begin();
  const waiting = Array.from({ length: RENDER_WAITING_PER_USER }, (_, i) => f.request(`waiting-${i}`).catch(error => error as Error));
  await turn();
  const full = await f.request("over-capacity");
  assert.equal(full.statusCode, 429);
  assert.equal(full.json().code, "RENDER_BUSY");
  f.connections.get("waiting-0")!.res.emit("close");
  assert.match((await waiting[0]! as Error).message, /response destroyed/);
  let replacementFinished = false;
  const replacement = f.request("replacement").then(response => { replacementFinished = true; return response; });
  await turn();
  assert.equal(replacementFinished, false, "the replacement waits instead of being rejected");
  await f.drain([...active, ...waiting, replacement]);
  assert.equal((await replacement).statusCode, 200);
  assert.equal(f.maximum(), 2);
  assert.ok(!f.started.includes("over-capacity") && !f.started.includes("waiting-0"));
});

test("a waiter gets 20 seconds before RENDER_BUSY and timeout releases its queue capacity", async t => {
  const f = heldPage();
  t.after(() => f.app.close());
  const active = await f.begin();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finished = false;
  const waiting = f.request("timeout").then(response => { finished = true; return response; });
  await turn();
  t.mock.timers.tick(RENDER_WAIT_MS - 1);
  await turn();
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  const response = await waiting;
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().code, "RENDER_BUSY");
  t.mock.timers.reset();
  await f.drain(active);
  assert.ok(!f.started.includes("timeout"));
  const next = f.request("after-timeout");
  await turn();
  f.release.get("after-timeout")!();
  assert.equal((await next).statusCode, 200);
});

test("waiting timers are unref'ed and cleared as soon as the request disconnects", async t => {
  const f = heldPage();
  t.after(() => f.app.close());
  const active = await f.begin();
  const timers: NodeJS.Timeout[] = [];
  const original = globalThis.setTimeout;
  const mock = t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
    const timer = original(...args);
    if (args[1] === RENDER_WAIT_MS) timers.push(timer);
    return timer;
  });
  const pending = f.request("unref");
  await turn();
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.hasRef(), false);
  const disconnected = assert.rejects(pending, /response destroyed/);
  f.connections.get("unref")!.res.emit("close");
  await disconnected;
  assert.equal((timers[0] as unknown as { _destroyed: boolean })._destroyed, true);
  mock.mock.restore();
  await f.drain(active);
});

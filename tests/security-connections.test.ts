import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { registerChatRoutes } from "../server/src/modules/chat/routes.js";
import { onResponseEnd } from "../server/src/shared/response-lifecycle.js";
import { registerUploadAdmission } from "../server/src/shared/upload-admission.js";

class Response extends EventEmitter {
  destroyed = false;
  closed = false;
  writableFinished = false;
  writableEnded = false;
  writableLength = 0;
  socket = { destroyed: false };
  status = 200;
  frames: string[] = [];
  writeHead(status: number) { this.status = status; return this; }
  write(frame: string) { this.frames.push(frame); return true; }
  end(frame: string) {
    this.frames.push(frame); this.writableEnded = true; this.writableFinished = true;
    this.emit("finish"); return this;
  }
  destroy() { this.destroyed = true; this.socket.destroyed = true; this.emit("close"); return this; }
}
const logger = { warn() {}, error() {} };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
function chatRoute(send: (...args: any[]) => Promise<void>) {
  let handler!: (req: any, reply: any) => Promise<void>;
  const app = new Proxy({}, { get: () => (url: string, _options: unknown, run: typeof handler) => {
    if (url === "/v1/chat/send") handler = run;
  } });
  registerChatRoutes(app as never, {
    auth: { require: (req: { userId: string }) => ({ id: req.userId }) } as never,
    chat: { send, finishSendBilling() {} } as never,
  });
  return (raw: Response, userId = "user") => handler({
    id: "request", userId, log: logger, body: { text: "hello", clientId: "request_123" },
  }, { raw, hijack() {} });
}

test("R03: responses already closed, destroyed or socket-disconnected never leak SSE admission", async () => {
  let started = 0;
  const run = chatRoute(async () => { started++; });
  for (let i = 0; i < 80; i++) {
    const raw = new Response();
    raw.emit("close"); // The event happened before the route installed listeners.
    if (i % 3 === 0) raw.destroyed = true;
    else if (i % 3 === 1) raw.socket.destroyed = true;
    else raw.closed = true;
    await run(raw);
    assert.equal(raw.listenerCount("close"), 0);
  }
  assert.equal(started, 0);
  const live = new Response();
  await run(live);
  assert.equal(started, 1);
  assert.ok(live.frames.some(frame => frame.includes("[DONE]")));
});

test("R16: disconnecting twice allows a reconnect while saved answers are still finishing", async () => {
  const held = deferred();
  let started = 0;
  const run = chatRoute(async () => { started++; await held.promise; });
  const raw = [new Response(), new Response(), new Response()];
  const first = run(raw[0]!);
  const second = run(raw[1]!);
  await assert.rejects(run(new Response()), { code: "STREAM_BUSY" });
  raw[0]!.destroy(); raw[1]!.destroy();
  const retry = run(raw[2]!);
  assert.equal(started, 3);
  held.resolve();
  await Promise.all([first, second, retry]);
  await run(new Response());
  assert.equal(started, 4);
});

test("R03/R16: generation errors and synchronous transport errors also release SSE admission", async () => {
  let fails = true, beforeEmit = false;
  const run = chatRoute(async (_id, _body, emit) => {
    if (beforeEmit) throw new Error("synthetic generation failure");
    emit({ e: "delta", text: "hello" });
    if (fails) throw new Error("synthetic failure");
  });
  for (let i = 0; i < 8; i++) {
    const raw = new Response();
    raw.write = () => { throw new Error("synthetic socket write failure"); };
    await assert.rejects(run(raw), /socket write failure/);
  }
  beforeEmit = true;
  for (let i = 0; i < 4; i++) {
    const raw = new Response();
    await run(raw);
    assert.equal(raw.status, 500);
    assert.equal(raw.writableFinished, true);
  }
  beforeEmit = false;
  fails = false;
  const raw = new Response();
  await run(raw);
  assert.ok(raw.writableFinished);
});

test("R16: a responsive long answer survives five minutes; thirty minutes remains bounded", async t => {
  // Node 24 MockTimers.refresh() is a no-op; use a clock which also models the
  // real Timeout.refresh behaviour used for SSE activity.
  let now = 0;
  const timers = new Set<{ at: number; callback: () => void }>();
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
    const timer = { at: now + delay, callback, unref() { return timer; },
      refresh() { timer.at = now + delay; return timer; } };
    timers.add(timer); return timer;
  });
  t.mock.method(globalThis, "clearTimeout", timer => { timers.delete(timer as never); });
  const tick = (ms: number) => {
    now += ms;
    for (const timer of timers) if (timer.at <= now) { timers.delete(timer); timer.callback(); }
  };
  const held = deferred();
  let emit!: (event: unknown) => void;
  const run = chatRoute(async (_id, _body, output) => { emit = output; await held.promise; });
  const raw = new Response();
  const pending = run(raw);
  for (let i = 0; i < 6; i++) {
    tick(60_000);
    emit({ e: "delta", text: "continuing" });
  }
  assert.equal(raw.destroyed, false);
  for (let i = 6; i < 30; i++) {
    tick(60_000);
    emit({ e: "delta", text: "continuing" });
  }
  assert.equal(raw.destroyed, true);
  held.resolve(); await pending;
});

test("R04: uploads disconnected during an earlier async hook release all admission slots", async () => {
  const hooks: Record<string, (...args: any[]) => Promise<void>> = {};
  registerUploadAdmission({ addHook: (name: string, hook: typeof hooks[string]) => { hooks[name] = hook; } } as never,
    { require: () => ({ id: "upload-user" }) } as never);
  const requests = new Map<string, object>();
  const req = (id: string) => {
    if (!requests.has(id)) requests.set(id, { id, raw: new EventEmitter(), headers: { "content-type": "multipart/form-data; boundary=x" } });
    return requests.get(id)!;
  };
  for (let i = 0; i < 12; i++) {
    const raw = new Response();
    raw.destroy();
    await Promise.resolve(); // Earlier asynchronous hook has yielded past close.
    await hooks.preHandler!(req(String(i)), { raw });
    assert.equal(raw.listenerCount("close"), 0);
  }
  const live: Response[] = [];
  for (let i = 0; i < 2; i++) {
    const raw = new Response(); live.push(raw);
    await hooks.preHandler!(req(`live-${i}`), { raw });
  }
  await assert.rejects(hooks.preHandler!(req("overflow"), { raw: new Response() }), { code: "UPLOAD_BUSY" });
  live[0]!.destroy();
  await hooks.preHandler!(req("reconnected"), { raw: new Response() });
  await hooks.onRequestAbort!(req("live-1"));
  await hooks.preHandler!(req("after-abort"), { raw: new Response() });
});

test("response lifecycle releases exactly once and removes listeners after finish or error", () => {
  for (const event of ["finish", "error", "close"]) {
    const raw = new Response(); let releases = 0;
    const release = onResponseEnd(raw as never, () => { releases++; });
    raw.emit(event);
    raw.emit("close"); release();
    assert.equal(releases, 1);
    assert.equal(raw.listenerCount("close"), 0);
    assert.equal(raw.listenerCount("finish"), 0);
    assert.equal(raw.listenerCount("error"), 0);
  }
});

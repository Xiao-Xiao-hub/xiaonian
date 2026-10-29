import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import type { FastifyRequest } from "fastify";
import Fastify from "../server/node_modules/fastify/fastify.js";
import multipart from "../server/node_modules/@fastify/multipart/index.js";
import { AppError } from "../server/src/shared/domain.js";
import { registerUploadAdmission } from "../server/src/shared/upload-admission.js";
import { registerChatRoutes } from "../server/src/modules/chat/routes.js";

const head = '--probe\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n';
const tail = "\r\n--probe--\r\n";
const photo = head + "synthetic-photo" + tail;

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "upload reached its expected lifecycle stage");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

function fixture(scan: () => Promise<unknown> = async () => ({ recognized: true })) {
  const app = Fastify();
  const requests: FastifyRequest[] = [];
  let denied = 0;
  const auth = {
    require(req: FastifyRequest) {
      const userId = req.headers.authorization?.match(/^Bearer (user-[a-z0-9]+)$/)?.[1];
      if (!userId) { denied++; throw new AppError(401, "AUTH_REQUIRED", "请先登录"); }
      return { id: userId };
    },
  };
  app.register(multipart);
  registerUploadAdmission(app, auth as never);
  app.addHook("preHandler", async req => { requests.push(req); });
  registerChatRoutes(app, { auth: auth as never, chat: { scan } as never });
  const sources: PassThrough[] = [];
  const upload = (user = "user-a", payload: string | PassThrough = photo) => app.inject({
    method: "POST", url: "/v1/chat/scan", payload,
    headers: { "content-type": "multipart/form-data; boundary=probe", ...(user ? { authorization: `Bearer ${user}` } : {}) },
  }).then(response => response);
  const slow = () => {
    const source = new PassThrough();
    source.write(head + "synthetic-photo");
    sources.push(source);
    return source;
  };
  const close = async () => {
    for (const source of sources) if (!source.writableEnded) source.end(tail);
    await app.close();
  };
  return { app, requests, upload, slow, close, denied: () => denied };
}

test("T01: four unauthenticated unfinished multipart streams do not block a signed-in photo", async () => {
  const f = fixture();
  await f.app.ready();
  const sources = Array.from({ length: 4 }, () => f.slow());
  const pending = sources.map(source => f.upload("", source));
  try {
    await until(() => f.denied() === 4);
    assert.ok(sources.every(source => !source.writableEnded));
    const response = await f.upload("user-b");
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual((await Promise.all(pending)).map(response => response.statusCode), [401, 401, 401, 401]);
    assert.equal(f.requests.length, 1, "unauthenticated uploads never enter the receive stage");
  } finally { await f.close(); }
});

test("T01: a third in-flight upload is limited only for its user and slots recover after receiving", async () => {
  const f = fixture();
  await f.app.ready();
  const sources = [f.slow(), f.slow()];
  const pending = sources.map(source => f.upload("user-a", source));
  try {
    await until(() => f.requests.length === 2);
    const limited = await f.upload("user-a");
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal(limited.json().code, "UPLOAD_BUSY");
    const other = await f.upload("user-b");
    assert.equal(other.statusCode, 200, other.body);
    for (const source of sources) source.end(tail);
    assert.ok((await Promise.all(pending)).every(response => response.statusCode === 200));
    assert.equal((await f.upload("user-a")).statusCode, 200);
  } finally { await f.close(); }
});

test("T01: forty users can receive photos concurrently without reaching the global safety cap", async () => {
  const f = fixture();
  await f.app.ready();
  const sources = Array.from({ length: 40 }, () => f.slow());
  const pending = sources.map((source, index) => f.upload(`user-${index}`, source));
  try {
    await until(() => f.requests.length === 40);
    assert.equal((await f.upload("user-next")).statusCode, 200);
    for (const source of sources) source.end(tail);
    assert.ok((await Promise.all(pending)).every(response => response.statusCode === 200));
  } finally { await f.close(); }
});

test("T01: completed files release immediately while HTTP bodies and vision responses remain unfinished", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let scans = 0;
  const f = fixture(async () => { scans++; await held; return { recognized: true }; });
  await f.app.ready();
  const sources = [f.slow(), f.slow(), f.slow()];
  const pending: ReturnType<typeof f.upload>[] = [];
  try {
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index]!;
      pending.push(f.upload("user-a", source));
      source.write(tail); // Complete the file, deliberately keep the request stream open.
      await until(() => scans === index + 1);
    }
    assert.ok(f.requests.every(req => !req.raw.readableEnded));
    assert.ok(sources.every(source => !source.writableEnded));
    release();
    assert.ok((await Promise.all(pending)).every(response => response.statusCode === 200));
  } finally { release(); await f.close(); }
});

test("T01: aborting a receiving request releases its user's slot before the response finishes", async () => {
  const f = fixture();
  await f.app.ready();
  const sources = [f.slow(), f.slow()];
  const pending = sources.map(source => f.upload("user-a", source));
  try {
    await until(() => f.requests.length === 2);
    assert.equal((await f.upload("user-a")).statusCode, 429);
    f.requests[0]!.raw.emit("aborted");
    assert.equal((await f.upload("user-a")).statusCode, 200);
    for (const source of sources) source.end(tail);
    await Promise.all(pending);
  } finally { await f.close(); }
});

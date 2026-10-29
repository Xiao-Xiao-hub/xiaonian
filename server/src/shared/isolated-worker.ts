import { fork, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";

// Parsing and rendering have independent workers and queues: a large document
// cannot delay opening a conversation. Each page submits its messages in order.
const MAX_PENDING = { document: 16, formula: 64 };
const MAX_RSS = 256 * 1024 * 1024;
const TIMEOUT_MS = 4_000;
type WorkerKind = "document" | "formula";
type WorkerState = { child?: ChildProcess; idle?: NodeJS.Timeout; pending: number; queue: Promise<unknown> };
const workers: Record<WorkerKind, WorkerState> = {
  document: { pending: 0, queue: Promise.resolve() },
  formula: { pending: 0, queue: Promise.resolve() },
};

export class ResourceLimitError extends Error {
  constructor(readonly reason: string) {
    super("File or formula processing limit exceeded");
    this.name = "ResourceLimitError";
  }
}
export function processingRejected(kind: string, reason: string) {
  // Only constant categories, never filenames, document text or parser errors.
  console.warn(JSON.stringify({ event: "parse_rejected", kind, reason }));
}
function stop(worker: ChildProcess, signal: NodeJS.Signals = "SIGKILL") {
  try {
    if (process.platform !== "win32" && worker.pid) process.kill(-worker.pid, signal);
    else worker.kill(signal);
  } catch { /* The process group already exited. */ }
}

export function runIsolated<T>(kind: WorkerKind, action: string, payload: unknown): Promise<T> {
  const state = workers[kind];
  if (state.pending >= MAX_PENDING[kind]) {
    processingRejected(kind, "queue_full");
    return Promise.reject(new ResourceLimitError("queue_full"));
  }
  state.pending++;
  const run = state.queue.then(() => execute<T>(kind, action, payload));
  state.queue = run.catch(() => undefined).finally(() => { state.pending--; });
  return run;
}

function execute<T>(kind: WorkerKind, action: string, payload: unknown): Promise<T> {
  const state = workers[kind];
  clearTimeout(state.idle);
  if (!state.child) {
    const source = import.meta.url.endsWith(".ts");
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    state.child = fork(new URL(`./processing-worker.${source ? "ts" : "js"}`, import.meta.url), [], {
      execArgv: ["--max-old-space-size=128", ...(source ? ["--import", "tsx"] : [])],
      serialization: "advanced",
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    state.child.unref();
    state.child.channel?.unref();
  }
  const worker = state.child;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (reason?: string, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(memory);
      worker.removeListener("message", message);
      worker.removeListener("error", failed);
      worker.removeListener("exit", failed);
      if (reason) {
        stop(worker);
        if (state.child === worker) state.child = undefined;
        if (reason === "timeout")
          console.warn(JSON.stringify({ event: "parse_timeout", kind }));
        else processingRejected(kind, reason);
        reject(new ResourceLimitError(reason));
      } else {
        // Release native buffers and idle process memory after a short burst.
        state.idle = setTimeout(() => {
          if (state.child === worker) { stop(worker); state.child = undefined; }
        }, 1_000);
        state.idle.unref();
        resolve(value as T);
      }
    };
    const failed = () => finish("worker_failed");
    const message = (reply: { ok?: boolean; value?: T; reason?: string }) =>
      reply.ok ? finish(undefined, reply.value) : finish(reply.reason === "limit" ? "input_limit" : "invalid_file");
    const timeout = setTimeout(() => finish("timeout"), TIMEOUT_MS);
    // V8's heap cap does not count PDF buffers or resvg's native allocations.
    // Linux is the production platform; dimensions and ZIP output are bounded too.
    let checking = false;
    const memory = setInterval(async () => {
      if (checking || !worker.pid || process.platform !== "linux") return;
      checking = true;
      try {
        const status = await readFile(`/proc/${worker.pid}/status`, "utf8");
        const rss = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024;
        if (rss > MAX_RSS) finish("memory_limit");
      } catch { /* An exited process is handled by the exit event. */ }
      finally { checking = false; }
    }, 50);
    worker.once("message", message);
    worker.once("error", failed);
    worker.once("exit", failed);
    worker.send({ action, payload }, (error) => { if (error) failed(); });
  });
}

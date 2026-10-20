import { AsyncLocalStorage } from "node:async_hooks";

// The job runner sets the running job's deadline (epoch ms) around a handler,
// so a model stream started inside a job ends before the job does instead of
// at the fixed outside-job cap.
const deadline = new AsyncLocalStorage<number>();
const MARGIN_MS = 5000;

export const withJobDeadline = <T>(at: number, run: () => T): T =>
  deadline.run(at, run);

// Time left for a stream inside the current job, or undefined outside jobs.
export function jobStreamMs() {
  const at = deadline.getStore();
  return at === undefined ? undefined : Math.max(1000, at - Date.now() - MARGIN_MS);
}

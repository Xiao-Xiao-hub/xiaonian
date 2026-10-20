import type { SqliteStore } from "./store.js";

// Daily allowances. Jobs charge ai/ocr/notes/brainstorm/import; chat and
// photos are charged by their synchronous service paths.
export const BUCKETS = [
  "ai",
  "ocr",
  "notes",
  "chat",
  "photos",
  "brainstorm",
  "import",
] as const;
export type Bucket = (typeof BUCKETS)[number];
export const MAX_LIMIT = 10000;
const valid = (n: unknown): n is number =>
  Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_LIMIT;
const pick = (saved: unknown) =>
  Object.fromEntries(
    BUCKETS.flatMap((b) => {
      const n = (saved as Record<string, unknown> | undefined)?.[b];
      return valid(n) ? [[b, n]] : [];
    }),
  ) as Partial<Record<Bucket, number>>;

// One account's limit: its own override, else the admin's global setting,
// else the environment default. Read on every check, so edits apply at once.
export class Limits {
  constructor(
    private readonly store: SqliteStore,
    readonly defaults: Record<Bucket, number>,
  ) {}
  global(): Record<Bucket, number> {
    return { ...this.defaults, ...pick(this.store.setting("quota.limits")) };
  }
  overrides(userId: string) {
    return pick(this.store.control(userId).quota);
  }
  for(userId: string, bucket: Bucket) {
    return this.overrides(userId)[bucket] ?? this.global()[bucket];
  }
}

// Calendar days follow China Standard Time (UTC+8, no DST) regardless of the
// process time zone, so quotas and review due dates roll over at local midnight.
const OFFSET_MS = 8 * 3600_000;
export const DAY_MS = 86400_000;
export type Clock = () => Date;

// Business time may move by whole days in development and tests. Callers use
// the returned clock instead of changing the process clock, so elapsed-time
// measurements and network timeouts still use the real monotonic timeline.
export const shiftedClock = (
  days = 0,
  realNow: Clock = () => new Date(),
): Clock => {
  if (!Number.isSafeInteger(days))
    throw new Error("Clock offset must be an integer");
  return () => new Date(realNow().getTime() + days * DAY_MS);
};

const processDays = Number(process.env.TEST_CLOCK_DAYS ?? 0);
export const now = shiftedClock(
  Number.isSafeInteger(processDays) ? processDays : 0,
);

export const chinaDate = (ms = now().getTime()) =>
  new Date(ms + OFFSET_MS).toISOString().slice(0, 10);
export const chinaDayStart = (ms = now().getTime()) =>
  new Date(Date.parse(`${chinaDate(ms)}T00:00:00Z`) - OFFSET_MS).toISOString();
export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
// The business week starts Monday 00:00 China time (V4.2 budgets).
export const chinaWeekStart = (ms = now().getTime()) => {
  const date = chinaDate(ms);
  const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return new Date(Date.parse(chinaDayStart(ms)) - weekday * DAY_MS).toISOString();
};

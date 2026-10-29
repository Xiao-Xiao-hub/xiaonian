import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type CallContext = {
  userId?: string;
  source: string;
};

const calls = new AsyncLocalStorage<CallContext>();
export type BillingScope = { ids: Set<string>; closed: boolean };
const billingScopes = new WeakMap<CallContext, BillingScope>();
const activities = new WeakMap<CallContext, string>();
const systemContext: Readonly<CallContext> = Object.freeze({
  source: "system",
});

export function runWithCallContext<T>(context: CallContext, run: () => T, activityId: string = randomUUID()): T {
  const own = { ...context };
  billingScopes.set(own, { ids: new Set(), closed: false });
  activities.set(own, activityId);
  return calls.run(own, run);
}

export function currentCallActivity(): string | undefined {
  const context = calls.getStore();
  return context ? activities.get(context) : undefined;
}

// A queue receives a new scope; it never shares its parent's mutable holds.
export function currentBillingScope(): BillingScope | undefined {
  const context = calls.getStore();
  return context ? billingScopes.get(context) : undefined;
}

// Work outside a request, job, or captured callback is system work. This keeps
// later metering conservative: an absent user can never become the prior call.
export function currentCallContext(): Readonly<CallContext> {
  return calls.getStore() ?? systemContext;
}

// A business-funded follow-up still has to be metered, but it must not inherit
// the learner's payment source or reservation scope.
export function runWithoutBillingUser<T>(run: () => T): T {
  return runWithCallContext({ source: currentCallContext().source }, run);
}

// Authentication augments the context created at the entry point. Do not use
// enterWith here: it would change the ambient context for unrelated work.
export function bindCallUser(userId: string): void {
  const context = calls.getStore();
  if (context) context.userId = userId;
}

// Queue callbacks must carry a snapshot of their enqueuing call, not whichever
// call happens to pump the queue later.
export function bindCallContext<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const context = { ...currentCallContext() };
  const activityId = currentCallActivity();
  return (...args) => runWithCallContext(context, () => fn(...args), activityId);
}

import { AppError } from "./domain.js";

// Zod 3 validates every collection item even after .max() has failed. Bound
// the work before entering any route schema, including strict-object issues.
export function checkInputComplexity(input: unknown) {
  const pending = [{ value: input, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 4000 || depth > 20) reject();
    if (value === null || typeof value !== "object") continue;
    const values = Array.isArray(value) ? value : Object.values(value);
    if (values.length > 1000 || nodes + pending.length + values.length > 4000)
      reject();
    for (const child of values) pending.push({ value: child, depth: depth + 1 });
  }
}
function reject(): never {
  throw new AppError(413, "INPUT_COMPLEXITY_LIMIT", "提交的内容太多或层级过深，请分批提交");
}

// Every event uses only a fixed code and the route template. In particular,
// validation errors may contain submitted enum values, object keys or text.
export function rejectionEvent(status: number, code: string, route: string) {
  if (code === "CALLBACK_SIGNATURE_INVALID") return "payment_signature_failed";
  if (code === "PAYMENT_AMOUNT_MISMATCH") return "payment_amount_mismatch";
  if (status === 429 || code === "SERVICE_BUSY") return "rate_limited";
  if (code === "INPUT_COMPLEXITY_LIMIT" || /^(FILE|PDF|DOCX|IMAGE|IMPORT|PARSE)_/.test(code))
    return /TIMEOUT/.test(code) ? "parse_timeout" : "parse_rejected";
  if (status === 401 && (/\/auth\/(dev|wechat)-login$/.test(route) || route === "/v1/admin/session" || route.startsWith("/v1/admin/")))
    return "login_failed";
  // A missing/deleted resource is a normal 404. Ownership-filtered lookups do
  // not reveal whether another user's row exists, so don't invent a denial.
  if (status === 403)
    return "authorization_denied";
  return undefined;
}

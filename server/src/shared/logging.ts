// Never serialize arbitrary Error.message, stack, cause or custom properties:
// an upstream SDK can attach learner text, request headers or provider replies.
export function safeError(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    code:
      typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
        ? code
        : "INTERNAL_ERROR",
    type:
      error instanceof TypeError
        ? "TypeError"
        : error instanceof RangeError
          ? "RangeError"
          : "Error",
  };
}

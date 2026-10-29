// No HTTP or database imports. The parent owns the deadline and process budget.
process.on("disconnect", () => process.exit(0));
process.on("message", async (message: { action: string; payload: unknown }) => {
  try {
    const value = message.action === "markdown"
      ? await markdown(String(message.payload))
      : message.action === "formula"
      ? await (await import("../modules/render/formula-worker.js")).processFormula(message.payload)
      : await (await import("../modules/imports/parser-worker.js")).processDocument(message.action, message.payload);
    process.send?.({ ok: true, value });
  } catch (error) {
    process.send?.({ ok: false, reason: error instanceof Error && error.name === "ResourceLimitError" ? "limit" : "invalid" });
  }
});

async function markdown(source: string) {
  const { ResourceLimitError } = await import("./isolated-worker.js");
  const tokens = (await import("marked")).marked.lexer(source);
  const stack: { value: unknown; depth: number }[] = [{ value: tokens, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (!value || typeof value !== "object") continue;
    if (++count > 20_000 || depth > 64) throw new ResourceLimitError("markdown_tree");
    for (const entry of Object.values(value)) stack.push({ value: entry, depth: depth + 1 });
  }
  if (JSON.stringify(tokens).length > 2_000_000) throw new ResourceLimitError("markdown_output");
  return tokens;
}

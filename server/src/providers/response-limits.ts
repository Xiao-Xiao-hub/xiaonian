export const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Bound decoded responses as they arrive; Content-Length may be absent or
 * describe compressed bytes. Cancelling the reader also closes the body. */
export async function boundedResponseText(response: Response, max = MAX_PROVIDER_RESPONSE_BYTES): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error("Provider response exceeds byte limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

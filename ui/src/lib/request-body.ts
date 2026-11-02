/** Read at most limit bytes; cancel oversized streams before buffering or parsing. */
export async function readBodyWithLimit(request: Request, limit: number): Promise<ArrayBuffer | null> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  let body = new Uint8Array(0);
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - total) {
        await reader.cancel();
        return null;
      }
      const nextTotal = total + value.byteLength;
      if (nextTotal > body.byteLength) {
        // Storage grows with payload bytes, independently of transport chunk count.
        const capacity = Math.min(limit, Math.max(nextTotal, body.byteLength * 2, 1024));
        const nextBody = new Uint8Array(capacity);
        nextBody.set(body.subarray(0, total));
        body = nextBody;
      }
      body.set(value, total);
      total = nextTotal;
    }
  } finally {
    reader.releaseLock();
  }
  return total === body.byteLength ? body.buffer : body.buffer.slice(0, total);
}


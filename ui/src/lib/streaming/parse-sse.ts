/**
 * Shared SSE stream parser.
 *
 * Extracted from DynamicAgentClient.parseSSEStream. Uses getReader() + TextDecoder
 * for Safari compatibility (Safari's ReadableByteStream doesn't support pipeThrough).
 *
 * Both custom-adapter and agui-adapter use this to parse the raw SSE byte stream
 * from the gateway proxy.
 */

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** A single parsed SSE frame: the event type and its data payload. */
export interface RawSSEEvent {
  event: string;
  data: string;
  /** Durable event cursor when supplied by the server. */
  id?: string;
}

// ═══════════════════════════════════════════════════════════════
// Parser
// ═══════════════════════════════════════════════════════════════

/**
 * Parse an SSE stream from a fetch Response.
 *
 * Yields one RawSSEEvent per SSE frame (delimited by `\n\n`).
 * Handles multi-line `data:` fields per the SSE spec.
 * Uses getReader() for Safari compatibility.
 */
export async function* parseSSEStream(
  response: Response,
): AsyncGenerator<RawSSEEvent, void, undefined> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Response body is not readable");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Both LF and CRLF delimiters are valid SSE, including across chunks.
      const events = buffer.split(/\r?\n\r?\n/);
      // Keep the last incomplete chunk in the buffer
      buffer = events.pop() || "";

      for (const eventStr of events) {
        if (!eventStr.trim()) continue;

        let eventType = "message";
        let id: string | undefined;
        const dataLines: string[] = [];

        for (const line of eventStr.split(/\r?\n/)) {
          const separator = line.indexOf(":");
          if (separator < 0) continue;
          const field = line.slice(0, separator);
          let value = line.slice(separator + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") {
            eventType = value;
          } else if (field === "data") {
            dataLines.push(value);
          } else if (field === "id" && !value.includes("\0")) {
            id = value;
          }
        }

        // Heartbeats/comments carry no event and must not advance a cursor.
        if (dataLines.length === 0) continue;
        // Join multiple data lines with newlines (SSE spec)
        const eventData = dataLines.join("\n");
        yield { event: eventType, data: eventData, ...(id !== undefined && { id }) };
      }
    }
  } finally {
    // Returning at a terminal frame closes only this subscription. Detached
    // execution belongs to the service and is cancelled through its API.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

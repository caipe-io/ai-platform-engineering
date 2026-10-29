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
}

// ═══════════════════════════════════════════════════════════════
// Parser
// ═══════════════════════════════════════════════════════════════

/**
 * Parse an SSE stream from a fetch Response.
 *
 * Yields one RawSSEEvent per data-bearing frame (delimited by `\n\n`).
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

      // Split on double newlines (SSE event separator)
      const events = buffer.split("\n\n");
      // Keep the last incomplete chunk in the buffer
      buffer = events.pop() || "";

      for (const eventStr of events) {
        if (!eventStr.trim()) continue;

        let eventType = "message";
        const dataLines: string[] = [];

        for (const line of eventStr.split("\n")) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            dataLines.push(line.slice(6));
          } else if (line.startsWith("data:")) {
            // Handle "data:" without space (valid per SSE spec)
            dataLines.push(line.slice(5));
          }
        }

        // Comments and event-only keep-alives do not dispatch application data.
        // An explicit empty data field still counts as a data-bearing frame.
        if (dataLines.length === 0) continue;

        // Join multiple data lines with newlines (SSE spec)
        const eventData = dataLines.join("\n");
        yield { event: eventType, data: eventData };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

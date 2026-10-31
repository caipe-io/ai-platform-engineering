import { waitForRetry } from "../retry";
import { parseSSEStream, type RawSSEEvent } from "../parse-sse";

/** Reattach to an admitted run; retries never resubmit the user's command. */
export async function* recoverableStream(
  initial: Response, protocol: "agui" | "custom", signal: AbortSignal,
): AsyncGenerator<RawSSEEvent> {
  const runId = initial.headers.get("X-Harness-Run-ID");
  let response = initial;
  let cursor = "0";
  let attempts = 0;
  while (!signal.aborted) {
    try {
      for await (const event of parseSSEStream(response)) {
        yield event;
        if (event.id && /^\d+(?:\.\d+)?$/.test(event.id)) cursor = event.id;
        attempts = 0;
        const terminalEvents = protocol === "agui" ? ["RUN_FINISHED", "RUN_ERROR"] : ["done", "error", "input_required"];
        if (terminalEvents.includes(event.event)) return;
      }
      if (!runId) throw new Error("Connection closed before the server confirmed completion. Reopen the chat to check its status.");
    } catch (error) {
      if (signal.aborted) return;
      if (!runId) throw error;
    }
    while (!signal.aborted) {
      await waitForRetry(Math.min(250 * 2 ** Math.min(attempts++, 7), 30_000), signal);
      if (signal.aborted) return;
      try {
        response = await fetch(`/api/harness-engine/runs/${encodeURIComponent(runId!)}/events/stream?after=${encodeURIComponent(cursor)}&protocol=${protocol}`, {
          credentials: "same-origin", signal, cache: "no-store",
        });
      } catch {
        continue;
      }
      if (response.ok) break;
      if (response.status < 500 && ![408, 429].includes(response.status)) {
        throw new Error(`Run recovery failed (${response.status})`);
      }
    }
  }
}

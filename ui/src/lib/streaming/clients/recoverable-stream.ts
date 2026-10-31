import { parseSSEStream, type RawSSEEvent } from "../parse-sse";

/** Reattach to an admitted run; retries never resubmit the user's command. */
export async function* recoverableStream(
  initial: Response, protocol: "agui" | "custom", signal: AbortSignal,
): AsyncGenerator<RawSSEEvent> {
  const runId = initial.headers.get("X-Harness-Run-ID");
  let response = initial;
  let cursor = 0;
  let attempts = 0;
  while (true) {
    try {
      for await (const event of parseSSEStream(response)) {
        yield event;
        if (event.id && /^\d+$/.test(event.id)) cursor = Math.max(cursor, Number(event.id));
        if (["RUN_FINISHED", "RUN_ERROR", "done", "error", "input_required"].includes(event.event)) return;
      }
      if (!runId) return;
    } catch (error) {
      if (signal.aborted || !runId) throw error;
    }
    if (signal.aborted) return;
    if (++attempts > 3) throw new Error("The run is continuing on the server. Reopen this chat to recover its state.");
    await new Promise(resolve => setTimeout(resolve, Math.min(attempts * 250, 1000)));
    response = await fetch(`/api/harness-engine/runs/${encodeURIComponent(runId)}/events/stream?after=${cursor}&protocol=${protocol}`, {
      credentials: "same-origin", signal, cache: "no-store",
    });
    if (!response.ok) throw new Error(`Run recovery failed (${response.status})`);
  }
}

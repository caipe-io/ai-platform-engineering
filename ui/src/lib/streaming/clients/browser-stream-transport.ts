import type { StreamCallbacks, StreamParams } from "../callbacks";
import { getLatestNativeRun, nativeEventSequence, nativeRunQuery, type NativeRunStatus, type RunStreamParams } from "../native-runs";
import { parseSSEStream, type RawSSEEvent } from "../parse-sse";
import { buildStreamErrorFromResponse, StreamError } from "../stream-error";

const STREAM_BASE = "/api/v1/chat/stream";
const MAX_RECONNECT_ATTEMPTS = 6;

function retryable(error: unknown): boolean {
  return !(error instanceof StreamError) || error.status === 429 || error.status >= 500;
}

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** One HTTP lifecycle for both wire protocols; reconnect never submits another prompt. */
export class BrowserStreamTransport {
  private abortController: AbortController | null = null;
  private cancelledTurns = new Set<string>();

  constructor(private accessToken?: string) {}

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  async cancelStream(conversationId: string, agentId: string, turnId?: string): Promise<boolean> {
    if (turnId) {
      this.cancelledTurns.add(turnId);
      // Stop can precede history persistence and therefore admission itself.
      // The later stream call will honor this intent without starting a run.
      if (!this.abortController) return true;
    }
    try {
      for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt += 1) {
        const response = await fetch(`${STREAM_BASE}/cancel`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ conversation_id: conversationId, agent_id: agentId, ...(turnId && { turn_id: turnId }) }),
        });
        if (!response.ok) return false;
        if ((await response.json()).cancelled) return true;
        if (!turnId) return false;
        const run = await getLatestNativeRun({ conversationId, agentId }, { accessToken: this.accessToken });
        if (run?.turn_id === turnId && ["completed", "failed", "cancelled", "interrupted", "awaiting_input"].includes(run.status)) {
          return run.status === "cancelled";
        }
        // False can mean the independent admission insert is still pending.
        // Every retry targets this same turn, never whichever run is newest.
        await waitForRetry(Math.min(250 * 2 ** attempt, 2000), new AbortController().signal);
      }
      return false;
    } catch {
      return false;
    }
  }

  async stream(
    action: "start" | "resume",
    body: string,
    params: StreamParams,
    callbacks: StreamCallbacks,
    dispatch: (raw: RawSSEEvent) => boolean,
  ): Promise<void> {
    if (params.turnId && this.cancelledTurns.has(params.turnId)) {
      callbacks.onError?.("Request cancelled before execution started.");
      callbacks.onRunStatus?.("cancelled");
      return;
    }
    await this.consume(params, callbacks, dispatch, async (signal) => {
      try {
        return await fetch(`${STREAM_BASE}/${action}`, {
          method: "POST",
          headers: this.headers(true),
          body,
          signal,
        });
      } catch (error) {
        if (signal.aborted || !params.turnId) throw error;
        // The server might have admitted the request before the response was
        // lost. Discover that exact turn instead of executing it a second time.
        for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt += 1) {
          callbacks.onConnectionState?.("reconnecting");
          await waitForRetry(Math.min(500 * 2 ** attempt, 8000), signal);
          try {
            const run = await getLatestNativeRun(params, { accessToken: this.accessToken, signal });
            if (run?.turn_id === params.turnId) {
              return this.replayResponse({ ...params, runId: run.run_id }, 0, signal);
            }
          } catch (lookupError) {
            if (!retryable(lookupError)) throw lookupError;
          }
        }
        throw error;
      }
    });
  }

  async reattach(
    params: RunStreamParams,
    callbacks: StreamCallbacks,
    dispatch: (raw: RawSSEEvent) => boolean,
  ): Promise<void> {
    await this.consume(params, callbacks, dispatch, (signal) => this.replayResponse(params, 0, signal), params.runId);
  }

  private headers(stream = false): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(stream && { Accept: "text/event-stream" }),
      ...(this.accessToken && { Authorization: `Bearer ${this.accessToken}` }),
    };
  }

  private replayResponse(params: RunStreamParams, after: number, signal: AbortSignal): Promise<Response> {
    const query = nativeRunQuery(params);
    query.set("after", String(after));
    return fetch(`/api/v1/chat/runs/${encodeURIComponent(params.runId)}/stream?${query}`, {
      headers: this.headers(true),
      cache: "no-store",
      signal,
    });
  }

  private async consume(
    params: { conversationId: string; agentId: string },
    callbacks: StreamCallbacks,
    dispatch: (raw: RawSSEEvent) => boolean,
    initialResponse: (signal: AbortSignal) => Promise<Response>,
    initialRunId?: string,
  ): Promise<void> {
    this.abort();
    const controller = new AbortController();
    this.abortController = controller;
    let runId = initialRunId;
    let cursor = 0;
    let attempts = 0;
    let semanticTerminalDelivered = false;
    let nativeErrorDelivered = false;
    try {
      let response = await initialResponse(controller.signal);
      while (true) {
        if (!response.ok) throw await buildStreamErrorFromResponse(response);
        runId = response.headers.get("X-CAIPE-Run-Id") ?? runId;
        callbacks.onConnectionState?.("connected");
        let terminal = false;
        try {
          for await (const raw of parseSSEStream(response)) {
            if (runId) {
              const sequence = nativeEventSequence(raw.id, runId);
              if (sequence === null) throw new StreamError("Invalid durable event cursor", 502);
              if (sequence <= cursor) continue;
              if (sequence !== cursor + 1) throw new StreamError("Missing durable event; reload to recover this response", 410);
              // Advance only after successful synchronous delivery to the UI.
              if (raw.event === "CAIPE_RUN_STATUS") {
                const record = JSON.parse(raw.data) as { run_id: string; status: NativeRunStatus };
                if (record.run_id !== runId || !["completed", "awaiting_input", "failed", "cancelled", "interrupted"].includes(record.status)) {
                  throw new StreamError("Invalid durable run status", 410);
                }
                if (["failed", "cancelled", "interrupted"].includes(record.status) && !nativeErrorDelivered) {
                  callbacks.onError?.(`Run ${record.status}. Saved progress is retained.`);
                } else if (record.status === "completed" && !semanticTerminalDelivered) {
                  callbacks.onDone?.();
                }
                callbacks.onRunStatus?.(record.status);
                terminal = true;
              } else {
                const nativeTerminal = dispatch(raw);
                semanticTerminalDelivered = nativeTerminal || semanticTerminalDelivered;
                nativeErrorDelivered = nativeErrorDelivered || (nativeTerminal && ["error", "RUN_ERROR"].includes(raw.event));
                // The service lifecycle marker is authoritative. A native
                // terminal can precede cancellation or terminal persistence.
                terminal = false;
              }
              cursor = sequence;
              attempts = 0;
            } else {
              terminal = dispatch(raw);
            }
            if (terminal) break;
          }
          if (terminal) return;
          if (!runId) throw new StreamError("Connection closed before the response completed", 502);
        } catch (error) {
          if (controller.signal.aborted || !runId || !retryable(error)) throw error;
        }

        // EOF without a terminal frame is a disconnected subscriber, never a
        // successful agent result. The worker remains owned by the service.
        while (true) {
          if (attempts >= MAX_RECONNECT_ATTEMPTS) {
            throw new StreamError("Connection lost. Reconnect to recover the existing response", 503);
          }
          callbacks.onConnectionState?.("reconnecting");
          await waitForRetry(Math.min(500 * 2 ** attempts, 8000), controller.signal);
          attempts += 1;
          try {
            response = await this.replayResponse({ ...params, runId: runId! }, cursor, controller.signal);
            if (!response.ok) throw await buildStreamErrorFromResponse(response);
            break;
          } catch (error) {
            if (controller.signal.aborted || !retryable(error)) throw error;
          }
        }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") throw error;
      // Aborting an observer must never finalize its partial reply as done.
      // A later page load can reconcile it against the durable run status.
      callbacks.onError?.("Stopped following the response. The existing run may still be working.");
      callbacks.onConnectionState?.("disconnected");
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }
}

import { waitForRetry } from "./streaming/retry";
import type { HarnessEventPage, HarnessRun, HarnessRunEvent } from "@/types/harness-engine";

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

async function requireData<T>(response: Response): Promise<T> {
  const envelope = await response.json() as Envelope<T>;
  if (!response.ok || !envelope.success || envelope.data === undefined) {
    throw new Error(envelope.error ?? `Harness Engine request failed (${response.status})`);
  }
  return envelope.data;
}

export async function startHarnessRun(input: {
  agent_id: string;
  conversation_id: string;
  message: string;
  client_request_id?: string;
}): Promise<HarnessRun> {
  const response = await fetch("/api/harness-engine/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return requireData<HarnessRun>(response);
}

export async function replayHarnessRun(runId: string, after = 0, wait = 0): Promise<HarnessEventPage> {
  const query = new URLSearchParams({ after: String(after), wait: String(wait) });
  const response = await fetch(
    `/api/harness-engine/runs/${encodeURIComponent(runId)}/events?${query}`,
    { cache: "no-store" },
  );
  return requireData<HarnessEventPage>(response);
}

export function subscribeHarnessRun(
  runId: string,
  onEvent: (event: HarnessRunEvent) => void,
  options: { after?: number; onError?: (event: Event) => void } = {},
): () => void {
  const url = new URL(
    `/api/harness-engine/runs/${encodeURIComponent(runId)}/events/stream`,
    window.location.origin,
  );
  if (options.after) url.searchParams.set("after", String(options.after));
  const source = new EventSource(url);
  const eventTypes: HarnessRunEvent["event_type"][] = [
    "run.started",
    "content.delta",
    "runtime.event",
    "result.updated",
    "run.paused",
    "reasoning.delta",
    "tool.started",
    "tool.completed",
    "subagent.started",
    "subagent.event",
    "interrupt.requested",
    "usage.updated",
    "run.completed",
    "run.failed",
    "run.cancelled",
  ];
  for (const eventType of eventTypes) {
    source.addEventListener(eventType, (message) => {
      const event = message as MessageEvent<string>;
      onEvent({
        run_id: runId,
        sequence: Number(event.lastEventId),
        event_type: eventType,
        data: JSON.parse(event.data) as Record<string, unknown>,
      });
      if (["run.completed", "run.failed", "run.cancelled", "run.paused"].includes(eventType)) source.close();
    });
  }
  if (options.onError) source.onerror = options.onError;
  return () => source.close();
}


/** Status recovery survives temporary BFF outages without reposting a prompt. */
export async function fetchChatRunStatus(agentId: string, conversationId: string, signal: AbortSignal): Promise<Response> {
  let attempts = 0;
  while (true) {
    signal.throwIfAborted();
    try {
      const response = await fetch("/api/v1/chat/stream/status", { method: "POST", signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_id: agentId, conversation_id: conversationId }) });
      if (response.ok || response.status < 500 && ![408, 409, 429].includes(response.status)) return response;
    } catch (error) {
      if (signal.aborted) throw error;
    }
    await waitForRetry(Math.min(250 * 2 ** Math.min(attempts++, 7), 30_000), signal);
  }
}

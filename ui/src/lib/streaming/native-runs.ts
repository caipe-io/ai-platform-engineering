import { buildStreamErrorFromResponse } from "./stream-error";

export type NativeRunStatus =
  | "queued"
  | "running"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface NativeRun {
  run_id: string;
  turn_id: string;
  agent_id: string;
  session_id: string;
  protocol: "custom" | "agui";
  status: NativeRunStatus;
  last_sequence: number;
  started_at?: string | null;
  failure_code?: string | null;
}

export interface RunStreamParams {
  conversationId: string;
  agentId: string;
  runId: string;
}

export function nativeRunQuery(params: { conversationId: string; agentId: string }): URLSearchParams {
  return new URLSearchParams({ conversation_id: params.conversationId, agent_id: params.agentId });
}

export async function getLatestNativeRun(
  params: { conversationId: string; agentId: string },
  options: { accessToken?: string; signal?: AbortSignal } = {},
): Promise<NativeRun | null> {
  const response = await fetch(`/api/v1/chat/runs?${nativeRunQuery(params)}`, {
    cache: "no-store",
    signal: options.signal,
    ...(options.accessToken && { headers: { Authorization: `Bearer ${options.accessToken}` } }),
  });
  if (!response.ok) throw await buildStreamErrorFromResponse(response);
  const result = await response.json() as { run: NativeRun | null };
  return result.run;
}

/** Match a durable frame to its admitted run before advancing the replay cursor. */
export function nativeEventSequence(id: string | undefined, runId: string): number | null {
  if (!id?.startsWith(`${runId}:`)) return null;
  const sequence = id.slice(runId.length + 1);
  if (!/^[1-9]\d*$/.test(sequence)) return null;
  const value = Number(sequence);
  return Number.isSafeInteger(value) ? value : null;
}

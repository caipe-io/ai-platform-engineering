import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

import { findAgenticAppAssistantStream } from "@/lib/agentic-apps/assistant-stream";
import type { AuthResult } from "@/lib/da-proxy";
import {
  buildHarnessEngineHeaders,
  getHarnessEngineConfig,
  isHarnessEngineConfigured,
  lookupHarnessSession,
  type HarnessEngineConfig,
} from "@/lib/harness-engine-proxy";
import { getCollection } from "@/lib/mongodb";
import type { HarnessRun, HarnessRunEvent } from "@/types/harness-engine";

export const DEFAULT_HARNESS_ID = "dynamic_agents";

interface AgentRuntimeRecord {
  _id: string;
  execution_harness_id?: string;
  backend?: { config?: { checkpoint_collection?: string | null } };
}

export interface HarnessGatewayTarget {
  kind: "dynamic_agents" | "harness_engine";
  harnessId: string;
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  detail?: string | { message?: string };
}

interface HarnessEventPage {
  run: HarnessRun;
  events: HarnessRunEvent[];
  next_cursor: number;
}

interface GatewayStreamState {
  messageId: string;
  messageStarted: boolean;
  terminalSent: boolean;
  toolNames: Map<string, string>;
}

type GatewayProtocol = "custom" | "agui";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

function normalizedHarnessId(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_HARNESS_ID;
}

interface GatewayBinding {
  _id: string;
  owner_subject: string;
  agent_id: string;
  conversation_id: string;
  harness_id: string;
}

function gatewayBindingId(agentId: string, subject: string, conversationId: string): string {
  return createHash("sha256").update(JSON.stringify([subject, agentId, conversationId])).digest("hex");
}

export async function clearHarnessGatewayBinding(agentId: string, subject: string, conversationId: string): Promise<void> {
  const bindings = await getCollection<GatewayBinding>("harness_gateway_bindings");
  await bindings.deleteOne({ _id: gatewayBindingId(agentId, subject, conversationId) });
}

/** Resolve the owner/conversation's pinned backend before an agent default. */
export async function resolveHarnessGatewayTarget(
  agentId: string,
  context: { subject: string; conversationId: string; traceparent?: string },
): Promise<HarnessGatewayTarget | NextResponse> {
  try {
    // App-owned assistants execute through their declared stream endpoints.
    // Reject entry points without an app operation before creating a provider binding.
    if (findAgenticAppAssistantStream(agentId)) {
      return NextResponse.json(
        { success: false, code: "APP_STREAM_REQUIRED", error: "This app assistant requires its declared chat stream endpoints" },
        { status: 501 },
      );
    }
    const bindings = await getCollection<GatewayBinding>("harness_gateway_bindings");
    const key = { _id: gatewayBindingId(agentId, context.subject, context.conversationId) };
    let binding = await bindings.findOne(key);
    if (!binding) {
      const agents = await getCollection<AgentRuntimeRecord>("dynamic_agents");
      const agent = await agents.findOne({ _id: agentId }, { projection: { _id: 1, execution_harness_id: 1, backend: 1 } });
      if (!agent) return NextResponse.json({ success: false, error: "Agent not found" }, { status: 404 });
      let harnessId = normalizedHarnessId(agent.execution_harness_id);
      // Dynamic Agents and the BFF share the application database. Match the
      // native runtime's checkpointer collection, including per-agent overrides.
      const checkpointCollection = agent.backend?.config?.checkpoint_collection ||
        process.env.CHECKPOINT_COLLECTION || "checkpoints_conversation";
      const checkpoints = await getCollection(checkpointCollection);
      const nativeContext = await checkpoints.findOne(
        { thread_id: context.conversationId }, { projection: { _id: 1 } },
      );
      if (nativeContext) harnessId = DEFAULT_HARNESS_ID;
      const config = getHarnessEngineConfig();
      if (isHarnessEngineConfigured() && !(config instanceof NextResponse)) {
        // Compare both authoritative owners when adopting pre-gateway sessions.
        const saved = await lookupHarnessSession(config, context, agentId, context.conversationId);
        if (saved instanceof NextResponse) {
          if (!nativeContext) return saved;
        } else if (nativeContext && saved.harness_id && saved.harness_id !== DEFAULT_HARNESS_ID) {
          return NextResponse.json({ success: false, error: "Conversation has conflicting runtime contexts; clear it before continuing" }, { status: 409 });
        } else {
          harnessId = saved.harness_id ?? harnessId;
        }
      } else if (harnessId !== DEFAULT_HARNESS_ID && config instanceof NextResponse) {
        return config;
      }
      binding = await bindings.findOneAndUpdate(key, { $setOnInsert: {
        ...key, owner_subject: context.subject, agent_id: agentId,
        conversation_id: context.conversationId, harness_id: harnessId,
      } }, { upsert: true, returnDocument: "after" });
      if (!binding) throw new Error("Backend binding could not be saved");
    }
    const harnessId = normalizedHarnessId(binding.harness_id);
    if (harnessId !== DEFAULT_HARNESS_ID) {
      const config = getHarnessEngineConfig();
      if (config instanceof NextResponse) return config;
    }
    return { kind: harnessId === DEFAULT_HARNESS_ID ? "dynamic_agents" : "harness_engine", harnessId };
  } catch (error) {
    console.error("[harness-gateway] Failed to resolve agent runtime", { agentId, error });
    return NextResponse.json({ success: false, error: "Agent runtime could not be resolved" }, { status: 503 });
  }
}

function engineErrorMessage<T>(envelope: Envelope<T>, fallback: string): string {
  if (envelope.error) return envelope.error;
  if (typeof envelope.detail === "string") return envelope.detail;
  if (envelope.detail && typeof envelope.detail.message === "string") {
    return envelope.detail.message;
  }
  return fallback;
}

async function readEnvelope<T>(response: Response): Promise<Envelope<T>> {
  try {
    return await response.json() as Envelope<T>;
  } catch {
    return { success: false, error: `Harness Engine returned HTTP ${response.status}` };
  }
}

async function engineRequest(
  config: HarnessEngineConfig,
  auth: Pick<AuthResult, "subject" | "traceparent">,
  path: string,
  init: RequestInit,
): Promise<Response | NextResponse> {
  const headers = buildHarnessEngineHeaders(config, auth);
  if (headers instanceof NextResponse) return headers;
  try {
    return await fetch(`${config.url}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
      cache: "no-store",
    });
  } catch (error) {
    console.error("[harness-gateway] Harness Engine request failed", { path, error });
    return NextResponse.json(
      { success: false, error: "Harness Engine is unavailable" },
      { status: 503 },
    );
  }
}

async function startRun(
  body: Record<string, unknown>,
  auth: Pick<AuthResult, "subject" | "traceparent">,
): Promise<{ config: HarnessEngineConfig; run: HarnessRun } | NextResponse> {
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;

  const response = await engineRequest(config, auth, "/api/v1/runs", {
    method: "POST",
    body: JSON.stringify({
      agent_id: body.agent_id,
      conversation_id: body.conversation_id,
      message: body.message,
      ...(typeof body.context === "string" && body.context.trim() && {
        context: body.context,
      }),
      ...(typeof body.client_request_id === "string" && {
        client_request_id: body.client_request_id,
      }),
    }),
  });
  if (response instanceof NextResponse) return response;
  const envelope = await readEnvelope<HarnessRun>(response);
  if (!response.ok || !envelope.success || !envelope.data?.run_id) {
    return NextResponse.json(
      {
        success: false,
        error: engineErrorMessage(envelope, "Harness run could not be started"),
      },
      { status: response.status || 502 },
    );
  }
  return { config, run: envelope.data };
}

function sseFrame(event: string, data: Record<string, unknown>, id?: number): string {
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function stringField(data: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = data[name];
    if (typeof value === "string") return value;
  }
  return "";
}

function closeMessage(
  protocol: GatewayProtocol,
  state: GatewayStreamState,
  sequence: number,
): string[] {
  if (protocol !== "agui" || !state.messageStarted) return [];
  state.messageStarted = false;
  return [sseFrame("TEXT_MESSAGE_END", {
    type: "TEXT_MESSAGE_END",
    messageId: state.messageId,
  }, sequence)];
}

function aguiFrames(
  event: HarnessRunEvent,
  run: HarnessRun,
  state: GatewayStreamState,
): string[] {
  const { data, event_type: eventType, sequence } = event;
  if (state.terminalSent) return [];
  switch (eventType) {
    case "run.started":
      return [sseFrame("RUN_STARTED", {
        type: "RUN_STARTED",
        runId: run.run_id,
        threadId: run.conversation_id,
      }, sequence)];
    case "content.delta": {
      const frames: string[] = [];
      if (!state.messageStarted) {
        state.messageStarted = true;
        frames.push(sseFrame("TEXT_MESSAGE_START", {
          type: "TEXT_MESSAGE_START",
          messageId: state.messageId,
          role: "assistant",
        }, sequence));
      }
      frames.push(sseFrame("TEXT_MESSAGE_CONTENT", {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: state.messageId,
        delta: stringField(data, "text", "delta"),
      }, sequence));
      return frames;
    }
    case "reasoning.delta":
      return [sseFrame("CUSTOM", {
        type: "CUSTOM",
        name: "REASONING_DELTA",
        value: { delta: stringField(data, "text", "delta") },
      }, sequence)];
    case "tool.started": {
      const toolCallId = stringField(data, "tool_call_id", "id");
      const toolName = stringField(data, "tool_name", "name");
      if (toolCallId) state.toolNames.set(toolCallId, toolName);
      const frames = [sseFrame("TOOL_CALL_START", {
        type: "TOOL_CALL_START",
        toolCallId,
        toolCallName: toolName,
      }, sequence)];
      if (data.arguments !== undefined) {
        frames.push(sseFrame("TOOL_CALL_ARGS", {
          type: "TOOL_CALL_ARGS",
          toolCallId,
          delta: JSON.stringify(data.arguments),
        }, sequence));
      }
      return frames;
    }
    case "tool.completed": {
      const toolCallId = stringField(data, "tool_call_id", "id");
      const result = data.result ?? data.content ?? "";
      state.toolNames.delete(toolCallId);
      return [
        sseFrame("TOOL_CALL_RESULT", {
          type: "TOOL_CALL_RESULT",
          messageId: `${state.messageId}-tool-${toolCallId}`,
          toolCallId,
          role: "tool",
          content: typeof result === "string" ? result : JSON.stringify(result),
        }, sequence),
        sseFrame("TOOL_CALL_END", {
          type: "TOOL_CALL_END",
          toolCallId,
        }, sequence),
      ];
    }
    case "interrupt.requested": {
      state.terminalSent = true;
      return [
        ...closeMessage("agui", state, sequence),
        sseFrame("RUN_FINISHED", {
          type: "RUN_FINISHED",
          runId: run.run_id,
          threadId: run.conversation_id,
          outcome: "interrupt",
          interrupt: {
            id: stringField(data, "interrupt_id", "id"),
            reason: data.interrupt_type === "tool_approval" ? "tool_approval" : "human_input",
            payload: data,
          },
        }, sequence),
      ];
    }
    case "run.completed":
      state.terminalSent = true;
      return [
        ...closeMessage("agui", state, sequence),
        sseFrame("RUN_FINISHED", {
          type: "RUN_FINISHED",
          runId: run.run_id,
          threadId: run.conversation_id,
          outcome: "success",
        }, sequence),
      ];
    case "run.failed":
      state.terminalSent = true;
      return [
        ...closeMessage("agui", state, sequence),
        sseFrame("RUN_ERROR", {
          type: "RUN_ERROR",
          message: stringField(data, "message") || "Harness execution failed",
          code: stringField(data, "code") || "harness_error",
        }, sequence),
      ];
    case "run.cancelled":
      state.terminalSent = true;
      return [
        ...closeMessage("agui", state, sequence),
        sseFrame("RUN_FINISHED", {
          type: "RUN_FINISHED",
          runId: run.run_id,
          threadId: run.conversation_id,
          outcome: "cancelled",
        }, sequence),
      ];
    default:
      return [];
  }
}

function customFrames(
  event: HarnessRunEvent,
  state: GatewayStreamState,
): string[] {
  const { data, event_type: eventType, sequence } = event;
  if (state.terminalSent) return [];
  switch (eventType) {
    case "content.delta":
      return [sseFrame("content", { text: stringField(data, "text", "delta"), namespace: [] }, sequence)];
    case "reasoning.delta":
      return [sseFrame("thinking", { text: stringField(data, "text", "delta") }, sequence)];
    case "tool.started":
      return [sseFrame("tool_start", {
        tool_call_id: stringField(data, "tool_call_id", "id"),
        tool_name: stringField(data, "tool_name", "name"),
        args: data.arguments ?? {},
        namespace: [],
      }, sequence)];
    case "tool.completed":
      return [sseFrame("tool_end", {
        tool_call_id: stringField(data, "tool_call_id", "id"),
        result: data.result ?? data.content ?? "",
        namespace: [],
      }, sequence)];
    case "interrupt.requested":
      state.terminalSent = true;
      return [sseFrame("input_required", data, sequence)];
    case "run.completed":
      state.terminalSent = true;
      return [sseFrame("done", {}, sequence)];
    case "run.failed":
      state.terminalSent = true;
      return [sseFrame("error", {
        error: stringField(data, "message") || "Harness execution failed",
        code: stringField(data, "code") || "harness_error",
      }, sequence)];
    case "run.cancelled":
      state.terminalSent = true;
      return [sseFrame("done", { outcome: "cancelled" }, sequence)];
    default:
      return [];
  }
}

export function encodeHarnessGatewayEvent(
  event: HarnessRunEvent,
  run: HarnessRun,
  protocol: GatewayProtocol,
  state: GatewayStreamState,
): string[] {
  return protocol === "agui"
    ? aguiFrames(event, run, state)
    : customFrames(event, state);
}

function parseCanonicalFrame(frame: string): { event: string; data: Record<string, unknown>; id: number } | null {
  let event = "message";
  let id = 0;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("id:")) id = Number(line.slice(3).trim()) || 0;
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try {
    return { event, id, data: JSON.parse(data.join("\n")) as Record<string, unknown> };
  } catch {
    return null;
  }
}

function translateCanonicalStream(
  source: ReadableStream<Uint8Array>,
  run: HarnessRun,
  protocol: GatewayProtocol,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const state: GatewayStreamState = {
    messageId: `message-${run.run_id}`,
    messageStarted: false,
    terminalSent: false,
    toolNames: new Map(),
  };

  function drain(controller: TransformStreamDefaultController<Uint8Array>, flush = false): void {
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const parsed = parseCanonicalFrame(frame);
      if (!parsed) {
        if (frame.startsWith(":")) controller.enqueue(encoder.encode(": keepalive\n\n"));
        continue;
      }
      const canonical: HarnessRunEvent = {
        run_id: run.run_id,
        sequence: parsed.id,
        event_type: parsed.event as HarnessRunEvent["event_type"],
        data: parsed.data,
      };
      for (const output of encodeHarnessGatewayEvent(canonical, run, protocol, state)) {
        controller.enqueue(encoder.encode(output));
      }
    }
    if (flush && buffer.trim()) {
      const parsed = parseCanonicalFrame(buffer);
      if (parsed) {
        const canonical: HarnessRunEvent = {
          run_id: run.run_id,
          sequence: parsed.id,
          event_type: parsed.event as HarnessRunEvent["event_type"],
          data: parsed.data,
        };
        for (const output of encodeHarnessGatewayEvent(canonical, run, protocol, state)) {
          controller.enqueue(encoder.encode(output));
        }
      }
      buffer = "";
    }
  }

  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      drain(controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      drain(controller, true);
    },
  }));
}

export async function streamHarnessGatewayRun(
  body: Record<string, unknown>,
  auth: Pick<AuthResult, "subject" | "traceparent">,
  signal?: AbortSignal,
): Promise<Response> {
  if (body.files && Array.isArray(body.files) && body.files.length > 0) {
    return NextResponse.json(
      { success: false, code: "HARNESS_CAPABILITY_UNSUPPORTED", error: "The selected harness does not support file attachments" },
      { status: 409 },
    );
  }
  const started = await startRun(body, auth);
  if (started instanceof NextResponse) return started;
  const protocol: GatewayProtocol = body.protocol === "agui" ? "agui" : "custom";
  const headers = buildHarnessEngineHeaders(started.config, auth);
  if (headers instanceof NextResponse) return headers;
  headers.Accept = "text/event-stream";

  let upstream: Response;
  try {
    upstream = await fetch(
      `${started.config.url}/api/v1/runs/${encodeURIComponent(started.run.run_id)}/events/stream?after=0`,
      { method: "GET", headers, cache: "no-store", signal },
    );
  } catch (error) {
    if (signal?.aborted) return new Response(null, { status: 499 });
    console.error("[harness-gateway] Event subscription failed", {
      runId: started.run.run_id,
      error,
    });
    return NextResponse.json(
      { success: false, error: "Harness run started but its event stream is unavailable", run_id: started.run.run_id },
      { status: 503, headers: { "X-Harness-Run-ID": started.run.run_id } },
    );
  }
  if (!upstream.ok || !upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
        "X-Harness-Run-ID": started.run.run_id,
      },
    });
  }
  return new Response(translateCanonicalStream(upstream.body, started.run, protocol), {
    status: 200,
    headers: {
      ...SSE_HEADERS,
      "X-Harness-Run-ID": started.run.run_id,
      "X-Harness-ID": started.run.harness_id,
    },
  });
}

export async function invokeHarnessGatewayRun(
  body: Record<string, unknown>,
  auth: Pick<AuthResult, "subject" | "traceparent">,
  signal?: AbortSignal,
): Promise<Response> {
  const started = await startRun(body, auth);
  if (started instanceof NextResponse) return started;
  let cursor = 0;
  let content = "";
  let thinking = "";
  let failure: Record<string, unknown> | undefined;
  const deadline = Date.now() + 290_000;

  while (Date.now() < deadline) {
    const waitSeconds = Math.min(30, Math.max(0, (deadline - Date.now()) / 1000));
    const response = await engineRequest(
      started.config,
      auth,
      `/api/v1/runs/${encodeURIComponent(started.run.run_id)}/events?after=${cursor}&wait=${waitSeconds}`,
      { method: "GET", signal },
    );
    if (response instanceof NextResponse) return response;
    const envelope = await readEnvelope<HarnessEventPage>(response);
    if (!response.ok || !envelope.success || !envelope.data) {
      return NextResponse.json(
        { success: false, error: engineErrorMessage(envelope, "Harness run events are unavailable"), run_id: started.run.run_id },
        { status: response.status || 502 },
      );
    }
    if (!Number.isInteger(envelope.data.run.last_sequence) || envelope.data.run.last_sequence < 0 ||
        !Number.isInteger(envelope.data.next_cursor) || envelope.data.next_cursor < cursor) {
      return NextResponse.json({ success: false, error: "Harness Engine returned an invalid event cursor", run_id: started.run.run_id }, { status: 502 });
    }
    for (const event of envelope.data.events) {
      if (event.event_type === "content.delta") content += stringField(event.data, "text", "delta");
      if (event.event_type === "reasoning.delta") thinking += stringField(event.data, "text", "delta");
      if (event.event_type === "run.failed") failure = event.data;
    }
    cursor = envelope.data.next_cursor;
    const status = envelope.data.run.status;
    if (["completed", "failed", "cancelled"].includes(status) && cursor >= envelope.data.run.last_sequence) {
      if (status === "completed") {
        return NextResponse.json({
          success: true,
          content,
          ...(thinking && { thinking }),
          agent_id: body.agent_id,
          conversation_id: body.conversation_id,
          trace_id: body.trace_id,
          run_id: started.run.run_id,
        });
      }
      return NextResponse.json(
        {
          success: false,
          error: stringField(failure ?? {}, "message") || `Harness run ${status}`,
          code: stringField(failure ?? {}, "code") || `harness_run_${status}`,
          agent_id: body.agent_id,
          conversation_id: body.conversation_id,
          run_id: started.run.run_id,
        },
        { status: status === "cancelled" ? 409 : 502 },
      );
    }
  }
  return NextResponse.json(
    { success: false, error: "Harness run is still active", code: "HARNESS_RUN_TIMEOUT", run_id: started.run.run_id },
    { status: 504 },
  );
}

export async function cancelHarnessGatewayRun(
  body: Record<string, unknown>,
  auth: Pick<AuthResult, "subject" | "traceparent">,
): Promise<Response> {
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;
  const response = await engineRequest(config, auth, "/api/v1/runs/cancel-active", {
    method: "POST",
    body: JSON.stringify({
      agent_id: body.agent_id,
      conversation_id: body.conversation_id,
    }),
  });
  if (response instanceof NextResponse) return response;
  const envelope = await readEnvelope<{ cancelled: boolean; run_id?: string; cancellation_requested?: boolean }>(response);
  if (!response.ok || !envelope.success || !envelope.data) {
    return NextResponse.json(
      { success: false, error: engineErrorMessage(envelope, "Harness run could not be cancelled") },
      { status: response.status || 502 },
    );
  }
  return NextResponse.json({
    success: true,
    cancelled: envelope.data.cancelled,
    cancellation_requested: envelope.data.cancellation_requested ?? false,
    run_id: envelope.data.run_id,
    agent_id: body.agent_id,
    conversation_id: body.conversation_id,
  });
}

export function unsupportedHarnessResume(): NextResponse {
  return NextResponse.json(
    {
      success: false,
      code: "HARNESS_CAPABILITY_UNSUPPORTED",
      error: "The selected harness does not support human-input resume yet",
    },
    { status: 409 },
  );
}

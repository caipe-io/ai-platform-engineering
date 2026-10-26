import { createHash } from "node:crypto";
import { getAgentId } from "@/types/a2a";
import { authorizeConversationReadAccess, authorizeConversationWriteAccess, resolveConversationRuntimeId } from "@/app/api/v1/chat/_conversation-authz";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";
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
  history?: { owner: "server"; user_message_id: string; assistant_message_id: string };
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

/** Read-only pin lookup; app registration changes cannot steal an existing runtime. */
export async function lookupPinnedHarnessGatewayTarget(
  agentId: string, context: { subject: string; conversationId: string },
): Promise<HarnessGatewayTarget | NextResponse | null> {
  try {
    const bindings = await getCollection<GatewayBinding>("harness_gateway_bindings");
    const id = gatewayBindingId(agentId, context.subject, context.conversationId);
    const binding = await bindings.findOne({ _id: id });
    if (!binding) return null;
    if (binding._id !== id || binding.owner_subject !== context.subject || binding.agent_id !== agentId ||
        binding.conversation_id !== context.conversationId || typeof binding.harness_id !== "string" || !binding.harness_id.trim()) {
      return NextResponse.json({ error: "The retained runtime binding is invalid" }, { status: 409 });
    }
    if (binding.harness_id !== DEFAULT_HARNESS_ID) {
      const config = getHarnessEngineConfig();
      if (config instanceof NextResponse) return config;
    }
    return { kind: binding.harness_id === DEFAULT_HARNESS_ID ? "dynamic_agents" : "harness_engine", harnessId: binding.harness_id };
  } catch {
    return NextResponse.json({ error: "Agent runtime could not be resolved" }, { status: 503 });
  }
}

/** Resolve the owner/conversation's pinned backend before an agent default. */
export async function resolveHarnessGatewayTarget(
  agentId: string,
  context: { subject: string; conversationId: string; traceparent?: string },
  options: { readOnly?: boolean } = {},
): Promise<HarnessGatewayTarget | NextResponse> {
  try {
    const bindings = await getCollection<GatewayBinding>("harness_gateway_bindings");
    const key = { _id: gatewayBindingId(agentId, context.subject, context.conversationId) };
    let binding = await bindings.findOne(key);
    if (!binding) {
      // Apps without a retained runtime use their declared operation endpoints.
      if (findAgenticAppAssistantStream(agentId)) {
        return NextResponse.json({ success: false, code: "APP_STREAM_REQUIRED",
          error: "This app assistant requires its declared chat stream endpoints" }, { status: 501 });
      }

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
      const selected = { ...key, owner_subject: context.subject, agent_id: agentId,
        conversation_id: context.conversationId, harness_id: harnessId };
      binding = options.readOnly ? selected : await bindings.findOneAndUpdate(key,
        { $setOnInsert: selected }, { upsert: true, returnDocument: "after" });
      if (!binding) throw new Error("Backend binding could not be saved");
    }
    if (binding._id !== key._id || binding.owner_subject !== context.subject ||
        binding.agent_id !== agentId || binding.conversation_id !== context.conversationId ||
        typeof binding.harness_id !== "string" || !binding.harness_id.trim()) {
      return NextResponse.json({ error: "The retained runtime binding is invalid" }, { status: 409 });
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

interface StartedRun {
  config: HarnessEngineConfig;
  run: HarnessRun;
  history?: { owner: "server"; user_message_id: string; assistant_message_id: string };
}

function matchingRun(run: HarnessRun, body: Record<string, unknown>, subject: string): boolean {
  return (run.owner_subject === undefined || run.owner_subject === subject) &&
    run.agent_id === body.agent_id && run.conversation_id === body.conversation_id &&
    (body.expected_harness_id === undefined || run.harness_id === body.expected_harness_id);
}

function invalidRun(): NextResponse {
  return NextResponse.json({ success: false, error: "Harness run identity or history contract does not match this conversation" }, { status: 502 });
}

function validatedHistory(history: Envelope<unknown>["history"], run: HarnessRun, visibleId?: unknown): StartedRun["history"] | false {
  if (history === undefined) return undefined;
  if (history?.owner !== "server" || history.user_message_id !== `user-${run.run_id}` ||
      history.assistant_message_id !== `message-${run.run_id}` ||
      !run.visible_conversation_id || (visibleId !== undefined && run.visible_conversation_id !== visibleId)) return false;
  return history;
}

function runHeaders(started: StartedRun): Record<string, string> {
  return {
    "X-Harness-Run-ID": started.run.run_id, "X-Harness-ID": started.run.harness_id,
    ...(started.history && {
      "X-Harness-History-Owner": "server",
      "X-Harness-User-Message-ID": started.history.user_message_id,
      "X-Harness-Assistant-Message-ID": started.history.assistant_message_id,
      "X-Harness-Conversation-ID": started.run.visible_conversation_id!,
    }),
  };
}

interface HarnessAttachment { id: string; name: string; media_type: string; size_bytes: number; sha256?: string }

async function prepareAttachments(
  body: Record<string, unknown>, config: HarnessEngineConfig,
  auth: Pick<AuthResult, "subject" | "traceparent">,
): Promise<HarnessAttachment[] | NextResponse> {
  const files = body.files;
  if (!Array.isArray(files) || !files.length) return Array.isArray(body.attachments) ? body.attachments as HarnessAttachment[] : [];
  if (files.length > 20 || (Array.isArray(body.attachments) && body.attachments.length)) {
    return NextResponse.json({ error: "Use at most 20 attachments in one format" }, { status: 400 });
  }
  const refs: HarnessAttachment[] = [];
  for (const file of files) {
    if (!file || typeof file !== "object" || typeof file.name !== "string" || !file.name || file.name.length > 255 ||
        typeof file.mime_type !== "string" || file.mime_type.length > 128 ||
        typeof file.data !== "string" || !file.data || file.data.length > 4 * Math.ceil(10 * 1024 * 1024 / 3)) {
      return NextResponse.json({ error: "Each attachment must be a named file no larger than 10 MiB" }, { status: 400 });
    }
    // Engine validates the retained provider/profile and stores scoped, deduplicated
    // bytes. Only its opaque reference enters the provider's admitted prompt.
    const response = await engineRequest(config, auth, "/api/v1/attachments", {
      method: "POST", body: JSON.stringify({ agent_id: body.agent_id, conversation_id: body.conversation_id,
        ...(body.expected_harness_id && { expected_harness_id: body.expected_harness_id }),
        ...(typeof body.visible_conversation_id === "string" && { visible_conversation_id: body.visible_conversation_id }),
        name: file.name, media_type: file.mime_type, data: file.data }),
    });
    if (response instanceof NextResponse) return response;
    const envelope = await readEnvelope<HarnessAttachment>(response);
    if (!response.ok || !envelope.success || !envelope.data) {
      return NextResponse.json({ code: "HARNESS_CAPABILITY_UNSUPPORTED", error: engineErrorMessage(envelope, "The selected profile does not support these attachments") }, { status: response.status || 502 });
    }
    const ref = envelope.data;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(ref.id) || ref.name !== file.name || ref.media_type !== file.mime_type ||
        !Number.isSafeInteger(ref.size_bytes) || ref.size_bytes < 0 || ref.size_bytes > 10 * 1024 * 1024 ||
        (ref.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(ref.sha256))) return invalidRun();
    refs.push({ id: ref.id, name: ref.name, media_type: ref.media_type, size_bytes: ref.size_bytes, ...(ref.sha256 && { sha256: ref.sha256 }) });
  }
  return refs;
}

async function startRun(
  body: Record<string, unknown>,
  auth: Pick<AuthResult, "subject" | "traceparent">,
): Promise<StartedRun | NextResponse> {
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;

  const attachments = await prepareAttachments(body, config, auth);
  if (attachments instanceof NextResponse) return attachments;

  const response = await engineRequest(config, auth, "/api/v1/runs", {
    method: "POST",
    body: JSON.stringify({
      agent_id: body.agent_id,
      conversation_id: body.conversation_id,
      message: body.message,
      protocol: body.protocol === "custom" ? "custom" : "agui",
      ...(typeof body.expected_harness_id === "string" && { expected_harness_id: body.expected_harness_id }),
      ...(typeof body.visible_conversation_id === "string" && { visible_conversation_id: body.visible_conversation_id }),
      ...(attachments.length && { attachments }),
      ...(typeof body.context === "string" && body.context.trim() && {
        context: body.context,
      }),
      ...(typeof (body.turn_id ?? body.client_request_id) === "string" && {
        client_request_id: body.turn_id ?? body.client_request_id,
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
  if (!matchingRun(envelope.data, body, auth.subject)) return invalidRun();
  const history = validatedHistory(envelope.history, envelope.data, body.visible_conversation_id);
  if (history === false || (history && envelope.data.owner_subject !== auth.subject)) return invalidRun();
  return { config, run: envelope.data, history: history || undefined };
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
      if (run.contract_version === 2 && sequence <= run.last_sequence &&
          stringField(data, "interrupt_id", "id") !== run.pending_interrupt_id) return [];
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
    case "run.interrupted":
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
  run: HarnessRun,
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
      if (run.contract_version === 2 && sequence <= run.last_sequence &&
          stringField(data, "interrupt_id", "id") !== run.pending_interrupt_id) return [];
      state.terminalSent = true;
      return [sseFrame("input_required", data, sequence)];
    case "run.completed":
      state.terminalSent = true;
      return [sseFrame("done", {}, sequence)];
    case "run.interrupted":
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
    : customFrames(event, run, state);
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
  const started = await startRun(body, auth);
  if (started instanceof NextResponse) return started;
  return subscribeRun(started, auth, body.protocol === "agui" ? "agui" : "custom", signal);
}

async function subscribeRun(
  started: StartedRun, auth: Pick<AuthResult, "subject" | "traceparent">,
  protocol: GatewayProtocol, signal?: AbortSignal, after = 0,
): Promise<Response> {

  const headers = buildHarnessEngineHeaders(started.config, auth);
  if (headers instanceof NextResponse) return headers;
  headers.Accept = "text/event-stream";

  let upstream: Response;
  try {
    upstream = await fetch(
      `${started.config.url}/api/v1/runs/${encodeURIComponent(started.run.run_id)}/events/stream?after=${after}`,
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
      { status: 503, headers: runHeaders(started) },
    );
  }
  if (!upstream.ok || !upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
        ...runHeaders(started),
      },
    });
  }
  return new Response(translateCanonicalStream(upstream.body, started.run, protocol), {
    status: 200,
    headers: {
      ...SSE_HEADERS,
      ...runHeaders(started),
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
        { status: response.status || 502, headers: runHeaders(started) },
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
    if (["completed", "failed", "cancelled", "interrupted"].includes(status) && cursor >= envelope.data.run.last_sequence) {
      if (status === "completed") {
        return NextResponse.json({
          success: true,
          content,
          ...(thinking && { thinking }),
          agent_id: body.agent_id,
          conversation_id: body.conversation_id,
          trace_id: body.trace_id,
          run_id: started.run.run_id,
        }, { headers: runHeaders(started) });
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
        { status: status === "cancelled" ? 409 : 502, headers: runHeaders(started) },
      );
    }
  }
  return NextResponse.json(
    { success: false, error: "Harness run is still active", code: "HARNESS_RUN_TIMEOUT", run_id: started.run.run_id },
    { status: 504, headers: runHeaders(started) },
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

async function latestRun(body: Record<string, unknown>, auth: Pick<AuthResult, "subject" | "traceparent">): Promise<StartedRun | NextResponse> {
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;
  const query = new URLSearchParams({ agent_id: String(body.agent_id), conversation_id: String(body.conversation_id) });
  const response = await engineRequest(config, auth, `/api/v1/runs/latest?${query}`, { method: "GET" });
  if (response instanceof NextResponse) return response;
  const envelope = await readEnvelope<HarnessRun | null>(response);
  if (!response.ok || !envelope.success) return NextResponse.json({ error: engineErrorMessage(envelope, "Harness status is unavailable") }, { status: response.status || 502 });
  if (!envelope.data) return NextResponse.json({ success: true, data: null });
  if (!matchingRun(envelope.data, body, auth.subject)) return invalidRun();
  const history = validatedHistory(envelope.history, envelope.data, body.visible_conversation_id);
  if (history === false || (history && envelope.data.owner_subject !== auth.subject)) return invalidRun();
  return { config, run: envelope.data, history: history || undefined };
}

export async function statusHarnessGatewayRun(body: Record<string, unknown>, auth: Pick<AuthResult, "subject" | "traceparent">, signal?: AbortSignal): Promise<Response> {
  const latest = await latestRun(body, auth);
  if (latest instanceof NextResponse) return latest;
  if (body.replay === true && latest.history) {
    return subscribeRun(latest, auth, body.protocol === "agui" ? "agui" : "custom", signal);
  }
  if (!latest.history && (latest.run.contract_version ?? 1) >= 2 && !latest.run.capabilities?.["history.server_owned"]) return invalidRun();
  const retainedServerHistory = ["native", "emulated"].includes(latest.run.capabilities?.["history.server_owned"]?.level ?? "");
  return NextResponse.json({ success: true, data: { run: latest.run, history: latest.history,
    history_owner: latest.history ? "server" : retainedServerHistory ? "pending" : "client" } }, {
    headers: !latest.history && !retainedServerHistory ? { "X-Harness-History-Owner": "client" } : {},
  });
}

export async function resumeHarnessGatewayRun(body: Record<string, unknown>, auth: Pick<AuthResult, "subject" | "traceparent">, signal?: AbortSignal): Promise<Response> {
  const latest = await latestRun(body, auth);
  if (latest instanceof NextResponse) return latest;
  if (!latest.history) return unsupportedHarnessResume();
  let decision: unknown;
  try { decision = typeof body.resume_data === "string" ? JSON.parse(body.resume_data) : body.resume_data; }
  catch { return NextResponse.json({ error: "Invalid resume decision" }, { status: 400 }); }
  if (!decision || typeof decision !== "object" || Array.isArray(decision) || typeof (decision as Record<string, unknown>).interrupt_id !== "string" || typeof body.turn_id !== "string") {
    return NextResponse.json({ error: "A decision identifier and interrupt_id are required" }, { status: 400 });
  }
  const response = await engineRequest(latest.config, auth, `/api/v1/runs/${encodeURIComponent(latest.run.run_id)}/input`, {
    method: "POST", body: JSON.stringify({ client_request_id: body.turn_id, decision }),
  });
  if (response instanceof NextResponse) return response;
  const envelope = await readEnvelope<{ run: HarnessRun; after_cursor: number; history: StartedRun["history"] }>(response);
  if (!response.ok || !envelope.success || !envelope.data) return NextResponse.json({ error: engineErrorMessage(envelope, "The input could not be submitted") }, { status: response.status || 502 });
  const accepted = envelope.data;
  if (!matchingRun(accepted.run, body, auth.subject) || accepted.run.run_id !== latest.run.run_id ||
      !Number.isSafeInteger(accepted.after_cursor) || accepted.after_cursor < 0 ||
      (!validatedHistory(accepted.history, accepted.run, body.visible_conversation_id) || accepted.run.owner_subject !== auth.subject)) return invalidRun();
  return subscribeRun({ ...latest, run: accepted.run }, auth, body.protocol === "agui" ? "agui" : "custom", signal, accepted.after_cursor);
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


/** A single owner/conversation boundary for controls beside the shared chat stream. */
export async function proxyHarnessConversationOperation(
  auth: AuthResult, conversationId: string, requestedAgentId: string | undefined,
  operation: "interrupt" | "files" | "file" | "delete-file" | "write-file" | "clear" | "restart" | "cancel",
  filePath?: string,
): Promise<Response | null> {
  const access = operation === "interrupt" || operation === "files" || operation === "file"
    ? await authorizeConversationReadAccess(auth, conversationId, requestedAgentId)
    : await authorizeConversationWriteAccess(auth, conversationId, requestedAgentId);
  if (access.denial) return access.denial;
  const agentId = requestedAgentId ?? getAgentId(access.conversation);
  if (!agentId) return NextResponse.json({ error: "Conversation has no agent" }, { status: 409 });
  const denied = await requireAgentUsePermission({ subject: auth.subject, email: auth.email,
    tenantId: auth.tenantId, isServiceAccount: auth.isServiceAccount, agentId });
  if (denied) return denied;
  const runtimeId = await resolveConversationRuntimeId(access.conversation);
  const context = { subject: auth.subject, conversationId: runtimeId };
  let target = await lookupPinnedHarnessGatewayTarget(agentId, context);
  if (target instanceof NextResponse) return target;
  if (!target) {
    const agents = await getCollection<AgentRuntimeRecord>("dynamic_agents");
    const agent = await agents.findOne({ _id: agentId }, { projection: { execution_harness_id: 1 } });
    if (normalizedHarnessId(agent?.execution_harness_id) === DEFAULT_HARNESS_ID) return null;
    target = await resolveHarnessGatewayTarget(agentId, context, { readOnly: true });
    if (target instanceof NextResponse) return target;
  }
  if (target.kind !== "harness_engine") return null;
  const body = { agent_id: agentId, conversation_id: runtimeId, visible_conversation_id: conversationId, expected_harness_id: target.harnessId };
  const latest = await latestRun(body, auth);
  let registered: StartedRun | undefined;
  let serverOwned = false;
  if (latest instanceof NextResponse) {
    if (!latest.ok) return latest;
  } else {
    registered = latest;
    serverOwned = !!latest.history || ["native", "emulated"].includes(latest.run.capabilities?.["history.server_owned"]?.level ?? "");
    // Retained runs own their capability snapshot even after the catalog changes.
    if (!serverOwned) return null;
  }
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;
  if (!registered) {
    const response = await engineRequest(config, auth, "/api/v1/harnesses", { method: "GET" });
    if (response instanceof NextResponse) return response;
    const envelope = await readEnvelope<{ harnesses: Array<{ id: string; capabilities: Record<string, { level: string }> }> }>(response);
    if (!response.ok || !envelope.success || !envelope.data) return NextResponse.json({ error: "Runtime capabilities are unavailable" }, { status: 503 });
    const descriptor = envelope.data.harnesses.find(item => item.id === target.harnessId);
    serverOwned = !!descriptor && ["native", "emulated"].includes(descriptor.capabilities["history.server_owned"]?.level);
    if (!serverOwned) return null;
  }
  if (operation === "interrupt") {
    if (!registered) return NextResponse.json({ has_pending_interrupt: false });
    const response = await engineRequest(config, auth, `/api/v1/runs/${encodeURIComponent(registered.run.run_id)}/input`, { method: "GET" });
    if (response instanceof NextResponse) return response;
    const envelope = await readEnvelope<Record<string, unknown> | null>(response);
    if (!response.ok || !envelope.success) return NextResponse.json({ error: engineErrorMessage(envelope, "Pending input is unavailable") }, { status: response.status || 502 });
    return NextResponse.json({ has_pending_interrupt: !!envelope.data, interrupt_data: envelope.data });
  }
  if (operation === "files" || operation === "file") {
    const capability = registered?.run.capabilities?.[operation === "files" ? "files.list" : "files.read"];
    if (registered && !["native", "emulated"].includes(capability?.level ?? "")) {
      return NextResponse.json({ code: "HARNESS_CAPABILITY_UNAVAILABLE", error: "Workspace artifacts are unavailable for this retained profile" }, { status: 501 });
    }
    if (operation === "file" && (!filePath || filePath.length > 1024)) return NextResponse.json({ error: "A valid workspace artifact path is required" }, { status: 400 });
    const query = new URLSearchParams({ agent_id: agentId, conversation_id: runtimeId, visible_conversation_id: conversationId });
    if (filePath) query.set("path", filePath);
    const response = await engineRequest(config, auth, `/api/v1/files/${operation === "files" ? "list" : "content"}?${query}`, { method: "GET" });
    if (response instanceof NextResponse) return response;
    const envelope = await readEnvelope<Record<string, unknown>>(response);
    if (!response.ok || !envelope.success || !envelope.data) return NextResponse.json({ error: engineErrorMessage(envelope, "Workspace snapshot is unavailable") }, { status: response.status || 502 });
    return NextResponse.json(envelope.data, { headers: { "X-Harness-File-Snapshot": "acknowledged" } });
  }
  if (operation === "cancel") return cancelHarnessGatewayRun(body, auth);
  if (operation === "clear") {
    const response = await engineRequest(config, auth, "/api/v1/sessions/clear", { method: "POST", body: JSON.stringify({ agent_id: agentId, conversation_id: runtimeId }) });
    if (response.ok) await clearHarnessGatewayBinding(agentId, auth.subject, runtimeId);
    return response;
  }
  return NextResponse.json({ success: false, code: "HARNESS_CAPABILITY_UNAVAILABLE",
    error: operation === "restart" ? "This runtime cannot restart in place. Start a new conversation to reset it."
      : "Workspace file browsing is not available for this runtime profile" }, { status: 501 });
}

/** Interpret only the canonical conversation filesystem namespace. */
export function conversationFileNamespace(value: unknown): { agentId: string; conversationId: string } | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) && parsed.length === 3 && parsed[2] === "filesystem" &&
      typeof parsed[0] === "string" && !!parsed[0] && typeof parsed[1] === "string" && !!parsed[1]
      ? { agentId: parsed[0], conversationId: parsed[1] } : null;
  } catch { return null; }
}

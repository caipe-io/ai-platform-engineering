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
import { stageHarnessAttachments } from "@/lib/harness-attachments";
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
  runtime?: "dynamic_agents" | "harness_engine";
  transition_id?: string;
  native_thread_id?: string;
}

export function gatewayBindingId(agentId: string, subject: string, conversationId: string): string {
  return createHash("sha256").update(JSON.stringify([subject, agentId, conversationId])).digest("hex");
}

export async function clearHarnessGatewayBinding(agentId: string, subject: string, conversationId: string): Promise<void> {
  const bindings = await getCollection<GatewayBinding>("harness_gateway_bindings");
  // Clear rotates the native epoch. Retain execution ownership so an optional
  // Engine outage cannot restore the old pre-clear native checkpoint.
  const agent = await (await getCollection<AgentRuntimeRecord>("dynamic_agents")).findOne({ _id: agentId });
  await bindings.updateOne({ _id: gatewayBindingId(agentId, subject, conversationId) }, {
    $unset: { native_thread_id: "" },
    ...(agent && { $set: { harness_id: normalizedHarnessId(agent.execution_harness_id) } }),
  });
}

export async function getPinnedHarnessGatewayTarget(agentId: string, subject: string, conversationId: string): Promise<HarnessGatewayTarget | NextResponse | null> {
  const binding = await (await getCollection<GatewayBinding>("harness_gateway_bindings")).findOne({ _id: gatewayBindingId(agentId, subject, conversationId) });
  if (!binding) return null;
  if (binding.transition_id) return NextResponse.json({ error: "Session handoff is in progress; retry its migration to recover" }, { status: 409 });
  return { kind: binding.runtime ?? (binding.harness_id === DEFAULT_HARNESS_ID ? "dynamic_agents" : "harness_engine"), harnessId: binding.harness_id };
}

export async function getHarnessGatewayNativeThread(agentId: string, subject: string, conversationId: string): Promise<string> {
  const binding = await (await getCollection<GatewayBinding>("harness_gateway_bindings")).findOne({ _id: gatewayBindingId(agentId, subject, conversationId) });
  return binding?.native_thread_id ?? conversationId;
}

export async function getHarnessGatewayStatus(body: Record<string, unknown>, auth: AuthResult): Promise<Response> {
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;
  const saved = await lookupHarnessSession(config, auth, String(body.agent_id), String(body.conversation_id));
  if (saved instanceof NextResponse) return saved;
  return NextResponse.json({ success: true, data: {
    runtime: "harness_engine",
    status: saved.active_run ? "running" : saved.pending_interrupt ? "waiting_for_input" : "idle",
    run_id: saved.active_run?.run_id ?? saved.pending_interrupt?.run_id ?? saved.last_run?.run_id ?? null,
    last_sequence: saved.active_run?.last_sequence ?? saved.last_run?.last_sequence ?? 0,
    run_status: saved.active_run?.status ?? saved.last_run?.status,
    turn_id: saved.active_run?.turn_id ?? saved.last_run?.turn_id ?? null,
    pending_interrupt: saved.pending_interrupt,
  } });
}

/** Resolve the owner/conversation's pinned backend before an agent default. */
export async function resolveHarnessGatewayTarget(
  agentId: string,
  context: { subject: string; conversationId: string; traceparent?: string },
): Promise<HarnessGatewayTarget | NextResponse> {
  try {
    // App-owned assistants execute through their declared stream endpoints.
    // Reject entry points without an app operation before creating a provider binding.
    if (findAgenticAppAssistantStream(agentId) && !await getPinnedHarnessGatewayTarget(agentId, context.subject, context.conversationId)) {
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
      let runtime: "dynamic_agents" | "harness_engine" = harnessId !== DEFAULT_HARNESS_ID ||
        process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED === "true" ? "harness_engine" : "dynamic_agents";
      // Dynamic Agents and the BFF share the application database. Match the
      // native runtime's checkpointer collection, including per-agent overrides.
      const checkpointCollection = agent.backend?.config?.checkpoint_collection ||
        process.env.CHECKPOINT_COLLECTION || "checkpoints_conversation";
      const checkpoints = await getCollection(checkpointCollection);
      const nativeContext = await checkpoints.findOne(
        { thread_id: context.conversationId }, { projection: { _id: 1 } },
      );
      if (nativeContext) {
        harnessId = DEFAULT_HARNESS_ID;
        if (process.env.HARNESS_ENGINE_DEEP_AGENTS_ADOPT_EXISTING !== "true") runtime = "dynamic_agents";
      }
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
          if (saved.harness_id) runtime = "harness_engine";
        }
      } else if (harnessId !== DEFAULT_HARNESS_ID && config instanceof NextResponse) {
        return config;
      }
      binding = await bindings.findOneAndUpdate(key, { $setOnInsert: {
        ...key, owner_subject: context.subject, agent_id: agentId,
        conversation_id: context.conversationId, harness_id: harnessId, runtime,
      } }, { upsert: true, returnDocument: "after" });
      if (!binding) throw new Error("Backend binding could not be saved");
    }
    if (binding.transition_id) return NextResponse.json({ success: false, error: "Session handoff is in progress" }, { status: 409 });
    const harnessId = normalizedHarnessId(binding.harness_id);
    const kind = binding.runtime ?? (harnessId === DEFAULT_HARNESS_ID ? "dynamic_agents" : "harness_engine");
    if (kind === "harness_engine") {
      const config = getHarnessEngineConfig();
      if (config instanceof NextResponse) return config;
    }
    return { kind, harnessId };
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
  auth: AuthResult,
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

export async function startHarnessGatewayRun(
  body: Record<string, unknown>,
  auth: AuthResult,
  harnessId = DEFAULT_HARNESS_ID,
): Promise<{ config: HarnessEngineConfig; run: HarnessRun } | NextResponse> {
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;

  let attachments: Array<{ id: string }>;
  try {
    attachments = await stageHarnessAttachments(body.files, auth, String(body.agent_id), String(body.conversation_id));
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof TypeError ? error.message : "Attachment storage is unavailable" }, { status: error instanceof TypeError ? 400 : 503 });
  }
  let resume: Record<string, unknown> = {};
  if (body.command === "resume") {
    const saved = await lookupHarnessSession(config, auth, String(body.agent_id), String(body.conversation_id));
    if (saved instanceof NextResponse) return saved;
    let pending = saved.pending_interrupt;
    let response: Record<string, unknown>;
    try { response = typeof body.resume_data === "string" ? JSON.parse(body.resume_data) : body.resume_data as Record<string, unknown>; }
    catch { return NextResponse.json({ success: false, error: "Invalid resume response" }, { status: 400 }); }
    if (body.client_request_id) {
      const known = await engineRequest(config, auth, "/api/v1/run-requests/lookup", { method: "POST", body: JSON.stringify({
        agent_id: body.agent_id, conversation_id: body.conversation_id, client_request_id: body.client_request_id,
      }) });
      if (known instanceof NextResponse) return known;
      if (!known.ok) return new NextResponse(known.body, { status: known.status, headers: known.headers });
      const prior = (await readEnvelope<HarnessRun & { resumes_run_id?: string; interrupt_id?: string }>(known)).data;
      if (prior?.resumes_run_id && prior.interrupt_id) pending = { run_id: prior.resumes_run_id, interrupt_id: prior.interrupt_id };
    }
    if (!pending || !response || response.interrupt_id !== pending.interrupt_id) {
      return NextResponse.json({ success: false, code: "HARNESS_INTERRUPT_MISMATCH", error: "Resume must identify the current pending interrupt" }, { status: 409 });
    }
    resume = { command: "resume", resume_data: response, interrupt_id: pending.interrupt_id, resumes_run_id: pending.run_id };
  }
  const published = await (await getCollection<{ _id: string; execution_blueprint_version?: number }>("dynamic_agents")).findOne({ _id: String(body.agent_id) });
  let selectedVersion = published?.execution_blueprint_version;
  if (selectedVersion) {
    const saved = await lookupHarnessSession(config, auth, String(body.agent_id), String(body.conversation_id));
    if (saved instanceof NextResponse) return saved;
    selectedVersion = saved.harness_id ? saved.agent_version ?? selectedVersion : selectedVersion;
  }
  const override = body.config_override;
  if (override !== undefined && (!override || typeof override !== "object" || Array.isArray(override) ||
      Object.keys(override).some(key => !["model", "allowed_tools"].includes(key)) ||
      ("model" in override && (!override.model || typeof override.model !== "object" || Array.isArray(override.model) ||
        Object.keys(override.model).some(key => key !== "reasoning_effort"))))) {
    return NextResponse.json({ error: "Unsupported per-turn execution override" }, { status: 400 });
  }
  const callerHeaders: Record<string, string> = harnessId === DEFAULT_HARNESS_ID && auth.bearerToken ? {
    "X-Harness-Caller-Token": auth.bearerToken,
    "X-Harness-Caller-Type": auth.isServiceAccount ? "service_account" : "user",
    ...(auth.email && { "X-Harness-Caller-Email": auth.email }),
    ...(auth.userContextHeader && { "X-Harness-Caller-Context": auth.userContextHeader }),
  } : {};
  const response = await engineRequest(config, auth, "/api/v1/runs", {
    method: "POST", headers: callerHeaders,
    body: JSON.stringify({
      agent_id: body.agent_id,
      conversation_id: body.conversation_id,
      message: body.message ?? "",
      ...(selectedVersion && { agent_version: selectedVersion }),
      ...resume,
      ...(body.command === "rewind" && { command: "rewind", rewind_data: body.rewind_data }),
      ...(body.command === "reconcile" && { command: "reconcile", ...(body.handoff_owner && { handoff_owner: body.handoff_owner }) }),
      attachments,
      ...(body.client_context && { client_context: body.client_context }),
      ...(body.turn_id && { turn_id: body.turn_id }),
      ...((body.config_override || body.reasoning_effort) && { config_override: {
        ...(body.config_override as Record<string, unknown> ?? {}),
        ...(body.reasoning_effort ? { model: { ...((body.config_override as { model?: object })?.model ?? {}), reasoning_effort: body.reasoning_effort } } : {}),
      } }),
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
  if (["queued", "running"].includes(envelope.data.status)) {
    await (await getCollection<GatewayBinding>("harness_gateway_bindings")).updateOne(
      { _id: gatewayBindingId(String(body.agent_id), auth.subject, String(body.conversation_id)), transition_id: { $exists: false } },
      { $set: { harness_id: envelope.data.harness_id, native_thread_id: envelope.data.provider_session_id } },
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
    case "run.paused":
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
    case "run.paused":
    case "interrupt.requested":
      state.terminalSent = true;
      return [sseFrame("input_required", { ...data, type: data.interrupt_type ?? data.type }, sequence)];
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
  if (event.event_type === "runtime.event") {
    const { protocol: source, name, payload } = event.data;
    if (state.terminalSent || source !== protocol || typeof name !== "string" ||
        !payload || typeof payload !== "object" || Array.isArray(payload)) return [];
    return [sseFrame(name, payload as Record<string, unknown>, event.sequence)];
  }
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

export function translateCanonicalStream(
  source: ReadableStream<Uint8Array>,
  run: HarnessRun,
  protocol: GatewayProtocol,
  after = "0",
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

  const [afterSequence, afterPart] = after.split(".").map(Number);
  function emit(canonical: HarnessRunEvent, controller: TransformStreamDefaultController<Uint8Array>): void {
    encodeHarnessGatewayEvent(canonical, run, protocol, state).forEach((output, part) => {
      if (canonical.sequence < afterSequence || canonical.sequence === afterSequence &&
          (afterPart === undefined || part <= afterPart)) return;
      const cursor = `${canonical.sequence}.${part}`;
      controller.enqueue(encoder.encode(output.replace(/^id:[^\n]*\n/m, `id: ${cursor}\n`)));
    });
  }

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
      emit(canonical, controller);
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
        emit(canonical, controller);
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
  auth: AuthResult,
  signal?: AbortSignal,
  harnessId = DEFAULT_HARNESS_ID,
): Promise<Response> {
  const started = await startHarnessGatewayRun(body, auth, harnessId);
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
  auth: AuthResult,
  signal?: AbortSignal,
  harnessId = DEFAULT_HARNESS_ID,
): Promise<Response> {
  const started = await startHarnessGatewayRun(body, auth, harnessId);
  if (started instanceof NextResponse) return started;
  let cursor = 0;
  let content = "";
  let thinking = "";
  let failure: Record<string, unknown> | undefined;
  let checkpointId: string | undefined;
  let interrupt: Record<string, unknown> | undefined;
  let structuredOutput: unknown;
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
      if (event.event_type === "result.updated") {
        content = stringField(event.data, "content");
        thinking = stringField(event.data, "thinking");
        checkpointId = typeof event.data.checkpoint_id === "string" ? event.data.checkpoint_id : undefined;
        structuredOutput = event.data.structured_output;
      }
      if (event.event_type === "run.paused") interrupt = event.data;
      if (event.event_type === "run.failed") failure = event.data;
    }
    cursor = envelope.data.next_cursor;
    const status = envelope.data.run.status;
    if (["completed", "failed", "cancelled", "paused"].includes(status) && cursor >= envelope.data.run.last_sequence) {
      if (status === "completed" || status === "paused") {
        return NextResponse.json({
          success: true,
          status,
          ...(checkpointId && { checkpoint_id: checkpointId }),
          ...(status === "paused" && { input_required: true }),
          ...(interrupt && { interrupt }),
          ...(structuredOutput && { structured_output: structuredOutput }),
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
  auth: AuthResult,
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

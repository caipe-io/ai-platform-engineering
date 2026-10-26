import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

import { findAgenticAppAssistantStream } from "@/lib/agentic-apps/assistant-stream";
import type { AuthResult } from "@/lib/da-proxy";
import { harnessRunCursor, parseHarnessRunCursor, type HarnessRunCursor } from "@/lib/harness-run-cursor";
import { normalizeHarnessId } from "@/lib/agent-presentation";
import {
  buildHarnessEngineHeaders,
  getHarnessEngineConfig,
  type HarnessEngineConfig,
} from "@/lib/harness-engine-proxy";
import { getCollection } from "@/lib/mongodb";
import type { HarnessRun, HarnessRunEvent } from "@/types/harness-engine";

export const DEFAULT_HARNESS_ID = "dynamic_agents";

interface AgentRuntimeRecord {
  _id: string;
  execution_harness_id?: string;
  execution?: { kind?: string };
  backend?: { config?: { checkpoint_collection?: string } };
}

export interface HarnessGatewayTarget {
  kind: "dynamic_agents" | "harness_engine";
  harnessId: string;
}

interface GatewayBinding {
  _id: string;
  agent_id: string;
  session_id?: string;
  conversation_id?: string;
  owner_subject?: string;
  harness_id: string;
}

const NATIVE_HARNESS_ALIASES = [DEFAULT_HARNESS_ID, "langchain-deepagents", "langchain_deepagents"];

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
}

type GatewayProtocol = "custom" | "agui";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/** Resolve only after authorizing the visible conversation and its runtime context.
 * Saved provider bindings take precedence over mutable agent configuration.
 * The gateway reads identity coordinates only; each provider owns its state.
 */
interface GatewayResolutionContext {
  conversationId: string;
  admit?: boolean;
  retainedOnly?: boolean;
}

export function resolveHarnessGatewayTarget(
  agentId: string,
  context: GatewayResolutionContext & { retainedOnly: true; admit?: false },
): Promise<HarnessGatewayTarget | NextResponse | null>;
export function resolveHarnessGatewayTarget(
  agentId: string,
  context?: GatewayResolutionContext & { retainedOnly?: false },
): Promise<HarnessGatewayTarget | NextResponse>;
export async function resolveHarnessGatewayTarget(
  agentId: string,
  context?: GatewayResolutionContext,
): Promise<HarnessGatewayTarget | NextResponse | null> {
  try {
    const claimId = context ? createHash("sha256").update(`${agentId}\0${context.conversationId}`).digest("hex") : "";
    const claims = context ? await getCollection<GatewayBinding>("harness_gateway_bindings") : null;
    const deleted = context ? await getCollection<{ _id: string }>("native_acp_deleted_sessions") : null;
    const claim = claims && await claims.findOne({ _id: claimId });
    if (claim && (claim.agent_id !== agentId || claim.session_id !== context?.conversationId || typeof claim.harness_id !== "string")) {
      throw new Error("Invalid gateway execution owner reference");
    }
    const conflict = () => NextResponse.json(
      { success: false, error: "Conflicting runtime bindings require an explicit migration", code: "RUNTIME_BINDING_CONFLICT" },
      { status: 409 },
    );
    // Older gateways keyed this same collection by owner. Reconcile those
    // stored choices across the authorized context instead of creating another
    // execution owner when the caller or shared definition changes.
    const legacy = claims && await claims.findOne({ agent_id: agentId, conversation_id: context!.conversationId });
    let legacyHarnessId: string | undefined;
    if (legacy) {
      if (typeof legacy.owner_subject !== "string" || !legacy.owner_subject.trim() ||
          typeof legacy.harness_id !== "string" || !legacy.harness_id.trim() ||
          legacy._id !== createHash("sha256").update(JSON.stringify([legacy.owner_subject, agentId, context!.conversationId])).digest("hex")) {
        throw new Error("Invalid legacy gateway execution owner reference");
      }
      legacyHarnessId = normalizeHarnessId(legacy.harness_id);
      const aliases = legacyHarnessId === DEFAULT_HARNESS_ID ? NATIVE_HARNESS_ALIASES : [legacy.harness_id];
      if ((claim && normalizeHarnessId(claim.harness_id) !== legacyHarnessId) || await claims!.findOne({
        agent_id: agentId, conversation_id: context!.conversationId, harness_id: { $nin: aliases },
      })) return conflict();
    }
    const wasDeleted = async () => Boolean(deleted && await deleted.findOne({ _id: context!.conversationId }, { projection: { _id: 1 } }));
    const deletedResponse = () => NextResponse.json({ success: false, error: "This execution context was permanently deleted" }, { status: 409 });
    if (await wasDeleted()) return deletedResponse();
    const selected = async (harnessId: string, authoritative = false): Promise<HarnessGatewayTarget | NextResponse> => {
      if ((claim && authoritative && normalizeHarnessId(claim.harness_id) !== harnessId) ||
          (legacyHarnessId !== undefined && authoritative && legacyHarnessId !== harnessId)) return conflict();
      let admitted = claim ? normalizeHarnessId(claim.harness_id) : legacyHarnessId ?? harnessId;
      if (admitted !== DEFAULT_HARNESS_ID) {
        const config = getHarnessEngineConfig();
        if (config instanceof NextResponse) return config;
      }
      if (claims && context?.admit && !context.retainedOnly && !claim) {
        let stored;
        try {
          stored = await claims.findOneAndUpdate(
            { _id: claimId },
            { $setOnInsert: { agent_id: agentId, session_id: context.conversationId, harness_id: admitted } },
            { upsert: true, returnDocument: "after" },
          );
        } catch (error) {
          if ((error as { code?: number }).code !== 11000) throw error;
          stored = await claims.findOne({ _id: claimId });
        }
        if (!stored || stored.agent_id !== agentId || stored.session_id !== context.conversationId || typeof stored.harness_id !== "string") {
          throw new Error("Gateway execution owner admission failed");
        }
        const winner = normalizeHarnessId(stored.harness_id);
        if ((authoritative && winner !== harnessId) || (legacyHarnessId !== undefined && winner !== legacyHarnessId)) return conflict();
        admitted = winner;
      }
      // A permanent deletion can race a request authorized before its tombstone.
      if (context?.admit && await wasDeleted()) return deletedResponse();
      if (admitted !== DEFAULT_HARNESS_ID) {
        const config = getHarnessEngineConfig();
        if (config instanceof NextResponse) return config;
      }
      return { kind: admitted === DEFAULT_HARNESS_ID ? "dynamic_agents" : "harness_engine", harnessId: admitted };
    };
    if (context) {
      const nativeBindings = await getCollection("native_acp_sessions");
      const engineBindings = await getCollection("harness_sessions");
      const checkpoints = await getCollection(process.env.CHECKPOINT_COLLECTION || "checkpoints_conversation");
      const [native, engine, legacyCheckpoint] = await Promise.all([
        nativeBindings.findOne({ agent_id: agentId, session_id: context.conversationId }, { projection: { _id: 0, protocol: 1, runtime_kind: 1 } }),
        engineBindings.findOne({ agent_id: agentId, conversation_id: context.conversationId }, { projection: { _id: 0, harness_id: 1 }, sort: { epoch: -1 } }),
        checkpoints.findOne({ thread_id: context.conversationId }, { projection: { _id: 1 } }),
      ]);
      if ((native || legacyCheckpoint) && engine) return conflict();
      if (native || legacyCheckpoint) {
        if (native && (native.protocol !== "acp" || !["native", "sandbox"].includes(native.runtime_kind))) throw new Error("Invalid native execution binding");
        return selected(DEFAULT_HARNESS_ID, true);
      }
      if (engine) {
        const conflictingEngine = await engineBindings.findOne(
          { agent_id: agentId, conversation_id: context.conversationId, harness_id: { $ne: engine.harness_id } }, { projection: { _id: 1 } },
        );
        if (conflictingEngine) return conflict();
        const harnessId = normalizeHarnessId(engine.harness_id);
        if (harnessId === DEFAULT_HARNESS_ID) throw new Error("Invalid engine execution binding");
        return selected(harnessId, true);
      }
    }
    const agents = await getCollection<AgentRuntimeRecord>("dynamic_agents");
    const agent = await agents.findOne({ _id: agentId }, { projection: { _id: 1, execution_harness_id: 1, execution: 1, backend: 1 } });
    // Existing legacy custom-checkpointer threads remain native before ACP admission.
    const legacyCollection = agent?.backend?.config?.checkpoint_collection;
    if (context && legacyCollection && legacyCollection !== (process.env.CHECKPOINT_COLLECTION || "checkpoints_conversation")) {
      const checkpoints = await getCollection(legacyCollection);
      if (await checkpoints.findOne({ thread_id: context.conversationId }, { projection: { _id: 1 } })) return selected(DEFAULT_HARNESS_ID, true);
    }
    if (claim) return selected(normalizeHarnessId(claim.harness_id));
    if (legacyHarnessId !== undefined) return selected(legacyHarnessId, true);
    // A current app claim cannot migrate a retained native/provider session.
    // Discovery is read-only so an app-owned chat never acquires a native pin.
    if (context?.retainedOnly) return null;
    if (findAgenticAppAssistantStream(agentId)) return NextResponse.json(
      { success: false, code: "APP_STREAM_REQUIRED", error: "This app assistant requires its declared chat stream endpoints" },
      { status: 501 },
    );
    if (!agent) return NextResponse.json({ success: false, error: "Agent not found" }, { status: 404 });
    const harnessId = normalizeHarnessId(agent?.execution_harness_id);
    if (harnessId !== DEFAULT_HARNESS_ID && agent?.execution?.kind === "sandbox") return NextResponse.json(
      { success: false, error: "Choose one execution provider; SDK and ACP sandbox selections cannot be combined", code: "RUNTIME_SELECTION_CONFLICT" }, { status: 409 },
    );
    return selected(harnessId);
  } catch (error) {
    console.error("[harness-gateway] Failed to resolve agent runtime", { agentId, error });
    return NextResponse.json({ success: false, error: "Agent runtime could not be resolved" }, { status: 503 });
  }
}

/** Stable transport marker; callers must not infer placement from a mutable definition. */
export function withHarnessGatewayTarget(response: Response, target: HarnessGatewayTarget): Response {
  response.headers.set("X-Harness-ID", target.harnessId);
  return response;
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
  if (Array.isArray(body.files) && body.files.length > 0) return NextResponse.json(
    { success: false, code: "HARNESS_CAPABILITY_UNSUPPORTED", error: "The selected harness does not support file attachments" }, { status: 409 },
  );
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;

  const response = await engineRequest(config, auth, "/api/v1/runs", {
    method: "POST",
    body: JSON.stringify({
      agent_id: body.agent_id,
      conversation_id: body.conversation_id,
      message: body.message,
      ...(typeof body.expected_harness_id === "string" && { expected_harness_id: body.expected_harness_id }),
      protocol: body.protocol === "agui" ? "agui" : "custom",
      ...(typeof body.context === "string" && body.context.trim() && {
        context: body.context,
      }),
      ...(typeof (body.client_request_id ?? body.turn_id) === "string" && {
        client_request_id: body.client_request_id ?? body.turn_id,
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
      state.messageStarted = true;
      return [sseFrame("RUN_STARTED", {
        type: "RUN_STARTED", runId: run.run_id, threadId: run.conversation_id,
      }, sequence), sseFrame("TEXT_MESSAGE_START", {
        type: "TEXT_MESSAGE_START", messageId: state.messageId, role: "assistant",
      }, sequence)];
    case "content.delta":
      return [sseFrame("TEXT_MESSAGE_CONTENT", {
        type: "TEXT_MESSAGE_CONTENT", messageId: state.messageId,
        delta: stringField(data, "text", "delta"),
      }, sequence)];
    case "reasoning.delta":
      return [sseFrame("CUSTOM", {
        type: "CUSTOM",
        name: "REASONING_DELTA",
        value: { delta: stringField(data, "text", "delta") },
      }, sequence)];
    case "tool.started": {
      const toolCallId = stringField(data, "tool_call_id", "id");
      const toolName = stringField(data, "tool_name", "name");
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
      return [sseFrame("CUSTOM", { type: "CUSTOM", name: eventType, value: data }, sequence)];
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
      return [sseFrame("metadata", { type: eventType, ...data }, sequence)];
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
  after: HarnessRunCursor | null = null,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const state: GatewayStreamState = {
    messageId: `message-${run.run_id}`,
    messageStarted: true,
    terminalSent: false,
  };

  function emit(event: HarnessRunEvent, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
      if (event.event_type !== "run.failed") throw new Error("Invalid canonical event cursor");
      const message = stringField(event.data, "message") || "Harness replay is unavailable";
      const frame = protocol === "agui"
        ? sseFrame("RUN_ERROR", { type: "RUN_ERROR", message, code: stringField(event.data, "code") || "replay_unavailable" })
        : sseFrame("error", { error: message, code: stringField(event.data, "code") || "replay_unavailable" });
      controller.enqueue(encoder.encode(frame));
      return;
    }
    const frames = encodeHarnessGatewayEvent(event, run, protocol, state);
    if (after && event.sequence === after.sequence && frames.length !== after.count) {
      throw new Error("Harness replay cursor does not match its event projection");
    }
    frames.forEach((frame, index) => {
      const part = index + 1;
      if (after && (event.sequence < after.sequence || (event.sequence === after.sequence && part <= after.part))) return;
      const id = `${run.run_id}:${harnessRunCursor({ sequence: event.sequence, part, count: frames.length })}`;
      controller.enqueue(encoder.encode(frame.replace(/^id: [^\n]+/m, `id: ${id}`)));
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
  auth: Pick<AuthResult, "subject" | "traceparent">,
  signal?: AbortSignal,
): Promise<Response> {
  const started = await startRun(body, auth);
  if (started instanceof NextResponse) return started;
  return replayHarnessGatewayRun(started.run, auth, "0", signal, started.config);
}

export async function replayHarnessGatewayRun(
  run: HarnessRun,
  auth: Pick<AuthResult, "subject" | "traceparent">,
  cursor: string,
  signal?: AbortSignal,
  resolvedConfig?: HarnessEngineConfig,
): Promise<Response> {
  const after = cursor === "0" ? null : parseHarnessRunCursor(cursor);
  if (cursor !== "0" && !after) return NextResponse.json({ error: "Invalid harness replay cursor" }, { status: 400 });
  const config = resolvedConfig ?? getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;
  const headers = buildHarnessEngineHeaders(config, auth);
  if (headers instanceof NextResponse) return headers;
  headers.Accept = "text/event-stream";
  const canonicalAfter = after ? after.sequence - (after.part < after.count ? 1 : 0) : 0;
  try {
    const upstream = await fetch(
      `${config.url}/api/v1/runs/${encodeURIComponent(run.run_id)}/events/stream?after=${canonicalAfter}`,
      { method: "GET", headers, cache: "no-store", signal },
    );
    if (!upstream.ok || !upstream.body) return new Response(upstream.body, {
      status: upstream.status, headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
    });
    return new Response(translateCanonicalStream(upstream.body, run, run.protocol ?? "agui", after), {
      headers: { ...SSE_HEADERS, "X-Harness-Run-ID": run.run_id, "X-CAIPE-Run-Id": run.run_id,
        "X-CAIPE-Cursor-Format": "engine-v1", "X-Harness-ID": run.harness_id },
    });
  } catch (error) {
    if (signal?.aborted) return new Response(null, { status: 499 });
    console.error("[harness-gateway] Event subscription failed", { runId: run.run_id, error });
    return NextResponse.json({ success: false, error: "Harness run exists but its event stream is unavailable", run_id: run.run_id },
      { status: 503, headers: { "X-CAIPE-Run-Id": run.run_id, "X-Harness-Run-ID": run.run_id } });
  }
}

export async function getHarnessGatewayRun(
  auth: Pick<AuthResult, "subject" | "traceparent">,
  context: { agentId: string; conversationId: string },
  runId?: string,
): Promise<HarnessRun | null | NextResponse> {
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;
  const path = runId ? `/api/v1/runs/${encodeURIComponent(runId)}` : `/api/v1/runs/latest?${new URLSearchParams({ agent_id: context.agentId, conversation_id: context.conversationId })}`;
  const response = await engineRequest(config, auth, path, { method: "GET" });
  if (response instanceof NextResponse) return response;
  const envelope = await readEnvelope<HarnessRun>(response);
  if (!response.ok || !envelope.success) return NextResponse.json(
    { success: false, error: engineErrorMessage(envelope, "Harness run is unavailable") }, { status: response.status || 502 },
  );
  const run = envelope.data ?? null;
  if (run && (run.agent_id !== context.agentId || run.conversation_id !== context.conversationId || (runId && run.run_id !== runId))) {
    return NextResponse.json({ success: false, error: "Run not found for this agent session" }, { status: 404 });
  }
  return run;
}

export function publicHarnessGatewayRun(run: HarnessRun | null): Record<string, unknown> | null {
  return run && {
    run_id: run.run_id, agent_id: run.agent_id, session_id: run.conversation_id,
    turn_id: run.client_request_id ?? run.run_id, protocol: run.protocol ?? "agui",
    status: run.status, last_sequence: run.last_sequence, failure_code: run.error_code,
    harness_id: run.harness_id,
  };
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
    if (!Number.isSafeInteger(envelope.data.run.last_sequence) || envelope.data.run.last_sequence < 0 ||
        !Number.isSafeInteger(envelope.data.next_cursor) || envelope.data.next_cursor < cursor) {
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
      ...(typeof body.turn_id === "string" && { client_request_id: body.turn_id }),
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

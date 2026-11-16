import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import type { MessageActionDeclaration } from "../../../app-sdk/assistant-options.mjs";
import { getAuditBackend } from "@/lib/audit";
import type { AuthResult } from "@/lib/da-proxy";
import { getCollection } from "@/lib/mongodb";
import { hashSubject } from "@/lib/rbac/audit";
import { getAgentId } from "@/types/a2a";
import type { Conversation, Message } from "@/types/mongodb";

import { supportsAssistantClient } from "./assistant-clients";
import { getAgenticAppRoutingSnapshot } from "./config";
import { proxyAgenticAppRequest } from "./proxy";

/** The app owns the action; a slow endpoint must not hold the user's request open. */
export const MESSAGE_ACTION_TIMEOUT_MS = 30_000;
const MAX_APP_RESPONSE_BYTES = 64 * 1024;
const MAX_APP_ERROR_CHARS = 300;
const APP_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Set by the proxy only on a response that came from the app. */
const APP_RESPONSE_HEADER = "x-caipe-decision-id";

export interface AgenticAppMessageAction {
  appId: string;
  action: MessageActionDeclaration;
  path: string[];
}

export interface MessageActionRequest {
  conversation_id: string;
  agent_id: string;
  message_id: string;
  action_id: string;
  input?: { text?: string };
}

type Outcome = "success" | "error" | "deny";

function fail(status: number, error: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error, code }, { status });
}

/** Resolve only deployment-owned declarations; the client never supplies a path. */
export function findAgenticAppMessageAction(agentId: string, actionId: string): AgenticAppMessageAction | null {
  const matches = getAgenticAppRoutingSnapshot().filter((app) =>
    app.manifest.ui.assistant?.agentId === agentId && app.manifest.ui.assistant.streamPath,
  );
  if (matches.length > 1) throw new Error("Multiple installed apps claim the assistant");
  const app = matches[0];
  if (!app) return null;
  if (!app.installation.installed || !app.installation.enabled) throw new Error("Assistant app is unavailable");
  const assistant = app.manifest.ui.assistant!;
  const action = assistant.hostOptions?.messageActions?.find((candidate) => candidate.id === actionId);
  if (!action || !supportsAssistantClient(assistant, "webui")) return null;
  return { appId: app.installation.appId, action, path: action.path.slice(1).split("/") };
}

/** A stored assistant message has finished streaming; its turn comes from storage, not the client. */
export async function loadAssistantMessage(
  conversationId: string,
  messageId: string,
): Promise<{ turnId: string } | "missing" | "not-assistant"> {
  const messages = await getCollection<Message>("messages");
  const message = await messages.findOne({ conversation_id: conversationId, message_id: messageId });
  if (!message) return "missing";
  const turnId = message.metadata?.turn_id;
  if (message.role !== "assistant" || typeof turnId !== "string" || !turnId) return "not-assistant";
  return { turnId };
}

/** Records who used which action; the user's text is never written. */
function auditMessageAction(
  auth: AuthResult,
  target: AgenticAppMessageAction,
  conversationId: string,
  outcome: Outcome,
  reason: string,
): void {
  getAuditBackend().write({
    audit_event_id: randomUUID(),
    // "auth" is retained at every audit verbosity level, so no action goes unrecorded.
    type: "auth",
    ts: new Date().toISOString(),
    action: "assistant.message_action",
    component: "chat",
    source: "webui_backend",
    tenant_id: auth.tenantId ?? "default",
    subject_hash: hashSubject(auth.subject ?? "unknown"),
    outcome,
    reason_code: reason,
    correlation_id: randomUUID(),
    resource_ref: `app:${target.appId}/action:${target.action.id}`,
    details: { app_id: target.appId, action_id: target.action.id, conversation_id: conversationId },
  });
}

async function readAppResponse(response: Response): Promise<unknown | undefined> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return undefined;
  const text = await response.text();
  if (text.length > MAX_APP_RESPONSE_BYTES) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Map the app's reply to a stable `{ error, code }`; nothing else from it reaches the browser. */
function appError(status: number, body: unknown): NextResponse {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const error = typeof record.error === "string" && record.error.trim()
    ? record.error.trim().slice(0, MAX_APP_ERROR_CHARS) : "The app could not complete this action";
  const code = typeof record.code === "string" && APP_ERROR_CODE.test(record.code) ? record.code : "ASSISTANT_ACTION_FAILED";
  // A 401 from the app must not look like an expired host session.
  return fail(status >= 400 && status < 500 && status !== 401 ? status : 502, error, code);
}

/**
 * Call after authentication, agent-use and conversation-write checks.
 * `text` is untrusted; the declaration's limits are enforced here.
 */
export async function runAgenticAppMessageAction(
  request: Request,
  auth: AuthResult,
  conversation: Conversation,
  body: MessageActionRequest,
): Promise<Response> {
  const savedAgentId = getAgentId(conversation);
  if (!savedAgentId || savedAgentId !== body.agent_id) {
    return fail(409, "Agent does not match this conversation", "CONVERSATION_AGENT_MISMATCH");
  }
  let target: AgenticAppMessageAction | null;
  try {
    target = findAgenticAppMessageAction(body.agent_id, body.action_id);
  } catch {
    console.error("[assistant-actions] Installed app assistant configuration is unavailable");
    return fail(503, "Assistant configuration unavailable", "ASSISTANT_UNAVAILABLE");
  }
  if (!target) return fail(404, "Unknown action", "ASSISTANT_ACTION_UNKNOWN");
  if (conversation.client_type !== "webui") {
    return fail(403, "This action is available in the web UI only", "ASSISTANT_CLIENT_UNSUPPORTED");
  }

  const stored = await loadAssistantMessage(String(conversation._id), body.message_id);
  if (stored === "missing") return fail(404, "Message not found", "ASSISTANT_MESSAGE_NOT_FOUND");
  if (stored === "not-assistant") return fail(409, "Actions apply to finished assistant answers", "ASSISTANT_MESSAGE_INVALID");

  const field = target.action.dialog?.field;
  let text: string | undefined;
  if (field) {
    text = body.input?.text;
    if (text !== undefined && (typeof text !== "string" || text.length > field.maxLength)) {
      return fail(400, `Text must be at most ${field.maxLength} characters`, "ASSISTANT_ACTION_TEXT_INVALID");
    }
    if (!field.optional && !text?.trim()) {
      return fail(400, "Text is required", "ASSISTANT_ACTION_TEXT_REQUIRED");
    }
  }

  const url = new URL(request.url);
  const timeout = AbortSignal.timeout(MESSAGE_ACTION_TIMEOUT_MS);
  // Only the server-built JSON body and a correlation id reach the app; no browser headers or cookies.
  const headers = new Headers({ "content-type": "application/json" });
  const correlationId = request.headers.get("x-correlation-id");
  if (correlationId) headers.set("x-correlation-id", correlationId);
  const upstreamRequest = new Request(`${url.origin}${url.pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      conversation_id: body.conversation_id, message_id: body.message_id, turn_id: stored.turnId,
      action_id: body.action_id, ...(text ? { text } : {}),
    }),
    signal: AbortSignal.any([request.signal, timeout]),
  });

  const response = await proxyAgenticAppRequest(
    upstreamRequest,
    { params: Promise.resolve({ appId: target.appId, path: target.path }) },
    auth.authenticatedUser,
  );
  const fromApp = response.headers.has(APP_RESPONSE_HEADER);
  const done = (result: Response, outcome: Outcome, reason: string): Response => {
    auditMessageAction(auth, target, body.conversation_id, outcome, reason);
    return result;
  };

  if (timeout.aborted) {
    await response.body?.cancel();
    return done(fail(504, "The app did not respond in time", "ASSISTANT_ACTION_TIMEOUT"), "error", "TIMEOUT");
  }
  if (!fromApp) {
    // The host refused or could not reach the app; its internal reason stays server-side.
    await response.body?.cancel();
    return response.status === 401 || response.status === 403
      ? done(fail(403, "You cannot use this app", "ASSISTANT_ACTION_FORBIDDEN"), "deny", "DENY_APP_ACCESS")
      : done(fail(502, "The app could not be reached", "ASSISTANT_ACTION_UNAVAILABLE"), "error", "UNAVAILABLE");
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return done(fail(502, "The app returned an invalid response", "ASSISTANT_ACTION_BAD_RESPONSE"), "error", "BAD_RESPONSE");
  }
  const result = await readAppResponse(response);
  if (result === undefined) {
    return done(fail(502, "The app returned an invalid response", "ASSISTANT_ACTION_BAD_RESPONSE"), "error", "BAD_RESPONSE");
  }
  if (!response.ok) return done(appError(response.status, result), "error", "APP_ERROR");
  return done(NextResponse.json({ success: true, data: result }), "success", "OK");
}

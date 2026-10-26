import { NextResponse } from "next/server";

import type { AuthResult } from "@/lib/da-proxy";
import { getAgentId } from "@/types/a2a";
import type { Conversation } from "@/types/mongodb";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { getCollection } from "@/lib/mongodb";
import { getAgenticAppAgentStreams, getAgenticAppRoutingSnapshot } from "./config";
import { admitAppConversation, resolveAppConversationDestination } from "./app-assistant-binding";
import { proxyAgenticAppRequest } from "./proxy";
import { supportsAssistantClient, verifyWebexAssistantContext, type AssistantClientContext } from "./assistant-clients";
import { ApiError } from "@/lib/api-error";

export type AssistantStreamOperation = "start" | "resume" | "cancel" | "status";

export interface AgenticAppAssistantStream {
  appId: string;
  path: string[];
  registeredAgent?: boolean;
  supportedClients?: Array<"webui" | "webex">;
  webexGroupChat?: boolean;
}

/** Resolve only deployment-owned paths; a declared runtime never falls back on failure. */
export function findAgenticAppAssistantStream(
  agentId: string,
  operation: AssistantStreamOperation = "start",
): AgenticAppAssistantStream | null {
  const matches = getAgenticAppRoutingSnapshot().flatMap((app) =>
    getAgenticAppAgentStreams(app).filter((assistant) => assistant.agentId === agentId).map((assistant) => ({ app, assistant })),
  );
  if (matches.length > 1) throw new Error("Multiple installed apps claim the assistant");
  const match = matches[0];
  if (!match) return null;
  const { app, assistant } = match;
  if (!app.installation.installed || !app.installation.enabled) {
    throw new Error("Assistant app is unavailable");
  }
  const path = operation === "start" ? assistant.streamPath
    : operation === "resume" ? assistant.resumePath
      : operation === "status" ? assistant.statusPath : assistant.cancelPath;
  // An empty path denotes an app-owned operation that the app does not implement.
  return { appId: app.installation.appId, path: path ? path.slice(1).split("/") : [],
    ...(assistant.id !== "assistant" ? { registeredAgent: true } : {}),
    ...(assistant.supportedClients ? { supportedClients: assistant.supportedClients } : {}),
    ...(assistant.webexGroupChat !== undefined ? { webexGroupChat: assistant.webexGroupChat } : {}) };
}

/** Call after conversation-write and agent-use checks, using the same resolved identity. */
export async function proxyAgenticAppAssistantStream(
  request: Request,
  auth: AuthResult,
  conversation: Conversation,
  body: Record<string, unknown>,
  operation: AssistantStreamOperation,
): Promise<Response | null> {
  const savedAgentId = getAgentId(conversation);
  const target = resolveAppConversationDestination(conversation, body.agent_id, operation, findAgenticAppAssistantStream);
  if (target instanceof NextResponse) return target;
  if (!target) return null;
  if (body.agent_id !== savedAgentId) {
    return NextResponse.json({ success: false, error: "Agent does not match this conversation" }, { status: 409 });
  }
  if (auth.isServiceAccount || !auth.subject || !auth.authenticatedUser) {
    return NextResponse.json({ success: false, error: "Interactive user identity required" }, { status: 403 });
  }
  const session = auth.authenticatedUser.session;
  if (session.authMethod === "bearer" &&
      session.authorizedParty === (process.env.KEYCLOAK_WEBEX_BOT_CLIENT_ID?.trim() || "caipe-webex-bot") &&
      conversation.client_type !== "webex") {
    return NextResponse.json({ error: "Webex calls require a stored Webex conversation", code: "ASSISTANT_CLIENT_MISMATCH" }, { status: 403 });
  }
  let clientContext: AssistantClientContext | undefined;
  if (conversation.client_type === "webex") {
    try {
      clientContext = await verifyWebexAssistantContext(request, auth, conversation);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return NextResponse.json({ error: error.message, code: "WEBEX_CONTEXT_REQUIRED" }, { status: error.statusCode });
    }
  } else if (conversation.client_type !== "webui") {
    return NextResponse.json({ error: "This app assistant does not support this client", code: "ASSISTANT_CLIENT_UNSUPPORTED" }, { status: 403 });
  }
  if (!supportsAssistantClient({ agentId: savedAgentId!, name: "", label: "", ...target },
      clientContext ? "webex" : "webui", clientContext?.kind)) {
    return NextResponse.json({ error: "The app has not enabled this assistant client or group-space support", code: "ASSISTANT_CLIENT_UNSUPPORTED" }, { status: 403 });
  }
  if (!target.path.length) {
    return NextResponse.json({ success: false, error: `Assistant does not support ${operation}` }, { status: 501 });
  }
  if ((operation === "start" || operation === "resume") && body.protocol !== undefined && body.protocol !== "agui") {
    return NextResponse.json({ success: false, error: "App assistant streams require AG-UI" }, { status: 400 });
  }
  if (target.registeredAgent && (operation === "start" || operation === "resume")) {
    try {
      const agents = await getCollection<DynamicAgentConfig>("dynamic_agents");
      if (!await agents.findOne({ _id: savedAgentId!, enabled: true }, { projection: { _id: 1 } })) {
        return NextResponse.json({ success: false, error: "Agent is disabled or unavailable" }, { status: 409 });
      }
    } catch {
      return NextResponse.json({ success: false, error: "Agent registry is temporarily unavailable" }, { status: 503 });
    }
  }
  const response = await proxyAgenticAppRequest(request, {
    params: Promise.resolve({ appId: target.appId, path: target.path }),
  }, auth.authenticatedUser, clientContext,
    operation === "start" || operation === "resume"
      ? () => admitAppConversation(conversation, target, findAgenticAppAssistantStream) : undefined);
  if (!response.ok) return response;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const expected = operation === "cancel" || operation === "status" ? "application/json" : "text/event-stream";
  if (contentType !== expected) {
    await response.body?.cancel();
    return NextResponse.json({ success: false, error: `Assistant response must be ${expected}` }, { status: 502 });
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", expected === "text/event-stream" ? "no-cache, no-transform" : "private, no-store");
  if (expected === "text/event-stream") headers.set("X-Accel-Buffering", "no");
  return new Response(response.body, { status: response.status, headers });
}

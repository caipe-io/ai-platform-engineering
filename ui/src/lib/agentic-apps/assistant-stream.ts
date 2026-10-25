import { NextResponse } from "next/server";

import type { AuthResult } from "@/lib/da-proxy";
import { getAgentId } from "@/types/a2a";
import type { Conversation } from "@/types/mongodb";
import { getAgenticAppRoutingSnapshot } from "./config";
import { proxyAgenticAppRequest } from "./proxy";

export type AssistantStreamOperation = "start" | "resume" | "cancel" | "status";

export interface AgenticAppAssistantStream {
  appId: string;
  path: string[];
}

/** Resolve only deployment-owned paths; a declared runtime never falls back on failure. */
export function findAgenticAppAssistantStream(
  agentId: string,
  operation: AssistantStreamOperation = "start",
): AgenticAppAssistantStream | null {
  const matches = getAgenticAppRoutingSnapshot().filter((app) =>
    app.manifest.ui.assistant?.agentId === agentId && app.manifest.ui.assistant.streamPath,
  );
  if (matches.length > 1) throw new Error("Multiple installed apps claim the assistant");
  const app = matches[0];
  if (!app) return null;
  if (!app.installation.installed || !app.installation.enabled) {
    throw new Error("Assistant app is unavailable");
  }
  const assistant = app.manifest.ui.assistant!;
  const path = operation === "start" ? assistant.streamPath
    : operation === "resume" ? assistant.resumePath
      : operation === "status" ? assistant.statusPath : assistant.cancelPath;
  // An empty path denotes an app-owned operation that the app does not implement.
  return { appId: app.installation.appId, path: path ? path.slice(1).split("/") : [] };
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
  let target: AgenticAppAssistantStream | null;
  try {
    target = savedAgentId ? findAgenticAppAssistantStream(savedAgentId, operation) : null;
    if (!target && typeof body.agent_id === "string" && body.agent_id !== savedAgentId &&
        findAgenticAppAssistantStream(body.agent_id)) {
      return NextResponse.json({ success: false, error: "Agent does not match this conversation" }, { status: 409 });
    }
  } catch {
    console.error(`[stream/${operation}] Installed app assistant configuration is unavailable`);
    return NextResponse.json({ success: false, error: "Assistant configuration unavailable" }, { status: 503 });
  }
  if (!target) return null;
  if (body.agent_id !== savedAgentId) {
    return NextResponse.json({ success: false, error: "Agent does not match this conversation" }, { status: 409 });
  }
  if (auth.isServiceAccount || !auth.subject || !auth.authenticatedUser) {
    return NextResponse.json({ success: false, error: "Interactive user identity required" }, { status: 403 });
  }
  if (!target.path.length) {
    return NextResponse.json({ success: false, error: `Assistant does not support ${operation}` }, { status: 501 });
  }
  if ((operation === "start" || operation === "resume") && body.protocol !== undefined && body.protocol !== "agui") {
    return NextResponse.json({ success: false, error: "App assistant streams require AG-UI" }, { status: 400 });
  }
  const response = await proxyAgenticAppRequest(request, {
    params: Promise.resolve({ appId: target.appId, path: target.path }),
  }, auth.authenticatedUser);
  if (!response.ok) return response;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const expected = operation === "cancel" || operation === "status" ? "application/json" : "text/event-stream";
  if (contentType !== expected) {
    await response.body?.cancel();
    return NextResponse.json({ success: false, error: `Assistant response must be ${expected}` }, { status: 502 });
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-cache, no-transform");
  if (expected === "text/event-stream") headers.set("X-Accel-Buffering", "no");
  return new Response(response.body, { status: response.status, headers });
}

import { NextResponse } from "next/server";
import { resolveAppConversationDestination } from "@/lib/agentic-apps/app-assistant-binding";

import {
  findAgenticAppAssistantStream,
  proxyAgenticAppAssistantStream,
  type AssistantStreamOperation,
} from "@/lib/agentic-apps/assistant-stream";
import {
  getDynamicAgentsConfig,
  proxyJSONRequest,
  proxySSEStream,
  type AuthResult,
} from "@/lib/da-proxy";
import {
  cancelHarnessGatewayRun,
  resolveHarnessGatewayTarget,
  streamHarnessGatewayRun,
  unsupportedHarnessResume,
} from "@/lib/harness-gateway";
import type { Conversation } from "@/types/mongodb";

import { resolveConversationRuntimeId } from "./_conversation-authz";

/** Dispatch after agent-use and conversation-write checks, retaining the resolved caller. */
export async function dispatchChatStream(
  request: Request,
  auth: AuthResult,
  conversation: Conversation,
  body: Record<string, unknown>,
  operation: AssistantStreamOperation,
): Promise<Response> {
  const runtimeBody = { ...body, conversation_id: await resolveConversationRuntimeId(conversation) };
  const context = { subject: auth.subject, conversationId: runtimeBody.conversation_id, traceparent: auth.traceparent };
  let target = await resolveHarnessGatewayTarget(String(body.agent_id), { ...context, retainedOnly: true });
  if (target instanceof NextResponse) return target;
  if (target) {
    const conflict = resolveAppConversationDestination(conversation, body.agent_id, operation, findAgenticAppAssistantStream, true);
    if (conflict instanceof NextResponse) return conflict;
  } else {
    const appResponse = await proxyAgenticAppAssistantStream(request, auth, conversation, body, operation);
    if (appResponse) return appResponse;
  }

  if (operation === "status") {
    return NextResponse.json(
      { error: "Status is not available for this runtime" },
      { status: 501 },
    );
  }

  target ??= await resolveHarnessGatewayTarget(String(body.agent_id), context);
  if (target instanceof NextResponse) return target;
  if (target.kind === "harness_engine") {
    if (operation === "start") return streamHarnessGatewayRun(runtimeBody, auth, request.signal);
    if (operation === "cancel") return cancelHarnessGatewayRun(runtimeBody, auth);
    return unsupportedHarnessResume();
  }

  const config = getDynamicAgentsConfig();
  if (config instanceof NextResponse) return config;
  const url = `${config.dynamicAgentsUrl}/api/v1/chat/stream/${operation}`;
  const proxy = operation === "cancel" ? proxyJSONRequest : proxySSEStream;
  return proxy(url, JSON.stringify(runtimeBody), auth, `[stream/${operation}]`);
}

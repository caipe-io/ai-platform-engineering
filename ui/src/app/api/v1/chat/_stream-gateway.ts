import { NextResponse } from "next/server";

import {
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
  lookupPinnedHarnessGatewayTarget,
  resumeHarnessGatewayRun,
  statusHarnessGatewayRun,
  streamHarnessGatewayRun,
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
  const runtimeBody = {
    ...body,
    conversation_id: await resolveConversationRuntimeId(conversation),
  };
  const context = { subject: auth.subject, conversationId: runtimeBody.conversation_id, traceparent: auth.traceparent };
  let target = await lookupPinnedHarnessGatewayTarget(String(body.agent_id), context);
  if (target instanceof NextResponse) return target;
  if (!target) {
    const appResponse = await proxyAgenticAppAssistantStream(request, auth, conversation, body, operation);
    if (appResponse) return appResponse;
    if (operation === "status") return NextResponse.json({ error: "Status is not available for this runtime" }, { status: 501 });
    target = await resolveHarnessGatewayTarget(String(body.agent_id), context);
    if (target instanceof NextResponse) return target;
  }
  const engineBody = { ...runtimeBody, visible_conversation_id: conversation._id, expected_harness_id: target.harnessId };
  if (target.kind === "harness_engine") {
    if (operation === "start") return streamHarnessGatewayRun(engineBody, auth, request.signal);
    if (operation === "cancel") return cancelHarnessGatewayRun(engineBody, auth);
    if (operation === "status") return statusHarnessGatewayRun(engineBody, auth, request.signal);
    return resumeHarnessGatewayRun(engineBody, auth, request.signal);
  }

  if (operation === "status") return NextResponse.json({ error: "Status is not available for this runtime" }, { status: 501, headers: { "X-Harness-History-Owner": "client" } });
  const config = getDynamicAgentsConfig();
  if (config instanceof NextResponse) return config;
  const url = `${config.dynamicAgentsUrl}/api/v1/chat/stream/${operation}`;
  const proxy = operation === "cancel" ? proxyJSONRequest : proxySSEStream;
  return proxy(url, JSON.stringify(runtimeBody), auth, `[stream/${operation}]`);
}

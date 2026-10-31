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
  getPinnedHarnessGatewayTarget,
  getHarnessGatewayNativeThread,
  getHarnessGatewayStatus,
  resolveHarnessGatewayTarget,
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
  // Apps own their native sessions and receive the canonical conversation ID.
  // Every claimed operation returns here, including denials and unsupported operations.
  const canonicalId = await resolveConversationRuntimeId(conversation);
  const pinned = auth.subject ? await getPinnedHarnessGatewayTarget(String(body.agent_id), auth.subject, canonicalId) : null;
  const appResponse = pinned ? null : await proxyAgenticAppAssistantStream(
    request, auth, conversation, body, operation,
  );
  if (appResponse) return appResponse;

  const runtimeBody = {
    ...body,
    conversation_id: canonicalId,
  };
  const target = await resolveHarnessGatewayTarget(String(body.agent_id), {
    subject: auth.subject,
    conversationId: runtimeBody.conversation_id,
    traceparent: auth.traceparent,
  });
  if (target instanceof NextResponse) return target;
  if (target.kind === "harness_engine") {
    if (operation === "status") return getHarnessGatewayStatus(runtimeBody, auth);
    if (operation === "start") return streamHarnessGatewayRun(runtimeBody, auth, request.signal, target.harnessId);
    if (operation === "cancel") return cancelHarnessGatewayRun(runtimeBody, auth);
    return streamHarnessGatewayRun({ ...runtimeBody, command: "resume" }, auth, request.signal, target.harnessId);
  }

  if (operation === "status") return NextResponse.json({ error: "Status is not available for this runtime" }, { status: 501 });

  const config = getDynamicAgentsConfig();
  if (config instanceof NextResponse) return config;
  runtimeBody.conversation_id = await getHarnessGatewayNativeThread(String(body.agent_id), auth.subject, canonicalId);
  const url = `${config.dynamicAgentsUrl}/api/v1/chat/stream/${operation}`;
  const proxy = operation === "cancel" ? proxyJSONRequest : proxySSEStream;
  return proxy(url, JSON.stringify(runtimeBody), auth, `[stream/${operation}]`);
}

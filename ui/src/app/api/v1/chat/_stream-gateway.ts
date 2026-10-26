import { NextResponse } from "next/server";

import {
  proxyAgenticAppAssistantStream,
  resolveConversationAppAssistant,
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
  withHarnessGatewayTarget,
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
  const context = { conversationId: runtimeBody.conversation_id };
  let target = await resolveHarnessGatewayTarget(String(body.agent_id), {
    ...context, retainedOnly: true,
  });
  if (target instanceof NextResponse) return target;
  if (target) {
    const appConflict = resolveConversationAppAssistant(conversation, body.agent_id, operation, true);
    if (appConflict instanceof NextResponse) return appConflict;
  }
  if (!target) {
    // Apps receive the visible conversation ID and own their native sessions.
    // A declaration can select an unbound context, never replace a retained owner.
    const appResponse = await proxyAgenticAppAssistantStream(
      request, auth, conversation, body, operation,
    );
    if (appResponse) return appResponse;
  }

  if (operation === "status") {
    return NextResponse.json(
      { error: "Status is not available for this runtime" },
      { status: 501 },
    );
  }

  target ??= await resolveHarnessGatewayTarget(String(body.agent_id), {
    ...context, admit: operation === "start" || operation === "resume",
  });
  if (target instanceof NextResponse) return target;
  if (target.kind === "harness_engine") {
    if (operation === "start") return streamHarnessGatewayRun(
      { ...runtimeBody, expected_harness_id: target.harnessId }, auth, request.signal,
    );
    if (operation === "cancel") return cancelHarnessGatewayRun(runtimeBody, auth);
    return unsupportedHarnessResume();
  }

  const config = getDynamicAgentsConfig();
  if (config instanceof NextResponse) return config;
  const url = `${config.dynamicAgentsUrl}/api/v1/chat/stream/${operation}`;
  const proxy = operation === "cancel" ? proxyJSONRequest : proxySSEStream;
  return withHarnessGatewayTarget(
    await proxy(url, JSON.stringify(runtimeBody), auth, `[stream/${operation}]`), target,
  );
}

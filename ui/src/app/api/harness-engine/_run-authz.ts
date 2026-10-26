import { NextRequest, NextResponse } from "next/server";

import {
  authorizeConversationReadAccess,
  authorizeConversationWriteAccess,
  resolveConversationRuntimeId,
} from "@/app/api/v1/chat/_conversation-authz";
import { authenticateRequest, type AuthResult } from "@/lib/da-proxy";
import {
  getHarnessEngineConfig,
  proxyHarnessEngine,
  type HarnessEngineConfig,
} from "@/lib/harness-engine-proxy";
import { createAuthzTraceContext } from "@/lib/rbac/authz-tracing";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";
import { getCollection } from "@/lib/mongodb";
import type { Conversation } from "@/types/mongodb";

/** Resolve the owner-scoped run, then recheck current grants before exposing or controlling it. */
export async function authorizeHarnessRunAccess(
  request: NextRequest,
  runId: string,
  permission: "read" | "write",
): Promise<{ auth: AuthResult; config: HarnessEngineConfig; response: Response } | NextResponse> {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;
  auth.traceparent = createAuthzTraceContext(request.headers.get("traceparent")).traceparent;
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;
  const response = await proxyHarnessEngine(config, auth, `/api/v1/runs/${encodeURIComponent(runId)}`, { method: "GET" });
  if (!response.ok) {
    return new NextResponse(response.body, { status: response.status, headers: response.headers });
  }
  const envelope = await response.clone().json().catch(() => null);
  const run = envelope?.data;
  if (!envelope?.success || run?.run_id !== runId || run?.owner_subject !== auth.subject ||
      typeof run?.agent_id !== "string" || !run.agent_id ||
      typeof run?.conversation_id !== "string" || !run.conversation_id) {
    return NextResponse.json({ success: false, error: "Harness run could not be authorized" }, { status: 502 });
  }
  const conversations = await getCollection<Conversation>("conversations");
  let conversation = await conversations.findOne({
    $or: [{ _id: run.conversation_id }, { execution_context_id: run.conversation_id }],
  });
  if (!conversation) {
    const contexts = await getCollection(process.env.AUTONOMOUS_RUNS_COLLECTION || "autonomous_runs");
    const context = await contexts.findOne(
      { execution_context_id: run.conversation_id }, { projection: { task_id: 1 } },
    );
    if (context?.task_id) conversation = await conversations.findOne({ source: "autonomous", task_id: context.task_id });
  }
  if (!conversation || await resolveConversationRuntimeId(conversation) !== run.conversation_id) {
    return NextResponse.json({ success: false, error: "Conversation not found" }, { status: 404 });
  }
  if (permission === "read") {
    const denied = await requireAgentUsePermission({
      subject: auth.subject, agentId: run.agent_id, email: auth.email,
      tenantId: auth.tenantId, isServiceAccount: auth.isServiceAccount, traceparent: auth.traceparent,
    });
    if (denied) return denied;
  }
  const authorize = permission === "write" ? authorizeConversationWriteAccess : authorizeConversationReadAccess;
  const access = await authorize(auth, conversation._id, run.agent_id);
  if (access.denial) return access.denial;
  return { auth, config, response };
}

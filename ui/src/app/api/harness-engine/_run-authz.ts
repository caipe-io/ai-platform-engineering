import { NextRequest, NextResponse } from "next/server";

import {
  authorizeConversationReadAccess,
  authorizeConversationWriteAccess,
} from "@/app/api/v1/chat/_conversation-authz";
import { authenticateRequest, type AuthResult } from "@/lib/da-proxy";
import {
  getHarnessEngineConfig,
  proxyHarnessEngine,
  type HarnessEngineConfig,
} from "@/lib/harness-engine-proxy";
import { createAuthzTraceContext } from "@/lib/rbac/authz-tracing";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";

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
  const denied = await requireAgentUsePermission({
    subject: auth.subject, agentId: run.agent_id, email: auth.email,
    tenantId: auth.tenantId, isServiceAccount: auth.isServiceAccount, traceparent: auth.traceparent,
  });
  if (denied) return denied;
  const authorize = permission === "write" ? authorizeConversationWriteAccess : authorizeConversationReadAccess;
  const access = await authorize(auth, run.conversation_id, run.agent_id);
  if (access.denial) return access.denial;
  return { auth, config, response };
}

/**
 * API proxy route for restarting Dynamic Agent runtime.
 *
 * Invalidates the cached agent runtime, forcing it to reconnect
 * to MCP servers on the next message. Useful when MCP servers
 * come back online after being unavailable.
 *
 * POST /api/dynamic-agents/chat/restart-runtime
 * Body: { agent_id, conversation_id }
 */

import {
ApiError,
getAuthFromBearerOrSession,
} from "@/lib/api-middleware";
import { getServerConfig } from "@/lib/config";
import { requireAgentPermission } from "@/lib/rbac/resource-authz";
import { NextRequest,NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/da-proxy";
import { authorizeConversationWriteAccess, resolveConversationRuntimeId } from "@/app/api/v1/chat/_conversation-authz";
import { getPinnedHarnessGatewayTarget, getHarnessGatewayNativeThread } from "@/lib/harness-gateway";
import { getHarnessEngineConfig, proxyHarnessEngine } from "@/lib/harness-engine-proxy";

export async function POST(request: NextRequest): Promise<Response> {
  const config = getServerConfig();

  const dynamicAgentsUrl = config.dynamicAgentsUrl;
  if (!dynamicAgentsUrl) {
    return NextResponse.json(
      { success: false, error: "Dynamic agents URL not configured" },
      { status: 500 }
    );
  }

  // Authenticate the request
  let accessToken: string | undefined;
  let sessionForAuthz: Awaited<ReturnType<typeof getAuthFromBearerOrSession>>["session"] | null = null;
  try {
    const { session } = await getAuthFromBearerOrSession(request);
    sessionForAuthz = session;
    accessToken = "accessToken" in session ? session.accessToken : undefined;
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json(
        {
          success: false,
          error: err.message,
          code: err.code,
          reason: err.reason,
          action: err.action,
        },
        { status: err.statusCode },
      );
    }
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  // Parse the request body
  let body: { agent_id: string; conversation_id: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request body" },
      { status: 400 }
    );
  }

  if (!body.agent_id || !body.conversation_id) {
    return NextResponse.json(
      { success: false, error: "Missing required fields: agent_id, conversation_id" },
      { status: 400 }
    );
  }

  try {
    if (!sessionForAuthz) {
      throw new ApiError("Unauthorized", 401);
    }
    await requireAgentPermission(sessionForAuthz, body.agent_id, "manage");
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json(
        {
          success: false,
          error: err.message,
          code: err.code,
          reason: err.reason,
          action: err.action,
        },
        { status: err.statusCode },
      );
    }
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;
  const access = await authorizeConversationWriteAccess(auth, body.conversation_id, body.agent_id);
  if (access.denial) return access.denial;
  const runtimeId = await resolveConversationRuntimeId(access.conversation);
  const pinned = auth.subject ? await getPinnedHarnessGatewayTarget(body.agent_id, auth.subject, runtimeId) : null;
  if (pinned?.kind === "harness_engine") {
    const engine = getHarnessEngineConfig();
    if (engine instanceof NextResponse) return engine;
    return proxyHarnessEngine(engine, auth, "/api/v1/sessions/restart-runtime", { method: "POST", body: JSON.stringify({ ...body, conversation_id: runtimeId }) });
  }

  body.conversation_id = await getHarnessGatewayNativeThread(body.agent_id, auth.subject, runtimeId);

  // Build headers for the backend request
  const backendHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Forward the access token to the Dynamic Agents backend
  if (accessToken) {
    backendHeaders["Authorization"] = `Bearer ${accessToken}`;
  }

  const backendUrl = `${dynamicAgentsUrl}/api/v1/chat/restart-runtime`;

  try {
    const backendResponse = await fetch(backendUrl, {
      method: "POST",
      headers: backendHeaders,
      body: JSON.stringify(body),
    });

    if (!backendResponse.ok) {
      const errorText = await backendResponse.text().catch(() => "");
      console.error(
        `[dynamic-agents/chat/restart-runtime] Backend error: ${backendResponse.status}`,
        errorText
      );
      return NextResponse.json(
        {
          success: false,
          error: `Backend error: ${backendResponse.status}`,
        },
        { status: backendResponse.status }
      );
    }

    const result = await backendResponse.json();
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";

    if (
      message.includes("fetch failed") ||
      message.includes("ECONNREFUSED")
    ) {
      console.error("[dynamic-agents/chat/restart-runtime] Backend unreachable:", message);
      return NextResponse.json(
        {
          success: false,
          error: "Dynamic agents service is not available",
        },
        { status: 503 }
      );
    }

    console.error("[dynamic-agents/chat/restart-runtime] Proxy error:", err);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

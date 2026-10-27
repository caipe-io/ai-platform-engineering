import { getAuthFromBearerOrSession } from "@/lib/api-middleware";
import type { AuthResult } from "@/lib/da-proxy";
import { getHarnessEngineConfig, proxyHarnessEngine } from "@/lib/harness-engine-proxy";
import { requireAgentPermission } from "@/lib/rbac/resource-authz";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

interface Context {
  params: Promise<{ agentId: string }>;
}

async function authorize(request: NextRequest, agentId: string, write: boolean): Promise<AuthResult> {
  const { user, session } = await getAuthFromBearerOrSession(request);
  await requireAgentPermission(session, agentId, write ? "write" : "read");
  const values = session as unknown as Record<string, unknown>;
  return {
    subject: (values.sub as string | undefined) ?? user.email,
    email: user.email,
    traceparent: request.headers.get("traceparent") ?? undefined,
  };
}

async function proxy(
  request: NextRequest,
  context: Context,
  method: "GET" | "PUT" | "DELETE",
): Promise<Response> {
  const { agentId } = await context.params;
  try {
    const auth = await authorize(request, agentId, method !== "GET");
    const config = getHarnessEngineConfig();
    if (config instanceof NextResponse) return config;
    const body = method === "PUT" ? await request.text() : undefined;
    return proxyHarnessEngine(
      config,
      auth,
      `/api/v1/agents/${encodeURIComponent(agentId)}`,
      { method, body },
    );
  } catch (error) {
    const candidate = error as { statusCode?: number; message?: string };
    return NextResponse.json(
      { success: false, error: candidate.message ?? "Authorization failed" },
      { status: candidate.statusCode ?? 401 },
    );
  }
}

export const GET = (request: NextRequest, context: Context) => proxy(request, context, "GET");
export const PUT = (request: NextRequest, context: Context) => proxy(request, context, "PUT");
export const DELETE = (request: NextRequest, context: Context) =>
  proxy(request, context, "DELETE");

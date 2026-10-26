import { conversationFileNamespace, proxyHarnessConversationOperation } from "@/lib/harness-gateway";
/**
 * Generic file content endpoint.
 *
 * GET    /api/files/content?fs_namespace=["a","b","c"]&path=some/file.txt
 * PUT    /api/files/content  (body: { fs_namespace, path, content })
 * DELETE /api/files/content?fs_namespace=["a","b","c"]&path=some/file.txt
 *
 * Proxies to Dynamic Agents service: /api/v1/files/content
 */

import {
authenticateRequest,
getDynamicAgentsConfig,
proxyRequest,
} from "@/lib/da-proxy";
import { NextRequest,NextResponse } from "next/server";

export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const fsNamespace = searchParams.get("fs_namespace");
  const path = searchParams.get("path");

  if (!fsNamespace) {
    return NextResponse.json(
      { success: false, error: "fs_namespace query parameter is required" },
      { status: 400 },
    );
  }

  if (!path) {
    return NextResponse.json(
      { success: false, error: "path query parameter is required" },
      { status: 400 },
    );
  }

  const authResult = await authenticateRequest(request);
  if (authResult instanceof NextResponse) return authResult;
  const context = conversationFileNamespace(fsNamespace);
  if (context) {
    const harness = await proxyHarnessConversationOperation(authResult, context.conversationId, context.agentId, "file", path);
    if (harness) return harness;
  }

  const daConfig = getDynamicAgentsConfig();
  if (daConfig instanceof NextResponse) return daConfig;

  const backendUrl = new URL("/api/v1/files/content", daConfig.dynamicAgentsUrl);
  backendUrl.searchParams.set("fs_namespace", fsNamespace);
  backendUrl.searchParams.set("path", path);

  return proxyRequest(backendUrl.toString(), "GET", authResult, "[files/content]");
}

export async function PUT(request: NextRequest): Promise<Response> {
  const authResult = await authenticateRequest(request);
  if (authResult instanceof NextResponse) return authResult;
  const body = await request.json();
  const context = conversationFileNamespace(body.fs_namespace);
  if (context) {
    const harness = await proxyHarnessConversationOperation(authResult, context.conversationId, context.agentId, "write-file", typeof body.path === "string" ? body.path : undefined);
    if (harness) return harness;
  }

  const daConfig = getDynamicAgentsConfig();
  if (daConfig instanceof NextResponse) return daConfig;

  const backendUrl = new URL("/api/v1/files/content", daConfig.dynamicAgentsUrl);



  return proxyRequest(backendUrl.toString(), "PUT", authResult, "[files/content]", JSON.stringify(body));
}

export async function DELETE(request: NextRequest): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const fsNamespace = searchParams.get("fs_namespace");
  const path = searchParams.get("path");

  if (!fsNamespace) {
    return NextResponse.json(
      { success: false, error: "fs_namespace query parameter is required" },
      { status: 400 },
    );
  }

  if (!path) {
    return NextResponse.json(
      { success: false, error: "path query parameter is required" },
      { status: 400 },
    );
  }

  const authResult = await authenticateRequest(request);
  if (authResult instanceof NextResponse) return authResult;
  const context = conversationFileNamespace(fsNamespace);
  if (context) {
    const harness = await proxyHarnessConversationOperation(authResult, context.conversationId, context.agentId, "delete-file", path);
    if (harness) return harness;
  }

  const daConfig = getDynamicAgentsConfig();
  if (daConfig instanceof NextResponse) return daConfig;

  const backendUrl = new URL("/api/v1/files/content", daConfig.dynamicAgentsUrl);
  backendUrl.searchParams.set("fs_namespace", fsNamespace);
  backendUrl.searchParams.set("path", path);

  return proxyRequest(backendUrl.toString(), "DELETE", authResult, "[files/content]");
}

/**
 * Generic file list endpoint.
 *
 * GET /api/files/list?fs_namespace=["a","b","c"]
 *
 * Proxies to Dynamic Agents service: GET /api/v1/files/list
 */

import {
authenticateRequest,
getDynamicAgentsConfig,
proxyRequest,
} from "@/lib/da-proxy";
import { resolveHarnessNativeNamespace } from "@/lib/harness-native-state";
import { NextRequest,NextResponse } from "next/server";

export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const fsNamespace = searchParams.get("fs_namespace");

  if (!fsNamespace) {
    return NextResponse.json(
      { success: false, error: "fs_namespace query parameter is required" },
      { status: 400 },
    );
  }

  const authResult = await authenticateRequest(request);
  if (authResult instanceof NextResponse) return authResult;

  const daConfig = getDynamicAgentsConfig();
  if (daConfig instanceof NextResponse) return daConfig;

  const backendUrl = new URL("/api/v1/files/list", daConfig.dynamicAgentsUrl);
  const resolvedNamespace = await resolveHarnessNativeNamespace(fsNamespace, authResult, request.method !== "GET");
  if (resolvedNamespace instanceof NextResponse) return resolvedNamespace;
  backendUrl.searchParams.set("fs_namespace", resolvedNamespace);

  return proxyRequest(backendUrl.toString(), "GET", authResult, "[files/list]");
}

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
import { resolveHarnessNativeNamespace } from "@/lib/harness-native-state";
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

  const daConfig = getDynamicAgentsConfig();
  if (daConfig instanceof NextResponse) return daConfig;

  const backendUrl = new URL("/api/v1/files/content", daConfig.dynamicAgentsUrl);
  const resolvedNamespace = await resolveHarnessNativeNamespace(fsNamespace, authResult, request.method !== "GET");
  if (resolvedNamespace instanceof NextResponse) return resolvedNamespace;
  backendUrl.searchParams.set("fs_namespace", resolvedNamespace);
  backendUrl.searchParams.set("path", path);

  return proxyRequest(backendUrl.toString(), "GET", authResult, "[files/content]");
}

export async function PUT(request: NextRequest): Promise<Response> {
  const authResult = await authenticateRequest(request);
  if (authResult instanceof NextResponse) return authResult;

  const daConfig = getDynamicAgentsConfig();
  if (daConfig instanceof NextResponse) return daConfig;

  const backendUrl = new URL("/api/v1/files/content", daConfig.dynamicAgentsUrl);

  const body = await request.json();
  const resolvedNamespace = await resolveHarnessNativeNamespace(JSON.stringify(body.fs_namespace), authResult, true);
  if (resolvedNamespace instanceof NextResponse) return resolvedNamespace;
  body.fs_namespace = JSON.parse(resolvedNamespace);

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

  const daConfig = getDynamicAgentsConfig();
  if (daConfig instanceof NextResponse) return daConfig;

  const backendUrl = new URL("/api/v1/files/content", daConfig.dynamicAgentsUrl);
  const resolvedNamespace = await resolveHarnessNativeNamespace(fsNamespace, authResult, request.method !== "GET");
  if (resolvedNamespace instanceof NextResponse) return resolvedNamespace;
  backendUrl.searchParams.set("fs_namespace", resolvedNamespace);
  backendUrl.searchParams.set("path", path);

  return proxyRequest(backendUrl.toString(), "DELETE", authResult, "[files/content]");
}

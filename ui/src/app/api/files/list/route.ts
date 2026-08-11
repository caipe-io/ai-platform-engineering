/** Generic file list endpoint backed by an authorized run namespace. */

import { NextRequest, NextResponse } from "next/server";

import { withErrorHandler } from "@/lib/api-middleware";
import { getDynamicAgentsConfig, proxyRequest } from "@/lib/da-proxy";
import { authorizeFileNamespace } from "@/lib/file-namespace-authorization";

export const GET = withErrorHandler(async (request: NextRequest): Promise<Response> => {
  const fsNamespace = request.nextUrl.searchParams.get("fs_namespace");
  if (!fsNamespace) {
    return NextResponse.json(
      { success: false, error: "fs_namespace query parameter is required" },
      { status: 400 },
    );
  }

  const authorization = await authorizeFileNamespace(request, fsNamespace, "read");
  if (authorization instanceof NextResponse) return authorization;

  const daConfig = getDynamicAgentsConfig();
  if (daConfig instanceof NextResponse) return daConfig;
  const backendUrl = new URL("/api/v1/files/list", daConfig.dynamicAgentsUrl);
  backendUrl.searchParams.set("fs_namespace", JSON.stringify(authorization.namespace));
  return proxyRequest(
    backendUrl.toString(),
    "GET",
    authorization.authResult,
    "[files/list]",
  );
});

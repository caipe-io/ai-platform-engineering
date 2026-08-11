/** Generic file content endpoint backed by an authorized run namespace. */

import { NextRequest, NextResponse } from "next/server";

import { withErrorHandler } from "@/lib/api-middleware";
import { getDynamicAgentsConfig, proxyRequest } from "@/lib/da-proxy";
import { authorizeFileNamespace } from "@/lib/file-namespace-authorization";

async function proxyQueryRequest(
  request: NextRequest,
  method: "GET" | "DELETE",
): Promise<Response> {
  const fsNamespace = request.nextUrl.searchParams.get("fs_namespace");
  const path = request.nextUrl.searchParams.get("path");
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

  const authorization = await authorizeFileNamespace(
    request,
    fsNamespace,
    method === "GET" ? "read" : "write",
  );
  if (authorization instanceof NextResponse) return authorization;

  const daConfig = getDynamicAgentsConfig();
  if (daConfig instanceof NextResponse) return daConfig;
  const backendUrl = new URL("/api/v1/files/content", daConfig.dynamicAgentsUrl);
  backendUrl.searchParams.set("fs_namespace", JSON.stringify(authorization.namespace));
  backendUrl.searchParams.set("path", path);
  return proxyRequest(
    backendUrl.toString(),
    method,
    authorization.authResult,
    "[files/content]",
  );
}

export const GET = withErrorHandler(
  async (request: NextRequest): Promise<Response> => proxyQueryRequest(request, "GET"),
);

export const PUT = withErrorHandler(async (request: NextRequest): Promise<Response> => {
  const body = await request.json() as Record<string, unknown>;
  const authorization = await authorizeFileNamespace(
    request,
    body.fs_namespace,
    "write",
  );
  if (authorization instanceof NextResponse) return authorization;

  const daConfig = getDynamicAgentsConfig();
  if (daConfig instanceof NextResponse) return daConfig;
  const backendUrl = new URL("/api/v1/files/content", daConfig.dynamicAgentsUrl);
  return proxyRequest(
    backendUrl.toString(),
    "PUT",
    authorization.authResult,
    "[files/content]",
    JSON.stringify({ ...body, fs_namespace: authorization.namespace }),
  );
});

export const DELETE = withErrorHandler(
  async (request: NextRequest): Promise<Response> => proxyQueryRequest(request, "DELETE"),
);

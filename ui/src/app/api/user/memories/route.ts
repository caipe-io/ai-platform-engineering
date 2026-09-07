import { NextRequest, NextResponse } from "next/server";

import {
  authenticateRequest,
  buildBackendHeaders,
  getDynamicAgentsConfig,
} from "@/lib/da-proxy";

async function proxyMemories(request: NextRequest, method: string): Promise<Response> {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const config = getDynamicAgentsConfig();
  if (config instanceof NextResponse) return config;

  const backendUrl = new URL("/api/v1/memories", config.dynamicAgentsUrl);
  request.nextUrl.searchParams.forEach((value, key) => backendUrl.searchParams.append(key, value));
  const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
  let response: Response;
  try {
    response = await fetch(backendUrl, {
      method,
      headers: buildBackendHeaders("application/json", auth),
      body: hasBody ? await request.text() : undefined,
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { success: false, error: "Memory storage is temporarily unavailable" },
      { status: 503 },
    );
  }

  const headers = new Headers();
  headers.set("Content-Type", response.headers.get("Content-Type") || "application/json");
  const etag = response.headers.get("ETag");
  if (etag) headers.set("ETag", etag);
  return new Response(await response.arrayBuffer(), { status: response.status, headers });
}

export const GET = (request: NextRequest) => proxyMemories(request, "GET");
export const POST = (request: NextRequest) => proxyMemories(request, "POST");
export const PUT = (request: NextRequest) => proxyMemories(request, "PUT");
export const PATCH = (request: NextRequest) => proxyMemories(request, "PATCH");
export const DELETE = (request: NextRequest) => proxyMemories(request, "DELETE");

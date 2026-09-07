import { NextRequest, NextResponse } from "next/server";

import {
  authenticateRequest,
  buildBackendHeaders,
  getDynamicAgentsConfig,
} from "@/lib/da-proxy";
import { getProjectsEnabled } from "@/lib/projects-config";

async function proxyProjects(request: NextRequest, method: "GET" | "POST"): Promise<Response> {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;
  if (!(await getProjectsEnabled())) {
    return NextResponse.json(
      { success: false, error: "Projects are not enabled on this platform" },
      { status: 404 },
    );
  }
  const config = getDynamicAgentsConfig();
  if (config instanceof NextResponse) return config;

  try {
    const response = await fetch(new URL("/api/v1/projects", config.dynamicAgentsUrl), {
      method,
      headers: buildBackendHeaders("application/json", auth),
      body: method === "POST" ? await request.text() : undefined,
      cache: "no-store",
    });
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: { "Content-Type": response.headers.get("Content-Type") || "application/json" },
    });
  } catch {
    return NextResponse.json(
      { success: false, error: "Projects are temporarily unavailable" },
      { status: 503 },
    );
  }
}

export const GET = (request: NextRequest) => proxyProjects(request, "GET");
export const POST = (request: NextRequest) => proxyProjects(request, "POST");

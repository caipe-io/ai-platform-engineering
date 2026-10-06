import {
  authenticateRequest,
  getDynamicAgentsConfig,
  proxyRequest,
} from "@/lib/da-proxy";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest): Promise<Response> {
  const authResult = await authenticateRequest(request);
  if (authResult instanceof NextResponse) return authResult;

  const daConfig = getDynamicAgentsConfig();
  if (daConfig instanceof NextResponse) return daConfig;

  const body = JSON.stringify({
    model: {
      id: request.nextUrl.searchParams.get("model_id") ?? "",
      provider: request.nextUrl.searchParams.get("provider") ?? "",
    },
  });
  const backendUrl = new URL(
    "/api/v1/model-capabilities",
    daConfig.dynamicAgentsUrl,
  );
  return proxyRequest(
    backendUrl.toString(),
    "POST",
    authResult,
    "[model-capabilities]",
    body,
  );
}

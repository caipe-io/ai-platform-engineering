import { NextRequest, NextResponse } from "next/server";

import { proxyRequest } from "@/lib/da-proxy";

import { authorizeRunReadRequest } from "../_authorization";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ runId: string }> }): Promise<Response> {
  const authorized = await authorizeRunReadRequest(request);
  if (authorized instanceof NextResponse) return authorized;
  const { runId } = await context.params;
  authorized.backendUrl.pathname += `/${encodeURIComponent(runId)}`;
  return proxyRequest(authorized.backendUrl.toString(), "GET", authorized.authResult, "[runs/status]");
}

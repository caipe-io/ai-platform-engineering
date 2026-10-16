import { NextRequest, NextResponse } from "next/server";

import { proxySSEStream } from "@/lib/da-proxy";

import { authorizeRunReadRequest } from "../../_authorization";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: NextRequest, context: { params: Promise<{ runId: string }> }): Promise<Response> {
  const authorized = await authorizeRunReadRequest(request);
  if (authorized instanceof NextResponse) return authorized;
  const after = new URL(request.url).searchParams.get("after") ?? "0";
  if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) {
    return NextResponse.json({ success: false, error: "after must be a non-negative integer" }, { status: 400 });
  }
  const { runId } = await context.params;
  authorized.backendUrl.pathname += `/${encodeURIComponent(runId)}/stream`;
  authorized.backendUrl.searchParams.set("after", after);
  return proxySSEStream(authorized.backendUrl.toString(), undefined, authorized.authResult, "[runs/stream]", "GET");
}

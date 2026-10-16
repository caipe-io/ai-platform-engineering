import { NextRequest, NextResponse } from "next/server";

import { proxyRequest } from "@/lib/da-proxy";

import { authorizeRunReadRequest } from "./_authorization";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  const authorized = await authorizeRunReadRequest(request);
  if (authorized instanceof NextResponse) return authorized;
  return proxyRequest(authorized.backendUrl.toString(), "GET", authorized.authResult, "[runs/latest]");
}

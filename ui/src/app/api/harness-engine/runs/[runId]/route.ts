import { proxyHarnessEngine } from "@/lib/harness-engine-proxy";
import { authorizeHarnessRunAccess } from "../../_run-authz";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

interface Context { params: Promise<{ runId: string }> }

async function proxy(request: NextRequest, context: Context, method: "GET" | "DELETE") {
  const { runId } = await context.params;
  const access = await authorizeHarnessRunAccess(request, runId, method === "DELETE" ? "write" : "read");
  if (access instanceof NextResponse) return access;
  if (method === "GET") return access.response;
  return proxyHarnessEngine(access.config, access.auth, `/api/v1/runs/${encodeURIComponent(runId)}`, { method });
}

export const GET = (request: NextRequest, context: Context) => proxy(request, context, "GET");
export const DELETE = (request: NextRequest, context: Context) => proxy(request, context, "DELETE");

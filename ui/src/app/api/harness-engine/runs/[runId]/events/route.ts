import { proxyHarnessEngine } from "@/lib/harness-engine-proxy";
import { authorizeHarnessRunAccess } from "../../../_run-authz";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await context.params;
  const access = await authorizeHarnessRunAccess(request, runId, "read");
  if (access instanceof NextResponse) return access;
  const query = new URLSearchParams();
  for (const key of ["after", "wait"]) {
    const value = request.nextUrl.searchParams.get(key);
    if (value !== null) query.set(key, value);
  }
  const suffix = query.size ? `?${query}` : "";
  return proxyHarnessEngine(
    access.config,
    access.auth,
    `/api/v1/runs/${encodeURIComponent(runId)}/events${suffix}`,
  );
}

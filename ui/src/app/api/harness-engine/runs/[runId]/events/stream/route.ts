import { proxyHarnessEngineStream } from "@/lib/harness-engine-proxy";
import { authorizeHarnessRunAccess } from "../../../../_run-authz";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await context.params;
  const access = await authorizeHarnessRunAccess(request, runId, "read");
  if (access instanceof NextResponse) return access;
  const after = request.nextUrl.searchParams.get("after") ?? request.headers.get("last-event-id");
  const suffix = after === null ? "" : `?after=${encodeURIComponent(after)}`;

  // Aborting this fetch only drops this subscriber. The run was started by a
  // separate POST and is owned by Harness Engine, so provider execution and
  // event persistence continue after the browser/BFF connection disappears.
  return proxyHarnessEngineStream(
    access.config,
    access.auth,
    `/api/v1/runs/${encodeURIComponent(runId)}/events/stream${suffix}`,
    request.signal,
  );
}

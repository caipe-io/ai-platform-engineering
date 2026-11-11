import { NextRequest, NextResponse } from "next/server";
import { authorizeHarnessRunAccess } from "../../../_run-authz";
import { ApiError, withErrorHandler } from "@/lib/api-middleware";
import { enqueueHandoff, handoffTools } from "@/lib/coordination/handoffs.server";

export const runtime = "nodejs";
export const POST = withErrorHandler(async (request: NextRequest, context: { params: Promise<{ runId: string }> }) => {
  const { runId } = await context.params;
  const access = await authorizeHarnessRunAccess(request, runId, "write");
  if (access instanceof NextResponse) return access;
  const run = (await access.response.json()).data;
  if (run.status !== "running" || run.cancellation_requested) throw new ApiError("An active run is required", 409);
  const body = await request.json();
  if (body.operation === "list") return NextResponse.json({ success: true, data: { tools: await handoffTools(run) } });
  if (body.operation !== "call") throw new ApiError("Expected list or call", 400);
  const assignment = await enqueueHandoff(run, access.auth, body.arguments);
  return NextResponse.json({ success: true, data: { content: [{ type: "text", text: JSON.stringify(assignment) }] } });
});

/**
 * GET  /api/workflow-runs/[id]  — Fetch a single run by path param (shareable URL)
 * PATCH /api/workflow-runs/[id] — Update sharing visibility (owner only)
 * # assisted-by claude code claude-sonnet-4-6
 */

import {
  ApiError,
  getAuthFromBearerOrSession,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { detectStaleRun, type WorkflowRunDocument, type WorkflowRunVisibility } from "@/lib/server/workflow-engine";
import { deleteEventsByRun, readEventsByRun } from "@/lib/server/event-store";
import { buildWorkflowDaAuthHeaders } from "@/lib/server/workflow-da-auth";
import {
  requireWorkflowRunAccess,
  workflowSubjectFromSession,
} from "@/lib/server/workflow-cas-authz";
import { NextRequest, NextResponse } from "next/server";

const ALLOWED_VISIBILITY: WorkflowRunVisibility[] = ["private", "workspace", "admin"];

// ═══════════════════════════════════════════════════════════════
// GET — Fetch a single run with events (shareable clean URL)
// ═══════════════════════════════════════════════════════════════

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  if (!isMongoDBConfigured) {
    throw new ApiError("MongoDB is required for workflow runs", 503);
  }

  const { id } = await params;
  const { session } = await getAuthFromBearerOrSession(request);

  const col = await getCollection<WorkflowRunDocument>("workflow_runs");
  const run = await col.findOne({ _id: id });
  if (!run) {
    throw new ApiError(`Run ${id} not found`, 404);
  }

  try {
    await requireWorkflowRunAccess(session, run, "read");
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 403) {
      // Mask existence for private runs
      throw new ApiError(`Run ${id} not found`, 404);
    }
    throw err;
  }

  const isStale = await detectStaleRun(run);
  if (isStale) {
    run.status = "failed";
  }

  const events = await readEventsByRun(id);
  const eventsObj: Record<number, unknown[]> = {};
  for (const [stepIndex, stepEvents] of events) {
    eventsObj[stepIndex] = stepEvents;
  }

  return NextResponse.json({ ...run, events: eventsObj }) as NextResponse;
});

// ═══════════════════════════════════════════════════════════════
// PATCH — Update sharing visibility (owner only)
// ═══════════════════════════════════════════════════════════════

export const PATCH = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  if (!isMongoDBConfigured) {
    throw new ApiError("MongoDB is required for workflow runs", 503);
  }

  const { id } = await params;
  const { session } = await getAuthFromBearerOrSession(request);

  const subject = workflowSubjectFromSession(session);
  if (!subject) {
    throw new ApiError("Authentication required", 401, "NO_SUBJECT", "session_expired", "sign_in");
  }

  const body = await request.json() as Record<string, unknown>;
  const rawVisibility = body.shared_with;

  if (rawVisibility !== undefined && !ALLOWED_VISIBILITY.includes(rawVisibility as WorkflowRunVisibility)) {
    throw new ApiError(
      `shared_with must be one of: ${ALLOWED_VISIBILITY.join(", ")}`,
      400,
    );
  }
  const shared_with = rawVisibility as WorkflowRunVisibility | undefined;

  const col = await getCollection<WorkflowRunDocument>("workflow_runs");
  const run = await col.findOne({ _id: id });
  if (!run) {
    throw new ApiError(`Run ${id} not found`, 404);
  }

  // Only the owner may change sharing settings
  if (run.owner_subject?.type !== subject.type || run.owner_subject?.id !== subject.id) {
    throw new ApiError("Only the run owner can change sharing settings", 403);
  }

  await col.updateOne({ _id: id }, { $set: { shared_with: shared_with ?? "private" } });

  return NextResponse.json({ id, shared_with: shared_with ?? "private" }) as NextResponse;
});

// ═══════════════════════════════════════════════════════════════
// DELETE — Delete a run (convenience: same path, owner only)
// ═══════════════════════════════════════════════════════════════

export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  if (!isMongoDBConfigured) {
    throw new ApiError("MongoDB is required for workflow runs", 503);
  }

  const { id } = await params;
  const { user, session } = await getAuthFromBearerOrSession(request);

  const col = await getCollection<WorkflowRunDocument>("workflow_runs");
  const run = await col.findOne({ _id: id });
  if (!run) {
    throw new ApiError(`Run ${id} not found`, 404);
  }

  await requireWorkflowRunAccess(session, run, "delete");

  try {
    const daUrl = process.env.DYNAMIC_AGENTS_URL || "http://localhost:8100";
    const fsNamespace = JSON.stringify([run.workflow_config_id, id, "filesystem"]);
    await fetch(
      `${daUrl}/api/v1/files/namespace?fs_namespace=${encodeURIComponent(fsNamespace)}`,
      {
        method: "DELETE",
        headers: buildWorkflowDaAuthHeaders(request, user, session),
      },
    );
  } catch { /* best-effort */ }

  try {
    await deleteEventsByRun(id);
  } catch { /* best-effort */ }

  await col.deleteOne({ _id: id });

  return NextResponse.json({ id, message: "Workflow run deleted" }) as NextResponse;
});

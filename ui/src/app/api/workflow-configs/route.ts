import {
ApiError,
successResponse,
withAuth,
withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import {
filterAccessibleWorkflowConfigs,
workflowAccessAllowed,
} from "@/lib/server/workflow-cas-authz";
import {
  buildTeamRefToSlugMap,
filterWorkflowConfigsByRunAccess,
mergeWorkflowConfigsById,
normalizeSharedWithTeamSlugs,
reconcileWorkflowConfigAccess,
requireWorkflowConfigRunAccess,
requireWorkflowConfigWriteAccess,
  resolveUserTeamSlugsForWorkflow,
} from "@/lib/rbac/workflow-config-rebac";
import { assertWorkflowConfigRunnable } from "@/lib/server/workflow-step-agents";
import type {
CreateWorkflowConfigInput,
StepEntry,
UpdateWorkflowConfigInput,
WorkflowConfig,
WorkflowConfigVisibility,
} from "@/types/workflow-config";
import { NextRequest,NextResponse } from "next/server";

/**
 * Workflow Config API Routes
 *
 * CRUD operations for workflow configs stored in the workflow_configs MongoDB collection.
 * These configs define multi-step workflows executed by the Workflow Service
 * against dynamic agents via AG-UI.
 */

const STORAGE_TYPE = isMongoDBConfigured ? "mongodb" : "none";
const VALID_VISIBILITIES: WorkflowConfigVisibility[] = ["private", "team", "global"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateSteps(steps: StepEntry[]): void {
  if (!steps || steps.length === 0) {
    throw new ApiError("At least one step is required", 400);
  }
  for (const entry of steps) {
    if (entry.type === "parallel") {
      throw new ApiError(
        "Parallel groups are not supported in v1. All steps must have type 'step'.",
        400
      );
    }
    if (entry.type !== "step") {
      const unsupported = entry as { type?: unknown };
      throw new ApiError(`Unknown step type: ${String(unsupported.type)}`, 400);
    }
    if (!entry.display_text || !entry.agent_id || !entry.prompt) {
      throw new ApiError(
        "Each step must have display_text, agent_id, and prompt",
        400
      );
    }
    if (entry.on_error === "retry" && (!entry.retry || entry.retry.max_attempts < 1)) {
      throw new ApiError(
        "Steps with on_error='retry' must have retry.max_attempts >= 1",
        400
      );
    }
  }
}

function validateVisibility(
  visibility: WorkflowConfigVisibility | undefined,
  sharedWithTeams: string[] | undefined
): void {
  if (visibility !== undefined) {
    if (!VALID_VISIBILITIES.includes(visibility)) {
      throw new ApiError(
        `Invalid visibility: ${visibility}. Must be one of: ${VALID_VISIBILITIES.join(", ")}`,
        400
      );
    }
    if (visibility === "team" && (!sharedWithTeams || sharedWithTeams.length === 0)) {
      throw new ApiError(
        "At least one team must be selected when visibility is 'team'",
        400
      );
    }
  }
}

async function getVisibleConfigs(): Promise<WorkflowConfig[]> {
  const collection = await getCollection<WorkflowConfig>("workflow_configs");

  return collection
    .find({})
    .sort({ name: 1 })
    .toArray();
}

async function getVisibleConfigById(
  id: string,
): Promise<WorkflowConfig | null> {
  const collection = await getCollection<WorkflowConfig>("workflow_configs");

  return collection.findOne({ _id: id });
}

// ---------------------------------------------------------------------------
// GET — list all visible configs, or get one by ?id=
// ---------------------------------------------------------------------------

export const GET = withErrorHandler(async (request: NextRequest) => {
  if (STORAGE_TYPE !== "mongodb") {
    throw new ApiError("Workflows require MongoDB to be configured", 503);
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  return await withAuth(request, async (_req, user, session) => {
    // Admins can see all workflow configs
    if (user.role === "admin") {
      const collection = await getCollection<WorkflowConfig>("workflow_configs");
      if (id) {
        const config = await collection.findOne({ _id: id });
        if (!config) throw new ApiError("Workflow config not found", 404);
        return NextResponse.json(config) as NextResponse;
      }
      const configs = await collection.find({}).sort({ name: 1 }).toArray();
      return NextResponse.json(configs) as NextResponse;
    }

    const userTeamSlugs = await resolveUserTeamSlugsForWorkflow(user.email, session);

    if (id) {
      const config = await getVisibleConfigById(id);
      if (!config) {
        throw new ApiError("Workflow config not found", 404);
      }
      // Additive CAS read (Phase 2) — mirrors the list's "visibility ∪ FGA read"
      // semantics: if CAS grants task#read (org-admin bypass included) serve it;
      // otherwise fall back to the legacy visibility check unchanged.
      if (!(await workflowAccessAllowed(session, String(config._id), "read"))) {
        await requireWorkflowConfigRunAccess(
          session,
          {
            _id: String(config._id),
            owner_id: config.owner_id,
            visibility: config.visibility,
            shared_with_teams: config.shared_with_teams,
          },
          user.email,
          userTeamSlugs,
        );
      }
      return NextResponse.json(config) as NextResponse;
    }

    const configs = await getVisibleConfigs();
    const teamRefToSlug = await buildTeamRefToSlugMap();
    const byVisibility = filterWorkflowConfigsByRunAccess(
      configs,
      user.email,
      userTeamSlugs,
      teamRefToSlug,
    );
    // Match workflow-runs list: org-wide global workflows use Mongo visibility;
    // CAS `task#read` supplements legacy per-user/team grants (org-admin bypass
    // included). This is the PDP call re-pointed onto CAS (Phase 2).
    const byFga = await filterAccessibleWorkflowConfigs(
      session,
      configs,
      (config) => String(config._id),
      "read",
    );
    const visibleConfigs = mergeWorkflowConfigsById(byVisibility, byFga);
    return NextResponse.json(visibleConfigs) as NextResponse;
  });
});

// ---------------------------------------------------------------------------
// POST — create a new workflow config
// ---------------------------------------------------------------------------

export const POST = withErrorHandler(async (request: NextRequest) => {
  if (STORAGE_TYPE !== "mongodb") {
    throw new ApiError("Workflows require MongoDB to be configured", 503);
  }

  return await withAuth(request, async (_req, user, session) => {
    const body: CreateWorkflowConfigInput = await request.json();

    if (!body.name) {
      throw new ApiError("Missing required field: name", 400);
    }

    validateSteps(body.steps);
    const visibility: WorkflowConfigVisibility = body.visibility || "private";
    const sharedWithTeams =
      visibility === "team"
        ? await normalizeSharedWithTeamSlugs(body.shared_with_teams)
        : undefined;
    validateVisibility(visibility, sharedWithTeams);

    const id = `wf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date();

    const config: WorkflowConfig = {
      _id: id,
      name: body.name,
      description: body.description,
      steps: body.steps,
      owner_id: user.email,
      visibility,
      shared_with_teams: sharedWithTeams,
      created_at: now,
      updated_at: now,
    };

    await assertWorkflowConfigRunnable(config);

    const collection = await getCollection<WorkflowConfig>("workflow_configs");
    await collection.insertOne(config);

    await reconcileWorkflowConfigAccess(session, config);

    return successResponse({ id, message: "Workflow config created successfully" }, 201);
  });
});

// ---------------------------------------------------------------------------
// PUT — update an existing workflow config (?id=)
// ---------------------------------------------------------------------------

export const PUT = withErrorHandler(async (request: NextRequest) => {
  if (STORAGE_TYPE !== "mongodb") {
    throw new ApiError("Workflows require MongoDB to be configured", 503);
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    throw new ApiError("Workflow config ID is required", 400);
  }

  return await withAuth(request, async (_req, user, session) => {
    const body: UpdateWorkflowConfigInput = await request.json();

    if (Object.keys(body).length === 0) {
      throw new ApiError("At least one field must be provided for update", 400);
    }

    const collection = await getCollection<WorkflowConfig>("workflow_configs");
    const existing = await collection.findOne({ _id: id });

    if (!existing) {
      throw new ApiError("Workflow config not found", 404);
    }
    if (existing.config_driven) {
      throw new ApiError("Cannot modify a config-driven workflow. Edit app-config.yaml instead.", 403);
    }

    if (user.role !== "admin") {
      await requireWorkflowConfigWriteAccess(
        session,
        {
          _id: id,
          owner_id: existing.owner_id,
          visibility: existing.visibility,
          shared_with_teams: existing.shared_with_teams,
        },
        user.email,
      );
    }

    if (body.steps) {
      validateSteps(body.steps);
    }
    if (body.visibility !== undefined) {
      validateVisibility(body.visibility, body.shared_with_teams);
      if (body.visibility !== "team") {
        body.shared_with_teams = undefined;
      }
    }
    if (body.shared_with_teams?.length) {
      body.shared_with_teams = await normalizeSharedWithTeamSlugs(body.shared_with_teams);
    }

    const mergedVisibility = body.visibility ?? existing.visibility;
    let mergedSharedWithTeams =
      mergedVisibility === "team"
        ? body.shared_with_teams ?? existing.shared_with_teams
        : mergedVisibility !== undefined
          ? undefined
          : existing.shared_with_teams;

    if (mergedVisibility === "team" && mergedSharedWithTeams?.length) {
      mergedSharedWithTeams =
        (await normalizeSharedWithTeamSlugs(mergedSharedWithTeams)) ?? undefined;
    }

    const updateFields: Record<string, unknown> = {
      ...body,
      updated_at: new Date(),
    };
    if (mergedVisibility === "team") {
      updateFields.shared_with_teams = mergedSharedWithTeams;
    } else if (
      body.visibility !== undefined &&
      (mergedVisibility === "private" || mergedVisibility === "global")
    ) {
      updateFields.shared_with_teams = undefined;
    }

    await collection.updateOne({ _id: id }, { $set: updateFields });

    const merged = {
      ...existing,
      ...body,
      _id: id,
      visibility: mergedVisibility,
      shared_with_teams: mergedSharedWithTeams,
    };

    await assertWorkflowConfigRunnable(merged);

    await reconcileWorkflowConfigAccess(session, merged, existing);

    return successResponse({ id, message: "Workflow config updated successfully" });
  });
});

// ---------------------------------------------------------------------------
// DELETE — delete a workflow config (?id=)
// ---------------------------------------------------------------------------

export const DELETE = withErrorHandler(async (request: NextRequest) => {
  if (STORAGE_TYPE !== "mongodb") {
    throw new ApiError("Workflows require MongoDB to be configured", 503);
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    throw new ApiError("Workflow config ID is required", 400);
  }

  return await withAuth(request, async (_req, user, session) => {
    const collection = await getCollection<WorkflowConfig>("workflow_configs");
    const existing = await collection.findOne({ _id: id });

    if (!existing) {
      throw new ApiError("Workflow config not found", 404);
    }
    if (existing.config_driven) {
      throw new ApiError("Cannot delete a config-driven workflow. Remove it from app-config.yaml instead.", 403);
    }

    if (user.role !== "admin") {
      await requireWorkflowConfigWriteAccess(
        session,
        {
          _id: id,
          owner_id: existing.owner_id,
          visibility: existing.visibility,
          shared_with_teams: existing.shared_with_teams,
        },
        user.email,
      );
    }

    await collection.deleteOne({ _id: id });
    return successResponse({ id, message: "Workflow config deleted successfully" });
  });
});

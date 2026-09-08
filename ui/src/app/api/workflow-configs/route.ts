import {
  ApiError,
  successResponse,
  withAuth,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import {
  AuthzSyncSupersededError,
  authzRevisionFilter,
  hasActiveAuthzSync,
  nextAuthzRevision,
  runRevisionedAuthzSync,
} from "@/lib/authz/resource-sync";
import { deleteAllWorkflowRelationshipTuples } from "@/lib/rbac/openfga-owned-resources-reconcile";
import { validateWorkflowAgentDependencies } from "@/lib/rbac/workflow-agent-dependency-scope";
import {
  filterAccessibleWorkflowConfigs,
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
import type {
  CreateWorkflowConfigInput,
  StepEntry,
  UpdateWorkflowConfigInput,
  WorkflowConfig,
  WorkflowConfigVisibility,
} from "@/types/workflow-config";
import { NextRequest, NextResponse } from "next/server";

/**
 * Workflow Config API Routes
 *
 * CRUD operations for workflow configs stored in the workflow_configs MongoDB collection.
 * These configs define multi-step workflows executed by the Workflow Service
 * against dynamic agents via AG-UI.
 */

const STORAGE_TYPE = isMongoDBConfigured ? "mongodb" : "none";
const VALID_VISIBILITIES: WorkflowConfigVisibility[] = [
  "private",
  "team",
  "global",
];

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
        400,
      );
    }
    if (entry.type !== "step") {
      const unsupported = entry as { type?: unknown };
      throw new ApiError(`Unknown step type: ${String(unsupported.type)}`, 400);
    }
    if (!entry.display_text || !entry.agent_id || !entry.prompt) {
      throw new ApiError(
        "Each step must have display_text, agent_id, and prompt",
        400,
      );
    }
    if (
      entry.on_error === "retry" &&
      (!entry.retry || entry.retry.max_attempts < 1)
    ) {
      throw new ApiError(
        "Steps with on_error='retry' must have retry.max_attempts >= 1",
        400,
      );
    }
  }
}

function validateVisibility(
  visibility: WorkflowConfigVisibility | undefined,
  sharedWithTeams: string[] | undefined,
): void {
  if (visibility !== undefined) {
    if (!VALID_VISIBILITIES.includes(visibility)) {
      throw new ApiError(
        `Invalid visibility: ${visibility}. Must be one of: ${VALID_VISIBILITIES.join(", ")}`,
        400,
      );
    }
    if (
      visibility === "team" &&
      (!sharedWithTeams || sharedWithTeams.length === 0)
    ) {
      throw new ApiError(
        "At least one team must be selected when visibility is 'team'",
        400,
      );
    }
  }
}

function stableSessionSubject(session: { sub?: unknown }): string {
  const subject = typeof session.sub === "string" ? session.sub.trim() : "";
  if (!subject) {
    throw new ApiError(
      "A stable user subject is required to own a workflow",
      401,
    );
  }
  return subject;
}

function normalizeTeamSet(values: string[] | null | undefined): string[] {
  return [
    ...new Set(
      (values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean),
    ),
  ];
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function workflowAuthzSnapshot(
  config: WorkflowConfig,
): Record<string, unknown> {
  return {
    visibility: config.visibility,
    shared_with_teams: normalizeTeamSet(config.shared_with_teams),
    owner_subject: config.owner_subject,
  };
}

function previousWorkflowAuthzState(config: WorkflowConfig): WorkflowConfig {
  return config.authz_previous_state
    ? ({
        ...config,
        ...config.authz_previous_state,
        authz_previous_state: undefined,
      } as WorkflowConfig)
    : config;
}

function isPrivateWorkflowOwner(
  config: WorkflowConfig,
  userEmail: string,
  sessionSubject: string,
): boolean {
  if (config.visibility !== "private") return true;
  if (config.owner_subject) return config.owner_subject === sessionSubject;
  return (
    config.owner_id.trim().toLowerCase() === userEmail.trim().toLowerCase()
  );
}

async function getVisibleConfigs(): Promise<WorkflowConfig[]> {
  const collection = await getCollection<WorkflowConfig>("workflow_configs");

  return collection.find({}).sort({ name: 1 }).toArray();
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
    const sessionSubject = stableSessionSubject(session);
    const userTeamSlugs = await resolveUserTeamSlugsForWorkflow(
      user.email,
      session,
    );

    if (id) {
      const config = await getVisibleConfigById(id);
      if (!config) {
        throw new ApiError("Workflow config not found", 404);
      }
      if (!isPrivateWorkflowOwner(config, user.email, sessionSubject)) {
        throw new ApiError("Workflow config not found", 404);
      }
      await requireWorkflowConfigRunAccess(
        session,
        config,
        user.email,
        userTeamSlugs,
      );
      return NextResponse.json(config) as NextResponse;
    }

    const configs = (await getVisibleConfigs()).filter((config) =>
      isPrivateWorkflowOwner(config, user.email, sessionSubject),
    );
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
    const ownerSubject = stableSessionSubject(session);

    const config: WorkflowConfig = {
      _id: id,
      name: body.name,
      description: body.description,
      steps: body.steps,
      owner_id: user.email,
      owner_subject: ownerSubject,
      visibility,
      shared_with_teams: sharedWithTeams ?? [],
      authz_revision: 1,
      authz_sync_state: "ready",
      authz_last_synced_revision: 1,
      created_at: now,
      updated_at: now,
    };

    await validateWorkflowAgentDependencies({
      session,
      workflow: { visibility, ownerSubject, ownerEmail: user.email },
      steps: body.steps,
    });

    const collection = await getCollection<WorkflowConfig>("workflow_configs");
    await reconcileWorkflowConfigAccess(session, config, null, {
      ownerSubject,
      context: {
        caller: { type: "user", id: ownerSubject },
        source: "workflow_create",
        verifyHigherConsistency: true,
      },
    });
    try {
      await collection.insertOne(config);
    } catch (error) {
      await deleteAllWorkflowRelationshipTuples(id, {
        caller: { type: "user", id: ownerSubject },
        source: "workflow_create_rollback",
        verifyHigherConsistency: true,
      }).catch((cleanupError) => {
        console.warn(
          "[workflow-configs] Failed to clean up authorization after create failure",
          cleanupError,
        );
      });
      throw error;
    }

    return successResponse(
      { id, message: "Workflow config created successfully" },
      201,
    );
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
      throw new ApiError(
        "Cannot modify a config-driven workflow. Edit app-config.yaml instead.",
        403,
      );
    }
    const sessionSubject = stableSessionSubject(session);
    if (!isPrivateWorkflowOwner(existing, user.email, sessionSubject)) {
      throw new ApiError("Workflow config not found", 404);
    }
    if (hasActiveAuthzSync(existing)) {
      throw new ApiError(
        "This workflow's authorization is already being reconciled. Retry shortly.",
        409,
        "AUTHZ_SYNC_PENDING",
      );
    }
    const previousAuthzState = previousWorkflowAuthzState(existing);
    const ownerSubject =
      existing.owner_subject ??
      (existing.owner_id.trim().toLowerCase() ===
      user.email.trim().toLowerCase()
        ? sessionSubject
        : null);

    await requireWorkflowConfigWriteAccess(
      session,
      {
        _id: id,
        owner_id: existing.owner_id,
        owner_subject: existing.owner_subject,
        visibility: existing.visibility,
        shared_with_teams: existing.shared_with_teams,
      },
      user.email,
    );

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
      body.shared_with_teams = await normalizeSharedWithTeamSlugs(
        body.shared_with_teams,
      );
    }

    const mergedVisibility = body.visibility ?? existing.visibility;
    let mergedSharedWithTeams =
      mergedVisibility === "team"
        ? (body.shared_with_teams ?? existing.shared_with_teams)
        : mergedVisibility !== undefined
          ? undefined
          : existing.shared_with_teams;

    if (mergedVisibility === "team" && mergedSharedWithTeams?.length) {
      mergedSharedWithTeams =
        (await normalizeSharedWithTeamSlugs(mergedSharedWithTeams)) ??
        undefined;
    }

    const updateFields: Record<string, unknown> = {
      ...body,
      visibility: mergedVisibility,
      shared_with_teams: mergedSharedWithTeams ?? [],
      ...(ownerSubject ? { owner_subject: ownerSubject } : {}),
      updated_at: new Date(),
    };
    const merged = {
      ...existing,
      ...updateFields,
      _id: id,
      visibility: mergedVisibility,
      shared_with_teams: mergedSharedWithTeams ?? [],
    } as WorkflowConfig;
    await validateWorkflowAgentDependencies({
      session,
      workflow: {
        visibility: mergedVisibility,
        ownerSubject: ownerSubject ?? sessionSubject,
        ownerEmail: existing.owner_id,
      },
      steps: merged.steps,
    });
    const previousVisibility = previousAuthzState.visibility;
    const previousTeams = normalizeTeamSet(
      previousAuthzState.shared_with_teams,
    );
    const nextTeams = normalizeTeamSet(merged.shared_with_teams);
    const reconcile = (verifyHigherConsistency: boolean) =>
      reconcileWorkflowConfigAccess(session, merged, previousAuthzState, {
        ownerSubject,
        context: {
          caller: { type: "user", id: sessionSubject },
          source: "workflow_update",
          verifyHigherConsistency,
        },
      });
    const authzMutationRequired =
      existing.authz_sync_state !== "ready" ||
      existing.authz_revision !== existing.authz_last_synced_revision ||
      !existing.owner_subject ||
      mergedVisibility !== previousVisibility ||
      !sameStringSet(previousTeams, nextTeams);

    let updated: WorkflowConfig | null;
    if (!authzMutationRequired) {
      await reconcile(false);
      updated = await collection.findOneAndUpdate(
        { _id: id },
        { $set: updateFields },
        { returnDocument: "after" },
      );
    } else {
      const revision = nextAuthzRevision(existing);
      const pending = await collection.findOneAndUpdate(
        { _id: id, ...authzRevisionFilter(existing) },
        {
          $set: {
            ...updateFields,
            authz_revision: revision,
            authz_sync_state: "pending",
            authz_sync_started_at: new Date().toISOString(),
            authz_previous_state:
              existing.authz_previous_state ?? workflowAuthzSnapshot(existing),
          },
          $unset: { authz_last_error_code: "" },
        },
        { returnDocument: "after" },
      );
      if (!pending) {
        throw new ApiError(
          "This workflow changed while authorization was being prepared. Retry the save.",
          409,
          "AUTHZ_SYNC_SUPERSEDED",
        );
      }
      try {
        updated = await runRevisionedAuthzSync({
          reconcile: async () => {
            await reconcile(true);
          },
          markError: async (errorCode) => {
            await collection.findOneAndUpdate(
              {
                _id: id,
                authz_revision: revision,
                authz_sync_state: "pending",
              },
              {
                $set: {
                  authz_sync_state: "error",
                  authz_last_error_code: errorCode,
                },
                $unset: { authz_sync_started_at: "" },
              },
            );
          },
          markReady: () =>
            collection.findOneAndUpdate(
              {
                _id: id,
                authz_revision: revision,
                authz_sync_state: "pending",
              },
              {
                $set: {
                  authz_sync_state: "ready",
                  authz_last_synced_revision: revision,
                },
                $unset: {
                  authz_last_error_code: "",
                  authz_previous_state: "",
                  authz_sync_started_at: "",
                },
              },
              { returnDocument: "after" },
            ),
        });
      } catch (error) {
        if (error instanceof AuthzSyncSupersededError) {
          throw new ApiError(error.message, 409, "AUTHZ_SYNC_SUPERSEDED");
        }
        throw error;
      }
    }
    if (!updated) throw new ApiError("Failed to update workflow config", 500);

    return successResponse({
      id,
      message: "Workflow config updated successfully",
      authz_revision: updated.authz_revision,
      authz_sync_state: updated.authz_sync_state,
      authz_last_synced_revision: updated.authz_last_synced_revision,
    });
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
      throw new ApiError(
        "Cannot delete a config-driven workflow. Remove it from app-config.yaml instead.",
        403,
      );
    }
    const sessionSubject = stableSessionSubject(session);
    if (!isPrivateWorkflowOwner(existing, user.email, sessionSubject)) {
      throw new ApiError("Workflow config not found", 404);
    }
    await requireWorkflowConfigWriteAccess(
      session,
      {
        _id: id,
        owner_id: existing.owner_id,
        owner_subject: existing.owner_subject,
        visibility: existing.visibility,
        shared_with_teams: existing.shared_with_teams,
      },
      user.email,
    );

    await deleteAllWorkflowRelationshipTuples(id, {
      caller: { type: "user", id: sessionSubject },
      source: "workflow_delete",
      verifyHigherConsistency: true,
    });
    await collection.deleteOne({ _id: id });
    return successResponse({
      id,
      message: "Workflow config deleted successfully",
    });
  });
});

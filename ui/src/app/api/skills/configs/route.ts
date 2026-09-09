import {
  getAgentSkillVisibleToUser,
  hydrateAgentSkillTeamShares,
  hydrateAgentSkillTeamSharesList,
} from "@/lib/agent-skill-visibility";
import {
  ApiError,
  successResponse,
  withAuth,
  withErrorHandler,
} from "@/lib/api-middleware";
import {
  BUILTIN_LOCKED_MESSAGE,
  canMutateBuiltinSkill,
} from "@/lib/builtin-skill-policy";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import {
  AuthzSyncSupersededError,
  authzRevisionFilter,
  hasActiveAuthzSync,
  nextAuthzRevision,
  runRevisionedAuthzSync,
} from "@/lib/authz/resource-sync";
import { syncSkillResource } from "@/lib/rbac/keycloak-resource-sync";
import { deleteAllSkillRelationshipTuples } from "@/lib/rbac/openfga-owned-resources-reconcile";
import {
  filterResourcesByPermission,
  requireSkillPermission,
} from "@/lib/rbac/resource-authz";
import {
  readSkillSharedTeamSlugsFromOpenFga,
  reconcileSkillTeamShares,
} from "@/lib/rbac/skill-team-grants";
import {
  deleteRevisionsForSkill,
  recordRevision,
  snapshotsDiffer,
  type SkillSnapshotInput,
} from "@/lib/skill-revisions";
import { scanSkillContent as runSkillScan } from "@/lib/skill-scan";
import { recordScanEvent } from "@/lib/skill-scan-history";
import type {
  AgentSkill,
  CreateAgentSkillInput,
  ScanStatus,
  SkillVisibility,
  UpdateAgentSkillInput,
} from "@/types/agent-skill";
import { NextRequest, NextResponse } from "next/server";

/**
 * Persisted agent skill configs (CRUD)
 *
 * Storage: MongoDB collection `agent_skills`
 *
 * - User ownership (`owner_id`); built-in rows (`is_system`) editable/deletable by any authenticated user (restore via import/seed)
 * - Catalog browse remains GET `/api/skills` (merged view), not this route
 *
 * HTTP: GET/POST/PUT/DELETE `/api/skills/configs`
 */

const STORAGE_TYPE = isMongoDBConfigured ? "mongodb" : "none";

const ANCILLARY_SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB soft limit (FR-028)

function validateAncillaryFiles(files: Record<string, string> | undefined): {
  valid: boolean;
  totalBytes: number;
  warning?: string;
} {
  if (!files || Object.keys(files).length === 0) {
    return { valid: true, totalBytes: 0 };
  }
  const totalBytes = Object.values(files).reduce(
    (sum, v) => sum + new Blob([v]).size,
    0,
  );
  if (totalBytes > ANCILLARY_SIZE_LIMIT) {
    return {
      valid: true,
      totalBytes,
      warning: `Ancillary files total ${(totalBytes / 1024 / 1024).toFixed(1)} MB, exceeding the recommended 5 MB limit. Consider using a skill hub for larger skills.`,
    };
  }
  return { valid: true, totalBytes };
}

function isUserAdmin(user: { email: string; role?: string }): boolean {
  return user.role === "admin";
}

/**
 * Extract the content-bearing fields of an `AgentSkill` for the
 * revision history.
 *
 * The revision schema deliberately excludes administrative fields
 * (`owner_id`, `is_system`, `visibility`) — those
 * are authorization state, not content, and a "restore" should never
 * change who owns the skill or who can see it. See lib/skill-revisions
 * for the rationale.
 */
function extractSnapshot(skill: AgentSkill): SkillSnapshotInput {
  return {
    name: skill.name,
    description: skill.description,
    category: skill.category,
    tasks: skill.tasks ?? [],
    metadata: skill.metadata,
    is_quick_start: skill.is_quick_start,
    difficulty: skill.difficulty,
    thumbnail: skill.thumbnail,
    input_form: skill.input_form,
    skill_content: skill.skill_content,
    ancillary_files: skill.ancillary_files,
    scan_status: skill.scan_status,
    scan_summary: skill.scan_summary,
  };
}

const VALID_VISIBILITIES: SkillVisibility[] = ["private", "team", "global"];

function normalizeTeamRefList(values: string[] | undefined | null): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function skillAuthzSnapshot(skill: AgentSkill): Record<string, unknown> {
  return {
    visibility: skill.visibility ?? "private",
    shared_with_teams: normalizeTeamRefList(skill.shared_with_teams),
    owner_subject: skill.owner_subject,
  };
}

function previousSkillAuthzState(skill: AgentSkill): AgentSkill {
  const previous = skill.authz_previous_state;
  return previous
    ? ({ ...skill, ...previous, authz_previous_state: undefined } as AgentSkill)
    : skill;
}

function stableSessionSubject(session: { sub?: unknown }): string {
  const subject = typeof session.sub === "string" ? session.sub.trim() : "";
  if (!subject) {
    throw new ApiError("A stable user subject is required to own a skill", 401);
  }
  return subject;
}

function isPrivateSkillOwner(
  skill: AgentSkill,
  userEmail: string,
  sessionSubject: string,
): boolean {
  if ((skill.visibility ?? "private") !== "private") return true;
  if (skill.owner_subject) return skill.owner_subject === sessionSubject;
  return skill.owner_id.trim().toLowerCase() === userEmail.trim().toLowerCase();
}

async function saveAgentSkillToMongoDB(config: AgentSkill): Promise<void> {
  const collection = await getCollection<AgentSkill>("agent_skills");
  await collection.insertOne(config);
}

async function updateAgentSkillInMongoDB(
  id: string,
  updates: Partial<AgentSkill>,
  user: { email: string; role?: string },
  expectedAuthz?: AgentSkill,
): Promise<{ before: AgentSkill; after: AgentSkill }> {
  console.log(
    `[MongoDB] ========== updateAgentSkillInMongoDB START ==========`,
  );
  console.log(`[MongoDB] Config ID: ${id}`);
  console.log(`[MongoDB] User: ${user.email}, IsAdmin: ${isUserAdmin(user)}`);

  const collection = await getCollection<AgentSkill>("agent_skills");
  console.log(`[MongoDB] Got collection`);

  const existing = await collection.findOne({ id });
  console.log(`[MongoDB] Found existing config:`, {
    id: existing?.id,
    name: existing?.name,
    is_system: existing?.is_system,
    owner_id: existing?.owner_id,
    tasks_count: existing?.tasks?.length,
  });

  if (!existing) {
    console.log(`[MongoDB] ERROR: Config not found`);
    throw new ApiError("Agent config not found", 404);
  }

  // Layered authorisation. Built-in lock first so a misconfigured
  // ownership check can't accidentally let a built-in through.
  if (existing.is_system && !canMutateBuiltinSkill(existing)) {
    console.log(`[MongoDB] ERROR: Built-in skill mutation locked by policy`);
    throw new ApiError(BUILTIN_LOCKED_MESSAGE, 403);
  }
  console.log(`[MongoDB] Permission checks passed`);

  const updatePayload = {
    ...updates,
    updated_at: new Date(),
  };
  console.log(
    `[MongoDB] Update payload:`,
    JSON.stringify(updatePayload, null, 2),
  );
  console.log(
    `[MongoDB] Update payload tasks count:`,
    updatePayload.tasks?.length,
  );
  if (updatePayload.tasks && updatePayload.tasks.length > 0) {
    console.log(
      `[MongoDB] First task llm_prompt:`,
      updatePayload.tasks[0].llm_prompt,
    );
  }

  console.log(`[MongoDB] Executing updateOne...`);
  const updated = await collection.findOneAndUpdate(
    { id, ...(expectedAuthz ? authzRevisionFilter(expectedAuthz) : {}) },
    { $set: updatePayload },
    { returnDocument: "after" },
  );
  if (!updated) {
    throw new ApiError(
      "This skill changed while authorization was being prepared. Retry the save.",
      409,
      "AUTHZ_SYNC_SUPERSEDED",
    );
  }
  console.log(`[MongoDB] Verified updated config:`, {
    id: updated?.id,
    name: updated?.name,
    tasks_count: updated?.tasks?.length,
    updated_at: updated?.updated_at,
  });
  if (updated?.tasks && updated.tasks.length > 0) {
    console.log(`[MongoDB] First task after update:`, {
      display_text: updated.tasks[0].display_text,
      llm_prompt: updated.tasks[0].llm_prompt,
      subagent: updated.tasks[0].subagent,
    });
  }
  console.log(`[MongoDB] ========== updateAgentSkillInMongoDB END ==========`);
  // Return the pre-update row so the route handler can capture a
  // revision without doing a duplicate read. We can't return the
  // post-update doc here because the verification read (`updated`)
  // is gated behind the same logging-only path; the route layer
  // overlays the body onto `existing` to derive the post-update
  // snapshot. Keeping the read here means existing tests that mock
  // exactly two `findOne` calls keep working.
  return { before: existing, after: updated };
}

async function deleteAgentSkillFromMongoDB(id: string): Promise<void> {
  const collection = await getCollection<AgentSkill>("agent_skills");

  const existing = await collection.findOne({ id });
  if (!existing) {
    throw new ApiError("Agent config not found", 404);
  }

  if (existing.is_system && !canMutateBuiltinSkill(existing)) {
    throw new ApiError(BUILTIN_LOCKED_MESSAGE, 403);
  }
  await collection.deleteOne({ id });

  await syncSkillResource("delete", id, existing.name);
}

async function getAgentSkillsFromMongoDB(): Promise<AgentSkill[]> {
  const collection = await getCollection<AgentSkill>("agent_skills");

  const configs = await collection
    .find({})
    .sort({ is_system: -1, created_at: -1 })
    .toArray();

  return configs;
}

async function getAgentSkillByIdFromMongoDB(
  id: string,
): Promise<AgentSkill | null> {
  const collection = await getCollection<AgentSkill>("agent_skills");

  const config = await collection.findOne({ id });

  return config;
}

// POST /api/skills/configs
export const POST = withErrorHandler(async (request: NextRequest) => {
  if (STORAGE_TYPE !== "mongodb") {
    throw new ApiError("Skills requires MongoDB to be configured", 503);
  }

  return await withAuth(request, async (req, user, session) => {
    const body: CreateAgentSkillInput = await request.json();

    if (
      !body.name ||
      !body.category ||
      !body.tasks ||
      body.tasks.length === 0
    ) {
      throw new ApiError(
        "Missing required fields: name, category, and at least one task are required",
        400,
      );
    }

    for (const task of body.tasks) {
      if (!task.display_text || !task.llm_prompt || !task.subagent) {
        throw new ApiError(
          "Each task must have display_text, llm_prompt, and subagent",
          400,
        );
      }
    }

    const visibility: SkillVisibility = body.visibility || "private";
    if (!VALID_VISIBILITIES.includes(visibility)) {
      throw new ApiError(
        `Invalid visibility: ${visibility}. Must be one of: ${VALID_VISIBILITIES.join(", ")}`,
        400,
      );
    }
    if (
      visibility === "team" &&
      (!body.shared_with_teams || body.shared_with_teams.length === 0)
    ) {
      throw new ApiError(
        "At least one team must be selected when visibility is 'team'",
        400,
      );
    }

    const nameSlug = (body.name as string)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const id = `skill-${nameSlug}-${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date();
    const ownerSubject = stableSessionSubject(session);
    const sharedWithTeams =
      visibility === "team" ? normalizeTeamRefList(body.shared_with_teams) : [];

    const ancillaryCheck = validateAncillaryFiles(body.ancillary_files);

    const config: AgentSkill = {
      id,
      name: body.name,
      description: body.description,
      category: body.category,
      tasks: body.tasks,
      owner_id: user.email,
      owner_subject: ownerSubject,
      is_system: false,
      created_at: now,
      updated_at: now,
      metadata: body.metadata,
      visibility,
      shared_with_teams: sharedWithTeams,
      authz_revision: 1,
      authz_sync_state: "ready",
      authz_last_synced_revision: 1,
      skill_content: body.skill_content,
      is_quick_start: body.is_quick_start,
      difficulty: body.difficulty,
      thumbnail: body.thumbnail,
      input_form: body.input_form,
      ancillary_files: body.ancillary_files,
      last_review: body.last_review,
    };

    const tCreate = Date.now();
    const scanResult = await runSkillScan(
      body.name,
      body.skill_content || "",
      id,
    );
    config.scan_status = scanResult.scan_status;
    if (scanResult.scan_summary !== undefined) {
      config.scan_summary = scanResult.scan_summary;
    }
    if (body.skill_content?.trim()) {
      config.scan_updated_at = new Date();
    }
    await recordScanEvent({
      trigger: "auto_save",
      skill_id: id,
      skill_name: body.name,
      source: "agent_skills",
      actor: user.email,
      scan_status: scanResult.scan_status,
      scan_summary: scanResult.scan_summary,
      scanner_unavailable:
        !body.skill_content?.trim() || scanResult.scan_status === "unscanned",
      duration_ms: Date.now() - tCreate,
    });

    await reconcileSkillTeamShares(
      {
        skillId: id,
        ownerSubject,
        previousTeamRefs: [],
        nextTeamRefs: sharedWithTeams,
        nextVisibility: visibility,
      },
      {
        caller: { type: "user", id: ownerSubject },
        source: "skill_create",
        verifyHigherConsistency: true,
      },
    );

    try {
      await saveAgentSkillToMongoDB(config);
    } catch (error) {
      await deleteAllSkillRelationshipTuples(id, {
        caller: { type: "user", id: ownerSubject },
        source: "skill_create_rollback",
        verifyHigherConsistency: true,
      }).catch((cleanupError) => {
        console.warn(
          "[AgentSkill] Failed to clean up authorization after create failure",
          cleanupError,
        );
      });
      throw error;
    }
    // Capture revision #1 right after the row is persisted so the
    // restore path always has a baseline to fall back to. We pass
    // through the same content fields the caller saved, plus the
    // freshly computed scan verdict — the workspace timeline shows
    // both the snapshot and which scanner state it was created at.
    await recordRevision({
      skillId: id,
      snapshot: extractSnapshot(config),
      trigger: "create",
      actor: user.email,
    });
    console.log(
      `[AgentSkill] Created agent config "${body.name}" by ${user.email} (visibility: ${visibility}, scan_status: ${scanResult.scan_status})`,
    );

    await syncSkillResource("create", id, body.name, visibility);
    return successResponse(
      {
        id,
        message: "Agent config created successfully",
        scan_status: scanResult.scan_status,
        scan_summary: scanResult.scan_summary,
        ...(ancillaryCheck.warning
          ? { ancillary_warning: ancillaryCheck.warning }
          : {}),
      },
      201,
    );
  });
});

// GET /api/skills/configs
export const GET = withErrorHandler(async (request: NextRequest) => {
  if (STORAGE_TYPE !== "mongodb") {
    throw new ApiError("Skills requires MongoDB to be configured", 503);
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  return await withAuth(request, async (req, user, session) => {
    const sessionSubject = stableSessionSubject(session);
    if (id) {
      console.log(
        `[API GET] Fetching single config: ${id} for user: ${user.email}`,
      );
      const config = await getAgentSkillByIdFromMongoDB(id);
      if (!config) {
        console.log(`[API GET] Config not found: ${id}`);
        throw new ApiError("Agent config not found", 404);
      }
      if (!isPrivateSkillOwner(config, user.email, sessionSubject)) {
        throw new ApiError("Agent config not found", 404);
      }
      await requireSkillPermission(session, id, "read");
      console.log(`[API GET] Returning config:`, {
        id: config.id,
        name: config.name,
        tasks_count: config.tasks?.length,
        updated_at: config.updated_at,
      });
      if (config.tasks && config.tasks.length > 0) {
        console.log(
          `[API GET] First task llm_prompt:`,
          config.tasks[0].llm_prompt,
        );
      }
      const hydrated = await hydrateAgentSkillTeamShares(config);
      return NextResponse.json(hydrated) as NextResponse;
    } else {
      console.log(`[API GET] Fetching all configs for user: ${user.email}`);
      const configs = await getAgentSkillsFromMongoDB();
      const scopedConfigs = configs.filter((config) =>
        isPrivateSkillOwner(config, user.email, sessionSubject),
      );
      const visibleConfigs = await filterResourcesByPermission(
        session,
        scopedConfigs,
        {
          type: "skill",
          action: "discover",
          id: (config) => config.id,
        },
      );
      const hydrated = await hydrateAgentSkillTeamSharesList(visibleConfigs);
      console.log(`[API GET] Returning ${hydrated.length} configs`);
      return NextResponse.json(hydrated) as NextResponse;
    }
  });
});

// PUT /api/skills/configs?id=<configId>
export const PUT = withErrorHandler(async (request: NextRequest) => {
  if (STORAGE_TYPE !== "mongodb") {
    throw new ApiError("Skills requires MongoDB to be configured", 503);
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  console.log(`[API PUT] ============ UPDATE REQUEST START ============`);
  console.log(`[API PUT] Config ID: ${id}`);

  if (!id) {
    throw new ApiError("Agent config ID is required", 400);
  }

  return await withAuth(request, async (req, user, session) => {
    console.log(
      `[API PUT] User: ${user.email}, Role: ${user.role}, IsAdmin: ${isUserAdmin(user)}`,
    );

    const body: UpdateAgentSkillInput = await request.json();
    console.log(`[API PUT] Request body:`, JSON.stringify(body, null, 2));

    if (Object.keys(body).length === 0) {
      throw new ApiError("At least one field must be provided for update", 400);
    }

    const sessionSubject = stableSessionSubject(session);
    const preUpdate = await getAgentSkillVisibleToUser(id);
    if (!preUpdate) {
      throw new ApiError("Agent config not found", 404);
    }
    if (!isPrivateSkillOwner(preUpdate, user.email, sessionSubject)) {
      throw new ApiError("Agent config not found", 404);
    }
    if (hasActiveAuthzSync(preUpdate)) {
      throw new ApiError(
        "This skill's authorization is already being reconciled. Retry shortly.",
        409,
        "AUTHZ_SYNC_PENDING",
      );
    }
    const previousAuthzState = previousSkillAuthzState(preUpdate);
    const ownerSubject =
      preUpdate.owner_subject ??
      (preUpdate.owner_id.trim().toLowerCase() ===
      user.email.trim().toLowerCase()
        ? sessionSubject
        : null);

    // Legacy rows may predate owner_subject. Repair the owner tuple before the
    // write check, then persist the stable subject as part of this save.
    if (!preUpdate.owner_subject && ownerSubject) {
      const healTeamRefs = preUpdate.shared_with_teams?.length
        ? normalizeTeamRefList(preUpdate.shared_with_teams)
        : await readSkillSharedTeamSlugsFromOpenFga(id);
      await reconcileSkillTeamShares(
        {
          skillId: id,
          ownerSubject,
          previousTeamRefs: healTeamRefs,
          nextTeamRefs: healTeamRefs,
          nextVisibility: preUpdate.visibility ?? "private",
          previousVisibility: preUpdate.visibility ?? "private",
        },
        {
          caller: { type: "user", id: sessionSubject },
          source: "skill_owner_backfill",
        },
      );
    }
    await requireSkillPermission(session, id, "write");

    if (body.visibility !== undefined) {
      if (!VALID_VISIBILITIES.includes(body.visibility)) {
        throw new ApiError(
          `Invalid visibility: ${body.visibility}. Must be one of: ${VALID_VISIBILITIES.join(", ")}`,
          400,
        );
      }
      if (
        body.visibility === "team" &&
        (!body.shared_with_teams || body.shared_with_teams.length === 0)
      ) {
        throw new ApiError(
          "At least one team must be selected when visibility is 'team'",
          400,
        );
      }
    }

    if (body.tasks) {
      console.log(`[API PUT] Validating ${body.tasks.length} tasks...`);
      if (body.tasks.length === 0) {
        throw new ApiError("At least one task is required", 400);
      }
      for (const task of body.tasks) {
        if (!task.display_text || !task.llm_prompt || !task.subagent) {
          throw new ApiError(
            "Each task must have display_text, llm_prompt, and subagent",
            400,
          );
        }
      }
      console.log(`[API PUT] Tasks validation passed`);
      console.log(`[API PUT] First task llm_prompt:`, body.tasks[0].llm_prompt);
    }

    let ancillaryWarning: string | undefined;
    if (body.ancillary_files !== undefined) {
      const ancillaryCheck = validateAncillaryFiles(body.ancillary_files);
      ancillaryWarning = ancillaryCheck.warning;
    }

    let scanSummaryFromSave: string | undefined;
    if (body.skill_content !== undefined) {
      const tPut = Date.now();
      const scanResult = await runSkillScan(
        body.name || id,
        body.skill_content || "",
        id,
      );
      (body as Record<string, unknown>).scan_status = scanResult.scan_status;
      if (scanResult.scan_summary !== undefined) {
        (body as Record<string, unknown>).scan_summary =
          scanResult.scan_summary;
        scanSummaryFromSave = scanResult.scan_summary;
      }
      if (body.skill_content?.trim()) {
        (body as Record<string, unknown>).scan_updated_at = new Date();
      }
      console.log(`[API PUT] Scan result: ${scanResult.scan_status}`);
      await recordScanEvent({
        trigger: "auto_save",
        skill_id: id,
        skill_name: body.name || id,
        source: "agent_skills",
        actor: user.email,
        scan_status: scanResult.scan_status,
        scan_summary: scanResult.scan_summary,
        scanner_unavailable:
          !body.skill_content?.trim() || scanResult.scan_status === "unscanned",
        duration_ms: Date.now() - tPut,
      });
    }

    const previousVisibility = previousAuthzState.visibility ?? "private";
    const nextVisibility = body.visibility ?? preUpdate.visibility ?? "private";
    const previousTeamRefs = Array.isArray(previousAuthzState.shared_with_teams)
      ? normalizeTeamRefList(previousAuthzState.shared_with_teams)
      : await readSkillSharedTeamSlugsFromOpenFga(id);
    const nextTeamRefs =
      nextVisibility === "team"
        ? Object.prototype.hasOwnProperty.call(body, "shared_with_teams")
          ? normalizeTeamRefList(body.shared_with_teams)
          : Array.isArray(preUpdate.shared_with_teams)
            ? normalizeTeamRefList(preUpdate.shared_with_teams)
            : previousTeamRefs
        : [];
    const reconcile = (verifyHigherConsistency: boolean) =>
      reconcileSkillTeamShares(
        {
          skillId: id,
          ownerSubject,
          previousTeamRefs,
          nextTeamRefs,
          nextVisibility,
          previousVisibility,
        },
        {
          caller: { type: "user", id: sessionSubject },
          source: "skill_update",
          verifyHigherConsistency,
        },
      );
    const authzMutationRequired =
      preUpdate.authz_sync_state !== "ready" ||
      preUpdate.authz_revision !== preUpdate.authz_last_synced_revision ||
      !preUpdate.owner_subject ||
      nextVisibility !== previousVisibility ||
      !sameStringSet(previousTeamRefs, nextTeamRefs);
    const baseUpdates: Partial<AgentSkill> = {
      ...(body as Partial<AgentSkill>),
      visibility: nextVisibility,
      shared_with_teams: nextTeamRefs,
      ...(ownerSubject ? { owner_subject: ownerSubject } : {}),
    };

    console.log(`[API PUT] Calling updateAgentSkillInMongoDB...`);
    let beforeUpdate: AgentSkill;
    let updated: AgentSkill;
    if (!authzMutationRequired) {
      await reconcile(false);
      ({ before: beforeUpdate, after: updated } =
        await updateAgentSkillInMongoDB(id, baseUpdates, user));
    } else {
      const revision = nextAuthzRevision(preUpdate);
      const pendingUpdates: Partial<AgentSkill> = {
        ...baseUpdates,
        authz_revision: revision,
        authz_sync_state: "pending",
        authz_sync_started_at: new Date().toISOString(),
        authz_previous_state:
          preUpdate.authz_previous_state ?? skillAuthzSnapshot(preUpdate),
      };
      ({ before: beforeUpdate } = await updateAgentSkillInMongoDB(
        id,
        pendingUpdates,
        user,
        preUpdate,
      ));
      try {
        updated = await runRevisionedAuthzSync({
          reconcile: async () => {
            await reconcile(true);
          },
          markError: async (errorCode) => {
            await (
              await getCollection<AgentSkill>("agent_skills")
            ).findOneAndUpdate(
              { id, authz_revision: revision, authz_sync_state: "pending" },
              {
                $set: {
                  authz_sync_state: "error",
                  authz_last_error_code: errorCode,
                },
                $unset: { authz_sync_started_at: "" },
              },
            );
          },
          markReady: async () =>
            (await getCollection<AgentSkill>("agent_skills")).findOneAndUpdate(
              { id, authz_revision: revision, authz_sync_state: "pending" },
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

    const prev = extractSnapshot(beforeUpdate);
    const next = extractSnapshot(updated);
    if (snapshotsDiffer(prev, next)) {
      await recordRevision({
        skillId: id,
        snapshot: next,
        trigger: "update",
        actor: user.email,
      });
    }
    console.log(`[AgentSkill] Updated agent config "${id}" by ${user.email}`);
    console.log(`[API PUT] ============ UPDATE REQUEST END ============`);

    const scanStatus = (body as Record<string, unknown>).scan_status as
      ScanStatus | undefined;
    return successResponse({
      id,
      message: "Agent config updated successfully",
      ...(scanStatus ? { scan_status: scanStatus } : {}),
      ...(scanSummaryFromSave !== undefined
        ? { scan_summary: scanSummaryFromSave }
        : {}),
      ...(ancillaryWarning ? { ancillary_warning: ancillaryWarning } : {}),
    });
  });
});

// DELETE /api/skills/configs?id=<configId>
export const DELETE = withErrorHandler(async (request: NextRequest) => {
  if (STORAGE_TYPE !== "mongodb") {
    throw new ApiError("Skills requires MongoDB to be configured", 503);
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    throw new ApiError("Agent config ID is required", 400);
  }

  return await withAuth(request, async (req, user, session) => {
    const sessionSubject = stableSessionSubject(session);
    const existing = await getAgentSkillByIdFromMongoDB(id);
    if (
      !existing ||
      !isPrivateSkillOwner(existing, user.email, sessionSubject)
    ) {
      throw new ApiError("Agent config not found", 404);
    }
    await requireSkillPermission(session, id, "delete");
    await deleteAllSkillRelationshipTuples(id, {
      caller: { type: "user", id: sessionSubject },
      source: "skill_delete",
      verifyHigherConsistency: true,
    });
    await deleteAgentSkillFromMongoDB(id);
    // Drop history rows for this skill so we don't leak orphaned
    // revision documents that nobody can render. Best-effort: a
    // failure here doesn't undo the delete (the skill is already
    // gone from the user's perspective).
    await deleteRevisionsForSkill(id);
    console.log(`[AgentSkill] Deleted agent config "${id}" by ${user.email}`);

    return successResponse({
      id,
      message: "Agent config deleted successfully",
    });
  });
});

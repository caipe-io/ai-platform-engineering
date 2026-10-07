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
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import { syncSkillResource } from "@/lib/rbac/keycloak-resource-sync";
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
import { withSkillConfigLease } from "@/lib/seed-skills";
import { scanSkillContent as runSkillScan } from "@/lib/skill-scan";
import { recordScanEvent } from "@/lib/skill-scan-history";
import type {
AgentSkill,
CreateAgentSkillInput,
ScanStatus,
SkillVisibility,
UpdateAgentSkillInput,
} from "@/types/agent-skill";
import { NextRequest,NextResponse } from "next/server";

/**
 * Persisted agent skill configs (CRUD)
 *
 * Storage: MongoDB collection `agent_skills`
 *
 * - Resource permissions govern database skills; config_driven rows are managed through app-config.yaml.
 * - Catalog browse remains GET `/api/skills` (merged view), not this route
 *
 * HTTP: GET/POST/PUT/DELETE `/api/skills/configs`
 */

const STORAGE_TYPE = isMongoDBConfigured ? "mongodb" : "none";

const ANCILLARY_SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB soft limit (FR-028)

function validateAncillaryFiles(
  files: Record<string, string> | undefined,
): { valid: boolean; totalBytes: number; warning?: string } {
  if (!files || Object.keys(files).length === 0) {
    return { valid: true, totalBytes: 0 };
  }
  const totalBytes = Object.values(files).reduce((sum, v) => sum + new Blob([v]).size, 0);
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

/** Team shares are OpenFGA-only; never persist legacy `shared_with_teams` on Mongo rows. */
function stripSharedWithTeamsFromMongoFields<T extends { shared_with_teams?: unknown }>(
  value: T,
): Omit<T, "shared_with_teams"> {
  const result = { ...value };
  delete result.shared_with_teams;
  return result;
}

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

async function saveAgentSkillToMongoDB(config: AgentSkill): Promise<void> {
  const collection = await getCollection<AgentSkill>("agent_skills");
  await collection.insertOne(config);
}

async function updateAgentSkillInMongoDB(
  id: string,
  updates: Partial<AgentSkill>,
  user: { email: string; role?: string },
  renew: () => Promise<void>,
): Promise<{ before: AgentSkill | null }> {
  console.log(`[MongoDB] ========== updateAgentSkillInMongoDB START ==========`);
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
  if (existing.config_driven) {
    throw new ApiError("Config-driven skills are read-only. Update app-config.yaml.", 403);
  }

  console.log(`[MongoDB] Permission checks passed`);

  const updatePayload = {
    ...stripSharedWithTeamsFromMongoFields(updates),
    updated_at: new Date(),
  };
  console.log(`[MongoDB] Update payload:`, JSON.stringify(updatePayload, null, 2));
  console.log(`[MongoDB] Update payload tasks count:`, updatePayload.tasks?.length);
  if (updatePayload.tasks && updatePayload.tasks.length > 0) {
    console.log(`[MongoDB] First task llm_prompt:`, updatePayload.tasks[0].llm_prompt);
  }

  console.log(`[MongoDB] Executing updateOne...`);
  await renew();
  const updateResult = await collection.updateOne(
    { id, config_driven: { $ne: true } },
    { $set: updatePayload, $unset: { shared_with_teams: "" } },
  );
  if (!updateResult.matchedCount) {
    throw new ApiError("Skill changed during the request. Reload; configured skills are managed in app-config.yaml.", 409);
  }
  console.log(`[MongoDB] UpdateOne result:`, {
    matchedCount: updateResult.matchedCount,
    modifiedCount: updateResult.modifiedCount,
    acknowledged: updateResult.acknowledged,
  });

  console.log(`[MongoDB] Fetching updated config for verification...`);
  const updated = await collection.findOne({ id });
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
  return { before: existing };
}

async function deleteAgentSkillFromMongoDB(
  id: string,
  renew: () => Promise<void>,
): Promise<void> {
  const collection = await getCollection<AgentSkill>("agent_skills");

  const existing = await collection.findOne({ id });
  if (!existing) {
    throw new ApiError("Agent config not found", 404);
  }
  if (existing.config_driven) {
    throw new ApiError("Config-driven skills cannot be deleted through the UI. Remove them from app-config.yaml.", 403);
  }

  await renew();
  const result = await collection.deleteOne({ id, config_driven: { $ne: true } });
  if (!result.deletedCount) {
    throw new ApiError("Skill changed during the request. Reload; configured skills are managed in app-config.yaml.", 409);
  }

  await renew();
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

    if (!body.name || !body.category || !body.tasks || body.tasks.length === 0) {
      throw new ApiError("Missing required fields: name, category, and at least one task are required", 400);
    }

    for (const task of body.tasks) {
      if (!task.display_text || !task.llm_prompt || !task.subagent) {
        throw new ApiError("Each task must have display_text, llm_prompt, and subagent", 400);
      }
    }

    const visibility: SkillVisibility = body.visibility || "private";
    if (!VALID_VISIBILITIES.includes(visibility)) {
      throw new ApiError(`Invalid visibility: ${visibility}. Must be one of: ${VALID_VISIBILITIES.join(", ")}`, 400);
    }
    if (visibility === "team" && (!body.shared_with_teams || body.shared_with_teams.length === 0)) {
      throw new ApiError("At least one team must be selected when visibility is 'team'", 400);
    }

    const nameSlug = (body.name as string)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const id = `skill-${nameSlug}-${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date();

    const ancillaryCheck = validateAncillaryFiles(body.ancillary_files);

    const config: AgentSkill = {
      id,
      name: body.name,
      description: body.description,
      category: body.category,
      tasks: body.tasks,
      owner_id: user.email,
      is_system: false,
      config_driven: false,
      created_at: now,
      updated_at: now,
      metadata: body.metadata,
      visibility,
      skill_content: body.skill_content,
      is_quick_start: body.is_quick_start,
      difficulty: body.difficulty,
      thumbnail: body.thumbnail,
      input_form: body.input_form,
      ancillary_files: body.ancillary_files,
      last_review: body.last_review,
    };

    const tCreate = Date.now();
    const scanResult = await runSkillScan(body.name, body.skill_content || "", id);
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
      scanner_unavailable: !body.skill_content?.trim() || scanResult.scan_status === "unscanned",
      duration_ms: Date.now() - tCreate,
    });

    return await withSkillConfigLease(async (renew) => {
      await renew();
      await saveAgentSkillToMongoDB(stripSharedWithTeamsFromMongoFields(config) as AgentSkill);
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

      await renew();
      await syncSkillResource("create", id, body.name, visibility);
      // Reconcile owner + optional team-share grants. Without the owner tuple,
      // the author can create/save via routes that skip per-skill FGA (POST) but
      // later PUT/scan checks (`can_write`) fail with "You do not have permission
      // to access this resource." Config (Mongo) is the source of truth, so an
      // OpenFGA hiccup must not fail the create.
      const ownerSubject =
        typeof session?.sub === "string" && session.sub.trim() ? session.sub.trim() : null;
      await renew();
      try {
        await reconcileSkillTeamShares({
          skillId: id,
          ownerSubject,
          previousTeamRefs: [],
          nextTeamRefs: visibility === "team" ? body.shared_with_teams : [],
          nextVisibility: visibility,
        });
      } catch (error) {
        console.warn(
          "[AgentSkill] Failed to reconcile skill FGA grants on create:",
          error instanceof Error ? error.message : String(error),
        );
      }

      return successResponse(
        {
          id,
          message: "Agent config created successfully",
          scan_status: scanResult.scan_status,
          scan_summary: scanResult.scan_summary,
          ...(ancillaryCheck.warning ? { ancillary_warning: ancillaryCheck.warning } : {}),
        },
        201,
      );
    });
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
    if (id) {
      console.log(`[API GET] Fetching single config: ${id} for user: ${user.email}`);
      const config = await getAgentSkillByIdFromMongoDB(id);
      if (!config) {
        console.log(`[API GET] Config not found: ${id}`);
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
        console.log(`[API GET] First task llm_prompt:`, config.tasks[0].llm_prompt);
      }
      const hydrated = await hydrateAgentSkillTeamShares(config);
      return NextResponse.json(hydrated) as NextResponse;
    } else {
      console.log(`[API GET] Fetching all configs for user: ${user.email}`);
      const configs = await getAgentSkillsFromMongoDB();
      const visibleConfigs = await filterResourcesByPermission(session, configs, {
        type: "skill",
        action: "discover",
        id: (config) => config.id,
      });
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
    console.log(`[API PUT] User: ${user.email}, Role: ${user.role}, IsAdmin: ${isUserAdmin(user)}`);

    const body: UpdateAgentSkillInput = await request.json();
    delete (body as Record<string, unknown>).config_driven;
    console.log(`[API PUT] Request body:`, JSON.stringify(body, null, 2));

    if (Object.keys(body).length === 0) {
      throw new ApiError("At least one field must be provided for update", 400);
    }

    await withSkillConfigLease(async (renew) => {
      const preUpdate = await getAgentSkillVisibleToUser(id);
      if (preUpdate && !preUpdate.config_driven && preUpdate.owner_id === user.email) {
        const healOwnerSubject =
          typeof session?.sub === "string" && session.sub.trim() ? session.sub.trim() : null;
        const healTeamRefs = await readSkillSharedTeamSlugsFromOpenFga(id);
        if (healOwnerSubject) {
          await renew();
          try {
            await reconcileSkillTeamShares({
              skillId: id,
              ownerSubject: healOwnerSubject,
              previousTeamRefs: healTeamRefs,
              nextTeamRefs: healTeamRefs,
              nextVisibility: preUpdate.visibility ?? "private",
              previousVisibility: preUpdate.visibility ?? "private",
            });
          } catch (error) {
            console.warn(
              "[AgentSkill] Failed to reconcile owner FGA tuple before update:",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      }
      await requireSkillPermission(session, id, "write");
    });

    if (body.visibility !== undefined) {
      if (!VALID_VISIBILITIES.includes(body.visibility)) {
        throw new ApiError(`Invalid visibility: ${body.visibility}. Must be one of: ${VALID_VISIBILITIES.join(", ")}`, 400);
      }
      if (body.visibility === "team" && (!body.shared_with_teams || body.shared_with_teams.length === 0)) {
        throw new ApiError("At least one team must be selected when visibility is 'team'", 400);
      }
    }

    if (body.tasks) {
      console.log(`[API PUT] Validating ${body.tasks.length} tasks...`);
      if (body.tasks.length === 0) {
        throw new ApiError("At least one task is required", 400);
      }
      for (const task of body.tasks) {
        if (!task.display_text || !task.llm_prompt || !task.subagent) {
          throw new ApiError("Each task must have display_text, llm_prompt, and subagent", 400);
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
      const scanResult = await runSkillScan(body.name || id, body.skill_content || "", id);
      (body as Record<string, unknown>).scan_status = scanResult.scan_status;
      if (scanResult.scan_summary !== undefined) {
        (body as Record<string, unknown>).scan_summary = scanResult.scan_summary;
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
        scanner_unavailable: !body.skill_content?.trim() || scanResult.scan_status === "unscanned",
        duration_ms: Date.now() - tPut,
      });
    }

    return await withSkillConfigLease(async (renew) => {
      console.log(`[API PUT] Calling updateAgentSkillInMongoDB...`);
      // updateAgentSkillInMongoDB already reads the pre-update row for
      // its permission check; have it hand the row back so we can build
      // a `prev` snapshot for the no-op diff guard without burning a
      // duplicate `findOne`.
      const { before: beforeUpdate } = await updateAgentSkillInMongoDB(
        id,
        body,
        user,
        renew,
      );
      if (beforeUpdate) {
        const merged: AgentSkill = { ...beforeUpdate, ...(body as Partial<AgentSkill>) };
        const prev = extractSnapshot(beforeUpdate);
        const next = extractSnapshot(merged);
        if (snapshotsDiffer(prev, next)) {
          await recordRevision({
            skillId: id,
            snapshot: next,
            trigger: "update",
            actor: user.email,
          });
        }
      }

      // The lease covers both persistence and grants so configuration adoption
      // cannot interleave with permissions derived from this ordinary edit.
      if (beforeUpdate) {
        const previousVisibility = beforeUpdate.visibility ?? "private";
        const nextVisibility =
          body.visibility !== undefined ? body.visibility : previousVisibility;
        const previousTeamRefs = await readSkillSharedTeamSlugsFromOpenFga(id);
        let nextTeamRefs: string[];
        if (nextVisibility !== "team") {
          nextTeamRefs = [];
        } else if (Object.prototype.hasOwnProperty.call(body, "shared_with_teams")) {
          nextTeamRefs = normalizeTeamRefList(body.shared_with_teams);
        } else {
          nextTeamRefs = previousTeamRefs;
        }
        const ownerSubject =
          beforeUpdate.owner_id === user.email &&
          typeof session?.sub === "string" &&
          session.sub.trim()
            ? session.sub.trim()
            : null;
        await renew();
        try {
          await reconcileSkillTeamShares({
            skillId: id,
            ownerSubject,
            previousTeamRefs,
            nextTeamRefs,
            nextVisibility,
            previousVisibility,
          });
        } catch (error) {
          console.warn(
            "[AgentSkill] Failed to reconcile skill FGA grants on update:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      console.log(`[AgentSkill] Updated agent config "${id}" by ${user.email}`);
      console.log(`[API PUT] ============ UPDATE REQUEST END ============`);

      const scanStatus = (body as Record<string, unknown>).scan_status as ScanStatus | undefined;
      return successResponse({
        id,
        message: "Agent config updated successfully",
        ...(scanStatus ? { scan_status: scanStatus } : {}),
        ...(scanSummaryFromSave !== undefined ? { scan_summary: scanSummaryFromSave } : {}),
        ...(ancillaryWarning ? { ancillary_warning: ancillaryWarning } : {}),
      });
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
    return await withSkillConfigLease(async (renew) => {
      await requireSkillPermission(session, id, "delete");
      await deleteAgentSkillFromMongoDB(id, renew);
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
});

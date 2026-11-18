import { randomUUID } from "node:crypto";
import { githubHubOptions } from "@/lib/github-hub-options";
import {
ApiError,
getAuthFromBearerOrSession,
validateCredentialsRef,
withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import { requireAdminSurfaceManage } from "@/lib/rbac/require-openfga";
import { NextRequest,NextResponse } from "next/server";
import {
normalizeHubLocation,
validateIncludePaths,
validateMaxTreePages,
} from "../_lib/normalize";

/**
 * Skill Hubs API — Individual hub operations.
 *
 * PATCH  /api/skill-hubs/[id]  — Update a hub (admin only)
 * DELETE /api/skill-hubs/[id]  — Remove a hub (admin only)
 *
 * Per contracts/skill-hubs-api.md
 */

function normalizeTeamRefs(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized.length > 0 ? normalized : undefined;
}

export const PATCH = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    if (!isMongoDBConfigured) {
      throw new ApiError("Skill hubs require MongoDB to be configured", 503);
    }

    const { session } = await getAuthFromBearerOrSession(request);
    await requireAdminSurfaceManage(session, "skills");

      const { id } = await context.params;
      const body = await request.json();

      const collection = await getCollection("skill_hubs");
      const existing = await collection.findOne({ id }) as
        | { type?: "github" | "gitlab" }
        | null;
      if (!existing) {
        throw new ApiError(`Hub not found: ${id}`, 404);
      }

      // Allow updating: enabled, location, credentials_ref, labels, include_paths
      const update: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      const unset: Record<string, "" | 1> = {};
      if (existing.type === "github") {
        const options = githubHubOptions(body);
        if (body.revision !== undefined) {
          if (options.revision) update.revision = options.revision;
          else unset.revision = "";
        }
        if (body.entry_paths !== undefined) update.entry_paths = options.entry_paths || [];
      }
      if (body.enabled !== undefined) update.enabled = !!body.enabled;
      if (body.location !== undefined) {
        // Use the existing hub's `type` so a GitLab subgroup URL is
        // preserved end-to-end on PATCH (FR-022).
        update.location = normalizeHubLocation(
          String(body.location),
          existing.type ?? "github",
        );
      }
      if (body.credentials_ref !== undefined)
        update.credentials_ref = validateCredentialsRef(body.credentials_ref);
      if (Array.isArray(body.labels))
        update.labels = body.labels.map((l: unknown) => String(l).trim().toLowerCase()).filter(Boolean).slice(0, 20);
      if (body.shared_with_teams !== undefined) {
        const teamRefs = normalizeTeamRefs(body.shared_with_teams);
        if (teamRefs && teamRefs.length > 0) {
          update.shared_with_teams = teamRefs;
        } else {
          unset.shared_with_teams = "";
        }
      }
      if (body.include_paths !== undefined) {
        const validated = validateIncludePaths(body.include_paths);
        if (validated && validated.length > 0) {
          update.include_paths = validated;
        } else {
          // Empty array or fully-empty input is treated as "unset" so the
          // crawler reverts to "walk the whole repo" behavior.
          unset.include_paths = "";
        }
      }
      if (body.max_tree_pages !== undefined) {
        // GitHub never paginates so silently ignoring would be a UX
        // trap. Reject the field for GitHub hubs (mirror of POST).
        if ((existing.type ?? "github") === "github") {
          throw new ApiError(
            "max_tree_pages applies to GitLab hubs only (GitHub fetches the tree in a single request).",
            400,
          );
        }
        const validated = validateMaxTreePages(body.max_tree_pages);
        if (typeof validated === "number") {
          update.max_tree_pages = validated;
        } else {
          // `null` or empty input clears the per-hub override so the
          // crawler falls back to GITLAB_MAX_TREE_PAGES.
          unset.max_tree_pages = "";
        }
      }

      if (["revision", "entry_paths", "include_paths", "location", "credentials_ref", "max_tree_pages"].some(key => body[key] !== undefined)) {
        update.cache_generation = randomUUID();
        update.last_success_at = null;
      }
      const writeOp: Record<string, unknown> = { $set: update };
      if (Object.keys(unset).length > 0) writeOp.$unset = unset;
      await collection.updateOne({ id }, writeOp);

      const updated = (await collection.findOne({ id })) as Record<string, unknown> | null;
      const rest = { ...(updated ?? {}) };
      delete rest._id;

      return NextResponse.json(rest);
  },
);

export const DELETE = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    if (!isMongoDBConfigured) {
      throw new ApiError("Skill hubs require MongoDB to be configured", 503);
    }

    const { session } = await getAuthFromBearerOrSession(request);
    await requireAdminSurfaceManage(session, "skills");

      const { id } = await context.params;

      const collection = await getCollection("skill_hubs");
      const result = await collection.deleteOne({ id });
      if (result.deletedCount === 0) {
        throw new ApiError(`Hub not found: ${id}`, 404);
      }

      // Purge cached skills for this hub so they don't linger in the catalog.
      const hubSkillsCol = await getCollection("hub_skills");
      await hubSkillsCol.deleteMany({ hub_id: id });

      return NextResponse.json(
        { success: true, message: `Hub ${id} deleted` },
        { status: 200 },
      );
  },
);

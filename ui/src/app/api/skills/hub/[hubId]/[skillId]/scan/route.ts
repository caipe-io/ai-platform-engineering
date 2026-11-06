import {
ApiError,
successResponse,
withAuth,
withErrorHandler,
} from "@/lib/api-middleware";
import type { HubSkillDoc,SkillHubDoc } from "@/lib/hub-crawl";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import { isSkillScannerConfigured,scanSkillContent } from "@/lib/skill-scan";
import { recordScanEvent } from "@/lib/skill-scan-history";
import { NextRequest } from "next/server";

const STORAGE_TYPE = isMongoDBConfigured ? "mongodb" : "none";

/**
 * POST /api/skills/hub/[hubId]/[skillId]/scan
 *
 * Re-runs skill-scanner on the cached SKILL.md for a hub-crawled skill.
 * Persists `scan_status`, `scan_summary`, `scan_updated_at` onto the
 * `hub_skills` cache doc so the gallery shield reflects the latest state.
 *
 * Permission: any authenticated user (hub catalogs are global / read-only).
 */
export const POST = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ hubId: string; skillId: string }> },
  ) => {
    if (STORAGE_TYPE !== "mongodb") {
      throw new ApiError("Skill hubs require MongoDB to be configured", 503);
    }

    const { hubId, skillId } = await context.params;
    if (!hubId || !skillId) {
      throw new ApiError("hubId and skillId are required", 400);
    }

    return await withAuth(request, async (_req, user, session) => {
      const hubsCol = await getCollection<SkillHubDoc>("skill_hubs");
      const hub = await hubsCol.findOne({ id: hubId });
      if (!hub) {
        throw new ApiError("Skill hub not found", 404);
      }

      const hubSkillsCol = await getCollection<HubSkillDoc>("hub_skills");
      const doc = await hubSkillsCol.findOne({
        hub_id: hubId,
        skill_id: skillId,
      });
      if (!doc) {
        throw new ApiError(
          "Skill not found in hub cache. The hub may need to be re-crawled.",
          404,
        );
      }
      await requireResourcePermission(session, {
        type: "skill",
        id: `hub-${hubId}-${skillId}`,
        action: "admin",
      });

      const content = doc.content;
      if (!content?.trim()) {
        throw new ApiError(
          "No SKILL.md content cached for this hub skill.",
          400,
        );
      }

      if (!isSkillScannerConfigured()) {
        throw new ApiError(
          "Scanner is not configured. Set SKILL_SCANNER_URL (e.g. http://skill-scanner:8000) so the UI can reach the standalone skill-scanner service.",
          503,
        );
      }

      const t0 = Date.now();
      const scanResult = await scanSkillContent(
        doc.name,
        content,
        `hub-${hubId}-${skillId}`,
        {
          // Bundle ancillary files captured during crawl so the scanner
          // analyzes the same surface the agent runtime materializes
          // (see `skills_middleware/backend_sync.py`).
          ancillaryFiles: doc.ancillary_files,
        },
      );
      const now = new Date();
      // Surface the unscanned reason (empty content / scanner timeout
      // / HTTP error) to admins via scan_summary instead of leaving
      // the workspace Scan tab silent.
      const persistedSummary =
        scanResult.scan_summary ?? scanResult.unscanned_reason;

      await recordScanEvent({
        trigger: "manual_hub_skill",
        skill_id: `hub-${hubId}-${skillId}`,
        skill_name: doc.name,
        source: "hub",
        hub_id: hubId,
        actor: user.email,
        scan_status: scanResult.scan_status,
        scan_summary: persistedSummary,
        scanner_unavailable: scanResult.scan_status === "unscanned",
        duration_ms: Date.now() - t0,
      });

      // Write the raw scanner verdict to ``scan_status`` /
      // ``scan_summary`` only. We deliberately do NOT touch the
      // ``scan_override`` sub-doc here — same rationale as the
      // agent_skills rescan route (configs/[id]/scan):
      //
      //   * The override was the admin's "I trust this regardless
      //     of the scanner" assertion. A subsequent rescan that
      //     still flags doesn't change that intent — and a
      //     passing rescan doesn't either (the user explicitly
      //     asked: "keep override across rescans, admins clear it
      //     manually"). Auto-reverting on clean was tried earlier;
      //     it created surprising "wait, I just set this and it
      //     disappeared" UX during scanner flakiness and was
      //     removed.
      //
      //   * Splitting status from override means the previous
      //     ``scan_status="admin_overridden"`` encoding is gone,
      //     so this update path can no longer accidentally nuke
      //     an override by writing the wrong status string. That
      //     class of bug is structurally impossible now.
      const updated = await hubSkillsCol.updateOne(
        { hub_id: hubId, skill_id: skillId, content: doc.content, ancillary_files: doc.ancillary_files ?? null },
        {
          $set: {
            scan_status: scanResult.scan_status,
            ...(persistedSummary !== undefined
              ? { scan_summary: persistedSummary }
              : {}),
            scan_updated_at: now,
          },
        },
      );

      if (!updated.matchedCount) throw new ApiError("Skill package changed during scanning; refresh and scan again", 409);

      return successResponse({
        id: `hub-${hubId}-${skillId}`,
        scan_status: scanResult.scan_status,
        scan_summary: persistedSummary,
        scan_updated_at: now.toISOString(),
      });
    });
  },
);

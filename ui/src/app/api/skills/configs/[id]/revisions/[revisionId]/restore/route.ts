import { NextRequest } from "next/server";

import {
getAgentSkillVisibleToUser,
} from "@/lib/agent-skill-visibility";
import {
ApiError,
successResponse,
withAuth,
withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import { requireSkillPermission } from "@/lib/rbac/resource-authz";
import { getRevision,recordRevision } from "@/lib/skill-revisions";
import { scanSkillContent as runSkillScan } from "@/lib/skill-scan";
import { recordScanEvent } from "@/lib/skill-scan-history";
import type { AgentSkill } from "@/types/agent-skill";

/**
 * POST /api/skills/configs/[id]/revisions/[revisionId]/restore
 *
 * Overwrite the live skill with the content from a stored revision,
 * then record a new revision tagged `restore` so the timeline shows
 * "Revision N — restored from Revision M".
 *
 * We deliberately re-scan after restoring instead of trusting the
 * `scan_status` captured in the old snapshot. A revision that passed
 * a year ago may fail today's scanner policy; the gallery's
 * scan-status pill must reflect a current verdict, not a frozen one.
 *
 * Auth: requires the same resource write permission as a normal save.
 */
export const POST = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string; revisionId: string }> },
  ) => {
    if (!isMongoDBConfigured) {
      throw new ApiError("Skills require MongoDB to be configured", 503);
    }
    const { id, revisionId } = await context.params;
    if (!id || !revisionId) {
      throw new ApiError("Skill id and revision id are required", 400);
    }
    return await withAuth(request, async (_req, user, session) => {
      const skill = await getAgentSkillVisibleToUser(id);
      if (!skill) {
        throw new ApiError("Skill not found", 404);
      }
      await requireSkillPermission(session, id, "write");
      if (skill.config_driven) {
        throw new ApiError("Config-driven skills are read-only. Update app-config.yaml.", 403);
      }
      const revision = await getRevision(id, revisionId);
      if (!revision) {
        throw new ApiError("Revision not found", 404);
      }

      // Re-scan with the restored content so the live row reflects a
      // current verdict. We pass the SKILL.md body and the original
      // skill name (keep the current name unless the revision
      // captured a different one) into the scanner.
      const t0 = Date.now();
      const scan = await runSkillScan(
        revision.name || skill.name,
        revision.skill_content || "",
        id,
      );

      const collection = await getCollection<AgentSkill>("agent_skills");
      const now = new Date();
      // Build the update payload by picking the content fields off
      // the revision and overlaying scan output. Administrative
      // fields (owner_id, is_system, visibility; team shares are OpenFGA-only)
      // are NOT touched — restore changes content, not who owns or
      // can see the skill.
      const updatePayload: Partial<AgentSkill> = {
        name: revision.name,
        description: revision.description,
        category: revision.category,
        tasks: revision.tasks,
        metadata: revision.metadata,
        is_quick_start: revision.is_quick_start,
        difficulty: revision.difficulty,
        thumbnail: revision.thumbnail,
        input_form: revision.input_form,
        skill_content: revision.skill_content,
        ancillary_files: revision.ancillary_files,
        scan_status: scan.scan_status,
        scan_summary: scan.scan_summary,
        scan_updated_at: revision.skill_content?.trim() ? now : undefined,
        updated_at: now,
      };
      await collection.updateOne({ id }, { $set: updatePayload });

      await recordScanEvent({
        trigger: "manual_user_skill",
        skill_id: id,
        skill_name: revision.name || skill.name,
        source: "agent_skills",
        actor: user.email,
        scan_status: scan.scan_status,
        scan_summary: scan.scan_summary,
        scanner_unavailable:
          !revision.skill_content?.trim() ||
          scan.scan_status === "unscanned",
        duration_ms: Date.now() - t0,
      });

      // Snapshot the restore as its own revision. We pass
      // `restoredFrom` so the timeline can render the breadcrumb
      // back to the source revision.
      await recordRevision({
        skillId: id,
        snapshot: {
          name: revision.name,
          description: revision.description,
          category: revision.category,
          tasks: revision.tasks,
          metadata: revision.metadata,
          is_quick_start: revision.is_quick_start,
          difficulty: revision.difficulty,
          thumbnail: revision.thumbnail,
          input_form: revision.input_form,
          skill_content: revision.skill_content,
          ancillary_files: revision.ancillary_files,
          scan_status: scan.scan_status,
          scan_summary: scan.scan_summary,
        },
        trigger: "restore",
        actor: user.email,
        restoredFrom: revision.id,
        note: `Restored from revision #${revision.revision_number}`,
      });

      return successResponse({
        skill_id: id,
        restored_from: revision.id,
        restored_revision_number: revision.revision_number,
        scan_status: scan.scan_status,
        scan_summary: scan.scan_summary,
      });
    });
  },
);

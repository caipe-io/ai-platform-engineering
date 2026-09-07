import {
getAgentSkillVisibleToUser,
userCanModifyAgentSkill,
} from "@/lib/agent-skill-visibility";
import {
ApiError,
successResponse,
withAuth,
withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import { requireSkillPermission } from "@/lib/rbac/resource-authz";
import { isSkillScannerConfigured,scanSkillContent } from "@/lib/skill-scan";
import { recordScanEvent } from "@/lib/skill-scan-history";
import type { AgentSkill } from "@/types/agent-skill";
import { NextRequest } from "next/server";

const STORAGE_TYPE = isMongoDBConfigured ? "mongodb" : "none";

/**
 * Prefer persisted SKILL.md (`skill_content`). If missing (e.g. workflow-only saves),
 * synthesize minimal markdown from task `llm_prompt` so manual scan still runs.
 */
function resolveSkillMarkdownForScan(skill: AgentSkill): string {
  const fromBuilder = skill.skill_content?.trim();
  if (fromBuilder) return fromBuilder;

  const prompts = (skill.tasks ?? [])
    .map((t) => t?.llm_prompt?.trim())
    .filter((p): p is string => Boolean(p));
  if (prompts.length === 0) return "";

  const title = skill.name?.trim() || skill.id;
  const head = `# ${title}\n\n`;
  const desc = skill.description?.trim() ? `${skill.description.trim()}\n\n` : "";
  if (prompts.length === 1) {
    return `${head}${desc}${prompts[0]}`;
  }
  const body = prompts
    .map((p, i) => `## Step ${i + 1}\n\n${p}`)
    .join("\n\n---\n\n");
  return `${head}${desc}${body}`;
}

/**
 * POST /api/skills/configs/[id]/scan
 *
 * Re-runs skill-scanner on persisted SKILL.md for Mongo-backed skills.
 * Same permission as editing the skill (owner for user skills; any authenticated user for built-in rows).
 */
export const POST = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    if (STORAGE_TYPE !== "mongodb") {
      throw new ApiError("Skills requires MongoDB to be configured", 503);
    }

    const { id } = await context.params;
    if (!id) {
      throw new ApiError("Config id is required", 400);
    }

    return await withAuth(request, async (_req, user, session) => {
      const existing = await getAgentSkillVisibleToUser(id);
      if (!existing) {
        throw new ApiError("Agent config not found", 404);
      }

      if (!userCanModifyAgentSkill(existing)) {
        throw new ApiError("You don't have permission to scan this skill", 403);
      }

      // Same gate as PUT / file-write: `can_write` on the skill (not `can_manage`).
      await requireSkillPermission(session, id, "write");

      const content = resolveSkillMarkdownForScan(existing);
      if (!content) {
        throw new ApiError(
          "No scannable text for this skill. Add SKILL.md in Skills Builder or task prompts in the workflow editor, save, then scan again.",
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
      const scanResult = await scanSkillContent(existing.name, content, id, {
        // Include ancillary files so the scanner sees the same files
        // the agent runtime injects into the StateBackend at
        // /skills/<source>/<name>/<rel_path>. Without this, scripts /
        // prompts referenced from SKILL.md would never be analyzed.
        ancillaryFiles: existing.ancillary_files,
      });
      const now = new Date();
      // Persist the unscanned reason so the workspace Scan tab can
      // explain *why* (empty content, scanner timeout, HTTP error)
      // instead of leaving the user staring at a grey badge.
      const persistedSummary =
        scanResult.scan_summary ?? scanResult.unscanned_reason;

      await recordScanEvent({
        trigger: "manual_user_skill",
        skill_id: id,
        skill_name: existing.name,
        source: existing.is_system ? "default" : "agent_skills",
        actor: user.email,
        scan_status: scanResult.scan_status,
        scan_summary: persistedSummary,
        scanner_unavailable: scanResult.scan_status === "unscanned",
        duration_ms: Date.now() - t0,
      });

      const collection = await getCollection<AgentSkill>("agent_skills");

      // Write the raw scanner verdict to ``scan_status`` /
      // ``scan_summary`` only. We deliberately do NOT touch the
      // ``scan_override`` sub-doc here:
      //
      //   * If the skill carries an admin override, the override
      //     was the admin's "I trust this regardless of the scanner"
      //     assertion. A subsequent rescan that still flags doesn't
      //     change that intent — and a passing rescan doesn't
      //     either (the user explicitly asked: "keep override
      //     across rescans, admins clear it manually"). Auto-
      //     reverting on clean was tried earlier; it created
      //     surprising "wait, I just set this and it disappeared"
      //     UX during scanner flakiness and was removed.
      //
      //   * Splitting status from override means the previous
      //     "scan_status='admin_overridden'" encoding is gone, so
      //     this update path can no longer accidentally nuke an
      //     override by writing the wrong status string. That
      //     class of bug is structurally impossible now.
      await collection.updateOne(
        { id },
        {
          $set: {
            scan_status: scanResult.scan_status,
            ...(persistedSummary !== undefined
              ? { scan_summary: persistedSummary }
              : {}),
            scan_updated_at: now,
            updated_at: now,
          },
        },
      );

      return successResponse({
        id,
        scan_status: scanResult.scan_status,
        scan_summary: persistedSummary,
        scan_updated_at: now.toISOString(),
      });
    });
  },
);

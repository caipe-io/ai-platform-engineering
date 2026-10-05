import { NextRequest } from "next/server";

import { getAgentSkillVisibleToUser } from "@/lib/agent-skill-visibility";
import {
ApiError,
successResponse,
withAuth,
withErrorHandler,
} from "@/lib/api-middleware";
import { isMongoDBConfigured } from "@/lib/mongodb";
import { requireSkillPermission } from "@/lib/rbac/resource-authz";
import { listRevisions } from "@/lib/skill-revisions";

/**
 * GET /api/skills/configs/[id]/revisions
 *
 * Returns the revision summaries for `[id]`, newest first. Heavy
 * fields (SKILL.md body, ancillary file contents) are stripped — the
 * UI fetches a single full revision via the per-revision endpoint
 * for diff/restore.
 *
 * Auth: anyone who can see the skill can see its history. We don't
 * restrict history to writers because read access to history is
 * a strictly weaker privilege than read access to the live skill —
 * if a user can already see the current SKILL.md they can already
 * see all previous content the helper would surface.
 */
export const GET = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    if (!isMongoDBConfigured) {
      throw new ApiError("Skills require MongoDB to be configured", 503);
    }
    const { id } = await context.params;
    if (!id) {
      throw new ApiError("Skill id is required", 400);
    }
    return await withAuth(request, async (_req, user, session) => {
      const skill = await getAgentSkillVisibleToUser(id);
      if (!skill) {
        // 404 (not 403) so we don't leak existence to non-viewers.
        throw new ApiError("Skill not found", 404);
      }
      await requireSkillPermission(session, id, "read");
      const revisions = await listRevisions(id);
      return successResponse({
        skill_id: id,
        revisions,
      });
    });
  },
);

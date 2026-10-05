import {
loadSkillTemplatesInternal,
} from "@/app/api/skills/skill-templates-loader";
import {
ApiError,
successResponse,
withAuth,
withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import { getEnabledSkillTemplates as getEnabledTemplates, templateToAgentSkill } from "@/lib/seed-skills";
import type { AgentSkill } from "@/types/agent-skill";
import { NextRequest,NextResponse } from "next/server";

/**
 * Seed API Route
 *
 * POST /api/skills/seed — seed MongoDB from disk templates (charts/data/skills/).
 * GET /api/skills/seed — check if seeding is needed
 *
 * Default selection is the tool-free Hello World skill. Startup bootstrap is
 * separate and runs once per database. This endpoint supports explicit imports.
 * BUILTIN_SKILL_IDS selects a subset; explicit imports also remove excluded
 * packaged system rows in whitelist mode.
 */

async function checkSeedingStatus(): Promise<{
  needsSeeding: boolean;
  existingCount: number;
  templateCount: number;
}> {
  const enabledTemplates = getEnabledTemplates();
  const allTemplates = loadSkillTemplatesInternal();

  if (!isMongoDBConfigured) {
    return { needsSeeding: false, existingCount: 0, templateCount: enabledTemplates.length };
  }

  const collection = await getCollection<AgentSkill>("agent_skills");
  const enabledIds = enabledTemplates.map((t) => t.id);
  const allSystemIds = allTemplates.map((t) => t.id);
  const disabledIds = allSystemIds.filter((id) => !new Set(enabledIds).has(id));

  const existingCount = await collection.countDocuments({
    is_system: true,
    id: { $in: enabledIds },
  });

  const staleCount =
    process.env.BUILTIN_SKILL_IDS?.trim() && disabledIds.length > 0
      ? await collection.countDocuments({ is_system: true, id: { $in: disabledIds } })
      : 0;

  return {
    needsSeeding: existingCount < enabledTemplates.length || staleCount > 0,
    existingCount,
    templateCount: enabledTemplates.length,
  };
}

async function seedTemplatesFromDisk(): Promise<{ seeded: number; skipped: number; removed: number }> {
  if (!isMongoDBConfigured) {
    throw new ApiError("MongoDB is not configured", 503);
  }

  const collection = await getCollection<AgentSkill>("agent_skills");
  const enabledTemplates = getEnabledTemplates();
  const allTemplates = loadSkillTemplatesInternal();
  const enabledIds = new Set(enabledTemplates.map((t) => t.id));

  let seeded = 0;
  let skipped = 0;

  for (const template of enabledTemplates) {
    const existing = await collection.findOne({ id: template.id });

    if (existing) {
      skipped++;
      continue;
    }

    const configToInsert = templateToAgentSkill(template);

    await collection.insertOne(configToInsert);
    seeded++;
    console.log(`[Seed] Seeded template: ${template.name}`);
  }

  let removed = 0;
  const whitelistMode = Boolean(process.env.BUILTIN_SKILL_IDS?.trim());
  if (whitelistMode) {
    const allSystemIds = allTemplates.map((t) => t.id);
    const disabledIds = allSystemIds.filter((id) => !enabledIds.has(id));
    if (disabledIds.length > 0) {
      const result = await collection.deleteMany({
        is_system: true,
        id: { $in: disabledIds },
      });
      removed = result.deletedCount;
      if (removed > 0) {
        console.log(`[Seed] Removed ${removed} non-whitelisted system template(s)`);
      }
    }
  }

  return { seeded, skipped, removed };
}

// GET /api/skills/seed
export const GET = withErrorHandler(async () => {
  const enabledTemplates = getEnabledTemplates();

  if (!isMongoDBConfigured) {
    return NextResponse.json({
      needsSeeding: false,
      message: "MongoDB not configured - using disk templates from charts/data/skills/",
      existingCount: 0,
      templateCount: enabledTemplates.length,
    });
  }

  const status = await checkSeedingStatus();

  return NextResponse.json({
    ...status,
    message: status.needsSeeding
      ? `${status.templateCount - status.existingCount} templates need to be seeded`
      : "All templates are already seeded",
  });
});

// POST /api/skills/seed
export const POST = withErrorHandler(async (request: NextRequest) => {
  if (!isMongoDBConfigured) {
    throw new ApiError("MongoDB is not configured", 503);
  }

  try {
    await withAuth(request, async (req) => {
      const session = (req as { session?: { role?: string } }).session;
      void session?.role;
      return NextResponse.json({ ok: true });
    });
  } catch {
    // Not authenticated — allow seeding for initial setup
  }

  const result = await seedTemplatesFromDisk();

  console.log(
    `[Seed] Seeding complete: ${result.seeded} seeded, ${result.skipped} skipped, ${result.removed} removed`,
  );

  return successResponse(
    {
      message: `Successfully seeded ${result.seeded} templates (${result.removed} removed)`,
      ...result,
    },
    201,
  );
});

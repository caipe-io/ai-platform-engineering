import { getCollection } from "@/lib/mongodb";
import {
  bootstrapSkills,
  getLegacySkillTemplates,
  isSkillBootstrapComplete,
  templateToAgentSkill,
  type SeedSkill,
} from "@/lib/seed-skills";
import type { AgentSkill } from "@/types/agent-skill";
import type { MigrationApplyResult, MigrationPlanResult } from "./types";

export const SKILLS_DATABASE_CATALOG_MIGRATION_ID = "skills_database_catalog_v1";
export const SKILLS_DATABASE_CATALOG_CONFIRMATION = "MIGRATE agent_skills TO v4";

async function migrationSeeds(): Promise<SeedSkill[]> {
  if (await isSkillBootstrapComplete()) return [];
  const { loadSeedConfig } = await import("@/lib/seed-config");
  const configured = process.env.APP_CONFIG_PATH
    ? loadSeedConfig(process.env.APP_CONFIG_PATH).skills
    : undefined;
  return configured ?? getLegacySkillTemplates();
}

export async function planSkillsDatabaseCatalogMigration(): Promise<MigrationPlanResult> {
  const seeds = await migrationSeeds();
  const collection = await getCollection<AgentSkill>("agent_skills");
  const missing: SeedSkill[] = [];
  for (const skill of seeds) {
    templateToAgentSkill(skill);
    if (!await collection.findOne({ $or: [
      { id: skill.id },
      { is_system: true, "metadata.template_source_id": skill.id },
    ] })) missing.push(skill);
  }
  return {
    migration_id: SKILLS_DATABASE_CATALOG_MIGRATION_ID,
    release: "1.3.0",
    schema_area: "agent_skills",
    kind: "explicit",
    from_version: 3,
    to_version: 4,
    counts: { selected_skills: seeds.length, missing_skills: missing.length, existing_skills: seeds.length - missing.length },
    warnings: missing.length ? ["Missing catalog skills will be inserted. Existing content and visibility are preserved."] : [],
    sample_diffs: missing.slice(0, 5).map((skill) => ({
      collection: "agent_skills", id: skill.id, before: {},
      after: { id: skill.id, name: skill.name, owner_id: "system", visibility: "global" },
    })),
    tuple_writes_planned: 0,
    confirmation: SKILLS_DATABASE_CATALOG_CONFIRMATION,
  };
}

export async function applySkillsDatabaseCatalogMigration(input: {
  actor: string; now: string;
}): Promise<MigrationApplyResult> {
  const plan = await planSkillsDatabaseCatalogMigration();
  const result = await bootstrapSkills(await migrationSeeds(), { migration: true });
  return {
    ...plan,
    applied_counts: { skills_inserted: result.seeded, skills_preserved: result.skipped },
    applied_at: input.now,
    applied_by: input.actor,
  };
}

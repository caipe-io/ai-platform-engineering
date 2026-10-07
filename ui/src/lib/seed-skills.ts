import {
  loadSkillTemplatesInternal,
  loadTemplateAncillaryFiles,
  resolveTemplateDir,
  type SkillTemplateData,
} from "@/app/api/skills/skill-templates-loader";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { reconcileShareableResource } from "@/lib/rbac/openfga-owned-resources-reconcile";
import type { AgentSkill } from "@/types/agent-skill";
import { randomUUID } from "node:crypto";

export type SeedSkill = Pick<SkillTemplateData, "id" | "name" | "content"> &
  Partial<Omit<SkillTemplateData, "id" | "name" | "content">>;

interface SkillBootstrap {
  _id: string;
  lease_owner?: string;
  lease_until?: Date;
  completed_at?: Date;
}

const BOOTSTRAP_ID = "skills";
const LEASE_MS = 5 * 60 * 1000;

/** Serialize skill database and grant writes with configured-skill reconciliation and cleanup. */
export async function withSkillConfigLease<T>(
  apply: (renew: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const state = await getCollection<SkillBootstrap>("startup_seeds");
  const id = "configured-skills";
  const owner = randomUUID();
  const deadline = Date.now() + 30_000;
  while (true) {
    const now = new Date();
    try {
      await state.updateOne(
        { _id: id, $or: [{ lease_until: { $exists: false } }, { lease_until: { $lte: now } }] },
        { $set: { lease_owner: owner, lease_until: new Date(now.getTime() + LEASE_MS) } },
        { upsert: true },
      );
      break;
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== 11000) throw error;
      if (Date.now() >= deadline) throw new Error("Configured skill reconciliation is running on another replica; retry");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const renew = async (): Promise<void> => {
    const now = new Date();
    const result = await state.updateOne(
      { _id: id, lease_owner: owner, lease_until: { $gt: now } },
      { $set: { lease_until: new Date(now.getTime() + LEASE_MS) } },
    );
    if (!result.matchedCount) throw new Error("Configured skill reconciliation lease lost");
  };
  try {
    return await apply(renew);
  } finally {
    await state.updateOne(
      { _id: id, lease_owner: owner },
      { $unset: { lease_owner: "", lease_until: "" } },
    );
  }
}

export function getLegacySkillTemplates(): SkillTemplateData[] {
  const templates = loadSkillTemplatesInternal().filter((skill) => skill.id !== "hello-world");
  if (!templates.length) {
    throw new Error("Packaged skill catalog unavailable; retry with the UI image assets present");
  }
  return templates;
}

export function getDefaultSkillTemplates(): SkillTemplateData[] {
  return loadSkillTemplatesInternal().filter((skill) => skill.id === "hello-world");
}

export async function isSkillBootstrapComplete(): Promise<boolean> {
  if (!isMongoDBConfigured) return false;
  const collection = await getCollection<SkillBootstrap>("startup_seeds");
  return Boolean((await collection.findOne({ _id: BOOTSTRAP_ID }))?.completed_at);
}

export function validateSeedSkills(skills: SeedSkill[]): void {
  if (!Array.isArray(skills)) throw new Error("Seed skills must be a list");
  const ids = new Set<string>();
  for (const skill of skills) {
    if (
      !skill || typeof skill.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(skill.id) ||
      typeof skill.name !== "string" || !skill.name.trim() ||
      typeof skill.content !== "string" || !skill.content.trim()
    ) {
      throw new Error("Seed skills require a valid id, name, and content");
    }
    if (ids.has(skill.id)) throw new Error("Seed skill IDs must be unique");
    ids.add(skill.id);
  }
}

export function templateToAgentSkill(skill: SeedSkill): AgentSkill {
  validateSeedSkills([skill]);
  const now = new Date();
  const templateDir = resolveTemplateDir(skill.id);
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description ?? "",
    category: skill.category ?? "Custom",
    tasks: [{
      display_text: skill.title || skill.name,
      llm_prompt: skill.content,
      subagent: "user_input",
    }],
    owner_id: "system",
    is_system: true,
    config_driven: false,
    visibility: "global",
    created_at: now,
    updated_at: now,
    is_quick_start: true,
    thumbnail: skill.icon ?? "Zap",
    skill_content: skill.content,
    ...(templateDir ? { ancillary_files: loadTemplateAncillaryFiles(templateDir) } : {}),
    metadata: {
      tags: skill.tags ?? [], schema_version: "1.0",
      ...(skill.input_variables?.length ? { input_variables: skill.input_variables } : {}),
    },
    ...(skill.input_variables?.length
      ? { input_form: { title: skill.title || skill.name, fields: skill.input_variables.map((field) => ({
          ...field, placeholder: field.placeholder ?? "", type: "text" as const,
        })) } }
      : {}),
  };
}

/** Seed once per database; the completion record preserves later edits and deletions. */
export async function bootstrapSkills(
  configuredSkills?: SeedSkill[],
  options: { migration?: boolean } = {},
): Promise<{ seeded: number; skipped: number }> {
  const result = { seeded: 0, skipped: 0 };
  if (!isMongoDBConfigured || await isSkillBootstrapComplete()) return result;
  const state = await getCollection<SkillBootstrap>("startup_seeds");
  if (!options.migration && !(await state.findOne({ _id: BOOTSTRAP_ID }))) {
    // Existing application records belong to the explicit catalog migration.
    for (const name of ["users", "dynamic_agents", "agent_skills", "data_schema_versions", "conversations", "llm_models", "mcp_servers", "workflow_configs"]) {
      const collection = await getCollection(name);
      if (await collection.findOne({}, { projection: { _id: 1 } })) return result;
    }
  }
  const skills = configuredSkills ?? getDefaultSkillTemplates();
  validateSeedSkills(skills);
  const documents = skills.map(templateToAgentSkill);
  if (!documents.length && configuredSkills === undefined) {
    throw new Error("No startup skill templates found");
  }
  const owner = randomUUID();
  const now = new Date();
  try {
    // The _id index admits one startup replica; expired leases permit recovery.
    await state.updateOne(
      {
        _id: BOOTSTRAP_ID,
        completed_at: { $exists: false },
        $or: [{ lease_until: { $exists: false } }, { lease_until: { $lte: now } }],
      },
      { $set: { lease_owner: owner, lease_until: new Date(now.getTime() + LEASE_MS) } },
      { upsert: true },
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
      if (options.migration && !await isSkillBootstrapComplete()) {
        throw new Error("Skill bootstrap is running on another replica; retry the migration");
      }
      return result;
    }
    throw error;
  }

  try {
    const collection = await getCollection<AgentSkill>("agent_skills");
    for (const document of documents) {
      const lease = await state.updateOne(
        { _id: BOOTSTRAP_ID, lease_owner: owner },
        { $set: { lease_until: new Date(Date.now() + LEASE_MS) } },
      );
      if (!lease.matchedCount) throw new Error("Skill bootstrap lease expired");

      const imported = await collection.findOne({
        is_system: true, "metadata.template_source_id": document.id,
      });
      if (configuredSkills === undefined || options.migration) {
        const scans = await getCollection<AgentSkill>("builtin_skill_scans");
        const scan = await scans.findOne({ id: document.id });
        if (scan?.scan_status) {
          document.scan_status = scan.scan_status;
          document.scan_summary = scan.scan_summary;
          document.scan_updated_at = scan.scan_updated_at;
          document.scan_override = scan.scan_override;
        }
      }
      const update = imported ? null : await collection.updateOne(
        { id: document.id }, { $setOnInsert: document }, { upsert: true },
      );
      if (update?.upsertedCount) result.seeded++;
      else result.skipped++;

      const stored = imported ?? await collection.findOne({ id: document.id });
      if (document.scan_status && stored?.is_system && stored.scan_status === undefined) {
        await collection.updateOne(
          { id: stored.id, scan_status: { $exists: false } },
          { $set: {
            scan_status: document.scan_status, scan_summary: document.scan_summary,
            scan_updated_at: document.scan_updated_at, scan_override: document.scan_override,
          } },
        );
      }
      if (stored?.is_system && stored.visibility === undefined) {
        await collection.updateOne(
          { id: stored.id, visibility: { $exists: false } },
          { $set: { visibility: "global" } },
        );
        stored.visibility = "global";
      }
      if (stored?.is_system && stored.visibility === "global") {
        await reconcileShareableResource({
          objectType: "skill", objectId: stored.id,
          sharedWithOrg: true, memberRelations: ["user"],
        });
      }
    }
    const completion = await state.updateOne(
      { _id: BOOTSTRAP_ID, lease_owner: owner },
      { $set: { completed_at: new Date() }, $unset: { lease_owner: "", lease_until: "" } },
    );
    if (!completion.matchedCount) throw new Error("Skill bootstrap lease lost");
    console.log(`[seed-skills] Applied: ${result.seeded} skills, ${result.skipped} existing`);
    return result;
  } catch (error) {
    await state.updateOne(
      { _id: BOOTSTRAP_ID, lease_owner: owner },
      { $unset: { lease_owner: "", lease_until: "" } },
    );
    throw error;
  }
}

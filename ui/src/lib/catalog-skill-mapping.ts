import type { AgentSkill,ScanOverride } from "@/types/agent-skill";

export interface CatalogSkillForUi {
  id: string;
  name: string;
  source: string;
  source_id?: string | null;
  owner_id?: string | null;
  description?: string;
  metadata?: Record<string, unknown>;
  visibility?: string;
  content?: string | null;
  ancillary_files?: Record<string, string>;
  scan_status?: "passed" | "flagged" | "unscanned";
  scan_summary?: string;
  scan_updated_at?: string;
  scan_override?: ScanOverride;
}

/**
 * Convert a unified-catalog row into the shape consumed by the gallery and
 * workspace. Mongo-backed skills retain their canonical id; only immutable
 * default and hub entries use the synthetic `catalog-` namespace.
 */
export function mapCatalogSkillToAgentSkill(skill: CatalogSkillForUi): AgentSkill {
  const isMongoBacked = skill.source === "agent_skills";
  const isBuiltin = skill.source === "default" || Boolean(skill.metadata?.is_system);

  return {
    id: isMongoBacked ? skill.id : `catalog-${skill.id}`,
    name: skill.name,
    description: skill.description || "",
    category: (skill.metadata?.category as string) || "Custom",
    tasks: [],
    owner_id: isMongoBacked ? String(skill.owner_id ?? "") : "",
    is_system: isBuiltin,
    is_quick_start: isBuiltin,
    visibility:
      (skill.visibility as AgentSkill["visibility"]) ??
      (skill.metadata?.visibility as AgentSkill["visibility"]) ??
      undefined,
    created_at: new Date(),
    updated_at: new Date(),
    thumbnail: (skill.metadata?.icon as string) || "Zap",
    skill_content: skill.content ?? undefined,
    ancillary_files: skill.ancillary_files,
    metadata: {
      tags: (skill.metadata?.tags as string[]) || [],
      catalog_source: skill.source,
      catalog_source_id: skill.source_id ?? null,
      catalog_visibility: skill.visibility,
      hub_location: (skill.metadata?.hub_location as string) || "",
      hub_type: (skill.metadata?.hub_type as string) || "",
      hub_path: (skill.metadata?.path as string) || "",
    },
    scan_status: skill.scan_status,
    scan_summary: skill.scan_summary,
    scan_updated_at: skill.scan_updated_at
      ? new Date(skill.scan_updated_at)
      : undefined,
    scan_override: skill.scan_override,
  } as AgentSkill;
}

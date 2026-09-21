export interface AgentSkillCatalogDoc {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  skill_content?: unknown;
  skill_template?: unknown;
  tasks?: Array<{ llm_prompt?: unknown }>;
  owner_id?: unknown;
  visibility?: unknown;
  is_system?: unknown;
  category?: unknown;
  metadata?: unknown;
  ancillary_files?: unknown;
  scan_status?: unknown;
  scan_summary?: unknown;
  scan_updated_at?: unknown;
  scan_override?: unknown;
}

export interface ProjectedAgentSkillCatalog {
  id: string;
  name: string;
  description: string;
  source: "agent_skills";
  source_id: string;
  owner_id: string | null;
  content: string | null;
  metadata: Record<string, unknown>;
  ancillary_files?: Record<string, string>;
  scan_status?: "passed" | "flagged" | "unscanned";
  scan_summary?: string;
  scan_updated_at?: string;
  scan_override?: {
    set_by: string;
    set_at: string;
    reason: string;
    prior_scan_status: "flagged";
    prior_scan_summary?: string;
  };
}

/** Project one Mongo `agent_skills` row into the unified catalog contract. */
export function projectAgentSkillCatalogDoc(
  doc: AgentSkillCatalogDoc,
  includeContent: boolean,
): ProjectedAgentSkillCatalog | null {
  if (!doc.name) return null;
  const id = String(doc.id || doc.name);
  const taskPrompt = Array.isArray(doc.tasks) ? doc.tasks[0]?.llm_prompt : undefined;
  const content = String(doc.skill_content || doc.skill_template || taskPrompt || "");
  const metadata =
    typeof doc.metadata === "object" && doc.metadata !== null
      ? (doc.metadata as Record<string, unknown>)
      : {};
  const scanStatus =
    doc.scan_status === "passed" ||
    doc.scan_status === "flagged" ||
    doc.scan_status === "unscanned"
      ? doc.scan_status
      : undefined;
  const ancillaryFiles =
    typeof doc.ancillary_files === "object" && doc.ancillary_files !== null
      ? (doc.ancillary_files as Record<string, string>)
      : undefined;

  return {
    id,
    name: String(doc.name),
    description: String(doc.description ?? "").slice(0, 1024),
    source: "agent_skills",
    source_id: id,
    owner_id: doc.owner_id ? String(doc.owner_id) : null,
    content: includeContent ? content : null,
    metadata: {
      ...metadata,
      category: doc.category,
      visibility: doc.visibility,
      is_system: doc.is_system,
    },
    ancillary_files:
      includeContent && ancillaryFiles ? ancillaryFiles : undefined,
    ...(scanStatus ? { scan_status: scanStatus } : {}),
    ...(doc.scan_summary !== undefined
      ? { scan_summary: String(doc.scan_summary) }
      : {}),
    ...(doc.scan_updated_at
      ? {
          scan_updated_at:
            doc.scan_updated_at instanceof Date
              ? doc.scan_updated_at.toISOString()
              : String(doc.scan_updated_at),
        }
      : {}),
    ...(doc.scan_override
      ? {
          scan_override:
            doc.scan_override as ProjectedAgentSkillCatalog["scan_override"],
        }
      : {}),
  };
}

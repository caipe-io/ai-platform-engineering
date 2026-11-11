type SkillIdentity = {
  id: string;
  name: string;
  source: "default" | "agent_skills" | "hub";
};

/** Names are labels; only a stable ID identifies an attached skill. */
export function mergeCatalogSkills<T extends SkillIdentity>(skills: T[]): T[] {
  const priority = { default: 0, agent_skills: 1, hub: 2 };
  const byId = new Map<string, T>();
  for (const skill of skills) {
    const existing = byId.get(skill.id);
    if (!existing || priority[skill.source] < priority[existing.source]) {
      byId.set(skill.id, skill);
    }
  }
  return [...byId.values()].sort(
    (a, b) => priority[a.source] - priority[b.source]
      || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

import { getCollection } from "@/lib/mongodb";
import { readSkillSharedTeamSlugsFromOpenFga } from "@/lib/rbac/skill-team-grants";
import type { AgentSkill } from "@/types/agent-skill";

/**
 * Load a single agent_skills row by id.
 *
 * Authorization is enforced by callers with concrete OpenFGA checks. Mongo
 * stores `visibility` and `owner_id` as metadata; team shares are OpenFGA-only
 * and exposed on API responses via {@link hydrateAgentSkillTeamShares}.
 */
export async function getAgentSkillVisibleToUser(
  id: string,
): Promise<AgentSkill | null> {
  const collection = await getCollection<AgentSkill>("agent_skills");
  return collection.findOne({ id });
}

/**
 * Attach `shared_with_teams` on API responses from OpenFGA (not Mongo).
 * Values are team slugs (UI accepts slug or Mongo team `_id` refs).
 */
export async function hydrateAgentSkillTeamShares(skill: AgentSkill): Promise<AgentSkill> {
  if (skill.visibility !== "team") {
    return { ...skill, shared_with_teams: undefined };
  }
  const slugs = await readSkillSharedTeamSlugsFromOpenFga(skill.id);
  return {
    ...skill,
    shared_with_teams: slugs.length > 0 ? slugs : undefined,
  };
}

export async function hydrateAgentSkillTeamSharesList(
  skills: AgentSkill[],
): Promise<AgentSkill[]> {
  return Promise.all(skills.map((skill) => hydrateAgentSkillTeamShares(skill)));
}

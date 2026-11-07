import {
  filterResourcesByPermission,
  requireResourcePermission,
  type ResourceAuthzSession,
} from "./resource-authz";

const OWNER_TEAM_ACTIONS = ["use", "manage"] as const;

/** Use the same team grants when offering an owner and when saving one. */
export async function canUseAgentOwnerTeam(
  session: ResourceAuthzSession,
  teamSlug: string,
): Promise<boolean> {
  if (!teamSlug.trim()) return false;
  for (const action of OWNER_TEAM_ACTIONS) {
    try {
      await requireResourcePermission(session, {
        type: "team",
        id: teamSlug,
        action,
      });
      return true;
    } catch {
      // Ownership stays unavailable unless a team grant can be verified.
    }
  }
  return false;
}

/** Batch catalog checks without treating organization administration as membership. */
export async function resolveAgentOwnerTeamAccess(
  session: ResourceAuthzSession,
  teamSlugs: string[],
): Promise<{ usable: Set<string>; manageable: Set<string> }> {
  const candidates = [...new Set(teamSlugs.filter((slug) => slug.trim()))];
  const [usable, manageable] = await Promise.all(
    OWNER_TEAM_ACTIONS.map((action) =>
      filterResourcesByPermission(session, candidates, {
        type: "team",
        action,
        id: (slug) => slug,
      }),
    ),
  );
  return { usable: new Set(usable), manageable: new Set(manageable) };
}

/** Teams with platform-defined mutation rules. */
export const EVERYONE_TEAM_SLUG = "everyone";
export const SUPER_ADMINS_TEAM_SLUG = "super-admins";

export function isEveryoneTeamSlug(slug: string | null | undefined): boolean {
  return slug?.trim().toLowerCase() === EVERYONE_TEAM_SLUG;
}

export function isSuperAdminsTeamSlug(
  slug: string | null | undefined,
): boolean {
  return slug?.trim().toLowerCase() === SUPER_ADMINS_TEAM_SLUG;
}

export const APPLICATION_NAVIGATION_COLLAPSED_COOKIE =
  "caipe-application-navigation-collapsed";

export const WORKSPACE_RAIL_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function isWorkspaceRailCollapsed(
  value: string | undefined,
): boolean {
  return value === "true";
}

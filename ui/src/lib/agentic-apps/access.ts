import type { ConfiguredAgenticApp } from "@/types/agentic-app";

export type AgenticAppUserContext = {
  role?: string;
  roles?: string[];
};

export function canLaunchAgenticApp(
  app: ConfiguredAgenticApp,
  user: AgenticAppUserContext,
): boolean {
  const { installation, manifest } = app;
  if (!installation.installed || !installation.enabled || !installation.visible) {
    return false;
  }

  const requiredRoles =
    installation.accessOverrides?.requiredRoles ?? manifest.access.requiredRoles ?? [];
  const roles = new Set(
    [user.role, ...(user.roles ?? [])]
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  if (roles.has("admin")) roles.add("user");
  return requiredRoles.length === 0 || requiredRoles.some((role) => roles.has(role));
}

export function agenticAppUserContextFromSession(
  session: Record<string, unknown>,
  fallbackRole?: string,
): AgenticAppUserContext {
  const role = typeof session.role === "string" ? session.role : fallbackRole;
  const roles = Array.isArray(session.roles)
    ? session.roles.filter((value): value is string => typeof value === "string")
    : [];
  return { role, roles };
}

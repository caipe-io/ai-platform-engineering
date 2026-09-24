import { isBootstrapAdmin } from "@/lib/auth-config";
import { checkOpenFgaTuple } from "@/lib/rbac/openfga";
import { SUPER_ADMINS_TEAM_SLUG } from "@/lib/rbac/reserved-teams";

export interface ImpersonationActor {
  sub?: string;
  user?: { email?: string | null } | null;
}

function allowedEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_ALLOW_IMPERSONATION ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Impersonation is an explicit, fail-closed privilege layered on top of
 * Super Admin membership. Both checks must pass for every start attempt.
 */
export async function canStartUserImpersonation(
  actor: ImpersonationActor,
): Promise<boolean> {
  const email = actor.user?.email?.trim().toLowerCase() ?? "";
  if (!email || !allowedEmails().has(email)) return false;
  if (isBootstrapAdmin(email)) return true;
  if (!actor.sub?.trim()) return false;

  try {
    const decision = await checkOpenFgaTuple({
      user: `user:${actor.sub.trim()}`,
      relation: "admin",
      object: `team:${SUPER_ADMINS_TEAM_SLUG}`,
    });
    return decision.allowed;
  } catch {
    return false;
  }
}

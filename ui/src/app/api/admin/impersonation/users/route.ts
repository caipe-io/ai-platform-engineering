import {
  ApiError,
  getAuthFromBearerOrSession,
  requireRbacPermission,
  withErrorHandler,
} from "@/lib/api-middleware";
import { extractGroups, hasRequiredGroup } from "@/lib/auth-config";
import {
  getUserFederatedIdentities,
  listIdpAliases,
  searchRealmUsers,
} from "@/lib/rbac/keycloak-admin";
import { type NextRequest, NextResponse } from "next/server";

function isHumanUser(user: Record<string, unknown>): boolean {
  const username = String(user.username ?? "").toLowerCase();
  return !user.serviceAccountClientId && !username.startsWith("service-account-");
}

function importedGroups(user: Record<string, unknown>): string[] {
  const attributes = user.attributes;
  const idpGroups = attributes && typeof attributes === "object"
    ? (attributes as Record<string, unknown>).idp_groups
    : undefined;
  return extractGroups({ groups: idpGroups });
}

export const GET = withErrorHandler(async (request: NextRequest): Promise<NextResponse> => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, "admin_ui", "admin");

  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() || undefined;
  const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "25", 10);
  if (!Number.isInteger(page) || page < 1) {
    throw new ApiError("page must be at least 1", 400);
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new ApiError("pageSize must be between 1 and 50", 400);
  }

  const rows = await searchRealmUsers({
    search,
    enabled: true,
    first: (page - 1) * pageSize,
    max: pageSize,
  });
  const federationRequired = (await listIdpAliases()).some(
    (provider) => provider.enabled !== false,
  );
  const excludedSubjects = new Set(
    [session.impersonatedBySub, session.sub].filter(
      (subject): subject is string => typeof subject === "string" && Boolean(subject),
    ),
  );
  const candidates = rows
    .filter((user) => (
      user.enabled === true
      && isHumanUser(user)
      && !excludedSubjects.has(String(user.id ?? ""))
      && hasRequiredGroup(importedGroups(user))
    ))
    .map(async (user) => {
      const id = String(user.id ?? "");
      if (!id) return null;
      if (federationRequired && (await getUserFederatedIdentities(id)).length === 0) return null;
      const firstName = String(user.firstName ?? "").trim();
      const lastName = String(user.lastName ?? "").trim();
      const email = String(user.email ?? "").trim();
      const username = String(user.username ?? "").trim();
      return {
        id,
        name: [firstName, lastName].filter(Boolean).join(" ") || email || username,
        email,
        username,
      };
    });
  const users = (await Promise.all(candidates)).filter(
    (user): user is NonNullable<typeof user> => Boolean(user?.id && user.email && user.username),
  );

  return NextResponse.json({
    users,
    page,
    pageSize,
    hasMore: rows.length === pageSize,
  });
});

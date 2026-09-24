// GET /api/admin/users/[id]/identity
//
// Slow Keycloak sub-calls (sessions + federated identities) split out of the
// main GET /api/admin/users/[id] so the profile header and team picker render
// immediately while this fetches in the background for the "Identity & account"
// section at the bottom of the modal.

import {
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import {
  getUserFederatedIdentities,
  getUserSessions,
  getKeycloakRealm,
  listRealmRoleMappingsForUser,
} from "@/lib/rbac/keycloak-admin";
import { requireAdminSimulationUserProfileRead } from "@/lib/rbac/admin-simulation-server";
import type { UserIdentityInfo } from "@/types/admin-user-identity";
import { type NextRequest } from "next/server";

export const GET = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const { session } = await getAuthFromBearerOrSession(request);
    const { id } = await context.params;
    await requireAdminSimulationUserProfileRead(
      new URL(request.url).searchParams,
      session,
      id,
    );

    const results = await Promise.allSettled([
      getUserSessions(id),
      getUserFederatedIdentities(id),
      listRealmRoleMappingsForUser(id),
    ]);
    const keys = ["sessions", "federatedIdentities", "realmRoles"] as const;
    const unavailable: UserIdentityInfo["unavailable"] = [];
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        unavailable.push(keys[index]);
        // Do not log upstream error bodies: they can contain identity data.
        console.warn(`[admin-user-identity] ${keys[index]} lookup failed`);
      }
    });
    const sessions = results[0].status === "fulfilled" ? results[0].value : [];
    const federatedIdentities = results[1].status === "fulfilled" ? results[1].value : [];
    const realmRoles = results[2].status === "fulfilled"
      ? results[2].value.map((role) => role.name).sort()
      : [];

    const lastAccess = sessions.reduce((max, s) => {
      const t = s.lastAccess ?? s.start ?? 0;
      return t > max ? t : max;
    }, 0);

    const data: UserIdentityInfo = {
      realm: getKeycloakRealm(),
      fetchedAt: new Date().toISOString(),
      sessions: sessions.map(({ id: sessionId, start, lastAccess }) => ({ id: sessionId, start, lastAccess })),
      federatedIdentities,
      realmRoles,
      unavailable,
      lastAccess: lastAccess > 0 ? lastAccess : null,
    };
    const response = successResponse(data);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
);

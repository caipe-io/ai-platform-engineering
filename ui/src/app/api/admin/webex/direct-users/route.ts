import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  getPaginationParams,
  requireRbacPermission,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { countRealmUsers, getRealmUserById, searchRealmUsers } from "@/lib/rbac/keycloak-admin";
import { firstAttribute, userAttributes } from "@/lib/rbac/keycloak-user-attributes";
import {
  deleteWebexDirectUserRoute,
  listWebexDirectUserRoutesByUserIds,
  upsertWebexDirectUserRoute,
} from "@/lib/rbac/webex-direct-user-route-store";
import {
  requireAvailableWebexBotPolicy,
  type WebexBotPolicy,
} from "@/lib/webex-bot-policy";

async function requireBot(value: unknown): Promise<WebexBotPolicy> {
  const botId = typeof value === "string" ? value.trim() : "";
  return requireAvailableWebexBotPolicy(botId);
}

const SAFE_ID = /^[A-Za-z0-9._@+-]+$/;

function requireId(value: unknown, field: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 255 || !SAFE_ID.test(id)) {
    throw new ApiError(`${field} is invalid`, 400);
  }
  return id;
}

function requireEmail(value: unknown, field: string): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!email || email.length > 320 || !email.includes("@")) {
    throw new ApiError(`${field} is invalid`, 400);
  }
  return email;
}

function requireMutableMode(policy: WebexBotPolicy): void {
  if (policy.directMessages.accessMode === "disabled") {
    throw new ApiError(
      `Direct messages are disabled for Webex bot "${policy.name}"`,
      409,
    );
  }
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, "admin_ui", "admin");

  const bot = await requireBot(request.nextUrl.searchParams.get("bot_id"));
  const accessMode = bot.directMessages.accessMode;
  const defaultAgentId = bot.directMessages.defaultAgentId;
  const query = (request.nextUrl.searchParams.get("q") ?? "").trim();
  const { page, pageSize, skip } = getPaginationParams(request);

  const [users, total] = await Promise.all([
    searchRealmUsers({ search: query || undefined, enabled: true, first: skip, max: pageSize }),
    countRealmUsers({ search: query || undefined, enabled: true }),
  ]);
  const userIds = users
    .map((user) => String(user.id ?? ""))
    .filter((id) => id.length > 0);
  const routeByUser = await listWebexDirectUserRoutesByUserIds(bot.id, userIds);
  const rows = users.filter((user) => {
    const id = String(user.id ?? "").trim();
    const email = String(user.email ?? "").trim();
    return id.length > 0 && email.length > 0;
  }).map((user) => {
    const id = String(user.id ?? "");
    const email = String(user.email ?? "").trim().toLowerCase();
    const attributes = userAttributes(user);
    const route = routeByUser.get(id);
    const inherited = accessMode === "all_users" && !route;
    const enabled =
      accessMode === "all_users"
        ? route?.status !== "disabled"
        : accessMode === "allowlist" && route?.status === "active";
    const state =
      accessMode === "disabled"
        ? "disabled"
        : inherited
          ? "inherited"
          : route?.status === "disabled"
            ? "denied"
            : route?.status === "active"
              ? accessMode === "allowlist"
                ? "allowlisted"
                : "overridden"
              : "not_allowed";
    return {
      keycloak_user_id: id,
      email,
      display_name:
        [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
        String(user.username ?? email),
      linked: Boolean(firstAttribute(attributes, "webex_user_id")),
      enabled,
      configured: Boolean(route),
      inherited,
      state,
      agent_id: route?.agent_id ?? (accessMode === "all_users" ? defaultAgentId ?? "" : ""),
    };
  });

  return successResponse({
    users: rows,
    bot_id: bot.id,
    dm_access_mode: accessMode,
    default_agent_id: defaultAgentId,
    total,
    page,
    page_size: pageSize,
    has_more: page * pageSize < total,
  });
});

export const PUT = withErrorHandler(async (request: NextRequest) => {
  const { user, session } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, "admin_ui", "admin");
  const body = await request.json() as Record<string, unknown>;
  const bot = await requireBot(body.bot_id);
  requireMutableMode(bot);
  const keycloakUserId = requireId(body.keycloak_user_id, "keycloak_user_id");
  const agentId = requireId(body.agent_id, "agent_id");
  const enabled = body.enabled !== false;
  if (bot.directMessages.accessMode === "allowlist" && !enabled) {
    throw new ApiError("Remove an allowlist route instead of disabling it", 400);
  }

  const realmUser = await getRealmUserById(keycloakUserId);
  if (realmUser.enabled === false) throw new ApiError("Disabled users cannot be onboarded", 400);
  const email = requireEmail(realmUser.email, "user email");
  const agents = await getCollection("dynamic_agents");
  const agent = await agents.findOne({ _id: agentId, enabled: { $ne: false } } as never);
  if (!agent) throw new ApiError("The selected agent does not exist or is disabled", 400);
  const attributes = userAttributes(realmUser);
  await upsertWebexDirectUserRoute({
    botId: bot.id,
    keycloakUserId,
    userEmail: email,
    webexUserId: firstAttribute(attributes, "webex_user_id"),
    agentId,
    enabled,
    actor: user.email,
  });
  return successResponse({ saved: true, bot_id: bot.id, keycloak_user_id: keycloakUserId });
});

export const DELETE = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, "admin_ui", "admin");
  const body = await request.json() as Record<string, unknown>;
  const bot = await requireBot(body.bot_id);
  requireMutableMode(bot);
  const keycloakUserId = requireId(body.keycloak_user_id, "keycloak_user_id");
  const deleted = await deleteWebexDirectUserRoute(bot.id, keycloakUserId);
  return successResponse({ deleted, bot_id: bot.id, keycloak_user_id: keycloakUserId });
});

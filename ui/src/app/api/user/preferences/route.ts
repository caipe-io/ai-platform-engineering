/**
 * GET  /api/user/preferences — return the signed-in user's saved
 *                              per-surface default-agent preferences.
 * PUT  /api/user/preferences — upsert (or clear when the field is null) the
 *                              user's saved default-agent for a given surface.
 *                              Accepts Web, Slack, and (per Webex bot) Webex
 *                              defaults.
 *
 * The PUT path enforces that the user has `can_use` on each chosen agent via
 * the BFF PDP (`evaluateAgentAccess`). The bot re-verifies again at dispatch
 * time (spec FR-024).
 *
 * Webex has no single default: a user may be reachable by more than one
 * Webex bot, so its default agent is bot-scoped and lives in
 * `webexDirectUserRoutes` — the same collection the admin "1:1 Messages" tab
 * manages. This route writes the caller's own row there so both surfaces
 * stay in sync on one underlying value. Writing a Webex default is only
 * allowed when the bot's DM access mode is `all_users` and an admin hasn't
 * explicitly denied the caller; in `allowlist` mode only an admin can set it.
 *
 * Authentication: existing `getAuthFromBearerOrSession` middleware. The
 * route does NOT accept impersonation; the signed-in subject is the only
 * principal whose preference can be read or written.
 */

import { NextRequest,NextResponse } from "next/server";

import {
getAuthFromBearerOrSession,
successResponse,
withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { getIntegrationAvailability } from "@/lib/integration-config";
import { getResolvedPlatformDefaultAgentId } from "@/lib/platform-default-agent";
import { getRealmUserByIdOrNull } from "@/lib/rbac/keycloak-admin";
import { firstAttribute, userAttributes } from "@/lib/rbac/keycloak-user-attributes";
import { evaluateAgentAccess } from "@/lib/rbac/pdp-shared";
import {
getUserPreference,
updateUserPreferences,
type UserAgentPreferenceField,
} from "@/lib/rbac/user-preferences-store";
import {
deleteWebexDirectUserRoute,
listWebexDirectUserRoutesForUser,
upsertWebexDirectUserRoute,
} from "@/lib/rbac/webex-direct-user-route-store";
import { listWebexBotPolicies, requireAvailableWebexBotPolicy } from "@/lib/webex-bot-policy";

const OPENFGA_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export const dynamic = "force-dynamic";

function errorResponse(
  status: number,
  body: { error: string; code: string; reason?: string; action?: string },
): NextResponse {
  return NextResponse.json({ success: false, ...body }, { status });
}

function resolveSubject(session: { sub?: unknown }): string | null {
  if (typeof session.sub === "string" && session.sub.trim().length > 0) {
    return session.sub.trim();
  }
  return null;
}

function resolveTenant(session: { org?: unknown }): string {
  if (typeof session.org === "string" && session.org.trim().length > 0) {
    return session.org.trim();
  }
  return "default";
}

interface WebexBotAgentSetting {
  bot_id: string;
  bot_name: string;
  access_mode: "allowlist" | "all_users";
  agent_id: string | null;
  editable: boolean;
  denied: boolean;
}

async function buildWebexBotSettings(subject: string): Promise<WebexBotAgentSetting[]> {
  const [bots, routesByBot] = await Promise.all([
    listWebexBotPolicies(),
    listWebexDirectUserRoutesForUser(subject),
  ]);

  const settings: WebexBotAgentSetting[] = [];
  for (const bot of bots) {
    if (!bot.available || bot.directMessages.accessMode === "disabled") continue;
    const route = routesByBot.get(bot.id);

    if (bot.directMessages.accessMode === "allowlist") {
      // Route presence *is* the access grant in allowlist mode; only an
      // admin can create one, so an allowlisted user always sees the
      // admin-chosen agent, read-only.
      if (route?.status !== "active") continue;
      settings.push({
        bot_id: bot.id,
        bot_name: bot.name,
        access_mode: "allowlist",
        agent_id: route.agent_id,
        editable: false,
        denied: false,
      });
      continue;
    }

    const denied = route?.status === "disabled";
    settings.push({
      bot_id: bot.id,
      bot_name: bot.name,
      access_mode: "all_users",
      agent_id: route?.agent_id ?? bot.directMessages.defaultAgentId ?? null,
      editable: !denied,
      denied,
    });
  }
  return settings;
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  const subject = resolveSubject(session);
  if (!subject) {
    return errorResponse(401, {
      error: "You are not signed in. Please sign in to continue.",
      code: "NOT_SIGNED_IN",
      reason: "not_signed_in",
      action: "sign_in",
    });
  }
  const tenantId = resolveTenant(session);
  const [preference, platformDefaultAgentId, webexBots] = await Promise.all([
    getUserPreference({ tenantId, userId: subject }),
    getResolvedPlatformDefaultAgentId(),
    buildWebexBotSettings(subject),
  ]);
  return successResponse({
    ...preference,
    webex_bots: webexBots,
    platform_default_agent_id: platformDefaultAgentId,
    integrations: getIntegrationAvailability(),
  });
});

interface PutBody {
  web_default_agent_id?: unknown;
  slack_default_agent_id?: unknown;
  webex_default_agent_id?: unknown;
}

const PREFERENCE_FIELDS: readonly UserAgentPreferenceField[] = [
  "web_default_agent_id",
  "slack_default_agent_id",
];

/**
 * Validate one preference field and, when a non-null agent is chosen, confirm
 * it exists and the signed-in user is authorized to use it.
 */
async function validatePreferenceField(
  field: UserAgentPreferenceField,
  raw: unknown,
  ctx: { tenantId: string; subject: string },
): Promise<{ value: string | null; error: NextResponse | null }> {
  if (raw === null) {
    return { value: null, error: null };
  }

  if (typeof raw !== "string" || !OPENFGA_ID_PATTERN.test(raw)) {
    return {
      value: null,
      error: errorResponse(400, {
        error: `${field} must be null or a valid agent id`,
        code: "INVALID_BODY",
        reason: "invalid_body",
        action: "fix_request",
      }),
    };
  }
  const agentId = raw;

  // Verify the agent actually exists before issuing a PDP probe to keep audit
  // logs honest and to give the user a precise 404 rather than a 403.
  const agentsCollection = await getCollection<{ _id: unknown }>("dynamic_agents");
  const existing = await agentsCollection.findOne({
    _id: agentId,
  } as never);
  if (!existing) {
    return {
      value: null,
      error: errorResponse(404, {
        error: "Agent not found",
        code: "AGENT_NOT_FOUND",
        reason: "agent_not_found",
        action: "pick_another",
      }),
    };
  }

  let decision;
  try {
    decision = await evaluateAgentAccess({ subject: ctx.subject, agentId });
  } catch (err) {
    console.error(
      "[user-preferences] PDP error while validating chosen agent",
      err instanceof Error ? err.message : String(err),
    );
    return {
      value: null,
      error: errorResponse(502, {
        error: "Authorization service is temporarily unavailable. Please try again in a moment.",
        code: "PDP_UNAVAILABLE",
        reason: "pdp_unavailable",
        action: "retry",
      }),
    };
  }

  if (!decision.allowed) {
    return {
      value: null,
      error: errorResponse(403, {
        error: "You do not have permission to use the selected agent.",
        code: "FORBIDDEN_AGENT",
        reason: "pdp_denied",
        action: "pick_another",
      }),
    };
  }

  return { value: agentId, error: null };
}

interface WebexPreferenceInput {
  bot_id: string;
  agent_id: string | null;
}

/**
 * Validate and apply a Webex default-agent choice. Unlike the flat surfaces,
 * this writes straight into `webexDirectUserRoutes` (the caller's own row)
 * since that is the same store the admin "1:1 Messages" tab manages — there
 * is only one underlying value, whichever surface last wrote it.
 */
async function validateAndApplyWebexPreference(
  raw: unknown,
  ctx: { subject: string; actorEmail: string },
): Promise<{ value: WebexPreferenceInput | null; error: NextResponse | null }> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      value: null,
      error: errorResponse(400, {
        error: "webex_default_agent_id must be an object with bot_id and agent_id",
        code: "INVALID_BODY",
        reason: "invalid_body",
        action: "fix_request",
      }),
    };
  }
  const input = raw as Record<string, unknown>;
  const botId = typeof input.bot_id === "string" ? input.bot_id.trim() : "";
  if (!botId) {
    return {
      value: null,
      error: errorResponse(400, {
        error: "webex_default_agent_id.bot_id is required",
        code: "INVALID_BODY",
        reason: "invalid_body",
        action: "fix_request",
      }),
    };
  }
  const agentIdInput = input.agent_id;
  if (agentIdInput !== null && (typeof agentIdInput !== "string" || !OPENFGA_ID_PATTERN.test(agentIdInput))) {
    return {
      value: null,
      error: errorResponse(400, {
        error: "webex_default_agent_id.agent_id must be null or a valid agent id",
        code: "INVALID_BODY",
        reason: "invalid_body",
        action: "fix_request",
      }),
    };
  }

  const bot = await requireAvailableWebexBotPolicy(botId);

  if (bot.directMessages.accessMode === "disabled") {
    return {
      value: null,
      error: errorResponse(409, {
        error: `Direct messages are disabled for Webex bot "${bot.name}"`,
        code: "DM_DISABLED",
      }),
    };
  }
  if (bot.directMessages.accessMode === "allowlist") {
    return {
      value: null,
      error: errorResponse(403, {
        error: "Only an admin can set your default agent for this bot",
        code: "ADMIN_MANAGED",
        reason: "pdp_denied",
        action: "contact_admin",
      }),
    };
  }

  const routes = await listWebexDirectUserRoutesForUser(ctx.subject);
  const existingRoute = routes.get(bot.id);
  if (existingRoute?.status === "disabled") {
    return {
      value: null,
      error: errorResponse(403, {
        error: "An admin has disabled direct messages for you on this bot",
        code: "ADMIN_DENIED",
        reason: "pdp_denied",
        action: "contact_admin",
      }),
    };
  }

  if (agentIdInput === null) {
    await deleteWebexDirectUserRoute(bot.id, ctx.subject);
    return { value: { bot_id: bot.id, agent_id: null }, error: null };
  }
  const agentId = agentIdInput as string;

  const agentsCollection = await getCollection<{ _id: unknown }>("dynamic_agents");
  const existingAgent = await agentsCollection.findOne({ _id: agentId } as never);
  if (!existingAgent) {
    return {
      value: null,
      error: errorResponse(404, {
        error: "Agent not found",
        code: "AGENT_NOT_FOUND",
        reason: "agent_not_found",
        action: "pick_another",
      }),
    };
  }

  let decision;
  try {
    decision = await evaluateAgentAccess({ subject: ctx.subject, agentId });
  } catch (err) {
    console.error(
      "[user-preferences] PDP error while validating chosen Webex agent",
      err instanceof Error ? err.message : String(err),
    );
    return {
      value: null,
      error: errorResponse(502, {
        error: "Authorization service is temporarily unavailable. Please try again in a moment.",
        code: "PDP_UNAVAILABLE",
        reason: "pdp_unavailable",
        action: "retry",
      }),
    };
  }
  if (!decision.allowed) {
    return {
      value: null,
      error: errorResponse(403, {
        error: "You do not have permission to use the selected agent.",
        code: "FORBIDDEN_AGENT",
        reason: "pdp_denied",
        action: "pick_another",
      }),
    };
  }

  const realmUser = await getRealmUserByIdOrNull(ctx.subject);
  const webexUserId = realmUser
    ? firstAttribute(userAttributes(realmUser), "webex_user_id")
    : undefined;
  await upsertWebexDirectUserRoute({
    botId: bot.id,
    keycloakUserId: ctx.subject,
    userEmail: ctx.actorEmail,
    webexUserId,
    agentId,
    enabled: true,
    actor: ctx.actorEmail,
  });
  return { value: { bot_id: bot.id, agent_id: agentId }, error: null };
}

export const PUT = withErrorHandler(async (request: NextRequest) => {
  const { user, session } = await getAuthFromBearerOrSession(request);
  const subject = resolveSubject(session);
  if (!subject) {
    return errorResponse(401, {
      error: "You are not signed in. Please sign in to continue.",
      code: "NOT_SIGNED_IN",
      reason: "not_signed_in",
      action: "sign_in",
    });
  }
  const tenantId = resolveTenant(session);

  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return errorResponse(400, {
      error: "Request body must be valid JSON",
      code: "INVALID_BODY",
      reason: "invalid_body",
      action: "fix_request",
    });
  }

  // Only act on fields the caller actually included, so one surface's update
  // never disturbs another surface's default.
  const providedFlat = PREFERENCE_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(body, field),
  );
  const hasWebex = Object.prototype.hasOwnProperty.call(body, "webex_default_agent_id");
  if (providedFlat.length === 0 && !hasWebex) {
    return errorResponse(400, {
      error: "Provide a supported default-agent preference field",
      code: "INVALID_BODY",
      reason: "invalid_body",
      action: "fix_request",
    });
  }

  const flatUpdates: Partial<Record<UserAgentPreferenceField,string | null>> = {};
  for (const field of providedFlat) {
    const validation = await validatePreferenceField(
      field,
      (body as Record<string, unknown>)[field],
      { tenantId, subject },
    );
    if (validation.error) return validation.error;
    flatUpdates[field] = validation.value;
  }

  let webexResult: WebexPreferenceInput | null = null;
  if (hasWebex) {
    const webexValidation = await validateAndApplyWebexPreference(body.webex_default_agent_id, {
      subject,
      actorEmail: user.email,
    });
    if (webexValidation.error) return webexValidation.error;
    webexResult = webexValidation.value;
  }

  if (Object.keys(flatUpdates).length > 0) {
    await updateUserPreferences({
      tenantId,
      userId: subject,
      preferences: flatUpdates,
    });
  }

  const result: Record<string, unknown> = { ...flatUpdates };
  if (hasWebex) {
    result.webex_default_agent_id = webexResult;
  }
  return successResponse(result);
});

import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import {
  canManagePublicationSettings,
  publicationActorFromSession,
} from "@/lib/publication-approval.server";
import {
  getPublicationApprovalSettings,
  savePublicationApprovalSettings,
} from "@/lib/publication-approval-settings";
import { getIntegrationAvailability } from "@/lib/integration-config";
import { resolveUserIdentitiesBySubject } from "@/lib/rbac/user-identity-directory";
import { callSlackBotAdmin } from "@/lib/slack-bot-admin";
import { callWebexBotAdmin } from "@/lib/webex-bot-admin";

interface PublicationIntegrationStatus {
  slack: boolean;
  webex: boolean;
}

async function getActiveIntegrations(): Promise<PublicationIntegrationStatus> {
  const configured = getIntegrationAvailability();
  const [slack, webex] = await Promise.all([
    configured.slack
      ? callSlackBotAdmin("/admin/slack/routes/status", {
          signal: AbortSignal.timeout(3_000),
        }).then(
          () => true,
          () => false,
        )
      : Promise.resolve(false),
    configured.webex
      ? callWebexBotAdmin("/admin/webex/routes/status", {
          signal: AbortSignal.timeout(3_000),
        }).then(
          () => true,
          () => false,
        )
      : Promise.resolve(false),
  ]);
  return { slack, webex };
}

async function requireSettingsManager(request: NextRequest) {
  const { session } = await getAuthFromBearerOrSession(request);
  const actor = publicationActorFromSession(session);
  if (!(await canManagePublicationSettings(actor))) {
    throw new ApiError(
      "Only organization administrators can change publication approval settings",
      403,
      "SETTINGS_FORBIDDEN",
    );
  }
  return actor;
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  await requireSettingsManager(request);
  const [settings, integrations] = await Promise.all([
    getPublicationApprovalSettings(),
    getActiveIntegrations(),
  ]);
  const userSubjects = Array.from(new Set([
    ...settings.rag_reviewer_user_subjects,
    ...settings.slack_reviewer_user_subjects,
    ...settings.webex_reviewer_user_subjects,
    ...Object.values(settings.rag_reviewer_user_delegations).flat(),
    ...settings.trusted_publisher_subjects,
  ]));
  const identities = await resolveUserIdentitiesBySubject(userSubjects);
  return successResponse({
    settings,
    integrations,
    users: [...identities.values()].map((identity) => ({
      kind: "user" as const,
      id: identity.subject,
      name: identity.name ?? identity.email ?? "Unknown user",
      email: identity.email,
    })),
  });
});

export const PATCH = withErrorHandler(async (request: NextRequest) => {
  const actor = await requireSettingsManager(request);
  const body = await request.json().catch(() => {
    throw new ApiError("Invalid JSON body", 400, "INVALID_JSON");
  });
  const [current, integrations] = await Promise.all([
    getPublicationApprovalSettings(),
    getActiveIntegrations(),
  ]);
  const update = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (
    update.require_slack_onboarding_approval === true &&
    !current.require_slack_onboarding_approval &&
    !integrations.slack
  ) {
    throw new ApiError(
      "The Slack integration must be active before Slack onboarding review can be enabled",
      400,
      "SLACK_INTEGRATION_INACTIVE",
    );
  }
  if (
    update.require_webex_onboarding_approval === true &&
    !current.require_webex_onboarding_approval &&
    !integrations.webex
  ) {
    throw new ApiError(
      "The Webex integration must be active before Webex onboarding review can be enabled",
      400,
      "WEBEX_INTEGRATION_INACTIVE",
    );
  }
  const settings = await savePublicationApprovalSettings(body, actor);
  return successResponse({ settings });
});

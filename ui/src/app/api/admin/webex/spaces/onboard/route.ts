import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import {
  createPublicationRequest,
  listPublicationActorTeamSlugs,
  planConnectorPublication,
  publicationActorFromSession,
  publicationResourceRevision,
  recordAutoApprovedPublication,
  replacePendingConnectorPublicationRequest,
} from "@/lib/publication-approval.server";
import { getPublicationApprovalSettings } from "@/lib/publication-approval-settings";
import { requireAdminSurfaceManage } from "@/lib/rbac/require-openfga";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import {
  webexSpaceSubjectId,
  webexWorkspaceRef,
} from "@/lib/rbac/webex-space-grant-store";
import {
  canonicalizeWebexSpaceId,
  onboardWebexSpace,
} from "@/lib/rbac/webex-space-onboarding";
import { callWebexBotAdmin } from "@/lib/webex-bot-admin";
import type { WebexRouteListenMode } from "@/types/webex-rebac";

const ALLOWED_FIELDS = new Set([
  "workspace_id",
  "bot_id",
  "space_id",
  "space_name",
  "team_slug",
  "agent_id",
  "listen",
  "create_route",
  "dry_run",
  "reload_runtime",
]);

interface InspectedWebexSpace {
  bot_id: string;
  space_id: string;
  space_name: string;
  member_count: number;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRequiredString(value: unknown, field: string): string {
  const trimmed = readOptionalString(value);
  if (!trimmed) {
    throw new ApiError(`${field} is required`, 400);
  }
  return trimmed;
}

function parseOnboardBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("Request body must be an object", 400);
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new ApiError(`Unexpected field "${key}"`, 400);
    }
  }
  return {
    bot_id: readRequiredString(input.bot_id, "bot_id"),
    workspace_id: readOptionalString(input.workspace_id),
    space_id: readRequiredString(input.space_id, "space_id"),
    space_name: readOptionalString(input.space_name),
    team_slug: readRequiredString(input.team_slug, "team_slug"),
    agent_id: readRequiredString(input.agent_id, "agent_id"),
    listen: readOptionalString(input.listen) as WebexRouteListenMode | undefined,
    create_route: input.create_route === undefined ? undefined : Boolean(input.create_route),
    dry_run: Boolean(input.dry_run),
    reload_runtime: input.reload_runtime === undefined ? undefined : Boolean(input.reload_runtime),
    actor: "api",
  };
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  const parsed = parseOnboardBody(await request.json());
  const actor = publicationActorFromSession(session);
  const onboardingInput = {
    ...parsed,
    actor: actor.email ?? actor.subject,
  };
  const canManageSurface = await requireAdminSurfaceManage(session, "webex").then(
    () => true,
    () => false,
  );
  if (!canManageSurface) {
    await Promise.all([
      requireResourcePermission(session, {
        type: "team",
        id: parsed.team_slug,
        action: "use",
      }),
      requireResourcePermission(session, {
        type: "agent",
        id: parsed.agent_id,
        action: "use",
      }),
    ]);
  }
  const provider = await callWebexBotAdmin<InspectedWebexSpace>(
    "/admin/webex/spaces/inspect",
    {
      method: "POST",
      body: { bot_id: parsed.bot_id, space_id: parsed.space_id },
    },
  );
  const canonicalSpaceId = canonicalizeWebexSpaceId(parsed.space_id);
  if (
    provider.bot_id !== parsed.bot_id ||
    provider.space_id !== canonicalSpaceId ||
    !provider.space_name?.trim() ||
    !Number.isFinite(provider.member_count) ||
    provider.member_count < 0
  ) {
    throw new ApiError(
      "Webex returned inconsistent space metadata",
      502,
      "WEBEX_SPACE_METADATA_INVALID",
    );
  }
  const [settings, requesterTeamSlugs] = await Promise.all([
    getPublicationApprovalSettings(),
    listPublicationActorTeamSlugs(actor),
  ]);
  const workspaceId = webexWorkspaceRef(parsed.workspace_id);
  const verifiedOnboardingInput = {
    ...onboardingInput,
    workspace_id: workspaceId,
    space_id: canonicalSpaceId,
    space_name: provider.space_name.trim(),
  };
  if (parsed.dry_run) {
    return successResponse(await onboardWebexSpace(verifiedOnboardingInput));
  }
  const requestedState = {
    ...verifiedOnboardingInput,
  } as unknown as Record<string, unknown>;
  const plan = planConnectorPublication({
    settings,
    requester: actor,
    requesterTeamSlugs,
    resourceKind: "webex_space",
    requestedState,
    targetTeamSlug: parsed.team_slug,
    memberCount: provider.member_count,
  });
  const resource = {
    kind: "webex_space" as const,
    id: webexSpaceSubjectId(workspaceId, canonicalSpaceId),
    label: `Webex: ${provider.space_name.trim()}`,
  };
  const revision = publicationResourceRevision({
    status: "not_onboarded",
    requested_state: requestedState,
  });
  await replacePendingConnectorPublicationRequest(
    resource,
    actor,
    "A newer Webex onboarding request replaced this proposal.",
  );
  if (plan.requires_approval) {
    const publicationRequest = await createPublicationRequest({
      resource,
      resourceRevision: revision,
      requestedState,
      effectiveState: {},
      riskFacts: plan.risk_facts,
      requester: actor,
      requesterTeamSlugs,
      approverTeamSlugs: plan.approver_team_slugs,
      approverUserSubjects: plan.approver_user_subjects,
    });
    return successResponse(
      {
        pending_approval: true,
        publication_request: {
          id: publicationRequest._id,
          status: publicationRequest.status,
          reason: plan.reason,
          resource,
          approver_team_slugs: publicationRequest.approver_team_slugs,
          approver_user_subjects: publicationRequest.approver_user_subjects ?? [],
        },
      },
      202,
    );
  }

  const result = await onboardWebexSpace(verifiedOnboardingInput);
  await recordAutoApprovedPublication({
    resource,
    resourceRevision: revision,
    requestedState,
    effectiveState: requestedState,
    riskFacts: plan.risk_facts,
    requester: actor,
    requesterTeamSlugs,
    approverTeamSlugs: plan.approver_team_slugs,
    approverUserSubjects: plan.approver_user_subjects,
  });
  return successResponse(result);
});

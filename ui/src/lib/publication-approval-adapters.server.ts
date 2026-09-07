import { ApiError } from "@/lib/api-error";
import { getCollection } from "@/lib/mongodb";
import { publicationResourceRevision } from "@/lib/publication-approval.server";
import { applyRagCollectionPublicationRequest } from "@/lib/rag-collection-publication-approval.server";
import { applyRagPublicationRequest } from "@/lib/rag-publication-approval.server";
import { getRbacCollection } from "@/lib/rbac/mongo-collections";
import { slackWorkspaceRef } from "@/lib/rbac/slack-channel-grant-store";
import {
  onboardWebexSpace,
  type WebexSpaceOnboardingInput,
} from "@/lib/rbac/webex-space-onboarding";
import type { PublicationRequestDocument } from "@/types/publication-approval";
import { callSlackBotAdmin } from "@/lib/slack-bot-admin";
import { callWebexBotAdmin } from "@/lib/webex-bot-admin";

interface AdapterSession {
  accessToken?: string;
  sub?: unknown;
  role?: string;
  user?: { email?: string | null; name?: string | null } | null;
}

interface SlackMapping {
  slack_workspace_id?: string;
  slack_channel_id?: string;
  team_slug?: string;
  updated_by?: string;
  active?: boolean;
}

interface WebexMapping {
  bot_id?: string;
  webex_workspace_id?: string;
  webex_space_id?: string;
  team_slug?: string;
  updated_by?: string;
  active?: boolean;
}

interface InspectedSlackChannel {
  workspace_id: string;
  channel_id: string;
  channel_name: string;
  member_count?: number;
}

interface InspectedWebexSpace {
  bot_id: string;
  space_id: string;
  space_name: string;
  member_count: number;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(`Approved state is missing ${field}`, 409, "INVALID_APPROVAL_STATE");
  }
  return value.trim();
}

function publicationApplyActor(request: PublicationRequestDocument): string {
  return `publication:${request._id}`;
}

async function assertConnectorRevision(
  request: PublicationRequestDocument,
  existing: { updated_by?: string; team_slug?: string } | null,
): Promise<void> {
  const currentRevision = publicationResourceRevision({
    status: existing ? "onboarded" : "not_onboarded",
    requested_state: request.requested_state,
  });
  const targetTeam = requiredString(request.requested_state.team_slug, "team_slug");
  const isOwnPriorApply =
    existing?.updated_by === publicationApplyActor(request) &&
    existing.team_slug === targetTeam;
  if ((!isOwnPriorApply && existing) || (!existing && currentRevision !== request.resource_revision)) {
    throw new ApiError(
      "This channel or space changed after approval was requested.",
      409,
      "PUBLICATION_REVISION_CONFLICT",
    );
  }
}

async function applySlackPublication(request: PublicationRequestDocument): Promise<void> {
  const defaults = request.requested_state.channel_defaults;
  if (!Array.isArray(defaults) || defaults.length !== 1) {
    throw new ApiError("Slack approval must contain exactly one channel", 409);
  }
  const channel = defaults[0];
  if (!channel || typeof channel !== "object" || Array.isArray(channel)) {
    throw new ApiError("Slack approval channel state is invalid", 409);
  }
  const record = channel as Record<string, unknown>;
  const workspaceId = requiredString(record.workspace_id, "workspace_id");
  const channelId = requiredString(record.channel_id, "channel_id");
  const provider = await callSlackBotAdmin<InspectedSlackChannel>(
    "/admin/slack/channels/inspect",
    { method: "POST", body: { channel_id: channelId } },
  );
  const expectedMemberCount = request.risk_facts.member_count;
  const providerMemberCount = provider.member_count;
  const membershipRiskChanged =
    typeof expectedMemberCount === "number"
      ? typeof providerMemberCount !== "number" ||
        providerMemberCount > expectedMemberCount
      : typeof providerMemberCount === "number";
  if (
    provider.channel_id !== channelId ||
    slackWorkspaceRef(provider.workspace_id) !== workspaceId ||
    membershipRiskChanged
  ) {
    throw new ApiError(
      "Slack channel membership or audience changed after approval was requested.",
      409,
      "PUBLICATION_REVISION_CONFLICT",
    );
  }
  const mappings = await getCollection<SlackMapping>("channel_team_mappings");
  const existing = await mappings.findOne({
    slack_workspace_id: workspaceId,
    slack_channel_id: channelId,
    active: { $ne: false },
  } as never);
  await assertConnectorRevision(request, existing);
  // Importing the route-owned implementation here keeps the existing,
  // transactional onboarding path as the single writer while it is moved to
  // a standalone connector module in a follow-up cleanup.
  const { applySlackChannelOnboarding } = await import(
    "@/app/api/admin/slack/channels/defaults/route"
  );
  await applySlackChannelOnboarding(
    {
      ...request.requested_state,
      channel_defaults: [{
        ...record,
        channel_name: provider.channel_name,
        ...(typeof provider.member_count === "number"
          ? { member_count: provider.member_count }
          : {}),
      }],
    },
    publicationApplyActor(request),
  );
}

async function applyWebexPublication(request: PublicationRequestDocument): Promise<void> {
  const state = request.requested_state;
  const botId = requiredString(state.bot_id, "bot_id");
  const workspaceId = requiredString(state.workspace_id, "workspace_id");
  const spaceId = requiredString(state.space_id, "space_id");
  const provider = await callWebexBotAdmin<InspectedWebexSpace>(
    "/admin/webex/spaces/inspect",
    { method: "POST", body: { bot_id: botId, space_id: spaceId } },
  );
  const expectedMemberCount = request.risk_facts.member_count;
  const membershipRiskChanged =
    typeof expectedMemberCount === "number"
      ? provider.member_count > expectedMemberCount
      : typeof provider.member_count === "number";
  if (
    provider.bot_id !== botId ||
    provider.space_id !== spaceId ||
    membershipRiskChanged
  ) {
    throw new ApiError(
      "Webex space membership or audience changed after approval was requested.",
      409,
      "PUBLICATION_REVISION_CONFLICT",
    );
  }
  const mappings = await getRbacCollection<WebexMapping>("webexSpaceTeamMappings");
  const existing = await mappings.findOne({
    bot_id: botId,
    webex_workspace_id: workspaceId,
    webex_space_id: spaceId,
    active: { $ne: false },
  } as never);
  await assertConnectorRevision(request, existing);
  await onboardWebexSpace({
    ...(state as unknown as WebexSpaceOnboardingInput),
    space_name: provider.space_name,
    actor: publicationApplyActor(request),
  });
}

/** Apply the domain-specific requested state after the generic store acquires it. */
export async function applyPublicationRequestAdapter(
  request: PublicationRequestDocument,
  session: AdapterSession,
): Promise<void> {
  switch (request.resource.kind) {
    case "rag_datasource":
      await applyRagPublicationRequest(request, session.accessToken);
      return;
    case "slack_channel":
      await applySlackPublication(request);
      return;
    case "webex_space":
      await applyWebexPublication(request);
      return;
    case "rag_collection":
      await applyRagCollectionPublicationRequest(request, session);
      return;
  }
}

import { ApiError, PublicationDriftError, withDrift } from "@/lib/api-error";
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
import type {
  PublicationDriftItem,
  PublicationRequestDocument,
} from "@/types/publication-approval";
import { callSlackBotAdmin } from "@/lib/slack-bot-admin";
import { callWebexBotAdmin } from "@/lib/webex-bot-admin";

interface AdapterApplyOptions {
  acknowledgedFingerprint?: string;
}

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
  contextDrift: PublicationDriftItem[],
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
    throw withDrift(
      new ApiError(
        "This channel or space changed after approval was requested.",
        409,
        "PUBLICATION_REVISION_CONFLICT",
      ),
      contextDrift,
    );
  }
}

function memberCountDrift(
  expected: number | undefined,
  live: number | undefined,
): PublicationDriftItem | null {
  const risky =
    typeof expected === "number"
      ? typeof live !== "number" || live > expected
      : typeof live === "number";
  if (!risky) return null;
  return {
    field: "member_count",
    label: "Members",
    before: typeof expected === "number" ? expected : null,
    after: typeof live === "number" ? live : null,
    overridable: true,
  };
}

function nameDrift(field: string, label: string, before: string, after: string): PublicationDriftItem | null {
  if (before === after) return null;
  return { field, label, before, after, overridable: true };
}

async function applySlackPublication(
  request: PublicationRequestDocument,
  { acknowledgedFingerprint }: AdapterApplyOptions,
): Promise<PublicationDriftItem[]> {
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
  if (provider.channel_id !== channelId || slackWorkspaceRef(provider.workspace_id) !== workspaceId) {
    throw withDrift(
      new ApiError(
        "Slack channel membership or audience changed after approval was requested.",
        409,
        "PUBLICATION_REVISION_CONFLICT",
      ),
      [],
    );
  }
  const membersDrift = memberCountDrift(request.risk_facts.member_count, provider.member_count);
  let appliedDrift: PublicationDriftItem[] = [];
  if (membersDrift) {
    const drift = [
      membersDrift,
      ...(typeof record.channel_name === "string"
        ? [nameDrift("channel_name", "Channel name", record.channel_name, provider.channel_name)].filter(
            (item): item is PublicationDriftItem => item !== null,
          )
        : []),
    ];
    const fingerprint = publicationResourceRevision(drift);
    if (acknowledgedFingerprint !== fingerprint) {
      throw new PublicationDriftError(
        "Slack channel membership or audience changed after approval was requested.",
        drift,
        fingerprint,
      );
    }
    appliedDrift = drift;
  }
  const mappings = await getCollection<SlackMapping>("channel_team_mappings");
  const existing = await mappings.findOne({
    slack_workspace_id: workspaceId,
    slack_channel_id: channelId,
    active: { $ne: false },
  } as never);
  await assertConnectorRevision(request, existing, membersDrift ? [membersDrift] : []);
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
  return appliedDrift;
}

async function applyWebexPublication(
  request: PublicationRequestDocument,
  { acknowledgedFingerprint }: AdapterApplyOptions,
): Promise<PublicationDriftItem[]> {
  const state = request.requested_state;
  const botId = requiredString(state.bot_id, "bot_id");
  const workspaceId = requiredString(state.workspace_id, "workspace_id");
  const spaceId = requiredString(state.space_id, "space_id");
  const provider = await callWebexBotAdmin<InspectedWebexSpace>(
    "/admin/webex/spaces/inspect",
    { method: "POST", body: { bot_id: botId, space_id: spaceId } },
  );
  if (provider.bot_id !== botId || provider.space_id !== spaceId) {
    throw withDrift(
      new ApiError(
        "Webex space membership or audience changed after approval was requested.",
        409,
        "PUBLICATION_REVISION_CONFLICT",
      ),
      [],
    );
  }
  const membersDrift = memberCountDrift(request.risk_facts.member_count, provider.member_count);
  let appliedDrift: PublicationDriftItem[] = [];
  if (membersDrift) {
    const drift = [
      membersDrift,
      ...(typeof state.space_name === "string"
        ? [nameDrift("space_name", "Space name", state.space_name, provider.space_name)].filter(
            (item): item is PublicationDriftItem => item !== null,
          )
        : []),
    ];
    const fingerprint = publicationResourceRevision(drift);
    if (acknowledgedFingerprint !== fingerprint) {
      throw new PublicationDriftError(
        "Webex space membership or audience changed after approval was requested.",
        drift,
        fingerprint,
      );
    }
    appliedDrift = drift;
  }
  const mappings = await getRbacCollection<WebexMapping>("webexSpaceTeamMappings");
  const existing = await mappings.findOne({
    bot_id: botId,
    webex_workspace_id: workspaceId,
    webex_space_id: spaceId,
    active: { $ne: false },
  } as never);
  await assertConnectorRevision(request, existing, membersDrift ? [membersDrift] : []);
  await onboardWebexSpace({
    ...(state as unknown as WebexSpaceOnboardingInput),
    space_name: provider.space_name,
    actor: publicationApplyActor(request),
  });
  return appliedDrift;
}

/** Apply the domain-specific requested state after the generic store acquires it. */
export async function applyPublicationRequestAdapter(
  request: PublicationRequestDocument,
  session: AdapterSession,
  options: AdapterApplyOptions = {},
): Promise<PublicationDriftItem[]> {
  switch (request.resource.kind) {
    case "rag_datasource":
      return applyRagPublicationRequest(request, session.accessToken, options);
    case "slack_channel":
      return applySlackPublication(request, options);
    case "webex_space":
      return applyWebexPublication(request, options);
    case "rag_collection":
      return applyRagCollectionPublicationRequest(request, session, options);
  }
}

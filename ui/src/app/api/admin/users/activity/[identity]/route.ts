// GET /api/admin/users/activity/[identity] - Get a user's Mongo-backed activity

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import { getDirectSharingAccessConversationIds } from "@/lib/rbac/conversation-implicit-authz";
import { hasOrganizationAdmin } from "@/lib/rbac/platform-admin";
import {
  requireAdminSurfaceManage,
  requireBaselineAdminSurfaceRead,
} from "@/lib/rbac/require-openfga";
import { loadTeamMembersForSlugs } from "@/lib/rbac/team-membership-store";
import {
  getInsightsActorTeamSlugs,
  getOwnedAgentConversationIds,
  getOwnedAgents,
  getReadableConversationIds,
  getReadableMessagingConversationScope,
  type OwnedAgent,
} from "@/lib/rbac/user-insights-scope";
import type { User } from "@/types/mongodb";
import type { Document,Filter } from "mongodb";
import { type NextRequest,NextResponse } from "next/server";

interface ActivityUser extends User {
  slack_user_id?: string;
  source?: string;
}

interface ActivityConversation extends Document {
  _id?: unknown;
  channel_id?: string;
  channel_name?: string;
  channel_type?: string;
  client_type?: string;
  created_at?: Date | string;
  idempotency_key?: string;
  metadata?: {
    channel_id?: string;
    channel_name?: string;
    channel_type?: string;
    owner_display_name?: string;
    slack_link?: string;
    slack_permalink?: string;
    thread_ts?: string;
    webex_message_id?: string;
    webex_room_id?: string;
    webex_space_id?: string;
    workspace_url?: string;
  };
  slack_meta?: {
    channel_id?: string;
    channel_name?: string;
    thread_ts?: string;
    workspace_url?: string;
  };
  source?: string;
  title?: string;
  updated_at?: Date | string;
}

interface ActivityFeedback extends Document {
  channel_id?: string;
  channel_name?: string;
  comment?: string;
  conversation_id?: string;
  created_at?: Date | string;
  rating?: string;
  slack_permalink?: string;
  source?: string;
  value?: string;
}

function dateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : "";
}

function conversationSource(conversation: ActivityConversation): string {
  if (conversation.source === "slack" || conversation.client_type === "slack") {
    return "slack";
  }
  if (conversation.source === "webex" || conversation.client_type === "webex") {
    return "webex";
  }
  return "web";
}

function safeHttpsUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function slackConversationPermalink(
  conversation: ActivityConversation,
  channelId: string | null,
): string | null {
  if (conversationSource(conversation) !== "slack") return null;

  const persistedLink =
    conversation.metadata?.slack_permalink ??
    conversation.metadata?.slack_link;
  const safePersistedLink = safeHttpsUrl(persistedLink);
  if (safePersistedLink) return safePersistedLink.toString();

  const threadTs =
    conversation.metadata?.thread_ts ??
    conversation.slack_meta?.thread_ts ??
    conversation.idempotency_key;
  if (!threadTs || !channelId) return null;

  const workspaceUrl =
    conversation.metadata?.workspace_url ??
    conversation.slack_meta?.workspace_url;
  const safeWorkspaceUrl = safeHttpsUrl(workspaceUrl);
  if (safeWorkspaceUrl) {
    safeWorkspaceUrl.pathname =
      `/archives/${encodeURIComponent(channelId)}/p${encodeURIComponent(threadTs.replaceAll(".", ""))}`;
    safeWorkspaceUrl.search = "";
    safeWorkspaceUrl.hash = "";
    return safeWorkspaceUrl.toString();
  }

  const params = new URLSearchParams({
    channel: channelId,
    message_ts: threadTs,
  });
  return `https://slack.com/app_redirect?${params.toString()}`;
}

function webexConversationLink(
  conversation: ActivityConversation,
): string | null {
  if (conversationSource(conversation) !== "webex") return null;
  const spaceId = conversation.metadata?.webex_space_id;
  if (!spaceId) return null;
  const params = new URLSearchParams({ space: spaceId });
  return `webexteams://im?${params.toString()}`;
}

function identityMatchesTeamMember(
  member: { user_email?: string; user_subject?: string },
  targetEmails: Set<string>,
  targetSubjects: Set<string>,
): boolean {
  const memberEmail = member.user_email?.trim().toLowerCase();
  const memberSubject = member.user_subject?.trim();
  return Boolean(
    (memberEmail && targetEmails.has(memberEmail)) ||
    (memberSubject && targetSubjects.has(memberSubject)),
  );
}

function scopedConversationClauses(
  readableConversationClauses: Document[],
  ownerEmail: string,
  ownedAgents: OwnedAgent[],
): Document[] {
  const clauses: Document[] = [...readableConversationClauses];
  if (ownerEmail) clauses.push({ owner_id: ownerEmail });

  const agentIds = ownedAgents.map((agent) => agent.id);
  if (agentIds.length > 0) {
    clauses.push({
      $or: [
        { "metadata.thread_owner_agent_id": { $in: agentIds } },
        { participants: { $elemMatch: { type: "agent", id: { $in: agentIds } } } },
        { agent_id: { $in: agentIds } },
      ],
    });
  }
  return clauses;
}

/**
 * Conversation titles and deep links are more sensitive than aggregate
 * Insights counts. External messaging conversations are visible only through
 * mapped resources the actor can read. Slack DMs have no valid mapped channel
 * and are also rejected through their explicit `channel_type`.
 */
function readableSlackConversationClause(channelIds: string[]): Document | null {
  if (channelIds.length === 0) return null;
  const ids = channelIds.length === 1 ? channelIds[0] : { $in: channelIds };
  return {
    $and: [
      { $or: [{ source: "slack" }, { client_type: "slack" }] },
      { channel_type: { $ne: "dm" } },
      { "metadata.channel_type": { $ne: "dm" } },
      {
        $or: [
          { channel_id: ids },
          { "metadata.channel_id": ids },
          { "slack_meta.channel_id": ids },
        ],
      },
    ],
  };
}

function readableWebexConversationClause(spaceIds: string[]): Document | null {
  if (spaceIds.length === 0) return null;
  return {
    $and: [
      { $or: [{ source: "webex" }, { client_type: "webex" }] },
      {
        "metadata.webex_space_id":
          spaceIds.length === 1 ? spaceIds[0] : { $in: spaceIds },
      },
    ],
  };
}

function readableWebConversationClause(
  ownerEmail: string,
  ownerSubject: string,
  explicitConversationIds: string[],
): Document | null {
  const accessClauses: Document[] = [];
  const normalizedEmail = ownerEmail.trim().toLowerCase();
  if (normalizedEmail) {
    const emails = ownerEmail === normalizedEmail
      ? normalizedEmail
      : { $in: [ownerEmail, normalizedEmail] };
    accessClauses.push(
      { owner_id: emails },
      { "sharing.shared_with": emails },
    );
  }
  if (ownerSubject) accessClauses.push({ owner_subject: ownerSubject });
  if (explicitConversationIds.length > 0) {
    accessClauses.push({ _id: { $in: explicitConversationIds } });
  }
  if (accessClauses.length === 0) return null;

  return {
    $and: [
      { client_type: { $nin: ["slack", "webex"] } },
      { source: { $nin: ["slack", "webex"] } },
      { $or: accessClauses },
    ],
  };
}

function scopedMessageClauses(
  channelIds: string[],
  ownerEmail: string,
  ownedAgents: OwnedAgent[],
): Document[] {
  const clauses: Document[] = [];
  if (channelIds.length > 0) {
    clauses.push({
      "metadata.source": "slack",
      "metadata.channel_id":
        channelIds.length === 1 ? channelIds[0] : { $in: channelIds },
    });
  }
  if (ownerEmail) clauses.push({ owner_id: ownerEmail });

  const agentIds = ownedAgents.map((agent) => agent.id);
  const agentNames = ownedAgents.map((agent) => agent.name);
  if (agentIds.length > 0) {
    clauses.push({
      $or: [
        { "metadata.agent_id": { $in: agentIds } },
        { "metadata.agent_name": { $in: agentNames } },
      ],
    });
  }
  return clauses;
}

export const GET = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ identity: string }> }
  ) => {
    if (!isMongoDBConfigured) {
      return NextResponse.json(
        {
          success: false,
          error: "MongoDB not configured - admin features require MongoDB",
          code: "MONGODB_NOT_CONFIGURED",
        },
        { status: 503 }
      );
    }

    const { session } = await getAuthFromBearerOrSession(request);
    const [canManageAllInsights,canAuditOrganization] = await Promise.all([
      requireAdminSurfaceManage(session, "stats").then(
        () => true,
        () => false,
      ),
      hasOrganizationAdmin(session),
    ]);
    const isFullInsightsScope = canManageAllInsights || canAuditOrganization;

    // Direct calls from a baseline member still need the same read grant that
    // exposes Admin → Insights. A stats manager/org admin already passed the
    // stronger check above.
    if (!isFullInsightsScope) {
      await requireBaselineAdminSurfaceRead(session, "stats");
    }

    const { identity: rawIdentity } = await context.params;
    const identity = rawIdentity.trim();
    if (!identity) {
      throw new ApiError("User identity is required", 400, "INVALID_USER_IDENTITY");
    }

    const normalizedIdentity = identity.includes("@")
      ? identity.toLowerCase()
      : identity;

    const openfgaUser = typeof session.sub === "string" && session.sub.trim()
      ? `user:${session.sub.trim()}`
      : "";
    const actorOwnerEmail = typeof session.user?.email === "string"
      ? session.user.email.trim()
      : "";
    if (!isFullInsightsScope && !openfgaUser && !actorOwnerEmail) {
      throw new ApiError("Unauthorized", 401, "UNAUTHORIZED");
    }

    const actorSubject = openfgaUser.startsWith("user:")
      ? openfgaUser.slice("user:".length)
      : "";
    const scopedOwnerEmail = isFullInsightsScope ? "" : actorOwnerEmail;
    let scopedOwnedAgentConversationIds: string[] = [];
    const [
      messagingConversationScope,
      openFgaReadableConversationIds,
      directShareConversationIds,
      scopedOwnedAgents,
      scopedTeamSlugs,
    ] = await Promise.all([
      !canAuditOrganization && openfgaUser
        ? getReadableMessagingConversationScope(openfgaUser)
        : Promise.resolve({
            slackChannelIds: [],
            webexSpaceIds: [],
          }),
      !canAuditOrganization && openfgaUser
        ? getReadableConversationIds(openfgaUser)
        : Promise.resolve([]),
      !canAuditOrganization && actorOwnerEmail
        ? getDirectSharingAccessConversationIds(
            actorOwnerEmail,
            getCollection,
          )
        : Promise.resolve([]),
      !isFullInsightsScope && openfgaUser
        ? getOwnedAgents(openfgaUser)
        : Promise.resolve([]),
      !isFullInsightsScope && openfgaUser
        ? getInsightsActorTeamSlugs(openfgaUser)
        : Promise.resolve([]),
    ]);
    const readableWebConversationIds = [
      ...new Set([
        ...openFgaReadableConversationIds,
        ...directShareConversationIds,
      ]),
    ];
    const scopedChannelIds = messagingConversationScope.slackChannelIds;
    const scopedWebexSpaceIds = messagingConversationScope.webexSpaceIds;
    if (scopedOwnedAgents.length > 0) {
      scopedOwnedAgentConversationIds = (
        await getOwnedAgentConversationIds(scopedOwnedAgents)
      ).ids;
    }

    const users = await getCollection<ActivityUser>("users");
    const conversations = await getCollection<ActivityConversation>("conversations");
    const feedback = await getCollection<ActivityFeedback>("feedback");
    const messages = await getCollection<Document>("messages");

    const userLookup: Filter<ActivityUser> = {
      $or: [
        { email: identity },
        { email: normalizedIdentity },
        { slack_user_id: identity },
      ],
    };
    const user = await users.findOne(userLookup);

    // A linked person can own web activity by email and Slack activity by the
    // linked Slack id. Query every known identifier so the drawer is complete.
    const ownerIds = new Set<string>();
    const addOwnerId = (value: unknown) => {
      if (typeof value !== "string" || !value.trim()) return;
      const trimmed = value.trim();
      ownerIds.add(trimmed);
      if (trimmed.includes("@")) ownerIds.add(trimmed.toLowerCase());
    };
    addOwnerId(identity);
    addOwnerId(user?.email);
    addOwnerId(user?.slack_user_id);
    const identities = [...ownerIds];
    const targetConversationFilter: Document = {
      owner_id: identities.length === 1 ? identities[0] : { $in: identities },
    };
    const targetFeedbackFilter: Document = {
      $or: [
        { user_email: { $in: identities } },
        { user_id: { $in: identities } },
      ],
    };
    const readableConversationClauses: Document[] = [];
    const readableSlackScope =
      readableSlackConversationClause(scopedChannelIds);
    const readableWebexScope =
      readableWebexConversationClause(scopedWebexSpaceIds);
    const readableWebScope = readableWebConversationClause(
      actorOwnerEmail,
      actorSubject,
      readableWebConversationIds,
    );
    if (readableSlackScope) readableConversationClauses.push(readableSlackScope);
    if (readableWebexScope) readableConversationClauses.push(readableWebexScope);
    if (readableWebScope) readableConversationClauses.push(readableWebScope);

    const conversationScope = scopedConversationClauses(
      readableConversationClauses,
      scopedOwnerEmail,
      scopedOwnedAgents,
    );
    const activityConversationFilter: Document = isFullInsightsScope
      ? targetConversationFilter
      : {
          $and: [
            targetConversationFilter,
            conversationScope.length > 0
              ? { $or: conversationScope }
              : { _id: null },
          ],
        };
    const visibleConversationFilter: Document = canAuditOrganization
      ? targetConversationFilter
      : {
          $and: [
            targetConversationFilter,
            readableConversationClauses.length > 0
              ? { $or: readableConversationClauses }
              : { _id: null },
          ],
        };
    const canViewConversations =
      canAuditOrganization || readableConversationClauses.length > 0;

    const feedbackScope: Document[] = [];
    if (scopedChannelIds.length > 0) {
      feedbackScope.push({
        source: "slack",
        channel_id:
          scopedChannelIds.length === 1
            ? scopedChannelIds[0]
            : { $in: scopedChannelIds },
      });
    }
    if (scopedOwnerEmail) {
      feedbackScope.push({ user_email: scopedOwnerEmail });
    }
    if (scopedOwnedAgentConversationIds.length > 0) {
      feedbackScope.push({
        conversation_id: { $in: scopedOwnedAgentConversationIds },
      });
    }
    if (readableWebConversationIds.length > 0) {
      feedbackScope.push({
        conversation_id: { $in: readableWebConversationIds },
      });
    }
    const feedbackFilter: Document = isFullInsightsScope
      ? targetFeedbackFilter
      : {
          $and: [
            targetFeedbackFilter,
            feedbackScope.length > 0 ? { $or: feedbackScope } : { _id: null },
          ],
        };

    const messageScope = scopedMessageClauses(
      scopedChannelIds,
      scopedOwnerEmail,
      scopedOwnedAgents,
    );
    const visibleMessagePromise = !isFullInsightsScope && messageScope.length === 0
      ? Promise.resolve([])
      : messages
          .aggregate([
            {
              $match: {
                role: "assistant",
                ...(!isFullInsightsScope ? { $or: messageScope } : {}),
              },
            },
            {
              $lookup: {
                from: "conversations",
                localField: "conversation_id",
                foreignField: "_id",
                as: "_conversation",
              },
            },
            {
              $addFields: {
                _owner: {
                  $ifNull: [
                    "$owner_id",
                    { $arrayElemAt: ["$_conversation.owner_id", 0] },
                  ],
                },
              },
            },
            {
              $match: {
                _owner:
                  identities.length === 1
                    ? identities[0]
                    : { $in: identities },
              },
            },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ])
          .toArray();

    const [
      recentConversations,
      totalConversations,
      visibleConversationCount,
      feedbackStats,
      recentFeedback,
      visibleMessages,
      teamMembersBySlug,
    ] =
      await Promise.all([
        canViewConversations
          ? conversations
              .find(visibleConversationFilter, {
                projection: {
                  _id: 1,
                  channel_id: 1,
                  channel_name: 1,
                  client_type: 1,
                  created_at: 1,
                  idempotency_key: 1,
                  "metadata.channel_id": 1,
                  "metadata.channel_name": 1,
                  "metadata.owner_display_name": 1,
                  "metadata.slack_link": 1,
                  "metadata.slack_permalink": 1,
                  "metadata.thread_ts": 1,
                  "metadata.webex_message_id": 1,
                  "metadata.webex_room_id": 1,
                  "metadata.webex_space_id": 1,
                  "metadata.workspace_url": 1,
                  slack_meta: 1,
                  source: 1,
                  title: 1,
                  updated_at: 1,
                },
              })
              .sort({ updated_at: -1 })
              .limit(20)
              .toArray()
          : Promise.resolve([]),
        conversations.countDocuments(activityConversationFilter),
        canViewConversations
          ? conversations.countDocuments(visibleConversationFilter)
          : Promise.resolve(0),
        feedback
          .aggregate([
            { $match: feedbackFilter },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                positive: {
                  $sum: { $cond: [{ $eq: ["$rating", "positive"] }, 1, 0] },
                },
                negative: {
                  $sum: { $cond: [{ $eq: ["$rating", "negative"] }, 1, 0] },
                },
              },
            },
          ])
          .toArray(),
        feedback
          .find(feedbackFilter, {
            projection: {
              _id: 0,
              channel_id: 1,
              channel_name: 1,
              comment: 1,
              created_at: 1,
              rating: 1,
              source: 1,
              value: 1,
              ...(canViewConversations
                ? {
                    conversation_id: 1,
                    slack_permalink: 1,
                  }
                : {}),
            },
          })
          .sort({ created_at: -1 })
          .limit(10)
          .toArray(),
        visibleMessagePromise,
        scopedTeamSlugs.length > 0
          ? loadTeamMembersForSlugs(scopedTeamSlugs)
          : Promise.resolve(new Map()),
      ]);

    const feedbackSummary = feedbackStats[0] ?? {
      total: 0,
      positive: 0,
      negative: 0,
    };
    const targetEmails = new Set<string>();
    const targetSubjects = new Set<string>();
    const addTargetEmail = (value: unknown): void => {
      if (typeof value === "string" && value.trim()) {
        targetEmails.add(value.trim().toLowerCase());
      }
    };
    const addTargetSubject = (value: unknown): void => {
      if (typeof value === "string" && value.trim()) {
        targetSubjects.add(value.trim());
      }
    };
    if (identity.includes("@")) addTargetEmail(identity);
    else addTargetSubject(identity);
    addTargetEmail(user?.email);
    addTargetSubject(user?.keycloak_sub);
    addTargetSubject(user?.metadata?.keycloak_sub);
    const actorOwnsTarget =
      (
        Boolean(actorOwnerEmail.trim()) &&
        targetEmails.has(actorOwnerEmail.trim().toLowerCase())
      ) ||
      (Boolean(actorSubject) && targetSubjects.has(actorSubject));
    const sharesTeam = [...teamMembersBySlug.values()].some((members) =>
      members.some((member) =>
        identityMatchesTeamMember(member, targetEmails, targetSubjects),
      ),
    );
    const hasVisibleActivity =
      totalConversations > 0 ||
      Number(feedbackSummary.total ?? 0) > 0 ||
      visibleMessages.length > 0;

    if (
      (!isFullInsightsScope && !sharesTeam && !hasVisibleActivity) ||
      (isFullInsightsScope &&
        !user &&
        totalConversations === 0 &&
        Number(feedbackSummary.total ?? 0) === 0 &&
        visibleMessages.length === 0)
    ) {
      if (!isFullInsightsScope) {
        throw new ApiError(
          "You do not have permission to view this user's Insights activity.",
          403,
          "admin_surface:stats#can_read",
          "pdp_denied",
          "contact_admin",
        );
      }
      throw new ApiError("User not found", 404, "USER_NOT_FOUND");
    }

    const firstConversation = recentConversations[0];
    const inferredSource = firstConversation
      ? conversationSource(firstConversation)
      : /^[UW][A-Z0-9]+$/.test(identity)
        ? "slack"
        : "web";
    const readableChannelIdSet = new Set(scopedChannelIds);
    const readableWebConversationIdSet =
      new Set(readableWebConversationIds);
    const visibleWebConversationIdSet = new Set(
      recentConversations
        .filter((conversation) => conversationSource(conversation) === "web")
        .map((conversation) => String(conversation._id ?? ""))
        .filter(Boolean),
    );

    return successResponse({
      can_view_conversations: canViewConversations,
      profile: {
        email: user?.email ?? (identity.includes("@") ? normalizedIdentity : ""),
        name:
          user?.name ||
          firstConversation?.metadata?.owner_display_name ||
          identity,
        avatar_url: user?.avatar_url ?? null,
        role: user?.metadata?.role ?? "user",
        source: user?.source ?? inferredSource,
        slack_user_id:
          user?.slack_user_id ?? (/^[UW][A-Z0-9]+$/.test(identity) ? identity : null),
        created_at: dateString(user?.created_at),
        last_login: dateString(user?.last_login),
      },
      stats: {
        total_conversations: totalConversations,
        visible_conversations: visibleConversationCount,
        feedback_given: Number(feedbackSummary.total ?? 0),
        feedback_positive: Number(feedbackSummary.positive ?? 0),
        feedback_negative: Number(feedbackSummary.negative ?? 0),
      },
      recent_conversations: recentConversations.map((conversation) => ({
        id: String(conversation._id ?? ""),
        title: conversation.title || "Untitled",
        source: conversationSource(conversation),
        channel_id:
          conversation.channel_id ??
          conversation.metadata?.channel_id ??
          conversation.slack_meta?.channel_id ??
          conversation.metadata?.webex_space_id ??
          null,
        channel_name:
          conversation.channel_name ??
          conversation.metadata?.channel_name ??
          conversation.slack_meta?.channel_name ??
          null,
        slack_permalink: slackConversationPermalink(
          conversation,
          conversation.channel_id ??
            conversation.metadata?.channel_id ??
            conversation.slack_meta?.channel_id ??
            null,
        ),
        webex_permalink: webexConversationLink(conversation),
        created_at: dateString(conversation.created_at),
        updated_at: dateString(conversation.updated_at),
      })),
      recent_feedback: recentFeedback.map((entry) => {
        const canOpenSlackThread =
          canAuditOrganization ||
          (
            entry.source === "slack" &&
            typeof entry.channel_id === "string" &&
            readableChannelIdSet.has(entry.channel_id)
          );
        const canOpenWebConversation =
          canAuditOrganization ||
          (
            entry.source !== "slack" &&
            entry.source !== "webex" &&
            typeof entry.conversation_id === "string" &&
            (
              actorOwnsTarget ||
              readableWebConversationIdSet.has(entry.conversation_id) ||
              visibleWebConversationIdSet.has(entry.conversation_id)
            )
          );
        return {
          source: entry.source || "web",
          rating: entry.rating || "",
          value: entry.value || "",
          comment: entry.comment ?? null,
          channel_name: entry.channel_name ?? null,
          // Scoped viewers receive web ids only for their own/shared chats.
          // Slack links survive only for feedback in readable channels.
          conversation_id:
            canOpenWebConversation ? entry.conversation_id ?? null : null,
          slack_permalink: canOpenSlackThread
            ? safeHttpsUrl(entry.slack_permalink)?.toString() ?? null
            : null,
          created_at: dateString(entry.created_at),
        };
      }),
    });
  }
);

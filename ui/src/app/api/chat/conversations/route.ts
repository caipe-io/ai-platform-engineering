// GET /api/chat/conversations - List user's conversations
// POST /api/chat/conversations - Create new conversation (or return existing via upsert)

import {
  getAuthFromBearerOrSession,
  getPaginationParams,
  getUserTeamIds,
  paginatedResponse,
  successResponse,
  validateRequired,
  withErrorHandler,
} from '@/lib/api-middleware';
import type { ConversationAccessLevel } from '@/lib/api-middleware';
import { getCollection, isMongoDBConfigured } from '@/lib/mongodb';
import {
  annotateConversationsWithViewerSharing,
  conversationVisibilityCandidateQuery,
  filterConversationsByImplicitOrExplicitPermission,
  getDirectSharingAccessConversationIds,
} from '@/lib/rbac/conversation-implicit-authz';
import { requireAgentUsePermission } from '@/lib/rbac/openfga-agent-authz';
import { writeOpenFgaTuples } from '@/lib/rbac/openfga';
import { buildParticipants } from '@/types/a2a';
import type { ClientType, Conversation, CreateConversationRequest } from '@/types/mongodb';
import { VALID_CLIENT_TYPES } from '@/types/mongodb';
import type { Document } from 'mongodb';
import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import packageJson from '../../../../../package.json';

type ConversationWithAgentDisplay<T extends Conversation = Conversation> = T & {
  agent_id?: string;
  agent_name?: string;
};

function normalizeIdentity(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function permissionToAccessLevel(permission: unknown): ConversationAccessLevel {
  return permission === 'view' ? 'shared_readonly' : 'shared';
}

function isListConversationOwner(
  conversation: Pick<Conversation, 'owner_id' | 'owner_subject'>,
  userEmail: string,
  session?: { sub?: unknown },
): boolean {
  const subject = typeof session?.sub === 'string' ? session.sub.trim() : '';
  if (subject && conversation.owner_subject === subject) return true;
  return Boolean(
    normalizeIdentity(userEmail) &&
    normalizeIdentity(conversation.owner_id) === normalizeIdentity(userEmail),
  );
}

async function getDirectSharePermission(
  conversationId: string,
  userEmail: string,
): Promise<'view' | 'comment' | undefined> {
  try {
    const sharingAccess = await getCollection<{ permission?: 'view' | 'comment' }>('sharing_access');
    const normalizedEmail = normalizeIdentity(userEmail);
    const identities = Array.from(new Set([userEmail, normalizedEmail].filter(Boolean)));
    const accessRecord = await sharingAccess.findOne({
      conversation_id: conversationId,
      granted_to: { $in: identities },
      revoked_at: null,
    });
    return accessRecord?.permission;
  } catch {
    return undefined;
  }
}

async function getTeamSharePermission(
  conversation: Conversation,
  userEmail: string,
): Promise<'view' | 'comment' | undefined> {
  const sharedTeams = conversation.sharing?.shared_with_teams;
  if (!sharedTeams?.length) return undefined;

  try {
    const userTeamIds = await getUserTeamIds(userEmail);
    const matchedTeamId = sharedTeams.find((teamId) => userTeamIds.includes(teamId));
    if (!matchedTeamId) return undefined;
    return conversation.sharing?.team_permissions?.[matchedTeamId] ?? 'comment';
  } catch {
    return undefined;
  }
}

async function resolveListConversationAccessLevel(
  conversation: Conversation,
  userEmail: string,
  session?: { role?: unknown; sub?: unknown },
): Promise<ConversationAccessLevel> {
  // assisted-by Codex Codex-sonnet-4-6
  // The list already passed ReBAC filtering; derive display-level access without refetching the row.
  if (isListConversationOwner(conversation, userEmail, session)) return 'owner';

  const normalizedEmail = normalizeIdentity(userEmail);
  const directShareMatch = conversation.sharing?.shared_with?.some(
    (email) => normalizeIdentity(email) === normalizedEmail,
  );
  if (directShareMatch) {
    const permission = await getDirectSharePermission(conversation._id, userEmail);
    return permissionToAccessLevel(permission ?? 'comment');
  }

  const directAccessPermission = await getDirectSharePermission(conversation._id, userEmail);
  if (directAccessPermission) {
    return permissionToAccessLevel(directAccessPermission);
  }

  const teamPermission = await getTeamSharePermission(conversation, userEmail);
  if (teamPermission) {
    return permissionToAccessLevel(teamPermission);
  }

  if (session?.role === 'admin') return 'admin_audit';

  return 'shared';
}

function getConversationAgentId(conversation: Conversation): string | undefined {
  return conversation.participants?.find((participant) => participant.type === 'agent')?.id;
}

async function enrichConversationAgentNames<T extends Conversation>(
  items: T[],
): Promise<ConversationWithAgentDisplay<T>[]> {
  const agentIds = Array.from(
    new Set(items.map(getConversationAgentId).filter((id): id is string => Boolean(id))),
  );

  if (agentIds.length === 0) {
    return items;
  }

  const agents = await getCollection<{ _id: string; name?: string }>('dynamic_agents');
  const agentDocs = await agents
    .find({ _id: { $in: agentIds } })
    .project({ _id: 1, name: 1 })
    .toArray();
  const agentNames = new Map(agentDocs.map((agent) => [agent._id, agent.name]));

  return items.map((conversation) => {
    const agentId = getConversationAgentId(conversation);
    if (!agentId) {
      return conversation;
    }

    return {
      ...conversation,
      agent_id: agentId,
      agent_name: agentNames.get(agentId) ?? agentId,
    };
  });
}

// GET /api/chat/conversations
export const GET = withErrorHandler(async (request: NextRequest) => {
  if (!isMongoDBConfigured) {
    return NextResponse.json(
      {
        success: false,
        error: 'MongoDB not configured - use localStorage mode',
        code: 'MONGODB_NOT_CONFIGURED',
      },
      { status: 503 }
    );
  }

  const { user, session } = await getAuthFromBearerOrSession(request);
  const { page, pageSize, skip } = getPaginationParams(request);
  const url = new URL(request.url);
  const archived = url.searchParams.get('archived') === 'true';
  const pinned = url.searchParams.get('pinned') === 'true';
  const clientTypeParam = url.searchParams.get('client_type') as ClientType | null;
  const sourceParam = url.searchParams.get('source');
  const sourceFilter =
    sourceParam === 'autonomous' || sourceParam === 'web' ? sourceParam : null;

  // Validate client_type param if provided
  if (clientTypeParam && !VALID_CLIENT_TYPES.includes(clientTypeParam)) {
    return NextResponse.json(
      {
        success: false,
        error: `Invalid client_type: "${clientTypeParam}". Valid values: ${VALID_CLIENT_TYPES.join(', ')}`,
      },
      { status: 400 }
    );
  }

  const conversations = await getCollection<Conversation>('conversations');
  const directShareConversationIds = await getDirectSharingAccessConversationIds(user.email, getCollection);

  // Fetch only owned or sharing-configured candidates; ReBAC remains the final
  // visibility check for team shares and explicit conversation grants.
  const query: Document = {
    $and: [
      { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
      conversationVisibilityCandidateQuery(user.email, directShareConversationIds),
    ],
  };

  // Filter by client_type if specified.
  // Backward compat: older documents without top-level client_type are treated as 'webui'.
  if (clientTypeParam) {
    if (clientTypeParam === 'webui') {
      // Match docs with client_type: 'webui' OR missing client_type (legacy)
      query.$and.push({
        $or: [
          { client_type: 'webui' },
          { client_type: { $exists: false } },
        ],
      });
    } else {
      query.$and.push({ client_type: clientTypeParam });
    }
  }

  if (archived !== null) {
    query.is_archived = archived;
  }

  if (pinned) {
    query.is_pinned = true;
  }

  // Source is a content filter, not an authz primitive — push into $and
  // to narrow results without touching the ownership $or. The previous
  // `delete query.$or` for source=autonomous was an IDOR.
  if (sourceFilter === 'autonomous') {
    query.$and.push({ source: 'autonomous' });
  } else if (sourceFilter === 'web') {
    query.$and.push({
      source: { $in: ['web', null] } as { $in: (string | null)[] },
    });
  } else {
    // Default ("All") view: include autonomous conversations alongside
    // regular human chats so the sidebar's "All" filter actually shows
    // both. Slack and Webex threads are still excluded because they have
    // their own dedicated UI, and `api` conversations are excluded because
    // they were created by a direct API caller (e.g. the ask-forge CLI)
    // with no UI transcript to show — they still count in insights/stats,
    // which query `conversations`/`messages` directly without this filter.
    // Slack/Webex are checked on both the legacy `source` field and the
    // newer `client_type` field (Webex is never tagged via `source` — see
    // the `Conversation.source` union in mongodb.ts), mirroring the same
    // dual-field exclusion used in admin/users/activity/[identity]/route.ts.
    query.$and.push({ source: { $nin: ['slack', 'api'] } });
    if (clientTypeParam !== 'slack' && clientTypeParam !== 'webex') {
      query.$and.push({ client_type: { $nin: ['slack', 'webex'] } });
    }
  }

  // Get total count
  const total = await conversations.countDocuments(query);

  // Get paginated results
  const items = await conversations
    .find(query)
    .sort({ is_pinned: -1, updated_at: -1 })
    .skip(skip)
    .limit(pageSize)
    .toArray();

  const visibleItems = await filterConversationsByImplicitOrExplicitPermission(
    session,
    user.email,
    items,
    'discover',
    directShareConversationIds,
  );
  const visibleItemsWithViewerFlags = annotateConversationsWithViewerSharing(session, user.email, visibleItems);
  const visibleItemsWithAccessLevel = await Promise.all(
    visibleItemsWithViewerFlags.map(async (conversation) => {
      const access_level = await resolveListConversationAccessLevel(conversation, user.email, session);
      return { ...conversation, access_level };
    }),
  );

  return paginatedResponse(
    await enrichConversationAgentNames(visibleItemsWithAccessLevel),
    visibleItems.length < items.length ? visibleItems.length : total,
    page,
    pageSize
  );
});

// POST /api/chat/conversations
export const POST = withErrorHandler(async (request: NextRequest) => {
  if (!isMongoDBConfigured) {
    return NextResponse.json(
      {
        success: false,
        error: 'MongoDB not configured - use localStorage mode',
        code: 'MONGODB_NOT_CONFIGURED',
      },
      { status: 503 }
    );
  }

  // Combine release/0.4.0's dual-auth (bearer token | session) with comprehensive
  // RBAC enforcement. The bearer path is required by the Slack bot and other
  // first-party service callers. Every conversation targets a dynamic agent, so
  // authorization is enforced per-agent via `agent#can_use` (no agentless chat).
  const { user, session } = await getAuthFromBearerOrSession(request);
  const body: CreateConversationRequest = await request.json();

  validateRequired(body, ['title', 'client_type']);

  // Validate client_type enum
  if (!VALID_CLIENT_TYPES.includes(body.client_type)) {
    return NextResponse.json(
      {
        success: false,
        error: `Invalid client_type: "${body.client_type}". Valid values: ${VALID_CLIENT_TYPES.join(', ')}`,
      },
      { status: 400 }
    );
  }

  // A conversation must target a dynamic agent. Reject agentless creation.
  if (!body.agent_id) {
    return NextResponse.json(
      { success: false, error: 'agent_id is required: select an agent to start a conversation.' },
      { status: 400 }
    );
  }

  // A genuine browser session never sends an Authorization header for its own
  // requests — it authenticates exclusively via the NextAuth session cookie.
  // Any Bearer-authenticated caller that isn't the Slack/Webex bot (which we
  // already trust to self-declare 'slack'/'webex' via their own OBO tokens)
  // is therefore a non-first-party caller falsely able to claim 'webui'. The
  // caller's declared client_type is trusted for the browser and for
  // Slack/Webex; otherwise it's overridden here rather than merely rejected,
  // so the request still succeeds but is correctly attributed as 'api'.
  const isFirstPartyBotBearer = body.client_type === 'slack' || body.client_type === 'webex';
  const isUntrustedBearerCaller = session.authMethod === 'bearer' && !isFirstPartyBotBearer;
  const effectiveClientType: ClientType = isUntrustedBearerCaller ? 'api' : body.client_type;

  // Dynamic agent conversation — gate on agent-level can_use.
  // Service-account callers are graphed as `service_account:<sub>` (their grants
  // live under that type); see requireAgentUsePermission (spec 2026-06-05).
  const denial = await requireAgentUsePermission({
    subject: session.sub,
    agentId: body.agent_id,
    email: user.email,
    isServiceAccount: session.isServiceAccount,
  });
  if (denial) {
    return denial;
  }

  const conversations = await getCollection<Conversation>('conversations');

  // ⚠️ RISK: owner_id can be set by any authenticated caller. This trusts the caller
  // (e.g. Slack bot setting owner_id to the Slack user's email). Future mitigation:
  // implement a service account allowlist — only specific OAuth2 client IDs should be
  // permitted to set owner_id on behalf of users.
  const ownerId = body.owner_id || user.email;

  // QUAL-8: extract once; reused in both idempotency and new-conversation paths.
  const isSaCaller = session.isServiceAccount === true && typeof session.sub === 'string' && session.sub.trim() !== '';
  const saSub = isSaCaller ? session.sub.trim() : undefined;

  // Idempotency: if an idempotency_key is provided, return the existing conversation
  // instead of creating a duplicate. This maintains a 1-1 mapping between integration-
  // specific identities (e.g. Slack thread_ts) and the conversation_id used by
  // UI and LangGraph checkpoints.
  if (body.idempotency_key) {
    const existing = await conversations.findOne({
      idempotency_key: body.idempotency_key,
    });
    if (existing) {
      // If the returning caller is a service account, ensure the writer grant exists
      // (write-if-missing). This heals conversations created before this fix was deployed.
      if (saSub) {
        try {
          await writeOpenFgaTuples({
            writes: [{
              user: `service_account:${saSub}`,
              relation: 'writer',
              object: `conversation:${existing._id}`,
            }],
            deletes: [],
          });
        } catch (err) {
          console.warn('[conversations/route] idempotency-hit SA writer grant failed (best-effort):', err);
        }
      }
      return successResponse({ conversation: existing, created: false }, 200);
    }
  }

  const now = new Date();
  const clientMetadata: Record<string, unknown> = {
    ...body.metadata,
    total_messages: 0,
  };

  // Add UI-specific metadata
  if (effectiveClientType === 'webui') {
    clientMetadata.ui_version = packageJson.version;
  }

  const newConversation: Conversation = {
    _id: uuidv4(), // Server owns ID generation
    title: body.title,
    client_type: effectiveClientType,
    owner_id: ownerId,
    ...(typeof session.sub === 'string' && session.sub.trim() && ownerId === user.email
      ? { owner_subject: session.sub.trim(), owner_identity_version: 2 }
      : {}),
    ...(body.idempotency_key && { idempotency_key: body.idempotency_key }),
    // Provenance: stamp the SA sub so the audit/reconcile step can find SA-created
    // conversations and verify/repair the writer grant. Only set for SA callers.
    ...(saSub ? { created_by_service_account: saSub } : {}),
    // 'api' origin: either the caller declared it (CreateConversationRequest['source'])
    // or the server forced effectiveClientType to 'api' above — the forced case must
    // win regardless of what the caller claimed for `source`.
    ...(effectiveClientType === 'api' || body.source === 'api' ? { source: 'api' as const } : {}),
    participants: buildParticipants(body.agent_id, ownerId),
    created_at: now,
    updated_at: now,
    metadata: clientMetadata as Conversation['metadata'],
    sharing: {
      is_public: false,
      shared_with: [],
      shared_with_teams: [],
      share_link_enabled: false,
    },
    tags: body.tags || [],
    is_archived: false,
    is_pinned: false,
  };

  await conversations.insertOne(newConversation);

  // Auto-grant: when the creating caller is a service account, write an explicit
  // OpenFGA writer tuple so the SA can act in this conversation (PATCH metadata,
  // stream/start, etc.). The human's owner_id is kept unchanged for auditability.
  // Best-effort: if the grant write fails we still return the conversation — the
  // startup/audit reconciler is the backstop.
  if (saSub) {
    try {
      await writeOpenFgaTuples({
        writes: [{
          user: `service_account:${saSub}`,
          relation: 'writer',
          object: `conversation:${newConversation._id}`,
        }],
        deletes: [],
      });
    } catch (err) {
      console.warn('[conversations/route] SA writer grant failed (best-effort):', err);
    }
  }

  return successResponse({ conversation: newConversation, created: true }, 201);
});

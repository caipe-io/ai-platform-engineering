// GET /api/chat/conversations/[id]/share - Get sharing info
// POST /api/chat/conversations/[id]/share - Share conversation with users
// DELETE /api/chat/conversations/[id]/share/[userId] handled in separate file

import {
ApiError,
requireConversationAccess,
successResponse,
validateEmail,
validateConversationId,
withAuth,
withErrorHandler
} from '@/lib/api-middleware';
import { getCollection } from '@/lib/mongodb';
import { requireConversationResourcePermission } from '@/lib/rbac/conversation-implicit-authz';
import { writeOpenFgaTuples, type OpenFgaTupleKey } from '@/lib/rbac/openfga';
import type { Conversation,ShareConversationRequest,SharingAccess } from '@/types/mongodb';
import { ObjectId,type Document } from 'mongodb';
import { NextRequest } from 'next/server';

type SharePermission = 'view' | 'comment';

interface TeamShareDocument {
  _id?: unknown;
  slug?: string;
  name?: string;
}

interface ResolvedTeamShare {
  shareRef: string;
  subjectRef: string;
  aliases: string[];
}

interface UserShareDocument {
  email?: string;
  keycloak_sub?: string;
  metadata?: {
    keycloak_sub?: string;
  };
}

interface ResolvedUserShare {
  email: string;
  subjectRef: string;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueEmails(values: string[]): string[] {
  return uniqueStrings(values.map(normalizedEmail));
}

function stableUserSubject(user: UserShareDocument): string | undefined {
  const candidates = [
    user.keycloak_sub,
    user.metadata?.keycloak_sub,
  ];
  return candidates.find((candidate) => typeof candidate === 'string' && candidate.trim())?.trim();
}

async function resolveUserShares(emails: string[]): Promise<ResolvedUserShare[]> {
  const recipientEmails = uniqueEmails(emails);
  if (recipientEmails.length === 0) return [];

  const users = await getCollection<UserShareDocument>('users');
  const docs = await users
    .find({ email: { $in: recipientEmails } })
    .project({ email: 1, keycloak_sub: 1, 'metadata.keycloak_sub': 1 })
    .toArray();
  const docsByEmail = new Map(
    docs
      .filter((doc) => typeof doc.email === 'string')
      .map((doc) => [normalizedEmail(doc.email as string), doc]),
  );

  return recipientEmails.flatMap((email) => {
    const subjectRef = stableUserSubject(docsByEmail.get(email) ?? {});
    return subjectRef ? [{ email, subjectRef }] : [];
  });
}

function userConversationGrantDiff(
  conversationId: string,
  resolvedUsers: ResolvedUserShare[],
  permission: SharePermission,
): { writes: OpenFgaTupleKey[]; deletes: OpenFgaTupleKey[] } {
  const writes: OpenFgaTupleKey[] = [];
  const deletes: OpenFgaTupleKey[] = [];
  for (const userShare of resolvedUsers) {
    const user = `user:${userShare.subjectRef}`;
    writes.push({ user, relation: 'reader', object: `conversation:${conversationId}` });
    const writerTuple = { user, relation: 'writer', object: `conversation:${conversationId}` };
    if (permission === 'comment') {
      writes.push(writerTuple);
    } else {
      deletes.push(writerTuple);
    }
  }
  return { writes, deletes };
}

async function writeUserConversationGrantTuplesBestEffort(
  conversationId: string,
  emails: string[],
  permission: SharePermission,
): Promise<void> {
  try {
    const resolvedUsers = await resolveUserShares(emails);
    const diff = userConversationGrantDiff(conversationId, resolvedUsers, permission);
    if (diff.writes.length === 0 && diff.deletes.length === 0) return;
    await writeOpenFgaTuples(diff);
  } catch (err) {
    console.warn('[chat/share] User conversation grant write failed (best-effort):', err);
  }
}

function teamLookupFilter(teamRef: string): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [
    { slug: teamRef },
    { _id: teamRef },
  ];
  if (ObjectId.isValid(teamRef)) {
    clauses.push({ _id: new ObjectId(teamRef) });
  }
  return { $or: clauses };
}

async function resolveTeamShares(teamRefs: string[]): Promise<ResolvedTeamShare[]> {
  const teams = await getCollection<TeamShareDocument>('teams');
  const resolved: ResolvedTeamShare[] = [];

  for (const rawRef of uniqueStrings(teamRefs)) {
    const team = await teams.findOne(teamLookupFilter(rawRef));
    if (!team) {
      throw new ApiError(`Team not found: ${rawRef}`, 404);
    }

    const id = team._id !== undefined && team._id !== null ? String(team._id) : rawRef;
    const slug = typeof team.slug === 'string' ? team.slug.trim() : '';
    // assisted-by Codex Codex-sonnet-4-6
    // Store canonical slugs for new team shares, while accepting legacy Mongo _id refs.
    const shareRef = slug || id;

    resolved.push({
      shareRef,
      subjectRef: slug || id,
      aliases: uniqueStrings([rawRef, id, slug]),
    });
  }

  return resolved;
}

function canonicalizeSharedTeamRefs(existingRefs: string[], resolvedTeams: ResolvedTeamShare[]): string[] {
  const next: string[] = [];
  for (const existingRef of existingRefs) {
    const ref = String(existingRef).trim();
    if (!ref) continue;
    const resolved = resolvedTeams.find((team) => team.aliases.includes(ref));
    next.push(resolved?.shareRef ?? ref);
  }
  next.push(...resolvedTeams.map((team) => team.shareRef));
  return uniqueStrings(next);
}

function mergeTeamPermissions(
  existing: Record<string, SharePermission> | undefined,
  resolvedTeams: ResolvedTeamShare[],
  permission: SharePermission,
): Record<string, SharePermission> {
  const next: Record<string, SharePermission> = {};
  for (const [ref, value] of Object.entries(existing || {})) {
    const resolved = resolvedTeams.find((team) => team.aliases.includes(ref));
    next[resolved?.shareRef ?? ref] = value;
  }
  for (const team of resolvedTeams) {
    next[team.shareRef] = permission;
  }
  return next;
}

function teamConversationGrantTuples(
  conversationId: string,
  resolvedTeams: ResolvedTeamShare[],
  permission: SharePermission,
): OpenFgaTupleKey[] {
  const tuples: OpenFgaTupleKey[] = [];
  for (const team of resolvedTeams) {
    const user = `team:${team.subjectRef}#member`;
    tuples.push({ user, relation: 'reader', object: `conversation:${conversationId}` });
    if (permission === 'comment') {
      tuples.push({ user, relation: 'writer', object: `conversation:${conversationId}` });
    }
  }
  return tuples;
}

// GET /api/chat/conversations/[id]/share
export const GET = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => {
  return withAuth(request, async (req, user, session) => {
    const params = await context.params;
    const conversationId = params.id;

    if (!validateConversationId(conversationId)) {
      throw new ApiError('Invalid conversation ID format', 400);
    }

    const { conversation } = await requireConversationAccess(
      conversationId,
      user.email,
      getCollection,
      session,
    );

    const sharingAccess = await getCollection<SharingAccess>('sharing_access');
    const accessList = await sharingAccess
      .find({ 
        conversation_id: conversationId, 
        revoked_at: { $exists: false }
      })
      .toArray();

    return successResponse({
      sharing: conversation.sharing,
      access_list: accessList,
    });
  });
});

// POST /api/chat/conversations/[id]/share
export const POST = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => {
  return withAuth(request, async (req, user, session) => {
    const params = await context.params;
    const conversationId = params.id;
    const body: ShareConversationRequest = await request.json();

    if (!validateConversationId(conversationId)) {
      throw new ApiError('Invalid conversation ID format', 400);
    }

    // assisted-by Codex Codex-sonnet-4-6
    // Public conversation sharing is retired; keep only a cleanup path for legacy state.
    if (body.is_public === true || body.public_permission !== undefined) {
      throw new ApiError(
        'Sharing with everyone is no longer supported. Add people or teams instead.',
        400,
        'PUBLIC_CONVERSATION_SHARING_DISABLED',
      );
    }

    // Require at least one sharing action
    const hasUsers = body.user_emails && body.user_emails.length > 0;
    const hasTeams = body.team_ids && body.team_ids.length > 0;
    const disablesPublicSharing = body.is_public === false;
    if (!hasUsers && !hasTeams && !disablesPublicSharing) {
      throw new ApiError('At least one of user_emails, team_ids, or is_public=false must be provided', 400);
    }

    if ((hasUsers || hasTeams) && !body.permission) {
      throw new ApiError('permission is required when sharing with users or teams', 400);
    }
    if (body.permission && !['view', 'comment'].includes(body.permission)) {
      throw new ApiError('permission must be "view" or "comment"', 400);
    }

    const conversations = await getCollection<Conversation>('conversations');
    const conversation = await conversations.findOne({ _id: conversationId });

    if (!conversation) {
      throw new ApiError('Conversation not found', 404);
    }

    await requireConversationResourcePermission(session, user.email, conversation, 'share');

    const now = new Date();
    const sharingAccess = await getCollection<SharingAccess>('sharing_access');
    const update: Document = {};

    // Handle user sharing
    if (body.user_emails && body.user_emails.length > 0) {
      // Validate emails
      for (const email of body.user_emails) {
        if (!validateEmail(email)) {
          throw new ApiError(`Invalid email format: ${email}`, 400);
        }
      }
      const recipientEmails = uniqueEmails(body.user_emails);
      const permission = body.permission as SharePermission;

      // Create sharing access records for users
      const accessRecords: SharingAccess[] = recipientEmails.map((email) => ({
        conversation_id: conversationId,
        granted_by: user.email,
        granted_to: email,
        permission,
        granted_at: now,
      }));

      if (accessRecords.length > 0) {
        await sharingAccess.insertMany(accessRecords);
      }
      await writeUserConversationGrantTuplesBestEffort(conversationId, recipientEmails, permission);

      // Initialize sharing object if it doesn't exist
      if (!conversation.sharing) {
        update['sharing'] = {};
      }
      
      // Update conversation shared_with
      const existingSharedWith = conversation.sharing?.shared_with || [];
      update['sharing.shared_with'] = uniqueStrings([...existingSharedWith, ...recipientEmails]);
    }

    // Handle team sharing
    if (body.team_ids && body.team_ids.length > 0) {
      const resolvedTeams = await resolveTeamShares(body.team_ids);
      const permission = body.permission as SharePermission;

      // Initialize sharing object if it doesn't exist
      if (!conversation.sharing) {
        update['sharing'] = {};
      }

      // Update conversation shared_with_teams
      const existingSharedWithTeams = conversation.sharing?.shared_with_teams || [];
      update['sharing.shared_with_teams'] = canonicalizeSharedTeamRefs(existingSharedWithTeams, resolvedTeams);

      // Store per-team permission
      update['sharing.team_permissions'] = mergeTeamPermissions(
        conversation.sharing?.team_permissions,
        resolvedTeams,
        permission,
      );

      const grantTuples = teamConversationGrantTuples(conversationId, resolvedTeams, permission);
      if (grantTuples.length > 0) {
        try {
          await writeOpenFgaTuples({ writes: grantTuples, deletes: [] });
        } catch (err) {
          console.warn('[chat/share] Team conversation grant write failed (best-effort):', err);
        }
      }
    }

    if (disablesPublicSharing) {
      update['sharing.is_public'] = false;
    }

    if (body.enable_link !== undefined) {
      update['sharing.share_link_enabled'] = body.enable_link;
    }

    if (body.link_expires) {
      update['sharing.share_link_expires'] = new Date(body.link_expires);
    }

    await conversations.updateOne(
      { _id: conversationId },
      { $set: update }
    );

    const updated = await conversations.findOne({ _id: conversationId });

    return successResponse(updated);
  });
});

// PATCH /api/chat/conversations/[id]/share — update permission for a user or team
export const PATCH = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => {
  return withAuth(request, async (req, user, session) => {
    const params = await context.params;
    const conversationId = params.id;
    const body = await request.json();

    if (!validateConversationId(conversationId)) {
      throw new ApiError('Invalid conversation ID format', 400);
    }

    const { email, team_id, permission } = body;
    if (!permission || !['view', 'comment'].includes(permission)) {
      throw new ApiError('permission must be "view" or "comment"', 400);
    }
    if (!email && !team_id) {
      throw new ApiError('email or team_id is required', 400);
    }

    const conversations = await getCollection<Conversation>('conversations');
    const conversation = await conversations.findOne({ _id: conversationId });
    if (!conversation) {
      throw new ApiError('Conversation not found', 404);
    }

    await requireConversationResourcePermission(session, user.email, conversation, 'share');

    if (email) {
      if (!validateEmail(email)) {
        throw new ApiError(`Invalid email format: ${email}`, 400);
      }
      const recipientEmail = normalizedEmail(email);
      const sharingAccess = await getCollection<SharingAccess>('sharing_access');
      await sharingAccess.updateOne(
        { conversation_id: conversationId, granted_to: { $in: uniqueStrings([email, recipientEmail]) }, revoked_at: null },
        { $set: { permission, granted_to: recipientEmail } }
      );
      await writeUserConversationGrantTuplesBestEffort(conversationId, [recipientEmail], permission);
    }

    if (team_id) {
      const teamPerms = conversation.sharing?.team_permissions || {};
      teamPerms[team_id] = permission;
      await conversations.updateOne(
        { _id: conversationId },
        { $set: { 'sharing.team_permissions': teamPerms } }
      );
    }

    const updated = await conversations.findOne({ _id: conversationId });
    return successResponse(updated);
  });
});

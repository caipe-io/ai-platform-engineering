// GET /api/chat/conversations/[id]/share - Get sharing info
// POST /api/chat/conversations/[id]/share - Share conversation with users
// DELETE /api/chat/conversations/[id]/share - Revoke user or team access

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
import {
  commitConversationSharingMutation,
  resumeConversationSharingMutation,
  withConversationSharingLock,
} from '@/lib/rbac/conversation-sharing-mutation';
import type { OpenFgaTupleKey } from '@/lib/rbac/openfga';
import {
stableKeycloakSubject,
type ShareableUserDocument,
} from '@/lib/rbac/shareable-users';
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

async function lookupUserShares(emails: string[]): Promise<ResolvedUserShare[]> {
  const recipientEmails = uniqueEmails(emails);
  if (recipientEmails.length === 0) return [];

  const users = await getCollection<ShareableUserDocument>('users');
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
    const subjectRef = stableKeycloakSubject(docsByEmail.get(email) ?? {});
    return subjectRef ? [{ email, subjectRef }] : [];
  });
}

async function resolveUserShares(emails: string[]): Promise<ResolvedUserShare[]> {
  const recipientEmails = uniqueEmails(emails);
  const resolvedUsers = await lookupUserShares(recipientEmails);
  const resolvedEmails = new Set(resolvedUsers.map((user) => user.email));
  const unavailableEmails = recipientEmails.filter((email) => !resolvedEmails.has(email));
  if (unavailableEmails.length > 0) {
    throw new ApiError(
      `These users must sign in before they can be shared with: ${unavailableEmails.join(', ')}`,
      400,
      'SHARE_RECIPIENT_NOT_PROVISIONED',
    );
  }
  return resolvedUsers;
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

function teamConversationGrantDiff(
  conversationId: string,
  resolvedTeams: ResolvedTeamShare[],
  permission: SharePermission,
): { writes: OpenFgaTupleKey[]; deletes: OpenFgaTupleKey[] } {
  const writes: OpenFgaTupleKey[] = [];
  const deletes: OpenFgaTupleKey[] = [];
  for (const team of resolvedTeams) {
    const user = `team:${team.subjectRef}#member`;
    const object = `conversation:${conversationId}`;
    writes.push({ user, relation: 'reader', object });
    const writerTuple = { user, relation: 'writer', object };
    if (permission === 'comment') {
      writes.push(writerTuple);
    } else {
      deletes.push(writerTuple);
    }
  }
  return { writes, deletes };
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
        revoked_at: null,
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

    return withConversationSharingLock(conversationId, async (assertOwned) => {
      const conversations = await getCollection<Conversation>('conversations');
      let conversation = await conversations.findOne({ _id: conversationId });

      if (!conversation) {
        throw new ApiError('Conversation not found', 404);
      }

      await requireConversationResourcePermission(session, user.email, conversation, 'share');
      if (await resumeConversationSharingMutation(conversationId, assertOwned)) {
        conversation = await conversations.findOne({ _id: conversationId });
        if (!conversation) throw new ApiError('Conversation not found', 404);
      }

      const now = new Date();
      const accessInserts: SharingAccess[] = [];
      const update: Document = {};
      let recipientEmails: string[] = [];
      let resolvedUsers: ResolvedUserShare[] = [];
      let resolvedTeams: ResolvedTeamShare[] = [];

      // Resolve every requested subject before any write so a mixed user/team
      // request cannot partially persist when one recipient is invalid.
      if (body.user_emails && body.user_emails.length > 0) {
        for (const email of body.user_emails) {
          if (!validateEmail(email)) {
            throw new ApiError(`Invalid email format: ${email}`, 400);
          }
        }
        recipientEmails = uniqueEmails(body.user_emails);
        resolvedUsers = await resolveUserShares(recipientEmails);
      }
      if (body.team_ids && body.team_ids.length > 0) {
        resolvedTeams = await resolveTeamShares(body.team_ids);
      }

      const permission = body.permission as SharePermission;
      const userDiff = userConversationGrantDiff(conversationId, resolvedUsers, permission);
      const teamDiff = teamConversationGrantDiff(conversationId, resolvedTeams, permission);
      const grantDiff = {
        writes: [...userDiff.writes, ...teamDiff.writes],
        deletes: [...userDiff.deletes, ...teamDiff.deletes],
      };

      // Handle user sharing
      if (body.user_emails && body.user_emails.length > 0) {
        const permission = body.permission as SharePermission;

        // Create sharing access records for users
        const accessRecords: SharingAccess[] = recipientEmails.map((email) => ({
          _id: new ObjectId(),
          conversation_id: conversationId,
          granted_by: user.email,
          granted_to: email,
          permission,
          granted_at: now,
        }));

        accessInserts.push(...accessRecords);

        // Update conversation shared_with
        const existingSharedWith = conversation.sharing?.shared_with || [];
        update['sharing.shared_with'] = uniqueStrings([...existingSharedWith, ...recipientEmails]);
      }

      // Handle team sharing
      if (body.team_ids && body.team_ids.length > 0) {
        const permission = body.permission as SharePermission;

        // Update conversation shared_with_teams
        const existingSharedWithTeams = conversation.sharing?.shared_with_teams || [];
        update['sharing.shared_with_teams'] = canonicalizeSharedTeamRefs(existingSharedWithTeams, resolvedTeams);

        // Store per-team permission
        update['sharing.team_permissions'] = mergeTeamPermissions(
          conversation.sharing?.team_permissions,
          resolvedTeams,
          permission,
        );
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

      await commitConversationSharingMutation({
        _id: conversationId, grants: grantDiff, accessInserts,
        conversationUpdate: { $set: update },
      }, assertOwned);

      const updated = await conversations.findOne({ _id: conversationId });

      return successResponse(updated);
    });
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

    return withConversationSharingLock(conversationId, async (assertOwned) => {
      const conversations = await getCollection<Conversation>('conversations');
      let conversation = await conversations.findOne({ _id: conversationId });
      if (!conversation) {
        throw new ApiError('Conversation not found', 404);
      }

      await requireConversationResourcePermission(session, user.email, conversation, 'share');
      if (await resumeConversationSharingMutation(conversationId, assertOwned)) {
        conversation = await conversations.findOne({ _id: conversationId });
        if (!conversation) throw new ApiError('Conversation not found', 404);
      }

      const grants: { writes: OpenFgaTupleKey[]; deletes: OpenFgaTupleKey[] } = { writes: [], deletes: [] };
      const accessUpdates = [];
      const update: Document = {};
      if (email) {
        if (!validateEmail(email)) throw new ApiError(`Invalid email format: ${email}`, 400);
        const recipientEmail = normalizedEmail(email);
        if (!(conversation.sharing?.shared_with ?? []).some((ref) => normalizedEmail(ref) === recipientEmail)) {
          throw new ApiError('User is no longer shared with this conversation', 404);
        }
        const resolvedUsers = await resolveUserShares([recipientEmail]);
        const diff = userConversationGrantDiff(conversationId, resolvedUsers, permission);
        grants.writes.push(...diff.writes);
        grants.deletes.push(...diff.deletes);
        accessUpdates.push({
          filter: { conversation_id: conversationId, granted_to: { $in: uniqueStrings([email, recipientEmail]) }, revoked_at: null },
          update: { $set: { permission, granted_to: recipientEmail } },
        });
      }
      if (team_id) {
        const resolvedTeams = await resolveTeamShares([team_id]);
        const sharedTeams = conversation.sharing?.shared_with_teams ?? [];
        if (!resolvedTeams.every((team) => team.aliases.some((ref) => sharedTeams.includes(ref)))) {
          throw new ApiError('Team is no longer shared with this conversation', 404);
        }
        const diff = teamConversationGrantDiff(conversationId, resolvedTeams, permission);
        grants.writes.push(...diff.writes);
        grants.deletes.push(...diff.deletes);
        update['sharing.team_permissions'] = mergeTeamPermissions(
          conversation.sharing?.team_permissions, resolvedTeams, permission,
        );
      }
      await commitConversationSharingMutation({
        _id: conversationId, grants, accessUpdates,
        conversationUpdate: { $set: update },
      }, assertOwned);

      const updated = await conversations.findOne({ _id: conversationId });
      return successResponse(updated);
    });
  });
});

// DELETE /api/chat/conversations/[id]/share — revoke access for one user or team
export const DELETE = withErrorHandler(async (
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

    const email = typeof body.email === 'string' ? normalizedEmail(body.email) : '';
    const teamId = typeof body.team_id === 'string' ? body.team_id.trim() : '';
    if (Boolean(email) === Boolean(teamId)) {
      throw new ApiError('Exactly one of email or team_id is required', 400);
    }
    if (email && !validateEmail(email)) {
      throw new ApiError(`Invalid email format: ${email}`, 400);
    }

    return withConversationSharingLock(conversationId, async (assertOwned) => {
      const conversations = await getCollection<Conversation>('conversations');
      let conversation = await conversations.findOne({ _id: conversationId });
      if (!conversation) {
        throw new ApiError('Conversation not found', 404);
      }

      await requireConversationResourcePermission(session, user.email, conversation, 'share');
      if (await resumeConversationSharingMutation(conversationId, assertOwned)) {
        conversation = await conversations.findOne({ _id: conversationId });
        if (!conversation) throw new ApiError('Conversation not found', 404);
      }
      const now = new Date();
      const grants: { writes: OpenFgaTupleKey[]; deletes: OpenFgaTupleKey[] } = { writes: [], deletes: [] };
      const accessUpdates = [];
      const update: Document = {};
      const pull: Document = {};

      if (email) {
        // Revocation remains idempotent for legacy drift: if the recipient was
        // never provisioned there is no subject tuple to remove, but Mongo state
        // must still be cleaned up.
        const resolvedUsers = await lookupUserShares([email]);
        if (resolvedUsers.length > 0) {
          const tupleDiff = userConversationGrantDiff(conversationId, resolvedUsers, 'comment');
          grants.deletes.push(...tupleDiff.writes);
        }

        accessUpdates.push({
          filter: {
            conversation_id: conversationId,
            granted_to: { $in: uniqueStrings([body.email, email]) },
            revoked_at: null,
          },
          update: { $set: { revoked_at: now, revoked_by: user.email } },
        });
        const aliases = (conversation.sharing?.shared_with ?? [])
          .filter((ref) => normalizedEmail(ref) === email);
        pull['sharing.shared_with'] = { $in: uniqueStrings([...aliases, body.email, email]) };
      }

      if (teamId) {
        let resolvedTeams: ResolvedTeamShare[];
        try {
          resolvedTeams = await resolveTeamShares([teamId]);
        } catch (err) {
          if (!(err instanceof ApiError) || err.statusCode !== 404) throw err;
          // A deleted/stale team must still be removable from a conversation.
          resolvedTeams = [{
            shareRef: teamId,
            subjectRef: teamId,
            aliases: [teamId],
          }];
        }
        const aliases = new Set(resolvedTeams.flatMap((team) => team.aliases));
        const revokeTuples = resolvedTeams.flatMap((team) => {
          const tupleUser = `team:${team.subjectRef}#member`;
          const object = `conversation:${conversationId}`;
          return [
            { user: tupleUser, relation: 'reader', object },
            { user: tupleUser, relation: 'writer', object },
          ];
        });
        grants.deletes.push(...revokeTuples);

        pull['sharing.shared_with_teams'] = { $in: Array.from(aliases) };
        update['sharing.team_permissions'] = Object.fromEntries(
          Object.entries(conversation.sharing?.team_permissions || {})
            .filter(([ref]) => !aliases.has(ref)),
        );
      }
      await commitConversationSharingMutation({
        _id: conversationId, grants, accessUpdates,
        conversationUpdate: { $pull: pull, ...(Object.keys(update).length ? { $set: update } : {}) },
      }, assertOwned);

      const updated = await conversations.findOne({ _id: conversationId });
      return successResponse(updated);
    });
  });
});

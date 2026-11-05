import type { Conversation } from "@/types/mongodb";

import {
  filterResourcesByPermission,
  requireResourcePermission,
  type ResourceAuthzSession,
  type ResourcePermissionAction,
} from "./resource-authz";

function stableSubject(session: ResourceAuthzSession): string | null {
  return typeof session.sub === "string" && session.sub.trim() ? session.sub.trim() : null;
}

function normalizeEmail(email: string | undefined): string {
  return email?.trim().toLowerCase() ?? "";
}

function identityCandidates(userEmail: string): string[] {
  const email = userEmail.trim();
  const normalizedEmail = normalizeEmail(userEmail);
  return Array.from(new Set([email, normalizedEmail].filter(Boolean)));
}

function identityMatch(field: string, values: string[]): Record<string, unknown> {
  return values.length === 1 ? { [field]: values[0] } : { [field]: { $in: values } };
}

function normalizedString(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Personal assistant discovery excludes shared and audit-visible conversations. */
export function conversationOwnershipCandidateQuery(
  session: ResourceAuthzSession,
  userEmail: string,
): { $or: Record<string, unknown>[] } {
  const subject = stableSubject(session);
  return { $or: [
    ...(subject ? [{ owner_subject: subject }] : []),
    identityMatch("owner_id", identityCandidates(userEmail)),
  ] };
}

export function conversationVisibilityCandidateQuery(
  userEmail: string,
  directShareConversationIds: readonly string[] = [],
): { $or: Record<string, unknown>[] } {
  const identities = identityCandidates(userEmail);
  const directIds = Array.from(new Set(directShareConversationIds.filter(Boolean)));
  const directIdCandidate = directIds.length > 0 ? [{ _id: { $in: directIds } }] : [];
  return {
    $or: [
      identityMatch("owner_id", identities),
      identityMatch("sharing.shared_with", identities),
      ...directIdCandidate,
      // assisted-by Codex Codex-sonnet-4-6
      // Team membership is still decided by ReBAC; this only bounds the Mongo candidate set.
      { "sharing.shared_with_teams.0": { $exists: true } },
    ],
  };
}

export function isImplicitConversationOwner(
  session: ResourceAuthzSession,
  userEmail: string,
  conversation: Pick<Conversation, "owner_id" | "owner_subject">,
): boolean {
  const subject = stableSubject(session);
  if (subject && conversation.owner_subject === subject) return true;
  return Boolean(normalizeEmail(userEmail) && normalizeEmail(conversation.owner_id) === normalizeEmail(userEmail));
}

function hasDirectMongoShare(userEmail: string, conversation: Pick<Conversation, "sharing">): boolean {
  const normalizedEmail = normalizeEmail(userEmail);
  if (!normalizedEmail) return false;
  return Boolean(
    conversation.sharing?.shared_with?.some((email) => normalizedString(email) === normalizedEmail),
  );
}

function hasImplicitConversationVisibility(
  session: ResourceAuthzSession,
  userEmail: string,
  conversation: Conversation,
  directShareIds: Set<string>,
): boolean {
  if (isImplicitConversationOwner(session, userEmail, conversation)) return true;
  if (hasDirectMongoShare(userEmail, conversation)) return true;
  return directShareIds.has(conversation._id);
}

export interface ConversationViewerSharingFlag {
  viewer_has_shared_access: boolean;
}

export function annotateConversationsWithViewerSharing<
  T extends Pick<Conversation, "owner_id" | "owner_subject">,
>(
  session: ResourceAuthzSession,
  userEmail: string,
  conversations: T[],
): Array<T & ConversationViewerSharingFlag> {
  return conversations.map((conversation) => ({
    ...conversation,
    // assisted-by Codex Codex-sonnet-4-6
    // Sidebar needs an explicit recipient signal even when owner metadata is absent client-side.
    viewer_has_shared_access: !isImplicitConversationOwner(session, userEmail, conversation),
  }));
}

export async function requireConversationResourcePermission(
  session: ResourceAuthzSession,
  userEmail: string,
  conversation: Conversation,
  action: ResourcePermissionAction,
): Promise<void> {
  if (isImplicitConversationOwner(session, userEmail, conversation)) return;
  await requireResourcePermission(
    session,
    {
      type: "conversation",
      id: conversation._id,
      action,
    },
    { bypassForOrgAdmin: true },
  );
}

export async function filterConversationsByImplicitOrExplicitPermission<T extends Conversation>(
  session: ResourceAuthzSession,
  userEmail: string,
  conversations: T[],
  action: ResourcePermissionAction = "discover",
  directShareConversationIds: readonly string[] = [],
): Promise<T[]> {
  const directShareIds = new Set(directShareConversationIds);
  const implicitIds = new Set(
    conversations
      .filter((conversation) => hasImplicitConversationVisibility(session, userEmail, conversation, directShareIds))
      .map((conversation) => conversation._id),
  );
  const explicitCandidates = conversations.filter((conversation) => !implicitIds.has(conversation._id));
  const explicitVisible = await filterResourcesByPermission(
    session,
    explicitCandidates,
    {
      type: "conversation",
      action,
      id: (conversation) => conversation._id,
    },
    { bypassForOrgAdmin: true },
  );
  const explicitIds = new Set(explicitVisible.map((conversation) => conversation._id));
  return conversations.filter((conversation) => implicitIds.has(conversation._id) || explicitIds.has(conversation._id));
}

export async function getDirectSharingAccessConversationIds(
  userEmail: string,
  getCollectionFn: (name: string) => Promise<unknown>,
): Promise<string[]> {
  const identities = identityCandidates(userEmail);
  if (identities.length === 0) return [];
  try {
    const sharingAccess = await getCollectionFn("sharing_access");
    const distinct = (sharingAccess as { distinct?: unknown } | null)?.distinct as
      | ((fieldName: string, filter: Record<string, unknown>) => Promise<unknown[]>)
      | undefined;
    if (
      typeof sharingAccess !== "object" ||
      sharingAccess === null ||
      typeof distinct !== "function"
    ) {
      return [];
    }
    const ids = await distinct("conversation_id", {
      granted_to: identities.length === 1 ? identities[0] : { $in: identities },
      revoked_at: null,
    });
    return Array.from(new Set(ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)));
  } catch {
    return [];
  }
}

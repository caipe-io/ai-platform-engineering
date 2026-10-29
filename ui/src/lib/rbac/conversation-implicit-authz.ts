import type { Conversation } from "@/types/mongodb";
import { ApiError } from "@/lib/api-error";
import { ownsPersonalEvidenceConversation } from "@/lib/conversation-evidence-privacy";

import {
  filterResourcesByPermission,
  requireResourcePermission,
  type ResourceAuthzSession,
  type ResourcePermissionAction,
} from "./resource-authz";

type ConversationOwnerFields = Pick<Conversation, "owner_id" | "owner_subject"> &
  Partial<Pick<Conversation, "personal_context" | "owner_identity_version">>;
type ConversationAuthzSession = ResourceAuthzSession & { canViewAdmin?: boolean };

function isPrivateEvidenceConversation(conversation: ConversationOwnerFields): boolean {
  return conversation.personal_context === "private";
}

function hasAdminAuditAccess(session: ConversationAuthzSession): boolean {
  return session.isServiceAccount !== true && (session.role === "admin" || session.canViewAdmin === true);
}

function isReadAction(action: ResourcePermissionAction): boolean {
  return action === "read" || action === "discover" || action === "list" || action === "audit";
}

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
  conversation: ConversationOwnerFields,
): boolean {
  const subject = stableSubject(session);
  if (isPrivateEvidenceConversation(conversation)) {
    return session.isServiceAccount !== true && ownsPersonalEvidenceConversation(conversation, subject ?? "", userEmail);
  }
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
  T extends ConversationOwnerFields,
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
  session: ConversationAuthzSession,
  userEmail: string,
  conversation: Conversation,
  action: ResourcePermissionAction,
): Promise<void> {
  if (!isImplicitConversationOwner(session, userEmail, conversation)) {
    // Old tuples must never turn private evidence into a share. Keep the
    // existing explicit, read-only admin audit path.
    if (isPrivateEvidenceConversation(conversation) && !(isReadAction(action) && hasAdminAuditAccess(session))) {
      throw new ApiError("Private personal research can only be accessed by its owner.", 403, "PRIVATE_CONVERSATION_OWNER_REQUIRED");
    }
    await requireResourcePermission(
      session,
      { type: "conversation", id: conversation._id, action },
      { bypassForOrgAdmin: true },
    );
  }
  if (conversation.purge && action !== 'delete') {
    throw new ApiError("This conversation is being permanently deleted.", 409, "CONVERSATION_PURGING");
  }
}

export async function filterConversationsByImplicitOrExplicitPermission<T extends Conversation>(
  session: ConversationAuthzSession,
  userEmail: string,
  conversations: T[],
  action: ResourcePermissionAction = "discover",
  directShareConversationIds: readonly string[] = [],
): Promise<T[]> {
  const candidates = conversations.filter((conversation) =>
    !isPrivateEvidenceConversation(conversation) ||
    isImplicitConversationOwner(session, userEmail, conversation) ||
    (isReadAction(action) && hasAdminAuditAccess(session)),
  );
  const directShareIds = new Set(directShareConversationIds);
  const implicitIds = new Set(
    candidates
      .filter((conversation) => hasImplicitConversationVisibility(session, userEmail, conversation, directShareIds))
      .map((conversation) => conversation._id),
  );
  const explicitCandidates = candidates.filter((conversation) => !implicitIds.has(conversation._id));
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
  return candidates.filter((conversation) => implicitIds.has(conversation._id) || explicitIds.has(conversation._id));
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

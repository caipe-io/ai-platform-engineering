/** Durable evidence visibility is shared by every BFF writing canonical conversations. */
import { ApiError } from "@/lib/api-error";
import { getCollection } from "@/lib/mongodb";
import { getAgentId } from "@/types/a2a";
import type { Conversation } from "@/types/mongodb";

// Admission and all sharing paths reserve this server-owned field atomically.

export const CONVERSATION_EVIDENCE_VISIBILITY_PATH = "personal_context";

/** Reserve sharing before any grant side effect; private admission uses this same CAS. */
export async function claimConversationShareable(conversationId: string): Promise<void> {
  const conversations = await getCollection<Conversation>("conversations");
  const claimed = await conversations.updateOne({
    _id: conversationId,
    $or: [
      { [CONVERSATION_EVIDENCE_VISIBILITY_PATH]: { $exists: false } },
      { [CONVERSATION_EVIDENCE_VISIBILITY_PATH]: "shareable" },
    ],
  }, { $set: { [CONVERSATION_EVIDENCE_VISIBILITY_PATH]: "shareable" } });
  if (claimed.matchedCount !== 1) {
    throw new ApiError(
      "This chat contains private personal evidence and cannot be shared. Start a separate chat to share agent answers.",
      409,
      "PERSONAL_CONTEXT_PRIVATE",
    );
  }
}

/** A normalized owner subject is authoritative; only legacy rows fall back to email. */
export function ownsPersonalEvidenceConversation(
  conversation: Pick<Conversation, "owner_id" | "owner_subject" | "owner_identity_version">,
  subject: string,
  email?: string | null,
): boolean {
  if (conversation.owner_subject?.trim() || conversation.owner_identity_version === 2) {
    return Boolean(subject && conversation.owner_subject === subject);
  }
  return Boolean(email?.trim() && conversation.owner_id?.trim().toLowerCase() === email.trim().toLowerCase());
}

/** An idempotent retry must not expose private evidence or manufacture a service grant. */
export function assertPrivateConversationIdempotencyAccess(
  conversation: Conversation,
  caller: { sub?: unknown; isServiceAccount?: unknown },
  email: string,
): void {
  if (conversation.personal_context !== "private") return;
  const subject = typeof caller.sub === "string" ? caller.sub.trim() : "";
  if (caller.isServiceAccount === true || !ownsPersonalEvidenceConversation(conversation, subject, email)) {
    throw new ApiError("Private personal research can only be resumed by its owner.", 403, "PRIVATE_CONVERSATION_OWNER_REQUIRED");
  }
}

function privateConversationRequired(): ApiError {
  return new ApiError(
    "Personal evidence requires a private chat that you own. Chats used for personal evidence cannot be shared.",
    403,
    "PERSONAL_CONTEXT_REQUIRED",
  );
}

function hasSharing(conversation: Conversation): boolean {
  const sharing = conversation.sharing;
  return Boolean(sharing?.is_public || sharing?.share_link_enabled ||
    (sharing?.shared_with !== undefined && (!Array.isArray(sharing.shared_with) || sharing.shared_with.length)) ||
    (sharing?.shared_with_teams !== undefined && (!Array.isArray(sharing.shared_with_teams) || sharing.shared_with_teams.length)));
}

function validPersonalConversation(conversation: Conversation, subject: string, email: string | null | undefined, agentId: string): boolean {
  return Boolean(subject && agentId && getAgentId(conversation) === agentId &&
    ownsPersonalEvidenceConversation(conversation, subject, email) && conversation.client_type === "webui" &&
    !conversation.created_by_service_account && !conversation.deleted_at &&
    conversation.source !== "autonomous" && !hasSharing(conversation));
}

async function hasActiveShare(conversationId: string): Promise<boolean> {
  const shares = await getCollection("sharing_access");
  // Mongo's null equality includes legacy rows with no revoked_at field.
  return Boolean(await shares.findOne({ conversation_id: conversationId, revoked_at: null }, { projection: { _id: 1 } }));
}

/** Readiness alone never reserves a chat for personal evidence or blocks later sharing. */
export async function isPersonalEvidenceConversationEligible(
  conversationId: string, subject: string, email: string | null | undefined, agentId: string,
): Promise<boolean> {
  const conversations = await getCollection<Conversation>("conversations");
  const conversation = await conversations.findOne({ _id: conversationId });
  const visibility = conversation?.personal_context;
  return Boolean(conversation && (visibility === undefined || visibility === "private") &&
    validPersonalConversation(conversation, subject, email, agentId) && !await hasActiveShare(conversationId));
}

/** Atomically exclude competing share admissions before any external delegation. */
export async function admitPersonalEvidenceConversation(
  conversationId: string, subject: string, email: string | null | undefined, agentId: string,
): Promise<void> {
  const conversations = await getCollection<Conversation>("conversations");
  const conversation = await conversations.findOne({ _id: conversationId });
  if (!conversation || !validPersonalConversation(conversation, subject, email, agentId) || await hasActiveShare(conversationId)) {
    throw privateConversationRequired();
  }
  const ownerFilter = conversation.owner_subject?.trim() || conversation.owner_identity_version === 2
    ? { owner_subject: subject }
    : { owner_id: conversation.owner_id, owner_subject: { $in: [null, ""] }, owner_identity_version: { $ne: 2 } };
  const claimed = await conversations.updateOne({
    _id: conversationId,
    ...ownerFilter,
    client_type: "webui",
    participants: conversation.participants,
    created_by_service_account: { $in: [null, ""] },
    deleted_at: null,
    source: { $ne: "autonomous" },
    "sharing.is_public": { $ne: true },
    "sharing.share_link_enabled": { $ne: true },
    "sharing.shared_with.0": { $exists: false },
    "sharing.shared_with_teams.0": { $exists: false },
    $or: [{ [CONVERSATION_EVIDENCE_VISIBILITY_PATH]: { $exists: false } }, { [CONVERSATION_EVIDENCE_VISIBILITY_PATH]: "private" }],
  }, { $set: { [CONVERSATION_EVIDENCE_VISIBILITY_PATH]: "private" } });
  if (claimed.matchedCount !== 1) throw privateConversationRequired();
  await assertPersonalEvidenceConversation(conversationId, subject, email, agentId);
}

/** Recheck the owner, routing, visibility and legacy grants before evidence leaves the broker. */
export async function assertPersonalEvidenceConversation(
  conversationId: string, subject: string, email: string | null | undefined, agentId: string,
): Promise<void> {
  const conversations = await getCollection<Conversation>("conversations");
  const conversation = await conversations.findOne({ _id: conversationId });
  if (!conversation || conversation.personal_context !== "private" ||
      !validPersonalConversation(conversation, subject, email, agentId) || await hasActiveShare(conversationId)) {
    throw privateConversationRequired();
  }
}

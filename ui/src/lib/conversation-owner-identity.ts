import type { Conversation } from "@/types/mongodb";
import type { Collection, Document, Filter, UpdateFilter } from "mongodb";

type ConversationIdentityFields = Pick<
  Conversation,
  "owner_id" | "owner_subject" | "owner_canonical_subject" | "owner_identity_version"
>;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ownerAliasClauses(ownerIds: readonly string[]): Document[] {
  const aliases = [...new Set(ownerIds.map((value) => value.trim()).filter(Boolean))];
  return aliases.map((alias) => (
    alias.includes("@")
      ? { owner_id: { $regex: `^${escapeRegex(alias)}$`, $options: "i" } }
      : { owner_id: alias }
  ));
}

function subjectCompatibility(subject: string): Document {
  return {
    $or: [
      { owner_subject: { $exists: false } },
      { owner_subject: null },
      { owner_subject: "" },
      { owner_subject: subject },
    ],
  };
}

/**
 * Attach a linked person's immutable subject to every conversation previously
 * attributed through the same email or connector id. Existing subject bindings
 * are never overwritten because an alias may have belonged to another account.
 */
export async function reconcileConversationOwnerIdentity<T extends ConversationIdentityFields>(
  conversations: Collection<T>,
  ownerSubject: string,
  ownerIds: readonly string[],
): Promise<number> {
  const subject = ownerSubject.trim();
  const aliases = ownerAliasClauses(ownerIds);
  if (!subject || aliases.length === 0) return 0;

  const filter = {
    $and: [
      { $or: aliases },
      subjectCompatibility(subject),
    ],
  } as Filter<T>;
  const update = {
    $set: {
      owner_subject: subject,
      owner_canonical_subject: subject,
      owner_identity_version: 2,
    },
  } as UpdateFilter<T>;
  const result = await conversations.updateMany(filter, update);

  return result.modifiedCount;
}

/**
 * Resolve analytics ownership without granting conversation access. This is
 * used when a trusted connector temporarily falls back to its unlinked service
 * account but still supplies an email that already maps to a platform user.
 */
export async function reconcileConversationAnalyticsIdentity<T extends ConversationIdentityFields>(
  conversations: Collection<T>,
  ownerSubject: string,
  ownerIds: readonly string[],
): Promise<number> {
  const subject = ownerSubject.trim();
  const aliases = ownerAliasClauses(ownerIds);
  if (!subject || aliases.length === 0) return 0;

  const filter = {
    $and: [
      { $or: aliases },
      subjectCompatibility(subject),
      {
        $or: [
          { owner_canonical_subject: { $exists: false } },
          { owner_canonical_subject: null },
          { owner_canonical_subject: "" },
        ],
      },
    ],
  } as Filter<T>;
  const update = {
    $set: {
      owner_canonical_subject: subject,
      owner_identity_version: 2,
    },
  } as UpdateFilter<T>;
  const result = await conversations.updateMany(filter, update);

  return result.modifiedCount;
}

import { getCollection } from "@/lib/mongodb";

interface IdentityClaim {
  _id: string;
  subject: string;
  createdAt: Date;
}

export class SecondaryIdentityClaimConflict extends Error {
  readonly name = "SecondaryIdentityClaimConflict";
}

/** Reserve the one-to-one binding atomically across all host replicas. */
export async function claimSecondaryIdentity(key: string, subject: string): Promise<void> {
  const collection = await getCollection<IdentityClaim>("secondary_auth_identity_links");
  // Unlike best-effort indexes, this uniqueness gate must succeed before linking.
  await collection.createIndex({ subject: 1 }, { unique: true, name: "secondary_auth_subject_unique" });
  try {
    await collection.insertOne({ _id: key, subject, createdAt: new Date() });
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== 11000) throw error;
    const existing = await collection.findOne({ _id: key });
    if (existing?.subject === subject) return;
    throw new SecondaryIdentityClaimConflict("The secondary identity or user is already bound");
  }
}

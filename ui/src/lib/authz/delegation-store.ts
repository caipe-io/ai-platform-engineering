import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import type { DelegationIdentity, DelegationIntent, DelegationRecord } from "./delegation-contract";
import { HttpAuthzError } from "./errors";

async function collection() {
  if (!isMongoDBConfigured) throw new Error("MongoDB is required for delegation");
  return getCollection<DelegationRecord>("access_delegations");
}

// References are protected by Mongo's unique _id index. No cache, TTL deletion,
// or mutable scope: expiry is checked by CAS and expired records remain inspectable.
export async function readDelegation(id: string): Promise<DelegationRecord | null> {
  return (await collection()).findOne({ _id: id }, {
    readPreference: "primary", readConcern: { level: "majority" }, timeoutMS: 5000,
  });
}

export async function insertDelegation(identity: DelegationIdentity, intent: DelegationIntent, id: string): Promise<DelegationRecord> {
  const record: DelegationRecord = {
    ...intent, _id: id, issuer: identity.issuer, user_id: identity.subject.id,
    created_at: new Date().toISOString(), revoked_at: null, version: 1,
  };
  const stored = await (await collection()).findOneAndUpdate({ _id: id }, { $setOnInsert: record }, {
    upsert: true, returnDocument: "after", writeConcern: { w: "majority" }, timeoutMS: 5000,
  });
  if (!stored) throw new Error("Approval write returned no record");
  // A retry can inspect the same immutable approval, never overwrite its owner,
  // scope, expiry or revocation. A reused key with different intent conflicts.
  if (stored.issuer !== identity.issuer || stored.user_id !== identity.subject.id || stored.job_id !== intent.job_id ||
    stored.service.id !== intent.service.id || stored.service.client_id !== intent.service.client_id ||
    stored.expires_at !== intent.expires_at || JSON.stringify(stored.scope) !== JSON.stringify(intent.scope)) {
    throw new HttpAuthzError(409, "INVALID_REQUEST", "Idempotency key already belongs to a different approval");
  }
  return stored;
}

/** Atomic, owner-bound, idempotent revocation across BFF replicas. */
export async function revokeDelegationRecord(id: string, identity: DelegationIdentity): Promise<DelegationRecord | null> {
  const store = await collection();
  const owner = { _id: id, issuer: identity.issuer, user_id: identity.subject.id };
  const changed = await store.findOneAndUpdate({ ...owner, revoked_at: null }, {
    $set: { revoked_at: new Date().toISOString() }, $inc: { version: 1 },
  }, { returnDocument: "after", writeConcern: { w: "majority" }, timeoutMS: 5000 });
  return changed ?? store.findOne(owner, {
    readPreference: "primary", readConcern: { level: "majority" }, timeoutMS: 5000,
  });
}

import { MongoServerError } from "mongodb";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { HttpAuthzError } from "./errors";
import type { RegisteredResource } from "./resource-contract";

async function collection() {
  if (!isMongoDBConfigured) throw new Error("MongoDB is required for resource registration");
  return getCollection<RegisteredResource>("access_resources");
}
export async function readRegisteredResource(id: string, signal?: AbortSignal): Promise<RegisteredResource | null> {
  return (await collection()).findOne({ _id: id }, {
    readPreference: "primary", readConcern: { level: "majority" }, timeoutMS: 5000,
    ...(signal ? { signal } : {}),
  });
}

/** One business identity maps to one immutable opaque handle across all replicas. */
export async function reserveResource(intent: RegisteredResource): Promise<RegisteredResource> {
  const records = await collection();
  await records.createIndex({ app_id: 1, resource_type: 1, local_id: 1 }, { unique: true, name: "app_resource_identity", maxTimeMS: 5000 });
  const key = { app_id: intent.app_id, resource_type: intent.resource_type, local_id: intent.local_id };
  let stored: RegisteredResource | null;
  try {
    stored = await records.findOneAndUpdate(key, { $setOnInsert: intent }, {
      upsert: true, returnDocument: "after", writeConcern: { w: "majority" }, timeoutMS: 5000,
    });
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
    stored = await records.findOne(key, { readConcern: { level: "majority" }, timeoutMS: 5000 });
  }
  if (!stored) throw new Error("Resource reservation returned no record");
  if (stored.issuer !== intent.issuer || stored.owner.type !== intent.owner.type || stored.owner.id !== intent.owner.id ||
    stored.creator.type !== intent.creator.type || stored.creator.id !== intent.creator.id) {
    throw new HttpAuthzError(409, "INVALID_REQUEST", "Resource identity already belongs to a different registration");
  }
  return stored;
}
export async function activateResource(id: string): Promise<RegisteredResource> {
  const record = await (await collection()).findOneAndUpdate({ _id: id, state: "pending" }, {
    $set: { state: "active" },
  }, { returnDocument: "after", writeConcern: { w: "majority" }, timeoutMS: 5000 });
  const result = record ?? await readRegisteredResource(id);
  if (!result || result.state !== "active") throw new Error("Resource activation not confirmed");
  return result;
}
export async function prepareResource(id: string): Promise<void> {
  await (await collection()).updateOne({ _id: id, state: "pending" }, { $set: { prepared: true } }, {
    writeConcern: { w: "majority" }, timeoutMS: 5000,
  });
}

import { createHash } from "crypto";
import { MongoServerError } from "mongodb";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { HttpAuthzError } from "./errors";
import type { RegisteredResource } from "./resource-contract";

async function collection() {
  if (!isMongoDBConfigured) throw new Error("MongoDB is required for resource registration");
  return getCollection<RegisteredResource>("access_resources");
}

/** A unique, unambiguous tuple key using Mongo's existing unique _id index. */
export function registeredResourceId(issuer: string, appId: string, kind: string, localId: string): string {
  return createHash("sha256").update(JSON.stringify([issuer, appId, kind, localId])).digest("hex");
}

export async function readRegisteredResource(id: string, signal?: AbortSignal): Promise<RegisteredResource | null> {
  return (await collection()).findOne({ _id: id }, {
    readPreference: "primary", readConcern: { level: "majority" }, timeoutMS: 5000,
    ...(signal ? { signal } : {}),
  });
}

export async function reserveResource(intent: RegisteredResource): Promise<RegisteredResource> {
  let stored: RegisteredResource | null;
  try {
    stored = await (await collection()).findOneAndUpdate({ _id: intent._id }, { $setOnInsert: intent }, {
      upsert: true, returnDocument: "after", writeConcern: { w: "majority" }, timeoutMS: 5000,
    });
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
    stored = await readRegisteredResource(intent._id);
  }
  if (!stored) throw new Error("Resource reservation returned no record");
  if (stored.issuer !== intent.issuer || stored.app_id !== intent.app_id || stored.kind !== intent.kind ||
    stored.local_id !== intent.local_id || stored.owner.type !== intent.owner.type || stored.owner.id !== intent.owner.id ||
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

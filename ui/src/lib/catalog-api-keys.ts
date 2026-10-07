/**
 * MongoDB-backed catalog API keys for Skills Gateway (FR-018).
 *
 * Mirrors `ai_platform_engineering/skills_middleware/api_keys_store.py` so the
 * BFF and Skills Gateway use the same key format.
 *
 * Key format: `{key_id}.{secret}`. Only a versioned scrypt digest is stored.
 */

import { randomInt,scrypt,timingSafeEqual } from "crypto";

import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";

const COLLECTION = "catalog_api_keys";
const KEY_ID_PREFIX = "sk_";
const KEY_ID_RANDOM_LEN = 12;
const SECRET_LEN = 32;
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
// assisted-by Codex Codex-sonnet-4-6
const SCRYPT_PREFIX = "scrypt:v1";
const SCRYPT_KEY_LEN = 32;
const SCRYPT_OPTIONS = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
};

interface CatalogApiKeyDocument {
  key_id: string;
  key_hash: string;
  owner_user_id: string;
  scopes: string[];
  created_at: number;
  revoked_at: number | null;
  expires_at?: number | null;
  last_used_at?: number | null;
}

export interface CatalogApiKeyListItem {
  key_id: string;
  owner_user_id: string;
  scopes: string[];
  created_at: number;
  revoked_at: number | null;
  last_used_at?: number | null;
}

function catalogApiKeyPepper(): string {
  return (
    process.env.CAIPE_CATALOG_API_KEY_PEPPER?.trim() ||
    process.env.SKILLS_API_KEY_PEPPER?.trim() ||
    ""
  );
}

async function deriveCatalogApiKeyDigest(secret: string,salt: string): Promise<Buffer> {
  return new Promise((resolve,reject) => {
    scrypt(secret,salt,SCRYPT_KEY_LEN,SCRYPT_OPTIONS,(error,derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

async function hashCatalogApiKeySecret(
  keyId: string,
  secret: string,
): Promise<string> {
  const pepper = catalogApiKeyPepper();
  const digest = await deriveCatalogApiKeyDigest(`${pepper}:${secret}`,keyId);
  return `${SCRYPT_PREFIX}:${digest.toString("base64url")}`;
}

function safeStringEqual(left: string,right: string): boolean {
  const leftBytes = Buffer.from(left,"utf8");
  const rightBytes = Buffer.from(right,"utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes,rightBytes)
  );
}

async function isCatalogApiKeySecretMatch(
  keyId: string,
  secret: string,
  storedHash: string,
): Promise<boolean> {
  const expectedHash = await hashCatalogApiKeySecret(keyId,secret);
  return safeStringEqual(storedHash,expectedHash);
}

function randomAlphanumeric(length: number): string {
  let out = "";
  while (out.length < length) {
    out += ALPHABET[randomInt(ALPHABET.length)]!;
  }
  return out;
}

function requireMongoCollection() {
  if (!isMongoDBConfigured) {
    throw new Error("MongoDB unavailable for catalog_api_keys");
  }
}

/**
 * Resolve the Keycloak subject used as `owner_user_id` (matches Python `_catalog_api_key_owner`).
 */
export function resolveCatalogApiKeyOwnerId(session: {
  sub?: unknown;
}): string | null {
  if (typeof session.sub === "string" && session.sub.trim()) {
    return session.sub.trim();
  }
  return null;
}

export async function createCatalogApiKey(
  ownerUserId: string,
  scopes: string[] = ["catalog:read"],
): Promise<{ key: string; key_id: string }> {
  requireMongoCollection();
  const collection = await getCollection<CatalogApiKeyDocument>(COLLECTION);
  const keyId = `${KEY_ID_PREFIX}${randomAlphanumeric(KEY_ID_RANDOM_LEN)}`;
  const secret = randomAlphanumeric(SECRET_LEN);
  const fullKey = `${keyId}.${secret}`;
  const now = Date.now() / 1000;

  const doc: CatalogApiKeyDocument = {
    key_id: keyId,
    key_hash: await hashCatalogApiKeySecret(keyId,secret),
    owner_user_id: ownerUserId,
    scopes,
    created_at: now,
    revoked_at: null,
  };
  await collection.insertOne(doc);

  return { key: fullKey, key_id: keyId };
}

export async function listCatalogApiKeys(
  ownerUserId: string,
): Promise<CatalogApiKeyListItem[]> {
  if (!isMongoDBConfigured) {
    return [];
  }
  const collection = await getCollection<CatalogApiKeyDocument>(COLLECTION);
  const docs = await collection
    .find({ owner_user_id: ownerUserId })
    .project({ key_hash: 0 })
    .sort({ created_at: -1 })
    .toArray();

  return docs
    .filter((doc) => doc.key_id)
    .map((doc) => ({
      key_id: doc.key_id,
      owner_user_id: doc.owner_user_id,
      scopes: doc.scopes ?? ["catalog:read"],
      created_at: doc.created_at,
      revoked_at: doc.revoked_at ?? null,
      last_used_at: doc.last_used_at ?? null,
    }));
}

export async function getCatalogApiKeyOwnerIfActive(
  keyId: string,
): Promise<string | null> {
  if (!isMongoDBConfigured) {
    return null;
  }
  const collection = await getCollection<CatalogApiKeyDocument>(COLLECTION);
  const doc = await collection.findOne(
    { key_id: keyId },
    { projection: { owner_user_id: 1, revoked_at: 1 } },
  );
  if (!doc || doc.revoked_at != null) {
    return null;
  }
  return doc.owner_user_id ?? null;
}

export async function revokeCatalogApiKey(keyId: string): Promise<boolean> {
  if (!isMongoDBConfigured) {
    return false;
  }
  const collection = await getCollection<CatalogApiKeyDocument>(COLLECTION);
  const result = await collection.updateOne(
    { key_id: keyId },
    { $set: { revoked_at: Date.now() / 1000 } },
  );
  return result.modifiedCount > 0;
}

/** Validate a raw key; returns owner_user_id when valid (for catalog auth paths). */
export async function verifyCatalogApiKey(
  rawKey: string,
): Promise<string | null> {
  const trimmed = (rawKey || "").trim();
  const dot = trimmed.indexOf(".");
  if (dot <= 0) {
    return null;
  }
  const keyId = trimmed.slice(0, dot).trim();
  const secret = trimmed.slice(dot + 1).trim();
  if (!keyId || !secret) {
    return null;
  }

  if (!isMongoDBConfigured) {
    return null;
  }

  const collection = await getCollection<CatalogApiKeyDocument>(COLLECTION);
  const doc = await collection.findOne(
    { key_id: keyId, revoked_at: null },
    { projection: { key_hash: 1, owner_user_id: 1, scopes: 1, expires_at: 1 } },
  );
  if (
    !doc ||
    (typeof doc.expires_at === "number" && doc.expires_at <= Date.now() / 1000) ||
    !Array.isArray(doc.scopes) ||
    !doc.scopes.includes("catalog:read") ||
    !(await isCatalogApiKeySecretMatch(keyId,secret,doc.key_hash))
  ) {
    return null;
  }

  try {
    await collection.updateOne(
      { key_id: keyId },
      { $set: { last_used_at: Date.now() / 1000 } },
    );
  } catch {
    // best-effort
  }

  return doc.owner_user_id ?? null;
}

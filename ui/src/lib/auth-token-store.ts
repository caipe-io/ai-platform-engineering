// assisted-by Codex Codex-sonnet-4-6
import crypto from 'crypto';

import { getCollection, isMongoDBConfigured } from './mongodb';

export interface StoredTokens {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
}

interface L1Entry {
  tokens: StoredTokens;
  expiresAt: number; // unix seconds
}

interface TokenStoreDoc {
  _id: string;
  enc: string; // base64(iv[12] || authTag[16] || ciphertext)
  updatedAt: Date;
}

const COLLECTION = 'auth_token_cache';
const L1_TTL_S = 60; // seconds — short enough for cross-pod consistency
const HKDF_INFO = 'caipe-auth-token-store-v1';

const _l1 = new Map<string, L1Entry>();

function _deriveKey(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET is not set');
  return Buffer.from(crypto.hkdfSync('sha256', secret, '', HKDF_INFO, 32));
}

function _encrypt(tokens: StoredTokens): string {
  const key = _deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(tokens))),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function _decrypt(enc: string): StoredTokens {
  const key = _deriveKey();
  const buf = Buffer.from(enc, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(),
  ) as StoredTokens;
}

function _l1Get(sub: string): StoredTokens | undefined {
  const entry = _l1.get(sub);
  if (!entry) return undefined;
  if (Math.floor(Date.now() / 1000) >= entry.expiresAt) {
    _l1.delete(sub);
    return undefined;
  }
  return entry.tokens;
}

function _l1Set(sub: string, tokens: StoredTokens): void {
  _l1.set(sub, {
    tokens,
    expiresAt: Math.floor(Date.now() / 1000) + L1_TTL_S,
  });
}

/**
 * Read stored OAuth tokens for a user.
 * L1 (in-memory, 60s TTL) is checked first; on miss, falls back to MongoDB.
 */
export async function getStoredTokens(sub: string | undefined): Promise<StoredTokens | undefined> {
  if (!sub) return undefined;

  const l1 = _l1Get(sub);
  if (l1) return l1;

  if (!isMongoDBConfigured) return undefined;

  try {
    const col = await getCollection<TokenStoreDoc>(COLLECTION);
    const doc = await col.findOne({ _id: sub } as Parameters<typeof col.findOne>[0]);
    if (!doc) return undefined;
    const tokens = _decrypt(doc.enc);
    _l1Set(sub, tokens);
    return tokens;
  } catch (err) {
    console.error('[auth-token-store] MongoDB read error:', err);
    return undefined;
  }
}

/**
 * Persist OAuth tokens for a user.
 * Writes to L1 immediately and to MongoDB asynchronously (non-fatal on failure).
 * Tokens are AES-256-GCM encrypted before storage; key derived from NEXTAUTH_SECRET via HKDF.
 */
export async function storeTokens(sub: string | undefined, tokens: StoredTokens): Promise<void> {
  if (!sub) return;

  _l1Set(sub, tokens);

  if (!isMongoDBConfigured) return;

  try {
    const enc = _encrypt(tokens);
    const col = await getCollection<TokenStoreDoc>(COLLECTION);
    await col.updateOne(
      { _id: sub } as Parameters<typeof col.updateOne>[0],
      { $set: { enc, updatedAt: new Date() } },
      { upsert: true },
    );
  } catch (err) {
    // Non-fatal: L1 still serves this pod; other pods may miss until next refresh
    console.error('[auth-token-store] MongoDB write error:', err);
  }
}

/** Remove persisted OAuth tokens and evict the local cache entry. */
export async function deleteStoredTokens(key: string | undefined): Promise<void> {
  if (!key) return;

  _l1.delete(key);

  if (!isMongoDBConfigured) return;

  try {
    const col = await getCollection<TokenStoreDoc>(COLLECTION);
    await col.deleteOne({ _id: key } as Parameters<typeof col.deleteOne>[0]);
  } catch (err) {
    console.error('[auth-token-store] MongoDB delete error:', err);
  }
}

/** Clear the L1 cache. For testing only. */
export function resetTokenStore(): void {
  _l1.clear();
}

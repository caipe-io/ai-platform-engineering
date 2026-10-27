import crypto from 'crypto';

import { getCollection, isMongoDBConfigured } from './mongodb';

export interface StoredTokens {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
}

export interface StoredTokenState extends StoredTokens {
  version: number;
}

interface TokenStoreDoc {
  _id: string;
  enc: string; // base64(iv[12] || authTag[16] || ciphertext)
  updatedAt: Date;
  version?: number;
  refreshLease?: { owner: string; until: Date };
}

const COLLECTION = 'auth_token_cache';
const HKDF_INFO = 'caipe-auth-token-store-v1';
const LEASE_MS = 30_000;
const WAIT_MS = 20_000;
const readOptions = { readPreference: 'primary' as const, readConcern: { level: 'majority' as const }, maxTimeMS: 5000 };
const writeOptions = { writeConcern: { w: 'majority' as const, wtimeoutMS: 5000 }, maxTimeMS: 5000 };

// Only standalone instances without MongoDB use process-local credentials.
const localTokens = new Map<string, StoredTokenState>();
const localRefreshes = new Map<string, { version: number; promise: Promise<StoredTokenState> }>();
const failedLocalRefreshes = new Set<string>();

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

/** Expiry metadata only; bearer signature validation remains with its caller. */
export function accessTokenExpiry(accessToken?: string, expiresAt?: number): number | undefined {
  let jwtExpiry: number | undefined;
  try {
    const claims = JSON.parse(Buffer.from(accessToken?.split('.')[1] ?? '', 'base64url').toString());
    if (typeof claims.exp === 'number' && Number.isFinite(claims.exp)) jwtExpiry = claims.exp;
  } catch { /* Opaque tokens use the expiry from their trusted OAuth response. */ }
  const candidates = [jwtExpiry, expiresAt].filter((value): value is number =>
    typeof value === 'number' && Number.isFinite(value));
  return candidates.length ? Math.min(...candidates) : undefined;
}

function stateFromDoc(doc: TokenStoreDoc): StoredTokenState {
  const tokens = _decrypt(doc.enc);
  return { ...tokens, expiresAt: accessTokenExpiry(tokens.accessToken, tokens.expiresAt), version: doc.version ?? 0 };
}

async function collection() {
  return getCollection<TokenStoreDoc>(COLLECTION);
}

/** Read credentials and expiry together from the primary, including legacy records. */
export async function getStoredTokens(sub: string | undefined): Promise<StoredTokenState | undefined> {
  if (!sub) return undefined;
  if (!isMongoDBConfigured) return localTokens.get(sub);
  try {
    const doc = await (await collection()).findOne({ _id: sub }, readOptions);
    return doc ? stateFromDoc(doc) : undefined;
  } catch {
    throw new Error('Shared token store unavailable');
  }
}

/** Publish a trusted login durably; a new login also fences any older refresh. */
export async function storeTokens(sub: string | undefined, tokens: StoredTokens): Promise<StoredTokenState | undefined> {
  if (!sub) return;
  const credentials = { ...tokens, expiresAt: accessTokenExpiry(tokens.accessToken, tokens.expiresAt) };
  if (!isMongoDBConfigured) {
    const state = { ...credentials, version: (localTokens.get(sub)?.version ?? 0) + 1 };
    localTokens.set(sub, state);
    failedLocalRefreshes.delete(sub);
    return state;
  }
  try {
    const doc = await (await collection()).findOneAndUpdate(
      { _id: sub },
      { $set: { enc: _encrypt(credentials), updatedAt: new Date() }, $inc: { version: 1 }, $unset: { refreshLease: '' } },
      { upsert: true, returnDocument: 'after', ...writeOptions },
    );
    if (!doc) throw new Error('Missing token record');
    return stateFromDoc(doc);
  } catch {
    throw new Error('Shared token store unavailable');
  }
}

/**
 * Adapt the shared refresh lease to existing user-keyed records. Version, owner,
 * and encrypted-record fencing stop a late response replacing a fresh login.
 */
export async function refreshStoredTokens(
  sub: string,
  expectedVersion: number,
  exchange: (tokens: StoredTokenState) => Promise<StoredTokens>,
): Promise<StoredTokenState> {
  if (!isMongoDBConfigured) {
    const current = localTokens.get(sub);
    if (!current) throw new Error('RefreshTokenExpired');
    if (current.version !== expectedVersion) return current;
    if (failedLocalRefreshes.has(sub)) throw new Error('RefreshTokenExpired');
    const pending = localRefreshes.get(sub);
    if (pending?.version === expectedVersion) return pending.promise;
    const refresh = (async () => {
      try {
        const fresh = await exchange(current);
        const latest = localTokens.get(sub);
        if (latest && latest.version !== expectedVersion) return latest;
        return (await storeTokens(sub, fresh))!;
      } catch (error) {
        const latest = localTokens.get(sub);
        if (latest && latest.version !== expectedVersion) return latest;
        failedLocalRefreshes.add(sub);
        throw error;
      } finally {
        if (localRefreshes.get(sub)?.version === expectedVersion) localRefreshes.delete(sub);
      }
    })();
    localRefreshes.set(sub, { version: expectedVersion, promise: refresh });
    return refresh;
  }

  const col = await collection();
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const doc = await col.findOne({ _id: sub }, readOptions);
    if (!doc) throw new Error('RefreshTokenExpired');
    const current = stateFromDoc(doc);
    if (current.version !== expectedVersion) return current;
    // A lost response may have consumed the provider token. A new login clears
    // this lease; another refresh must never replay that ambiguous credential.
    if (doc.refreshLease && doc.refreshLease.until.getTime() <= Date.now()) throw new Error('RefreshTokenExpired');
    if (doc.refreshLease) {
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    const owner = crypto.randomUUID();
    const claimed = await col.updateOne({ _id: sub, enc: doc.enc, refreshLease: { $exists: false } }, {
      $set: { refreshLease: { owner, until: new Date(Date.now() + LEASE_MS) } },
    }, writeOptions);
    if (!claimed.matchedCount) continue;
    try {
      const fresh = await exchange(current);
      const credentials = { ...fresh, expiresAt: accessTokenExpiry(fresh.accessToken, fresh.expiresAt) };
      const saved = await col.updateOne({ _id: sub, enc: doc.enc, 'refreshLease.owner': owner,
        'refreshLease.until': { $gt: new Date() } }, {
        $set: { enc: _encrypt(credentials), updatedAt: new Date() },
        $inc: { version: 1 }, $unset: { refreshLease: '' },
      }, writeOptions);
      if (saved.matchedCount) {
        const published = await getStoredTokens(sub);
        if (published) return published;
      }
      throw new Error('RefreshTokenExpired');
    } catch (error) {
      const latest = await col.findOne({ _id: sub }, readOptions);
      if (latest && latest.enc !== doc.enc) return stateFromDoc(latest);
      throw error;
    }
  }
  throw new Error('RefreshTokenError');
}

/** Reset standalone-only state for tests. */
export function resetTokenStore(): void {
  localTokens.clear();
  localRefreshes.clear();
  failedLocalRefreshes.clear();
}

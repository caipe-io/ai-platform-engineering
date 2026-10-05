import crypto from 'crypto';
import { getCollection, isMongoDBConfigured } from './mongodb';

export const SESSION_FORMAT = 2;
export const SESSION_MAX_AGE = 24 * 60 * 60;
const COLLECTION = 'auth_sessions';
const LEASE_MS = 30_000;
const WAIT_MS = 12_000;

export interface StoredTokens {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  refreshTokenExpiresAt?: number;
  idToken?: string;
}

interface SessionDoc {
  _id: string;
  sub: string;
  enc: string;
  version: number;
  expiresAt: Date;
  refreshLease?: { owner: string; until: Date };
}

export interface StoredSession extends StoredTokens {
  sessionId: string;
  sessionVersion: number;
  sessionExpiresAt: number;
}

export class SessionExpiredError extends Error {
  constructor() { super('Your session has expired. Please sign in again.'); }
}

export class SessionUnavailableError extends Error {
  constructor() { super('Sign-in services are temporarily unavailable. Please retry.'); }
}

/** A definitive provider failure before rotation, safe to retry later. */
export class RefreshRetryableError extends SessionUnavailableError {}

function cryptKey(): Buffer {
  if (!process.env.NEXTAUTH_SECRET) throw new SessionUnavailableError();
  return Buffer.from(crypto.hkdfSync('sha256', process.env.NEXTAUTH_SECRET, '', 'caipe-auth-session-v2', 32));
}

function encrypt(tokens: StoredTokens, id: string, sub: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cryptKey(), iv);
  cipher.setAAD(Buffer.from(JSON.stringify([id, sub])));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function unpack(doc: SessionDoc): StoredSession {
  try {
    const bytes = Buffer.from(doc.enc, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', cryptKey(), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(JSON.stringify([doc._id, doc.sub])));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const tokens: StoredTokens = JSON.parse(Buffer.concat([
      decipher.update(bytes.subarray(28)), decipher.final(),
    ]).toString());
    if (!tokens.accessToken || !Number.isFinite(tokens.expiresAt)) throw new Error('Invalid record');
    return { ...tokens, sessionId: doc._id, sessionVersion: doc.version,
      sessionExpiresAt: Math.floor(doc.expiresAt.getTime() / 1000) };
  } catch {
    // Never log encrypted records, credentials, or driver errors containing them.
    throw new SessionUnavailableError();
  }
}

async function collection() {
  if (!isMongoDBConfigured) throw new SessionUnavailableError();
  try { return await getCollection<SessionDoc>(COLLECTION); }
  catch { throw new SessionUnavailableError(); }
}

const writeOptions = { writeConcern: { w: 'majority' as const, wtimeoutMS: 5000 }, maxTimeMS: 5000 };

/** A fresh login owns a new record; encoding cookies never writes credentials. */
export async function createSession(sub: string, tokens: StoredTokens): Promise<StoredSession> {
  const id = crypto.randomUUID();
  const doc: SessionDoc = { _id: id, sub, enc: encrypt(tokens, id, sub), version: 1,
    expiresAt: new Date(Date.now() + SESSION_MAX_AGE * 1000) };
  try { await (await collection()).insertOne(doc, writeOptions); }
  catch { throw new SessionUnavailableError(); }
  return unpack(doc);
}

async function readSession(id: string, sub: string): Promise<SessionDoc> {
  let doc: SessionDoc | null;
  try {
    doc = await (await collection()).findOne({ _id: id, sub }, {
      readPreference: 'primary', readConcern: { level: 'majority' }, maxTimeMS: 5000,
    });
  } catch { throw new SessionUnavailableError(); }
  if (!doc || doc.expiresAt.getTime() <= Date.now()) throw new SessionExpiredError();
  return doc;
}

export async function getStoredSession(id: string, sub: string): Promise<StoredSession> {
  return unpack(await readSession(id, sub));
}

export async function revokeSession(id: string, sub: string): Promise<void> {
  try { await (await collection()).deleteOne({ _id: id, sub }, writeOptions); }
  catch { throw new SessionUnavailableError(); }
}

/**
 * A Mongo lease serializes refreshes across processes. Version + owner fencing
 * prevents a late request overwriting a winner or recreating a logged-out session.
 * An abandoned exchange is ambiguous: its refresh token may have been consumed.
 * Expire that session instead of replaying the old refresh token.
 */
export async function refreshSession(
  id: string, sub: string, expectedVersion: number,
  exchange: (tokens: StoredTokens) => Promise<StoredTokens>,
): Promise<StoredSession> {
  const deadline = Date.now() + WAIT_MS;
  const col = await collection();
  while (Date.now() < deadline) {
    const doc = await readSession(id, sub);
    if (doc.version !== expectedVersion) return unpack(doc);
    if (doc.refreshLease && doc.refreshLease.until.getTime() <= Date.now()) {
      try {
        const deleted = await col.deleteOne({ _id: id, sub, version: doc.version,
          'refreshLease.owner': doc.refreshLease.owner }, writeOptions);
        if (!deleted.deletedCount) continue;
      } catch { throw new SessionUnavailableError(); }
      throw new SessionExpiredError();
    }
    if (doc.refreshLease) {
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    const owner = crypto.randomUUID();
    let acquired;
    try {
      acquired = await col.updateOne({ _id: id, sub, version: doc.version,
        expiresAt: { $gt: new Date() }, refreshLease: { $exists: false } }, {
        $set: { refreshLease: { owner, until: new Date(Date.now() + LEASE_MS) } },
      }, writeOptions);
    } catch { throw new SessionUnavailableError(); }
    if (!acquired.matchedCount) continue;

    const fence = { _id: id, sub, version: doc.version, 'refreshLease.owner': owner };
    try {
      const fresh = await exchange(unpack(doc));
      const enc = encrypt(fresh, id, sub);
      const saved = await col.updateOne({ ...fence, expiresAt: { $gt: new Date() },
        'refreshLease.until': { $gt: new Date() } }, {
        $set: { enc }, $inc: { version: 1 }, $unset: { refreshLease: '' },
      }, writeOptions);
      if (!saved.matchedCount) {
        await readSession(id, sub);
        throw new SessionExpiredError();
      }
      return await getStoredSession(id, sub);
    } catch (error) {
      try {
        if (error instanceof SessionExpiredError) await col.deleteOne(fence, writeOptions);
        if (error instanceof RefreshRetryableError) {
          await col.updateOne(fence, { $unset: { refreshLease: '' } }, writeOptions);
        }
      } catch { throw new SessionUnavailableError(); }
      // Unknown outcomes retain the lease: the provider may have rotated the token.
      if (error instanceof SessionExpiredError) throw error;
      throw new SessionUnavailableError();
    }
  }
  throw new SessionUnavailableError();
}

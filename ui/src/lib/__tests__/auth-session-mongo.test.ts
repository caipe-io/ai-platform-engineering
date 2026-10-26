/** @jest-environment node */
import crypto from 'crypto';
import { MongoClient, type Db } from 'mongodb';
let mockDb: Db;
jest.mock('../mongodb', () => ({
  isMongoDBConfigured: true,
  getCollection: jest.fn(async (name: string) => mockDb.collection(name)),
}));
import * as store from '../auth-token-store';

const uri = process.env.AUTH_SESSION_TEST_MONGODB_URI;
const describeMongo = uri ? describe : describe.skip;
describeMongo('session coordination with real MongoDB', () => {
  let client: MongoClient;
  let peer: typeof store;
  const sub = 'test-user';
  const credentials = { accessToken: 'old', refreshToken: 'refresh', expiresAt: 1 };
  beforeAll(async () => {
    process.env.NEXTAUTH_SECRET = 'example-session-test-secret';
    client = await new MongoClient(uri!).connect();
    // Random test-owned database; never use MONGODB_DATABASE or deployment data.
    mockDb = client.db(`caipe_session_test_${crypto.randomUUID().replaceAll('-', '')}`);
    jest.isolateModules(() => { peer = jest.requireActual('../auth-token-store'); });
  });
  afterAll(async () => { if (mockDb) await mockDb.dropDatabase(); await client?.close(); });

  it('publishes login durably before a different process can read it', async () => {
    const login = await store.createSession(sub, credentials);
    expect(await peer.getStoredSession(login.sessionId, sub)).toMatchObject(credentials);
  });

  it('uses Mongo atomic fencing to perform one refresh across two independent modules', async () => {
    const login = await store.createSession(sub, credentials);
    const exchange = jest.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { ...credentials, accessToken: 'fresh', expiresAt: 9999999999 };
    });
    const [one, two] = await Promise.all([
      store.refreshSession(login.sessionId, sub, 1, exchange),
      peer.refreshSession(login.sessionId, sub, 1, exchange),
    ]);
    expect(one).toEqual(two);
    expect(one.sessionVersion).toBe(2);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('cannot republish tokens after logout wins on another replica', async () => {
    const login = await store.createSession(sub, credentials);
    await expect(store.refreshSession(login.sessionId, sub, 1, async () => {
      await peer.revokeSession(login.sessionId, sub);
      return { ...credentials, accessToken: 'fresh' };
    })).rejects.toBeInstanceOf(store.SessionExpiredError);
    expect(await mockDb.collection('auth_sessions').countDocuments({ _id: login.sessionId as never })).toBe(0);
  });

  it.each([false, true])('a late refresh cannot alter a separate login for the same user (failure=%s)', async failure => {
    const first = await store.createSession(sub, credentials);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = store.refreshSession(first.sessionId, sub, 1, async () => {
      entered();
      await gate;
      if (failure) throw new store.SessionExpiredError();
      return { ...credentials, accessToken: 'late-response' };
    });
    // Attach both outcomes before releasing the refresh so rejection is observed.
    const outcome = failure
      ? expect(pending).rejects.toBeInstanceOf(store.SessionExpiredError)
      : expect(pending).resolves.toMatchObject({ accessToken: 'late-response' });
    await started;
    const secondCredentials = { ...credentials, accessToken: 'new-login', expiresAt: 9999999999 };
    const second = await peer.createSession(sub, secondCredentials);
    release();
    await outcome;
    expect(await peer.getStoredSession(second.sessionId, sub)).toMatchObject({
      ...secondCredentials, sessionVersion: 1,
    });
  });

  it('never replays an abandoned refresh token, while a new login restores access', async () => {
    const login = await store.createSession(sub, credentials);
    await expect(store.refreshSession(login.sessionId, sub, 1, async () => {
      throw new Error('response lost');
    })).rejects.toBeInstanceOf(store.SessionUnavailableError);
    await mockDb.collection('auth_sessions').updateOne({ _id: login.sessionId as never }, {
      $set: { 'refreshLease.until': new Date(0) },
    });
    const exchange = jest.fn();
    await expect(peer.refreshSession(login.sessionId, sub, 1, exchange))
      .rejects.toBeInstanceOf(peer.SessionExpiredError);
    expect(exchange).not.toHaveBeenCalled();
    const replacement = await store.createSession(sub, { ...credentials, accessToken: 'new-login' });
    expect(await peer.getStoredSession(replacement.sessionId, sub)).toMatchObject({ accessToken: 'new-login' });
  });

  it('fences refresh responses arriving after their lease deadline', async () => {
    const login = await store.createSession(sub, credentials);
    await expect(store.refreshSession(login.sessionId, sub, 1, async () => {
      await mockDb.collection('auth_sessions').updateOne({ _id: login.sessionId as never }, {
        $set: { 'refreshLease.until': new Date(0) },
      });
      return { ...credentials, accessToken: 'late-response' };
    })).rejects.toBeInstanceOf(store.SessionExpiredError);
    await expect(peer.getStoredSession(login.sessionId, sub)).rejects.toBeInstanceOf(peer.SessionExpiredError);
  });

  it('shares definite-failure cooldowns across replicas without overriding logout', async () => {
    const valid = { ...credentials, expiresAt: Math.floor(Date.now() / 1000) + 240 };
    const login = await store.createSession(sub, valid);
    const exchange = jest.fn(async (sessions: typeof store) => {
      await new Promise(resolve => setTimeout(resolve, 100));
      throw new sessions.RefreshRetryableError();
    });
    const [one, two] = await Promise.all([
      store.refreshSession(login.sessionId, sub, 1, () => exchange(store)),
      peer.refreshSession(login.sessionId, sub, 1, () => exchange(peer)),
    ]);
    expect(one).toMatchObject(valid);
    expect(two).toEqual(one);
    expect(exchange).toHaveBeenCalledTimes(1);
    await peer.revokeSession(login.sessionId, sub);
    await expect(store.refreshSession(login.sessionId, sub, 1, () => exchange(store))).rejects.toBeInstanceOf(store.SessionExpiredError);
    expect(exchange).toHaveBeenCalledTimes(1);
  });
});

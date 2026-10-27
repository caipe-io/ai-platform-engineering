/** @jest-environment node */
import crypto from 'crypto';
import { MongoClient, type Db } from 'mongodb';

let mockDb: Db;
jest.mock('../mongodb', () => ({
  isMongoDBConfigured: true,
  getCollection: jest.fn(async (name: string) => mockDb.collection(name)),
}));
import * as store from '../auth-token-store';

const uri = process.env.AUTH_TOKEN_STORE_TEST_MONGODB_URI;
const describeMongo = uri ? describe : describe.skip;
describeMongo('shared session consistency with independent module instances', () => {
  let client: MongoClient;
  let peer: typeof store;
  const sub = 'test-user';
  const initial = { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1 };
  const fresh = { accessToken: 'fresh-access', refreshToken: 'fresh-refresh', expiresAt: 9999999999 };
  beforeAll(async () => {
    process.env.NEXTAUTH_SECRET = 'example-session-consistency-secret';
    client = await new MongoClient(uri!).connect();
    mockDb = client.db(`test_session_consistency_${crypto.randomUUID().replaceAll('-', '')}`);
    jest.isolateModules(() => { peer = jest.requireActual('../auth-token-store'); });
  });
  beforeEach(async () => { await mockDb.collection('auth_sessions').deleteMany({}); });
  afterAll(async () => { if (mockDb) await mockDb.dropDatabase(); await client?.close(); });

  it('publishes each login and its expiry immediately without replacing another login', async () => {
    const old = await store.createSession(sub, initial);
    expect(await peer.getStoredSession(old.sessionId, sub)).toMatchObject(initial);
    const next = await store.createSession(sub, fresh);
    expect(next.sessionId).not.toBe(old.sessionId);
    expect(await peer.getStoredSession(next.sessionId, sub)).toMatchObject({ ...fresh, sessionVersion: 1 });
    expect(await peer.getStoredSession(old.sessionId, sub)).toMatchObject(initial);
  });

  it('performs only one rotating-token exchange across module instances', async () => {
    const login = await store.createSession(sub, initial);
    const exchange = jest.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return fresh;
    });
    const [one, two] = await Promise.all([
      store.refreshSession(login.sessionId, sub, 1, exchange), peer.refreshSession(login.sessionId, sub, 1, exchange),
    ]);
    expect(one).toEqual(two);
    expect(one).toMatchObject({ ...fresh, sessionVersion: 2 });
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('a late refresh cannot restore logout or change another login (failure=%s)', async failure => {
    const login = await store.createSession(sub, initial);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const refresh = store.refreshSession(login.sessionId, sub, 1, async () => {
      entered(); await gate;
      if (failure) throw new Error('provider rejected refresh');
      return { ...fresh, accessToken: 'late-response' };
    });
    await started;
    await peer.revokeSession(login.sessionId, sub);
    const next = await peer.createSession(sub, fresh);
    release();
    await expect(refresh).rejects.toThrow(/session has expired|temporarily unavailable/);
    await expect(peer.getStoredSession(login.sessionId, sub)).rejects.toThrow(/session has expired/);
    expect(await peer.getStoredSession(next.sessionId, sub)).toMatchObject(fresh);
  });

  it('never replays an abandoned refresh; a new login restores progress', async () => {
    const login = await store.createSession(sub, initial);
    await expect(store.refreshSession(login.sessionId, sub, 1, async () => {
      throw new Error('response lost');
    })).rejects.toThrow(/temporarily unavailable/);
    const exchange = jest.fn(async () => fresh);
    await mockDb.collection('auth_sessions').updateOne({ _id: login.sessionId as never }, {
      $set: { 'refreshLease.until': new Date(0) },
    });
    await expect(peer.refreshSession(login.sessionId, sub, 1, exchange)).rejects.toThrow(/session has expired/);
    expect(exchange).not.toHaveBeenCalled();
    const next = await peer.createSession(sub, fresh);
    expect(await peer.getStoredSession(next.sessionId, sub)).toMatchObject(fresh);
  });

  it('fences a response that arrives after its refresh lease expires', async () => {
    const login = await store.createSession(sub, initial);
    await expect(store.refreshSession(login.sessionId, sub, 1, async () => {
      await mockDb.collection('auth_sessions').updateOne({ _id: login.sessionId as never }, {
        $set: { 'refreshLease.until': new Date(0) },
      });
      return fresh;
    })).rejects.toThrow(/session has expired/);
    await expect(peer.getStoredSession(login.sessionId, sub)).rejects.toThrow(/session has expired/);
  });

  it('does not treat an old per-user token-cache record as a new login session', async () => {
    await mockDb.collection('auth_token_cache').insertOne({ _id: sub as never, enc: 'legacy-record', updatedAt: new Date() });
    await expect(peer.getStoredSession(sub, sub)).rejects.toThrow(/session has expired/);
    const login = await peer.createSession(sub, fresh);
    expect(login.sessionId).not.toBe(sub);
    expect(await peer.getStoredSession(login.sessionId, sub)).toMatchObject(fresh);
  });
});

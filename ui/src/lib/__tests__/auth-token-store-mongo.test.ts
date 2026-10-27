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
describeMongo('shared token consistency with independent replicas', () => {
  let client: MongoClient;
  let peer: typeof store;
  const sub = 'test-user';
  const initial = { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1 };
  const fresh = { accessToken: 'fresh-access', refreshToken: 'fresh-refresh', expiresAt: 9999999999 };
  beforeAll(async () => {
    process.env.NEXTAUTH_SECRET = 'example-token-consistency-secret';
    client = await new MongoClient(uri!).connect();
    mockDb = client.db(`test_token_consistency_${crypto.randomUUID().replaceAll('-', '')}`);
    jest.isolateModules(() => { peer = jest.requireActual('../auth-token-store'); });
  });
  beforeEach(async () => { await mockDb.collection('auth_token_cache').deleteMany({}); });
  afterAll(async () => { if (mockDb) await mockDb.dropDatabase(); await client?.close(); });

  it('makes a new login and its matching expiry visible on another replica immediately', async () => {
    await store.storeTokens(sub, initial);
    expect(await peer.getStoredTokens(sub)).toMatchObject(initial);
    await store.storeTokens(sub, fresh);
    expect(await peer.getStoredTokens(sub)).toMatchObject({ ...fresh, version: 2 });
  });

  it('performs only one rotating-token exchange across replicas', async () => {
    await store.storeTokens(sub, initial);
    const exchange = jest.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return fresh;
    });
    const [one, two] = await Promise.all([
      store.refreshStoredTokens(sub, 1, exchange), peer.refreshStoredTokens(sub, 1, exchange),
    ]);
    expect(one).toEqual(two);
    expect(one).toMatchObject({ ...fresh, version: 2 });
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('a late refresh cannot overwrite or invalidate a newer login (failure=%s)', async failure => {
    await store.storeTokens(sub, initial);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const refresh = store.refreshStoredTokens(sub, 1, async () => {
      entered(); await gate;
      if (failure) throw new Error('RefreshTokenExpired');
      return { ...fresh, accessToken: 'late-response' };
    });
    await started;
    await peer.storeTokens(sub, fresh);
    release();
    expect(await refresh).toMatchObject(fresh);
    expect(await peer.getStoredTokens(sub)).toMatchObject(fresh);
  });

  it('never replays a refresh token after an abandoned exchange; login restores progress', async () => {
    await store.storeTokens(sub, initial);
    await expect(store.refreshStoredTokens(sub, 1, async () => {
      throw new Error('response lost');
    })).rejects.toThrow('response lost');
    const exchange = jest.fn(async () => fresh);
    await mockDb.collection('auth_token_cache').updateOne({ _id: sub as never }, {
      $set: { 'refreshLease.until': new Date(0) },
    });
    await expect(peer.refreshStoredTokens(sub, 1, exchange)).rejects.toThrow('RefreshTokenExpired');
    expect(exchange).not.toHaveBeenCalled();
    await store.storeTokens(sub, fresh);
    expect(await peer.refreshStoredTokens(sub, 2, exchange)).toMatchObject(fresh);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('fences a response that arrives after its refresh lease expires', async () => {
    await store.storeTokens(sub, initial);
    await expect(store.refreshStoredTokens(sub, 1, async () => {
      await mockDb.collection('auth_token_cache').updateOne({ _id: sub as never }, {
        $set: { 'refreshLease.until': new Date(0) },
      });
      return fresh;
    })).rejects.toThrow('RefreshTokenExpired');
    expect(await peer.getStoredTokens(sub)).toMatchObject(initial);
  });

  it('reads the existing encryption format and derives a legacy JWT expiry', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ exp: 5000 })).toString('base64url')}.signature`;
    const key = Buffer.from(crypto.hkdfSync('sha256', process.env.NEXTAUTH_SECRET!, '', 'caipe-auth-token-store-v1', 32));
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ accessToken: token, refreshToken: 'legacy-refresh' })), cipher.final()]);
    const enc = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    await mockDb.collection('auth_token_cache').insertOne({ _id: sub as never, enc, updatedAt: new Date() });
    expect(await peer.getStoredTokens(sub)).toMatchObject({ accessToken: token, expiresAt: 5000, version: 0 });
  });
});

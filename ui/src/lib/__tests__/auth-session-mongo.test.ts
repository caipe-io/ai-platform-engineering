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
});

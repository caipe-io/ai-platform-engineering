/** @jest-environment node */
type Doc = Record<string, unknown>;
const mockDocuments = new Map<string, Doc>();
const mockMatches = (doc: Doc, filter: Doc): boolean => Object.entries(filter).every(([key, condition]) => {
  if (key === '$or') return (condition as Doc[]).some(branch => mockMatches(doc, branch));
  const actual = key.split('.').reduce<unknown>((value, field) => (value as Doc | undefined)?.[field], doc);
  if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
    const operator = condition as Doc;
    if ('$exists' in operator) return (actual !== undefined) === operator.$exists;
    if ('$gt' in operator) return (actual as number) > (operator.$gt as number);
    if ('$lte' in operator) return (actual as number) <= (operator.$lte as number);
  }
  return actual === condition;
});
const mockCollection = {
  insertOne: jest.fn(async (doc: Doc) => { mockDocuments.set(doc._id as string, structuredClone(doc)); }),
  findOne: jest.fn(async (filter: Doc) => structuredClone([...mockDocuments.values()].find(doc => mockMatches(doc, filter)) ?? null)),
  updateOne: jest.fn(async (filter: Doc, update: Doc) => {
    const doc = [...mockDocuments.values()].find(value => mockMatches(value, filter));
    if (!doc) return { matchedCount: 0 };
    Object.assign(doc, update.$set);
    for (const [key, value] of Object.entries((update.$inc as Doc) ?? {})) doc[key] = (doc[key] as number) + (value as number);
    for (const key of Object.keys((update.$unset as Doc) ?? {})) delete doc[key];
    return { matchedCount: 1 };
  }),
  deleteOne: jest.fn(async (filter: Doc) => {
    const doc = [...mockDocuments.values()].find(value => mockMatches(value, filter));
    if (!doc) return { deletedCount: 0 };
    mockDocuments.delete(doc._id as string);
    return { deletedCount: 1 };
  }),
};
jest.mock('../mongodb', () => ({
  isMongoDBConfigured: true,
  getCollection: jest.fn(async () => mockCollection),
}));

import * as store from '../auth-token-store';
import { getCollection } from '../mongodb';
import { exchangeRefreshToken } from '../auth-token-refresh';
import { authOptions } from '../auth-config';

const sub = 'test-user';
const tokens = { accessToken: 'old-token', refreshToken: 'refresh-token', expiresAt: 100 };
const fresh = { ...tokens, accessToken: 'fresh-token', expiresAt: 200 };
let peer!: typeof store;

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = 'example-test-secret';
  mockDocuments.clear();
  jest.clearAllMocks();
  jest.isolateModules(() => { peer = jest.requireActual('../auth-token-store'); });
});
afterEach(() => { jest.useRealTimers(); });

it('awaits durable creation and stores encrypted credentials and expiry together', async () => {
  let acknowledge!: () => void;
  mockCollection.insertOne.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
  let completed = false;
  const creating = store.createSession(sub, tokens).then(value => { completed = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  expect(completed).toBe(false);
  const doc = mockCollection.insertOne.mock.calls[0][0];
  expect(doc.enc).not.toContain('old-token');
  expect(doc.enc).not.toContain('refresh-token');
  expect(doc.enc).not.toContain('expiresAt');
  acknowledge();
  await creating;
  expect(mockCollection.insertOne).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    writeConcern: { w: 'majority', wtimeoutMS: 5000 },
  }));
});

it('login on A is immediately readable on B; two browsers for one user are independent', async () => {
  const first = await peer.createSession(sub, tokens);
  await peer.getStoredSession(first.sessionId, sub);
  const second = await store.createSession(sub, fresh);
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(await peer.getStoredSession(second.sessionId, sub)).toMatchObject(fresh);
  expect(await peer.getStoredSession(first.sessionId, sub)).toMatchObject(tokens);
});

it('replica B never returns its old credentials after A publishes a refresh', async () => {
  const login = await store.createSession(sub, tokens);
  await peer.getStoredSession(login.sessionId, sub);
  await store.refreshSession(login.sessionId, sub, 1, async () => fresh);
  expect(await peer.getStoredSession(login.sessionId, sub)).toMatchObject({ ...fresh, sessionVersion: 2 });
  expect(mockCollection.findOne).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ readPreference: 'primary' }));
});

it('serializes refresh across isolated modules and stale requests reuse the winner', async () => {
  const login = await store.createSession(sub, tokens);
  let finish!: (value: typeof fresh) => void;
  const exchange = jest.fn(() => new Promise<typeof fresh>(resolve => { finish = resolve; }));
  const a = store.refreshSession(login.sessionId, sub, 1, exchange);
  await new Promise(resolve => setImmediate(resolve));
  const b = peer.refreshSession(login.sessionId, sub, 1, exchange);
  finish(fresh);
  const [one, two] = await Promise.all([a, b]);
  expect(one).toEqual(two);
  expect(exchange).toHaveBeenCalledTimes(1);
  await store.refreshSession(login.sessionId, sub, 1, exchange);
  expect(exchange).toHaveBeenCalledTimes(1);
});

it('logout on another replica prevents a pending refresh from resurrecting the session', async () => {
  const login = await store.createSession(sub, tokens);
  await expect(store.refreshSession(login.sessionId, sub, 1, async () => {
    await peer.revokeSession(login.sessionId, sub);
    return fresh;
  })).rejects.toBeInstanceOf(store.SessionExpiredError);
  await expect(peer.getStoredSession(login.sessionId, sub)).rejects.toBeInstanceOf(peer.SessionExpiredError);
  expect(mockDocuments.size).toBe(0);
});

it('binds a record to its subject and rejects missing and expired sessions', async () => {
  const login = await store.createSession(sub, tokens);
  await expect(store.getStoredSession(login.sessionId, 'other-user')).rejects.toBeInstanceOf(store.SessionExpiredError);
  mockDocuments.get(login.sessionId)!.expiresAt = new Date(0);
  await expect(store.getStoredSession(login.sessionId, sub)).rejects.toBeInstanceOf(store.SessionExpiredError);
});

it('rejects swapped ciphertext rather than confusing two logins', async () => {
  const one = await store.createSession(sub, tokens);
  const two = await store.createSession(sub, fresh);
  mockDocuments.get(one.sessionId)!.enc = mockDocuments.get(two.sessionId)!.enc;
  await expect(store.getStoredSession(one.sessionId, sub)).rejects.toBeInstanceOf(store.SessionUnavailableError);
});

it('distinguishes storage outages from expired sessions, without serving cached tokens', async () => {
  const login = await store.createSession(sub, tokens);
  await store.getStoredSession(login.sessionId, sub);
  mockCollection.findOne.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(store.getStoredSession(login.sessionId, sub)).rejects.toBeInstanceOf(store.SessionUnavailableError);
  mockCollection.insertOne.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(store.createSession(sub, tokens)).rejects.toBeInstanceOf(store.SessionUnavailableError);
  mockCollection.deleteOne.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(store.revokeSession(login.sessionId, sub)).rejects.toBeInstanceOf(store.SessionUnavailableError);
});

it('abandons a crashed refresh without replaying a possibly consumed token', async () => {
  const login = await store.createSession(sub, tokens);
  mockDocuments.get(login.sessionId)!.refreshLease = { owner: 'dead-replica', until: new Date(0) };
  const exchange = jest.fn();
  await expect(peer.refreshSession(login.sessionId, sub, 1, exchange)).rejects.toBeInstanceOf(peer.SessionExpiredError);
  expect(exchange).not.toHaveBeenCalled();
  expect(mockDocuments.size).toBe(0);
});

it('fences late refresh completion after the lease deadline', async () => {
  jest.useFakeTimers();
  const login = await store.createSession(sub, tokens);
  await expect(store.refreshSession(login.sessionId, sub, 1, async () => {
    jest.setSystemTime(Date.now() + 31_000);
    return fresh;
  })).rejects.toBeInstanceOf(store.SessionExpiredError);
  expect(mockDocuments.size).toBe(0);
});

it('shares a retry cooldown and keeps only unexpired credentials after a definite rejection', async () => {
  jest.useFakeTimers();
  const valid = { ...tokens, expiresAt: Math.floor(Date.now() / 1000) + 60 };
  const login = await store.createSession(sub, valid);
  const exchange = jest.fn(async () => { throw new store.RefreshRetryableError(); });
  expect(await store.refreshSession(login.sessionId, sub, 1, exchange)).toMatchObject(valid);
  expect(mockDocuments.get(login.sessionId)!.refreshLease).toBeUndefined();
  expect(await peer.refreshSession(login.sessionId, sub, 1, exchange)).toMatchObject(valid);
  expect(exchange).toHaveBeenCalledTimes(1);
  jest.setSystemTime(Date.now() + 31_000);
  expect(await store.refreshSession(login.sessionId, sub, 1, exchange)).toMatchObject(valid);
  expect(exchange).toHaveBeenCalledTimes(2);
  jest.setSystemTime(Date.now() + 29_000);
  await expect(peer.refreshSession(login.sessionId, sub, 1, exchange)).rejects.toBeInstanceOf(peer.SessionUnavailableError);
  expect(exchange).toHaveBeenCalledTimes(2);
  jest.setSystemTime(Date.now() + 2000);
  const recovered = { ...valid, accessToken: 'recovered', expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  expect(await store.refreshSession(login.sessionId, sub, 1, async () => recovered)).toMatchObject(recovered);
  expect(mockDocuments.get(login.sessionId)!.refreshRetryAfter).toBeUndefined();
});

it('never falls back after logout or a failed post-rejection database read', async () => {
  const valid = { ...tokens, expiresAt: Math.floor(Date.now() / 1000) + 60 };
  const login = await store.createSession(sub, valid);
  await expect(store.refreshSession(login.sessionId, sub, 1, async () => {
    await peer.revokeSession(login.sessionId, sub);
    throw new store.RefreshRetryableError();
  })).rejects.toBeInstanceOf(store.SessionExpiredError);
  const second = await store.createSession(sub, valid);
  await expect(store.refreshSession(second.sessionId, sub, 1, async () => {
    mockCollection.findOne.mockRejectedValueOnce(new Error('database unavailable'));
    throw new store.RefreshRetryableError();
  })).rejects.toBeInstanceOf(store.SessionUnavailableError);
});

it('does not erase a concurrent replica cooldown using a stale lease-acquisition read', async () => {
  const valid = { ...tokens, expiresAt: Math.floor(Date.now() / 1000) + 60 };
  const login = await store.createSession(sub, valid);
  const update = mockCollection.updateOne.getMockImplementation()!;
  mockCollection.updateOne.mockImplementationOnce(async (filter, change) => {
    // Another replica releases its lease between this caller's read and update.
    mockDocuments.get(login.sessionId)!.refreshRetryAfter = new Date(Date.now() + 30_000);
    return update(filter, change);
  });
  const exchange = jest.fn();
  expect(await store.refreshSession(login.sessionId, sub, 1, exchange)).toMatchObject(valid);
  expect(exchange).not.toHaveBeenCalled();
});

it('retains a lease after an ambiguous response and requires re-login after it expires', async () => {
  jest.useFakeTimers();
  const login = await store.createSession(sub, tokens);
  await expect(store.refreshSession(login.sessionId, sub, 1, async () => {
    throw new Error('connection closed after sending refresh');
  })).rejects.toBeInstanceOf(store.SessionUnavailableError);
  expect(mockDocuments.get(login.sessionId)!.refreshLease).toBeDefined();
  jest.setSystemTime(Date.now() + 31_000);
  const exchange = jest.fn();
  await expect(store.refreshSession(login.sessionId, sub, 1, exchange)).rejects.toBeInstanceOf(store.SessionExpiredError);
  expect(exchange).not.toHaveBeenCalled();
  expect(mockDocuments.has(login.sessionId)).toBe(false);
});

it.each([undefined, { error: 'temporarily_unavailable' }])('a provider 503 remains ambiguous through the full store lifecycle: %j', async body => {
  jest.useFakeTimers();
  const originalFetch = global.fetch;
  const originalEnv = process.env;
  process.env = { ...originalEnv, OIDC_ISSUER: 'https://sso.example.test',
    OIDC_CLIENT_ID: 'example-client', OIDC_CLIENT_SECRET: 'example-secret' };
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ token_endpoint: 'https://sso.example.test/token' }) })
    .mockResolvedValueOnce({ ok: false, status: 503, json: async () => body });
  try {
    const login = await store.createSession(sub, { ...tokens, expiresAt: Math.floor(Date.now() / 1000) + 240 });
    await expect(store.refreshSession(login.sessionId, sub, 1, exchangeRefreshToken)).rejects.toBeInstanceOf(store.SessionUnavailableError);
    expect(mockDocuments.get(login.sessionId)!.refreshLease).toBeDefined();
    jest.setSystemTime(Date.now() + 31_000);
    await expect(store.refreshSession(login.sessionId, sub, 1, exchangeRefreshToken)).rejects.toBeInstanceOf(store.SessionExpiredError);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mockDocuments.has(login.sessionId)).toBe(false);
  } finally { global.fetch = originalFetch; process.env = originalEnv; }
});

it('keeps a valid browser session through a definite provider rejection and the NextAuth callbacks', async () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env;
  process.env = { ...originalEnv, OIDC_ISSUER: 'https://sso.example.test',
    OIDC_CLIENT_ID: 'example-client', OIDC_CLIENT_SECRET: 'example-secret' };
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ token_endpoint: 'https://sso.example.test/token' }) })
    .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'temporarily_unavailable' }) });
  try {
    const login = await store.createSession(sub, { ...tokens, expiresAt: Math.floor(Date.now() / 1000) + 240 });
    const token = await authOptions.callbacks!.jwt!({ token: { ...login, sub, sessionFormat: 2 },
      trigger: 'update', session: { forceRefresh: true } } as never);
    const session = await authOptions.callbacks!.session!({ token,
      session: { user: { email: 'user@example.test' }, expires: 'later' } } as never);
    expect(session).toMatchObject({ user: { email: 'user@example.test' }, accessToken: tokens.accessToken, expiresAt: login.expiresAt });
    expect(session.error).toBeUndefined();
  } finally { global.fetch = originalFetch; process.env = originalEnv; }
});

it('expires a session rejected by the provider', async () => {
  const login = await store.createSession(sub, tokens);
  await expect(store.refreshSession(login.sessionId, sub, 1, async () => {
    throw new store.SessionExpiredError();
  })).rejects.toBeInstanceOf(store.SessionExpiredError);
  expect(mockDocuments.size).toBe(0);
});

it('requires configured storage rather than silently using process memory', async () => {
  const mongo = jest.requireMock('../mongodb');
  mongo.isMongoDBConfigured = false;
  try {
    await expect(store.createSession(sub, tokens)).rejects.toBeInstanceOf(store.SessionUnavailableError);
    expect(getCollection).not.toHaveBeenCalled();
  } finally { mongo.isMongoDBConfigured = true; }
});

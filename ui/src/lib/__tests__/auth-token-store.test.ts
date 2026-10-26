/** @jest-environment node */
const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
jest.mock('../mongodb', () => ({
  isMongoDBConfigured: true,
  getCollection: jest.fn(async () => ({ findOne: mockFindOne, findOneAndUpdate: mockFindOneAndUpdate })),
}));

import { accessTokenExpiry, getStoredTokens, storeTokens, refreshStoredTokens, resetTokenStore } from '../auth-token-store';

beforeEach(() => {
  jest.requireMock('../mongodb').isMongoDBConfigured = true;
  resetTokenStore();
  process.env.NEXTAUTH_SECRET = 'example-token-store-secret';
  mockFindOne.mockReset();
  mockFindOneAndUpdate.mockReset().mockImplementation(async (filter, update) => ({
    ...filter, ...update.$set, version: 1,
  }));
});
afterEach(() => { delete process.env.NEXTAUTH_SECRET; });

it('publishes encrypted credentials and expiry together before returning the login', async () => {
  const credentials = { accessToken: 'access', refreshToken: 'refresh', expiresAt: 5000 };
  expect(await storeTokens('test-user', credentials)).toEqual({ ...credentials, version: 1 });
  const [, update, options] = mockFindOneAndUpdate.mock.calls[0];
  expect(update.$set.enc).not.toContain('access');
  expect(update.$set.enc).not.toContain('refresh');
  expect(options.writeConcern.w).toBe('majority');
  expect(options.returnDocument).toBe('after');
});

it('rereads shared credentials immediately instead of retaining a replica-local snapshot', async () => {
  await storeTokens('test-user', { accessToken: 'old', expiresAt: 5000 });
  const old = { _id: 'test-user', enc: mockFindOneAndUpdate.mock.calls[0][1].$set.enc, version: 1 };
  await storeTokens('test-user', { accessToken: 'fresh', expiresAt: 8000 });
  const fresh = { _id: 'test-user', enc: mockFindOneAndUpdate.mock.calls[1][1].$set.enc, version: 2 };
  mockFindOne.mockResolvedValueOnce(old).mockResolvedValueOnce(fresh);
  expect((await getStoredTokens('test-user'))?.accessToken).toBe('old');
  expect(await getStoredTokens('test-user')).toMatchObject({ accessToken: 'fresh', expiresAt: 8000, version: 2 });
  expect(mockFindOne).toHaveBeenCalledTimes(2);
  expect(mockFindOne).toHaveBeenLastCalledWith({ _id: 'test-user' }, expect.objectContaining({ readPreference: 'primary' }));
});

it('reads records written before the version field was introduced', async () => {
  await storeTokens('test-user', { accessToken: 'legacy', expiresAt: 5000 });
  mockFindOne.mockResolvedValue({ _id: 'test-user', enc: mockFindOneAndUpdate.mock.calls[0][1].$set.enc });
  expect(await getStoredTokens('test-user')).toMatchObject({ accessToken: 'legacy', version: 0 });
});

it('fails login when shared persistence fails instead of publishing only to one replica', async () => {
  mockFindOneAndUpdate.mockRejectedValue(new Error('database unavailable'));
  await expect(storeTokens('test-user', { accessToken: 'access' })).rejects.toThrow('Shared token store unavailable');
});

it('uses the earlier JWT/provider expiry and leaves unknown opaque expiry unset', () => {
  const jwt = `header.${Buffer.from(JSON.stringify({ exp: 100 })).toString('base64url')}.signature`;
  expect(accessTokenExpiry(jwt, 200)).toBe(100);
  expect(accessTokenExpiry(jwt, 80)).toBe(80);
  expect(accessTokenExpiry('opaque', 200)).toBe(200);
  expect(accessTokenExpiry('opaque')).toBeUndefined();
});

it('keeps the standalone fallback usable and serializes local refreshes without MongoDB', async () => {
  jest.requireMock('../mongodb').isMongoDBConfigured = false;
  await storeTokens('test-user', { accessToken: 'old', refreshToken: 'refresh', expiresAt: 5000 });
  const exchange = jest.fn(async () => {
    await Promise.resolve();
    return { accessToken: 'fresh', refreshToken: 'rotated', expiresAt: 8000 };
  });
  const [first, second] = await Promise.all([
    refreshStoredTokens('test-user', 1, exchange), refreshStoredTokens('test-user', 1, exchange),
  ]);
  expect(first).toEqual(second);
  expect(first).toMatchObject({ accessToken: 'fresh', expiresAt: 8000, version: 2 });
  expect(exchange).toHaveBeenCalledTimes(1);
  expect(mockFindOne).not.toHaveBeenCalled();
});

it('does not join an older standalone refresh after a fresh login', async () => {
  jest.requireMock('../mongodb').isMongoDBConfigured = false;
  await storeTokens('test-user', { accessToken: 'old', expiresAt: 5000 });
  let release!: (tokens: { accessToken: string; expiresAt: number }) => void;
  const old = refreshStoredTokens('test-user', 1, () => new Promise(resolve => { release = resolve; }));
  await storeTokens('test-user', { accessToken: 'new-login', expiresAt: 8000 });
  const fresh = await refreshStoredTokens('test-user', 2, async () => ({ accessToken: 'new-refresh', expiresAt: 9000 }));
  expect(fresh.accessToken).toBe('new-refresh');
  release({ accessToken: 'late-response', expiresAt: 6000 });
  expect((await old).accessToken).toBe('new-refresh');
});

/** @jest-environment node */
jest.mock('../mongodb', () => ({ isMongoDBConfigured: true }));
import { accessTokenExpiry, exchangeRefreshToken } from '../auth-token-refresh';
import { RefreshRetryableError, SessionExpiredError, SessionUnavailableError } from '../auth-token-store';

const originalFetch = global.fetch;
const originalEnv = process.env;
const now = () => Math.floor(Date.now() / 1000);
const tokens = () => ({ accessToken: 'old', refreshToken: 'refresh', expiresAt: now() - 1 });

beforeEach(() => {
  process.env = { ...originalEnv, OIDC_ISSUER: 'https://sso.example.test',
    OIDC_CLIENT_ID: 'example-client', OIDC_CLIENT_SECRET: 'example-secret' };
  global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ token_endpoint: 'https://sso.example.test/token' }) });
});
afterEach(() => { global.fetch = originalFetch; process.env = originalEnv; });

it('never lets response metadata extend the access token actual expiry', () => {
  const token = `header.${Buffer.from(JSON.stringify({ exp: 100 })).toString('base64url')}.signature`;
  expect(accessTokenExpiry(token, 200)).toBe(100);
  expect(accessTokenExpiry('opaque', 200)).toBe(200);
  expect(() => accessTokenExpiry('opaque')).toThrow(SessionUnavailableError);
});

it('keeps rotated credentials and their expiry together', async () => {
  jest.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
    access_token: 'new', refresh_token: 'rotated', expires_in: 3600, refresh_expires_in: 7200,
  }) } as Response);
  expect(await exchangeRefreshToken(tokens())).toEqual({ accessToken: 'new', refreshToken: 'rotated',
    expiresAt: expect.any(Number), refreshTokenExpiresAt: expect.any(Number) });
  expect(fetch).toHaveBeenLastCalledWith('https://sso.example.test/token', expect.objectContaining({ cache: 'no-store', signal: expect.anything() }));
});

it('preserves a refresh token if the provider does not rotate it', async () => {
  jest.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'new', expires_in: 3600 }) } as Response);
  expect((await exchangeRefreshToken(tokens())).refreshToken).toBe('refresh');
});

it('treats invalid_grant as expiration, even if an older access token is still valid', async () => {
  jest.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) } as Response);
  await expect(exchangeRefreshToken({ ...tokens(), expiresAt: now() + 60 })).rejects.toBeInstanceOf(SessionExpiredError);
});

it('classifies provider 503 as ambiguous, leaving recovery to the session store', async () => {
  jest.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503 } as Response);
  await expect(exchangeRefreshToken(tokens())).rejects.toBeInstanceOf(SessionUnavailableError);
});

it('does not misclassify a transport timeout as a definitely unconsumed token', async () => {
  const timeout = new Error('timeout');
  jest.mocked(fetch).mockRejectedValueOnce(timeout);
  await expect(exchangeRefreshToken(tokens())).rejects.toBe(timeout);
});

it('allows retry after a definitive OAuth temporary-error response', async () => {
  jest.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 400,
    json: async () => ({ error: 'temporarily_unavailable' }) } as Response);
  await expect(exchangeRefreshToken(tokens())).rejects.toBeInstanceOf(RefreshRetryableError);
});

it('rejects an expired refresh token without contacting the provider', async () => {
  await expect(exchangeRefreshToken({ ...tokens(), refreshTokenExpiresAt: now() - 1 })).rejects.toBeInstanceOf(SessionExpiredError);
  expect(fetch).not.toHaveBeenCalled();
});

it('requires expiry information in a successful opaque-token response', async () => {
  jest.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'new' }) } as Response);
  await expect(exchangeRefreshToken(tokens())).rejects.toBeInstanceOf(SessionUnavailableError);
});

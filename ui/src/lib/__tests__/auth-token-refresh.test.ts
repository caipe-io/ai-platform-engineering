/** @jest-environment node */
jest.mock('../mongodb', () => ({ isMongoDBConfigured: true }));
import { accessTokenExpiry, exchangeRefreshToken } from '../auth-token-refresh';
import { RefreshRejectedError, RefreshRetryableError, SessionUnavailableError } from '../auth-token-store';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fetch as realFetch } from 'next/dist/compiled/@edge-runtime/primitives/fetch';

const originalFetch = global.fetch;
const originalEnv = process.env;
const now = () => Math.floor(Date.now() / 1000);
const tokens = () => ({ accessToken: 'old', refreshToken: 'refresh', expiresAt: now() - 1 });

beforeEach(() => {
  process.env = { ...originalEnv, OIDC_ISSUER: 'https://sso.example.test',
    OIDC_CLIENT_ID: 'example-client', OIDC_CLIENT_SECRET: 'example-secret' };
  delete process.env.OIDC_DISCOVERY_URL;
  delete process.env.OIDC_TOKEN_ENDPOINT;
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

it.each(['invalid_grant', 'invalid_token'])('classifies %s as terminal refresh rejection', async error => {
  jest.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error }) } as Response);
  await expect(exchangeRefreshToken({ ...tokens(), expiresAt: now() + 60 })).rejects.toBeInstanceOf(RefreshRejectedError);
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
  await expect(exchangeRefreshToken({ ...tokens(), refreshTokenExpiresAt: now() - 1 })).rejects.toBeInstanceOf(RefreshRejectedError);
  expect(fetch).not.toHaveBeenCalled();
});

it('requires expiry information in a successful opaque-token response', async () => {
  jest.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'new' }) } as Response);
  await expect(exchangeRefreshToken(tokens())).rejects.toBeInstanceOf(SessionUnavailableError);
});

it.each([
  ['http://identity.example.test/realms/example', 'http://identity.example.test/realms/example/protocol/openid-connect/token'],
  ['http://identity.example.test/realms/example/.well-known/openid-configuration', 'http://identity.example.test/realms/example/protocol/openid-connect/token'],
])('refreshes through the internal Keycloak endpoint without public discovery: %s', async (issuer, endpoint) => {
  process.env.OIDC_DISCOVERY_URL = issuer;
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200,
    json: async () => ({ access_token: 'new', expires_in: 3600 }) });
  await exchangeRefreshToken(tokens());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({ method: 'POST' }));
});

it('honors an explicit token endpoint without performing discovery', async () => {
  process.env.OIDC_TOKEN_ENDPOINT = 'https://tokens.example.test/custom/token';
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200,
    json: async () => ({ access_token: 'new', expires_in: 3600 }) });
  await exchangeRefreshToken(tokens());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(process.env.OIDC_TOKEN_ENDPOINT, expect.objectContaining({ method: 'POST' }));
});

it('uses generic-provider discovery, including a full well-known URL', async () => {
  process.env.OIDC_DISCOVERY_URL = 'https://identity.example.test/oauth2/default/.well-known/openid-configuration';
  jest.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200,
    json: async () => ({ access_token: 'new', expires_in: 3600 }) } as Response);
  await exchangeRefreshToken(tokens());
  expect(fetch).toHaveBeenNthCalledWith(1, process.env.OIDC_DISCOVERY_URL, expect.anything());
  expect(fetch).toHaveBeenNthCalledWith(2, 'https://sso.example.test/token', expect.objectContaining({ method: 'POST' }));
});

it.each(['http', 'network', 'missing', 'malformed'])('never invents a Keycloak endpoint when generic discovery fails: %s', async failure => {
  process.env.OIDC_DISCOVERY_URL = 'https://identity.example.test/oauth2/default';
  global.fetch = jest.fn().mockImplementation(async () => {
    if (failure === 'network') throw new Error('discovery unavailable');
    return { ok: failure !== 'http', json: async () => {
      if (failure === 'malformed') throw new SyntaxError('invalid JSON');
      return {};
    } };
  });
  await expect(exchangeRefreshToken(tokens())).rejects.toBeInstanceOf(RefreshRetryableError);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/.well-known/'), expect.not.objectContaining({ method: 'POST' }));
});

it('falls back only for an actual Keycloak realm when public discovery is unavailable', async () => {
  process.env.OIDC_ISSUER = 'https://identity.example.test/realms/example/';
  global.fetch = jest.fn().mockRejectedValueOnce(new Error('discovery unavailable'))
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'new', expires_in: 3600 }) });
  await exchangeRefreshToken(tokens());
  expect(fetch).toHaveBeenLastCalledWith('https://identity.example.test/realms/example/protocol/openid-connect/token',
    expect.objectContaining({ method: 'POST' }));
});

it.each(['file:///tmp/token', 'https://user:password@identity.example.test/token',
  'https://identity.example.test/token#fragment'])('rejects an unsafe endpoint before sending credentials: %s', async endpoint => {
  process.env.OIDC_TOKEN_ENDPOINT = endpoint;
  await expect(exchangeRefreshToken(tokens())).rejects.toBeInstanceOf(RefreshRetryableError);
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects a missing refresh token before contacting the provider', async () => {
  await expect(exchangeRefreshToken({ ...tokens(), refreshToken: undefined })).rejects.toBeInstanceOf(RefreshRejectedError);
  expect(fetch).not.toHaveBeenCalled();
});

it('does not retry a successful response that omits rotated credentials', async () => {
  jest.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as Response);
  await expect(exchangeRefreshToken(tokens())).rejects.toBeInstanceOf(SessionUnavailableError);
});

it.each(['file:///tmp/issuer', 'https://user:password@identity.example.test',
  'https://identity.example.test#fragment'])('rejects unsafe discovery configuration: %s', async issuer => {
  process.env.OIDC_DISCOVERY_URL = issuer;
  await expect(exchangeRefreshToken(tokens())).rejects.toBeInstanceOf(RefreshRetryableError);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['https://identity.example.test', 'https://identity.example.test/realms/example'])
('rejects discovered HTTPS downgrades without a token exchange or fallback: %s', async issuer => {
  process.env.OIDC_ISSUER = issuer;
  global.fetch = jest.fn().mockResolvedValue({ ok: true,
    json: async () => ({ token_endpoint: 'http://identity.example.test/token' }) });
  await expect(exchangeRefreshToken(tokens())).rejects.toBeInstanceOf(RefreshRetryableError);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('allows an explicit internal HTTP token endpoint with a public HTTPS issuer', async () => {
  process.env.OIDC_TOKEN_ENDPOINT = 'http://identity.example.test/token';
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200,
    json: async () => ({ access_token: 'new', expires_in: 3600 }) });
  expect((await exchangeRefreshToken(tokens())).accessToken).toBe('new');
});

const goodResponse = { access_token: 'new', refresh_token: 'rotated', expires_in: 3600 };
it.each([
  null, [], 'unexpected', {},
  { ...goodResponse, error: 'invalid_grant' },
  { ...goodResponse, access_token: '   ' },
  ...['', ' ', null, {}, 123].map(refresh_token => ({ ...goodResponse, refresh_token })),
  ...['', ' ', null, {}, 123].map(id_token => ({ ...goodResponse, id_token })),
  ...[-1, 0, 1.5, '3600', null, Number.MAX_SAFE_INTEGER].map(expires_in => ({ ...goodResponse, expires_in })),
  ...[-1, 1.5, '7200', null, Number.MAX_SAFE_INTEGER].map(refresh_expires_in => ({ ...goodResponse, refresh_expires_in })),
])('rejects malformed success data as ambiguous without changing credentials: %j', async body => {
  jest.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => body } as Response);
  const original = tokens();
  await expect(exchangeRefreshToken(original)).rejects.toBeInstanceOf(SessionUnavailableError);
  expect(original).toEqual({ accessToken: 'old', refreshToken: 'refresh', expiresAt: original.expiresAt });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('treats a non-JSON response as ambiguous', async () => {
  jest.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403,
    json: async () => { throw new SyntaxError('HTML response'); } } as unknown as Response);
  await expect(exchangeRefreshToken(tokens())).rejects.toBeInstanceOf(SessionUnavailableError);
});

it('supports JWT expiry when expires_in is omitted', async () => {
  const expiresAt = now() + 3600;
  const accessToken = `header.${Buffer.from(JSON.stringify({ exp: expiresAt })).toString('base64url')}.signature`;
  jest.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200,
    json: async () => ({ access_token: accessToken, refresh_expires_in: 0 }) } as Response);
  expect(await exchangeRefreshToken(tokens())).toMatchObject({ accessToken, expiresAt, refreshToken: 'refresh' });
});

it.each(['discovery', 'token'])('does not follow %s redirects to another endpoint', async stage => {
  const redirected = jest.fn();
  const server = createServer((request, response) => {
    if (request.url === '/destination') {
      redirected();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(goodResponse));
    } else {
      response.writeHead(307, { location: '/destination' });
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.OIDC_ISSUER = origin;
    if (stage === 'token') process.env.OIDC_TOKEN_ENDPOINT = `${origin}/token`;
    global.fetch = realFetch;
    await expect(exchangeRefreshToken(tokens())).rejects.toThrow();
    expect(redirected).not.toHaveBeenCalled();
  } finally {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }
});

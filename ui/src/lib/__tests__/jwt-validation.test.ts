/**
 * Tests for the OIDC_ACCEPTED_AUDIENCES logic in jwt-validation.ts.
 *
 * Since jose v6 relies on APIs (structuredClone, WebCrypto) that aren't
 * fully available in jsdom, we test the audience-building logic by calling
 * validateBearerJWT through the real module but mocking jwtVerify itself
 * to capture the options passed to it.
 */

import { jwtVerify } from 'jose';
import { validateBearerJWT } from '../jwt-validation';

let capturedOptions: Record<string, unknown> | undefined;

// Mock jose — intercept jwtVerify to capture the audience option
jest.mock('jose', () => {
  const actual = jest.requireActual('jose');
  return {
    ...actual,
    createRemoteJWKSet: jest.fn().mockReturnValue('mock-jwks'),
    jwtVerify: jest.fn().mockImplementation(async (_token: string, _key: unknown, options?: Record<string, unknown>) => {
      capturedOptions = options;
      return {
        payload: {
          email: 'user@example.com',
          name: 'Test User',
          sub: 'user@example.com',
        },
        protectedHeader: { alg: 'RS256' },
      };
    }),
  };
});

beforeEach(() => {
  capturedOptions = undefined;

  global.fetch = jest.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({ jwks_uri: 'https://idp.example.com/jwks' }),
  }));
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_ACCEPTED_AUDIENCES;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../jwt-validation');
  mod._resetJWKSCache();
});

describe('validateBearerJWT audience handling', () => {
  it('passes OIDC_CLIENT_ID as audience when no OIDC_ACCEPTED_AUDIENCES', async () => {
    process.env.OIDC_ISSUER = 'https://idp.example.com';
    process.env.OIDC_CLIENT_ID = 'my-client-id';

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { validateBearerJWT } = require('../jwt-validation');
    await validateBearerJWT('fake-token');

    expect(capturedOptions?.audience).toEqual(['my-client-id']);
  });

  it('combines OIDC_ACCEPTED_AUDIENCES and OIDC_CLIENT_ID', async () => {
    process.env.OIDC_ISSUER = 'https://idp.example.com';
    process.env.OIDC_CLIENT_ID = 'my-client-id';
    process.env.OIDC_ACCEPTED_AUDIENCES = 'https://my-api.example.com';

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { validateBearerJWT } = require('../jwt-validation');
    await validateBearerJWT('fake-token');

    expect(capturedOptions?.audience).toEqual(['https://my-api.example.com', 'my-client-id']);
  });

  it('supports multiple comma-separated OIDC_ACCEPTED_AUDIENCES', async () => {
    process.env.OIDC_ISSUER = 'https://idp.example.com';
    process.env.OIDC_CLIENT_ID = 'my-client-id';
    process.env.OIDC_ACCEPTED_AUDIENCES = 'https://api-a.example.com, https://api-b.example.com';

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { validateBearerJWT } = require('../jwt-validation');
    await validateBearerJWT('fake-token');

    expect(capturedOptions?.audience).toEqual([
      'https://api-a.example.com',
      'https://api-b.example.com',
      'my-client-id',
    ]);
  });

  it('deduplicates OIDC_CLIENT_ID when already in OIDC_ACCEPTED_AUDIENCES', async () => {
    process.env.OIDC_ISSUER = 'https://idp.example.com';
    process.env.OIDC_CLIENT_ID = 'my-client-id';
    process.env.OIDC_ACCEPTED_AUDIENCES = 'my-client-id, https://my-api.example.com';

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { validateBearerJWT } = require('../jwt-validation');
    await validateBearerJWT('fake-token');

    expect(capturedOptions?.audience).toEqual(['my-client-id', 'https://my-api.example.com']);
  });

  it('passes undefined audience when neither OIDC_CLIENT_ID nor OIDC_ACCEPTED_AUDIENCES is set', async () => {
    process.env.OIDC_ISSUER = 'https://idp.example.com';

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { validateBearerJWT } = require('../jwt-validation');
    await validateBearerJWT('fake-token');

    expect(capturedOptions?.audience).toBeUndefined();
  });

  it('trims whitespace and ignores empty entries in OIDC_ACCEPTED_AUDIENCES', async () => {
    process.env.OIDC_ISSUER = 'https://idp.example.com';
    process.env.OIDC_ACCEPTED_AUDIENCES = ' https://api.example.com , , ';

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { validateBearerJWT } = require('../jwt-validation');
    await validateBearerJWT('fake-token');

    expect(capturedOptions?.audience).toEqual(['https://api.example.com']);
  });

  it('always passes issuer from OIDC_ISSUER', async () => {
    process.env.OIDC_ISSUER = 'https://idp.example.com';
    process.env.OIDC_CLIENT_ID = 'my-client-id';

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { validateBearerJWT } = require('../jwt-validation');
    await validateBearerJWT('fake-token');

    expect(capturedOptions?.issuer).toBe('https://idp.example.com');
  });
});

describe('verified service-account client identity', () => {
  it.each([
    ['service-account-example-platform', 'example-platform', true, 'example-platform'],
    ['service-account-example-platform', 'external-client', true, undefined],
    ['service-account-example-platform', undefined, true, undefined],
    ['service-account-example-platform', 123, true, undefined],
    ['test-user', 'example-platform', false, undefined],
  ])('extracts client identity from verified claims (%s, %s)', async (
    preferred_username, azp, isServiceAccount, serviceAccountClientId,
  ) => {
    process.env.OIDC_ISSUER = 'https://idp.example.com';
    process.env.OIDC_CLIENT_ID = 'example-api';
    jest.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { sub: 'example-subject', preferred_username, azp },
      protectedHeader: { alg: 'RS256' },
    } as never);

    await expect(validateBearerJWT('example-token')).resolves.toMatchObject({
      sub: 'example-subject', isServiceAccount, serviceAccountClientId,
    });
  });
});
